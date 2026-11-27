import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { agentGraph, GRAPH_RUN_NAME } from '../../agent/graph.js';
import { extractConversationalReply } from '../../agent/utils/messageUtils.js';
import { createNodeLogger } from '../../utils/nodeLogger.js';
import {
  getConversationSession,
  saveConversationSession,
  withConversationLock,
} from '../sessionStore.js';
import { handleSseChatStream } from '../sseChatHandler.js';

function validateConversationId(
  raw: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  if (raw === undefined) {
    return { valid: true, value: uuidv4() };
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, error: 'conversationId must be a non-empty string.' };
  }
  return { valid: true, value: raw.trim() };
}

export function createChatRouter(): Router {
  const router = Router();

  router.post('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
    const { message } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message string is required.' });
      return;
    }

    const convResult = validateConversationId(req.body?.conversationId);
    if (!convResult.valid) {
      res.status(400).json({ error: convResult.error });
      return;
    }

    await handleSseChatStream(req, res, message, convResult.value);
  });

  router.get('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
    const message = req.query.message as string;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Query parameter "message" is required.' });
      return;
    }

    const convResult = validateConversationId(req.query.conversationId);
    if (!convResult.valid) {
      res.status(400).json({ error: convResult.error });
      return;
    }

    await handleSseChatStream(req, res, message, convResult.value);
  });

  router.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
    let log: ReturnType<typeof createNodeLogger> | undefined;
    try {
      const { message } = req.body ?? {};

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message string is required.' });
        return;
      }

      const convResult = validateConversationId(req.body?.conversationId);
      if (!convResult.valid) {
        res.status(400).json({ error: convResult.error });
        return;
      }
      const conversationId = convResult.value;

      if (req.headers.accept?.includes('text/event-stream')) {
        await handleSseChatStream(req, res, message, conversationId);
        return;
      }

      log = createNodeLogger('Server:Chat', conversationId);

      const responsePayload = await withConversationLock(conversationId, async () => {
        const session = await getConversationSession(conversationId);
        log!.start({ messageLen: message.length, historyCount: session.messages.length });

        const userMessage = new HumanMessage(message);
        const updatedHistory = [...session.messages, userMessage];

        const finalState = await agentGraph.invoke(
          {
            messages: updatedHistory,
            leadInfo: session.leadInfo,
            isVerified: session.isVerified,
          },
          {
            runName: GRAPH_RUN_NAME,
            configurable: { thread_id: conversationId },
            metadata: { conversationId, session_id: conversationId },
          }
        );

        const lastAiMsg = finalState.messages[finalState.messages.length - 1];
        const replyText = extractConversationalReply(lastAiMsg.content);

        const mergedLeadInfo = { ...session.leadInfo, ...(finalState.leadInfo || {}) };
        const finalIsVerified = Boolean(finalState.isVerified ?? session.isVerified);
        await saveConversationSession(
          conversationId,
          [...updatedHistory, new AIMessage(replyText)],
          mergedLeadInfo,
          finalIsVerified
        );

        const uiAction = finalState.uiAction || null;
        const retrievedCount = finalState.retrievedDocs?.length || 0;
        log!.done({ intent: finalState.intent, retrievedCount, replyLen: replyText.length });

        return {
          reply: replyText,
          conversationId,
          intent: finalState.intent,
          leadInfo: mergedLeadInfo,
          uiAction,
          retrievedCount,
        };
      });

      res.json(responsePayload);
    } catch (error: any) {
      if (log) {
        log.fail(error);
      } else {
        console.error('[API Chat Error]', error);
      }
      res.status(500).json({
        error: 'An error occurred while processing your request.',
        ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}),
      });
    }
  });

  return router;
}
