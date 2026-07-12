/**
 * Minimal structured JSON logger with built-in PII redaction (FR-B10 / NFR-6).
 *
 * Design for testability: the output sink and clock are injectable, so tests need no console
 * spies or fake timers, and the module has no hidden global state.
 */
import { redact, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  correlationId: string;
  sink?: (line: string) => void;
  clock?: () => string;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/**
 * Splits a context object into (a) redactable data and (b) serialised Error fields. Errors are
 * kept out of the redaction pass so that `Error.name` (e.g. "Error", "ThrottlingException") is not
 * clobbered by the "name" PII key; the error message is still scrubbed for embedded PII.
 */
function partitionErrors(context: Record<string, unknown>): {
  data: Record<string, unknown>;
  errors: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {};
  const errors: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (v instanceof Error) {
      errors[k] = { name: v.name, message: redactText(v.message) };
    } else {
      data[k] = v;
    }
  }
  return { data, errors };
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const clock = options.clock ?? (() => new Date().toISOString());
  const threshold = LEVEL_ORDER[options.level];

  const bound: Record<string, unknown> = {};

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const { data, errors } = partitionErrors({ ...bound, ...(context ?? {}) });
    const entry = {
      level,
      time: clock(),
      correlationId: options.correlationId,
      message,
      ...redact(data),
      ...errors,
    };
    sink(JSON.stringify(entry));
  };

  const logger: Logger = {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child(context: Record<string, unknown>): Logger {
      Object.assign(bound, context);
      return logger;
    },
  };
  return logger;
}
