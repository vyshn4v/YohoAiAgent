import type { Request, Response } from 'express';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { agentGraph } from '../agent/graph.js';
import type { LeadInfo } from '../agent/state.js';
import { extractConversationalReply } from '../agent/utils/messageUtils.js';
import { createNodeLogger } from '../utils/nodeLogger.js';
import { applySseCorsHeaders } from './corsConfig.js';
import {
  getConversationSession,
  saveConversationSession,
  withConversationLock,
} from './sessionStore.js';

const NODE_STATUS_MAP: Record<string, string> = {
  decision_router: 'understanding_query',
  greeting_small_model: 'greeting',
  pgvector_retriever: 'extracting_facts',
  knowledge_big_model: 'generating_answer',
  schedule_enquiry: 'processing_enquiry',
};

/**
 * Core SSE Chat Streaming Handler.
 * Streams LangGraph node progress events, tokens, UI actions, and completion state.
 */
export async function handleSseChatStream(
  req: Request,
  res: Response,
  message: string,
  conversationId: string
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  applySseCorsHeaders(req, res);
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let isClientDisconnected = false;
  const heartbeat = setInterval(() => {
    if (!isClientDisconnected && !res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 15000);
  heartbeat.unref();

  res.on('close', () => {
    if (!res.writableEnded) {
      isClientDisconnected = true;
    }
    clearInterval(heartbeat);
  });

  const log = createNodeLogger('Server:SSE', conversationId);
  let activeNode = 'graph_init';

  try {
    sendEvent('status', { status: 'starting', conversationId });

    await withConversationLock(conversationId, async () => {
      if (isClientDisconnected) return;

      const session = await getConversationSession(conversationId);
      log.start({ messageLen: message.length, historyCount: session.messages.length });

      const userMessage = new HumanMessage(message);
      const updatedHistory = [...session.messages, userMessage];

      let fullReply = '';
      let intent = 'profile_query';
      let finalLeadInfo: LeadInfo = { ...session.leadInfo };
      let finalIsVerified = session.isVerified;
      let finalUiAction: Record<string, any> | null = null;

      const stream = agentGraph.streamEvents(
        {
          messages: updatedHistory,
          leadInfo: session.leadInfo,
          isVerified: session.isVerified,
        },
        {
          version: 'v2',
          runName: 'PortfolioAgentChat',
          configurable: { thread_id: conversationId },
          metadata: { conversationId, session_id: conversationId },
        }
      );

      for await (const event of stream) {
        if (isClientDisconnected) {
          log.warn('Client disconnected mid-stream', { activeNode });
          break;
        }

        const node = event.metadata?.langgraph_node;
        if (event.event === 'on_chain_start' && node) {
          activeNode = node;
          const mappedStatus = NODE_STATUS_MAP[node];
          if (mappedStatus) {
            sendEvent('status', { node, status: mappedStatus });
          }
        }

        if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
          const finalState = event.data.output;
          if (finalState?.intent) intent = finalState.intent;
          if (finalState?.leadInfo) finalLeadInfo = { ...finalLeadInfo, ...finalState.leadInfo };
          if (typeof finalState?.isVerified === 'boolean') finalIsVerified = finalState.isVerified;
          if (finalState?.uiAction !== undefined) finalUiAction = finalState.uiAction;
          if (finalState?.messages?.length > 0) {
            const lastMsg = finalState.messages[finalState.messages.length - 1];
            fullReply = extractConversationalReply(lastMsg.content);
          }
        }
      }

      if (fullReply && !isClientDisconnected) {
        for (const word of fullReply.split(/(\s+)/)) {
          if (isClientDisconnected) break;
          sendEvent('token', { token: word, conversationId });
        }
      }

      // Avoid saving empty AIMessage("") turns when client disconnects before completion
      if (!isClientDisconnected && fullReply) {
        await saveConversationSession(
          conversationId,
          [...updatedHistory, new AIMessage(fullReply)],
          finalLeadInfo,
          finalIsVerified
        );
      }

      if (!isClientDisconnected) {
        if (finalUiAction) sendEvent('ui_action', finalUiAction);
        sendEvent('done', {
          conversationId,
          reply: fullReply,
          intent,
          leadInfo: finalLeadInfo,
          uiAction: finalUiAction,
        });
      }

      log.done({
        intent,
        replyLen: fullReply.length,
        hasUiAction: Boolean(finalUiAction),
        ...(isClientDisconnected ? { disconnected: true, activeNode } : {}),
      });
    });
  } catch (err: any) {
    log.fail(err, { activeNode });
    if (!isClientDisconnected && !res.writableEnded) {
      sendEvent('error', {
        error:
          process.env.NODE_ENV === 'development'
            ? err.message || 'Stream processing failed'
            : 'Stream processing failed',
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      res.end();
    }
  }
}
