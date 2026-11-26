import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { agentGraph } from '../../agent/graph.js';
import { extractConversationalReply } from '../../agent/utils/messageUtils.js';
import { createNodeLogger } from '../../utils/nodeLogger.js';
import { getConversationSession, saveConversationSession } from '../sessionStore.js';
import { handleSseChatStream } from '../sseChatHandler.js';

export function createChatRouter(): Router {
  const router = Router();

  router.post('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
    const { message, conversationId = uuidv4() } = req.body;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message string is required.' });
      return;
    }
    await handleSseChatStream(req, res, message, conversationId);
  });

  router.get('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
    const message = req.query.message as string;
    const conversationId = (req.query.conversationId as string) || uuidv4();

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Query parameter "message" is required.' });
      return;
    }

    await handleSseChatStream(req, res, message, conversationId);
  });

  router.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
    let log: ReturnType<typeof createNodeLogger> | undefined;
    try {
      const { message, conversationId = uuidv4() } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message string is required.' });
        return;
      }

      if (req.headers.accept?.includes('text/event-stream')) {
        await handleSseChatStream(req, res, message, conversationId);
        return;
      }

      const session = getConversationSession(conversationId);
      log = createNodeLogger('Server:Chat', conversationId);
      log.start({ messageLen: message.length, historyCount: session.messages.length });

      const userMessage = new HumanMessage(message);
      const updatedHistory = [...session.messages, userMessage];

      const finalState = await agentGraph.invoke(
        {
          messages: updatedHistory,
          leadInfo: session.leadInfo,
          isVerified: session.isVerified,
        },
        {
          runName: 'PortfolioAgentChat',
          configurable: { thread_id: conversationId },
          metadata: { conversationId, session_id: conversationId },
        }
      );

      const lastAiMsg = finalState.messages[finalState.messages.length - 1];
      const replyText = extractConversationalReply(lastAiMsg.content);

      const mergedLeadInfo = { ...session.leadInfo, ...(finalState.leadInfo || {}) };
      const finalIsVerified = Boolean(finalState.isVerified ?? session.isVerified);
      saveConversationSession(
        conversationId,
        [...updatedHistory, new AIMessage(replyText)],
        mergedLeadInfo,
        finalIsVerified
      );

      const uiAction = finalState.uiAction || null;
      const retrievedCount = finalState.classifiedDocs?.length || finalState.retrievedDocs?.length || 0;
      log.done({ intent: finalState.intent, retrievedCount, replyLen: replyText.length });

      res.json({
        reply: replyText,
        conversationId,
        intent: finalState.intent,
        leadInfo: mergedLeadInfo,
        uiAction,
        retrievedCount,
      });
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
