import { getRequestId } from './requestContext.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface RedactionContext {
  key: string;
  path: readonly string[];
  value: unknown;
}

export type RedactionHook = (context: RedactionContext) => unknown;

export interface LoggerOptions {
  level?: LogLevel | string;
  redactors?: RedactionHook[];
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY =
  /(authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)/i;
const MAX_SERIALIZATION_DEPTH = 12;

const defaultRedactionHook: RedactionHook = ({ key }) =>
  SENSITIVE_KEY.test(key) ? REDACTED_VALUE : undefined;

function normalizeLevel(level: string | undefined): LogLevel {
  const normalizedLevel = level?.toLowerCase();
  return normalizedLevel && normalizedLevel in LEVEL_PRIORITY
    ? (normalizedLevel as LogLevel)
    : 'info';
}

function safeRead(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return '[Unserializable]';
  }
}

function applyRedactionHooks(
  key: string,
  value: unknown,
  path: readonly string[],
  redactors: RedactionHook[],
): unknown {
  let redactedValue = value;

  for (const redactor of redactors) {
    try {
      const candidate = redactor({ key, path, value: redactedValue });
      if (candidate !== undefined) redactedValue = candidate;
    } catch {
      // A logging hook must never take down the application.
    }
  }

  return redactedValue;
}

function serializeError(
  error: Error,
  path: readonly string[],
  ancestors: Set<object>,
  redactors: RedactionHook[],
  depth: number,
): Record<string, unknown> {
  const messagePath = [...path, 'message'];
  const namePath = [...path, 'name'];
  const stackPath = [...path, 'stack'];
  const serialized: Record<string, unknown> = {
    message: serializeValue(
      applyRedactionHooks('message', safeRead(error, 'message'), messagePath, redactors),
      messagePath,
      ancestors,
      redactors,
      depth + 1,
    ),
    name: serializeValue(
      applyRedactionHooks('name', safeRead(error, 'name'), namePath, redactors),
      namePath,
      ancestors,
      redactors,
      depth + 1,
    ),
    stack: serializeValue(
      applyRedactionHooks('stack', safeRead(error, 'stack'), stackPath, redactors),
      stackPath,
      ancestors,
      redactors,
      depth + 1,
    ),
  };

  const code = safeRead(error, 'code');
  if (code !== undefined) {
    const codePath = [...path, 'code'];
    serialized.code = serializeValue(
      applyRedactionHooks('code', code, codePath, redactors),
      codePath,
      ancestors,
      redactors,
      depth + 1,
    );
  }

  const cause = safeRead(error, 'cause');
  if (cause !== undefined) {
    const causePath = [...path, 'cause'];
    serialized.cause = serializeValue(
      applyRedactionHooks('cause', cause, causePath, redactors),
      causePath,
      ancestors,
      redactors,
      depth + 1,
    );
  }

  if (error instanceof AggregateError) {
    serialized.errors = error.errors.map((nestedError, index) =>
      serializeValue(
        nestedError,
        [...path, 'errors', String(index)],
        ancestors,
        redactors,
        depth + 1,
      ),
    );
  }

  for (const key of Object.keys(error)) {
    if (key === 'cause' || key === 'code' || key === 'errors') continue;
    serialized[key] = serializeValue(
      applyRedactionHooks(key, safeRead(error, key), [...path, key], redactors),
      [...path, key],
      ancestors,
      redactors,
      depth + 1,
    );
  }

  return serialized;
}

function serializeValue(
  value: unknown,
  path: readonly string[],
  ancestors: Set<object>,
  redactors: RedactionHook[],
  depth: number,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return value;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (depth > MAX_SERIALIZATION_DEPTH) return '[MaxDepth]';

  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);

  try {
    if (value instanceof Error) {
      return serializeError(value, path, ancestors, redactors, depth);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        serializeValue(item, [...path, String(index)], ancestors, redactors, depth + 1),
      );
    }
    if (value instanceof Map) {
      return Array.from(value.entries()).map(([key, item], index) => ({
        key: serializeValue(
          key,
          [...path, String(index), 'key'],
          ancestors,
          redactors,
          depth + 1,
        ),
        value: serializeValue(
          item,
          [...path, String(index), 'value'],
          ancestors,
          redactors,
          depth + 1,
        ),
      }));
    }
    if (value instanceof Set) {
      return Array.from(value.values()).map((item, index) =>
        serializeValue(item, [...path, String(index)], ancestors, redactors, depth + 1),
      );
    }

    const serialized: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const childPath = [...path, key];
      const childValue = applyRedactionHooks(
        key,
        safeRead(value, key),
        childPath,
        redactors,
      );
      serialized[key] = serializeValue(
        childValue,
        childPath,
        ancestors,
        redactors,
        depth + 1,
      );
    }
    return serialized;
  } catch {
    return '[Unserializable]';
  } finally {
    ancestors.delete(value);
  }
}

function serializeMeta(
  meta: Record<string, unknown> | undefined,
  redactors: RedactionHook[],
) {
  if (!meta) return {};

  return serializeValue(meta, [], new Set<object>(), redactors, 0) as Record<
    string,
    unknown
  >;
}

function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? '{}' : serialized;
  } catch {
    return JSON.stringify({
      level: 'error',
      msg: 'Failed to serialize log payload',
      timestamp: new Date().toISOString(),
    });
  }
}

function writeLog(
  level: Exclude<LogLevel, 'silent'>,
  msg: string,
  meta: Record<string, unknown> | undefined,
  options: Required<Pick<LoggerOptions, 'level'>> & { redactors: RedactionHook[] },
): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[normalizeLevel(options.level)]) return;

  const contextRequestId = getRequestId();
  const serializedMeta = serializeMeta(meta, options.redactors);
  const payload = {
    ...serializedMeta,
    level,
    msg,
    ...(contextRequestId ? { requestId: contextRequestId } : {}),
    timestamp: new Date().toISOString(),
  };
  const line = safeJsonStringify(payload);

  try {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  } catch {
    // Logging must not change application behavior if the output stream fails.
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const loggerOptions = {
    level: normalizeLevel(options.level),
    redactors: [defaultRedactionHook, ...(options.redactors || [])],
  };

  return {
    debug: (msg, meta) => writeLog('debug', msg, meta, loggerOptions),
    info: (msg, meta) => writeLog('info', msg, meta, loggerOptions),
    warn: (msg, meta) => writeLog('warn', msg, meta, loggerOptions),
    error: (msg, meta) => writeLog('error', msg, meta, loggerOptions),
  };
}

const logger = createLogger({ level: process.env.LOG_LEVEL });

export default logger;
