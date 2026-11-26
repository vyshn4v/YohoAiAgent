import type { RunnableConfig } from '@langchain/core/runnables';

const MAX_LOG_STRING_LENGTH = 200;

export interface NodeLogger {
  start: (fields?: Record<string, unknown>) => void;
  step: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  done: (fields?: Record<string, unknown>) => void;
  fail: (error: unknown, fields?: Record<string, unknown>) => void;
}

/**
 * Sanitizes values before writing to logs to prevent CRLF/control-char log injection
 * and keep single-line log entries readable.
 */
export function sanitizeLogValue(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);

  const singleLine = (raw ?? '')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .trim();

  if (singleLine.length > MAX_LOG_STRING_LENGTH) {
    return `${singleLine.slice(0, MAX_LOG_STRING_LENGTH)}...`;
  }
  return singleLine;
}

function formatLogFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const parts: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${sanitizeLogValue(value)}`);
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Extracts safe diagnostic error metadata (name, status, error code, message, and source frame)
 * without dumping raw SDK objects or sensitive request payloads.
 */
export function formatErrorDetails(error: unknown): string {
  if (!error) return 'Unknown error';

  if (typeof error === 'string') {
    return sanitizeLogValue(error);
  }

  const errObj = error as Record<string, any>;
  const metaParts: string[] = [];

  if (errObj.name && errObj.name !== 'Error') {
    metaParts.push(`type=${sanitizeLogValue(errObj.name)}`);
  }
  if (errObj.status !== undefined) {
    metaParts.push(`status=${sanitizeLogValue(errObj.status)}`);
  }
  const errorCode = errObj.code || errObj.lc_error_code;
  if (errorCode) {
    metaParts.push(`code=${sanitizeLogValue(errorCode)}`);
  }

  const message = sanitizeLogValue(errObj.message || String(error));
  const prefix = metaParts.length > 0 ? `[${metaParts.join(' ')}] ` : '';

  let location = '';
  if (typeof errObj.stack === 'string') {
    const appFrame = errObj.stack
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.startsWith('at ') &&
          !line.includes('node_modules') &&
          !line.includes('node:internal/')
      );
    if (appFrame) {
      location = ` (${sanitizeLogValue(appFrame)})`;
    }
  }

  return `${prefix}${message}${location}`;
}

function resolveConversationId(context?: RunnableConfig | string): string | undefined {
  if (typeof context === 'string') {
    return context.trim() || undefined;
  }
  const threadId =
    context?.configurable?.thread_id ?? context?.configurable?.conversationId;
  return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined;
}

/**
 * Creates a scoped logger for a LangGraph node, tool, or request handler.
 * Tracks elapsed duration automatically so logs show current progress and failure points.
 */
export function createNodeLogger(
  scope: string,
  context?: RunnableConfig | string
): NodeLogger {
  const startedAt = Date.now();
  const safeScope = sanitizeLogValue(scope);
  const convId = resolveConversationId(context);
  const convTag = convId ? ` [conv=${sanitizeLogValue(convId)}]` : '';

  const prefix = (level: 'INFO' | 'WARN' | 'ERROR') =>
    `${new Date().toISOString()} ${level.padEnd(5)} [${safeScope}]${convTag}`;

  return {
    start(fields) {
      console.log(`${prefix('INFO')} Started${formatLogFields(fields)}`);
    },
    step(message, fields) {
      console.log(
        `${prefix('INFO')} ${sanitizeLogValue(message)}${formatLogFields(fields)}`
      );
    },
    warn(message, fields) {
      console.warn(
        `${prefix('WARN')} ${sanitizeLogValue(message)}${formatLogFields(fields)}`
      );
    },
    done(fields) {
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `${prefix('INFO')} Completed in ${elapsedMs}ms${formatLogFields(fields)}`
      );
    },
    fail(error, fields) {
      const elapsedMs = Date.now() - startedAt;
      console.error(
        `${prefix('ERROR')} Failed in ${elapsedMs}ms${formatLogFields(fields)}: ${formatErrorDetails(error)}`
      );
    },
  };
}
