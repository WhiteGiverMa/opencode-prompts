/**
 * Diagnostics values shared by every opencode-prompts module.
 *
 * `Failure` is the body-free projection of an error: codes, paths, slot names,
 * counts and source locations only. Raw messages and prompt data never pass
 * through it, so it is safe to log.
 */
import { PromptsError, type SourceLocation } from './core.ts';
import type { LogRecord } from './log.ts';

export interface Failure {
  readonly code: string;
  readonly file?: string;
  readonly slot?: string;
  readonly count?: number;
  readonly locations?: readonly SourceLocation[];
}

/** Generic, body-free error thrown to abort a request before the model runs. */
export class PromptsBlockedError extends Error {
  readonly code: string;

  constructor(failure: Failure, logPath?: string) {
    super(`opencode-prompts blocked this request [${failure.code}]; diagnostics: ${logPath ?? 'stderr'}`);
    this.name = 'PromptsBlockedError';
    this.code = failure.code;
  }
}

/** Internal error carrying a structured failure without leaking it into messages. */
export class AdapterError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.code);
    this.name = 'AdapterError';
    this.failure = failure;
  }
}

export function toFailure(error: unknown): Failure {
  if (error instanceof PromptsError) {
    return { code: error.code, file: error.file, slot: error.slot, count: error.count, locations: error.locations };
  }
  if (error instanceof AdapterError) return error.failure;
  return { code: 'unexpected' };
}

export function isRuntimeValue(error: unknown): error is PromptsError {
  return error instanceof PromptsError && error.code === 'runtime-value';
}

export function failureFields(failure: Failure): Pick<LogRecord, 'file' | 'slot' | 'count' | 'locations'> {
  return {
    file: failure.file,
    slot: failure.slot,
    count: failure.count,
    locations: failure.locations,
  };
}
