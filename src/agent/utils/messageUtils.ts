import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { isRunnableConfigLike } from 'langsmith/run_trees';

/**
 * Safely parses JSON tool output strings, returning an error object when invalid JSON is returned.
 */
export function parseToolOutput(res: unknown): Record<string, any> {
  const str =
    typeof res === 'string'
      ? res
      : typeof (res as any)?.content === 'string'
      ? ((res as any).content as string)
      : JSON.stringify(res);

  try {
    const parsed = JSON.parse(str);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Tool output JSON must be a plain object.');
    }
    return parsed;
  } catch {
    return { status: 'error', message: str };
  }
}

/**
 * Extracts the plain-text content of the most recent user (HumanMessage) turn.
 */
export function getLastUserMessage(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage || messages[i]._getType() === 'human') {
      return typeof messages[i].content === 'string'
        ? (messages[i].content as string)
        : JSON.stringify(messages[i].content);
    }
  }
  return '';
}

/**
 * Builds contextual input for the decision router by including the immediately preceding
 * assistant prompt when available, so follow-up answers (e.g. a name or OTP) stay in context.
 */
export function buildDecisionInput(messages: BaseMessage[], lastUserMessage: string): string {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage || messages[i]._getType() === 'human') {
      lastHumanIdx = i;
      break;
    }
  }

  for (let i = lastHumanIdx >= 0 ? lastHumanIdx - 1 : messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof AIMessage || messages[i]._getType() === 'ai') {
      const prevContent =
        typeof messages[i].content === 'string'
          ? (messages[i].content as string).trim()
          : JSON.stringify(messages[i].content);
      if (prevContent) {
        return `Previous assistant message: "${prevContent}"\nLatest user message: "${lastUserMessage}"`;
      }
      break;
    }
  }

  return lastUserMessage;
}

/**
 * Unwraps structured `{ reply }` or `{ message }` JSON strings into plain conversational text.
 */
export function extractConversationalReply(content: unknown): string {
  let text = typeof content === 'string' ? content : JSON.stringify(content);

  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.reply === 'string') text = parsed.reply;
      else if (typeof parsed.message === 'string') text = parsed.message;
    }
  } catch {
    // Plain conversational text already
  }

  return text;
}

/**
 * Invokes a LangSmith traceable wrapper while preserving parent-child LangGraph nesting
 * whenever RunnableConfig carries an active LangChainTracer callback manager.
 */
export function invokeTraceable<Args extends any[], Res>(
  tracedFn: (...args: any[]) => Promise<Res>,
  runConfig: RunnableConfig | undefined,
  ...args: Args
): Promise<Res> {
  return isRunnableConfigLike(runConfig as any)
    ? tracedFn(runConfig as any, ...args)
    : tracedFn(...args);
}
