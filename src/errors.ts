/**
 * Structured diagnostics for opencode-prompts.
 *
 * Messages carry file paths, slot names, reference counts and source
 * locations only. Prompt bodies, slot bodies and file contents are never
 * echoed, so errors are safe to log.
 */

export type PromptsErrorCode =
  | 'definition-read'
  | 'definition-json'
  | 'definition-shape'
  | 'template-missing'
  | 'template-file'
  | 'template-parse'
  | 'slot-unknown'
  | 'slot-missing'
  | 'slot-repeated'
  | 'slot-omit-repeated'
  | 'slot-conflict'
  | 'slot-file'
  | 'slot-value'
  | 'runtime-value';

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export interface PromptsErrorInput {
  readonly code: PromptsErrorCode;
  readonly detail: string;
  readonly file?: string;
  readonly slot?: string;
  readonly count?: number;
  readonly locations?: readonly SourceLocation[];
}

const HINTS: Record<PromptsErrorCode, string> = {
  'definition-read': 'check the definition path and file permissions',
  'definition-json': 'fix the JSONC syntax',
  'definition-shape': 'align the definition with the documented schema',
  'template-missing': 'add "template" to the agent policy or to a matching rule',
  'template-file': 'check the template path and file permissions',
  'template-parse': 'fix the placeholder syntax',
  'slot-unknown': 'declare the name under "slots" or remove the placeholder',
  'slot-missing': 'reference the slot as {{name}} or {{name:omit}}',
  'slot-repeated': 'reference it once or set "allowRepeatedSlots": true',
  'slot-omit-repeated': 'keep a single {{name:omit}} marker per slot',
  'slot-conflict': 'use either {{name}} or {{name:omit}}, not both',
  'slot-file': 'check the slot path and file permissions',
  'slot-value': 'internal precondition failed for a used slot',
  'runtime-value': 'supply the runtime data before rendering',
};

export class PromptsError extends Error {
  readonly code: PromptsErrorCode;
  readonly file: string | undefined;
  readonly slot: string | undefined;
  readonly count: number | undefined;
  readonly locations: readonly SourceLocation[];

  constructor(input: PromptsErrorInput) {
    super(formatMessage(input));
    this.name = 'PromptsError';
    this.code = input.code;
    this.file = input.file;
    this.slot = input.slot;
    this.count = input.count;
    this.locations = input.locations ?? [];
  }
}

function formatMessage(input: PromptsErrorInput): string {
  const parts = [`opencode-prompts[${input.code}]`];
  if (input.file !== undefined) parts.push(`file=${input.file}`);
  if (input.slot !== undefined) parts.push(`slot=${JSON.stringify(input.slot)}`);
  if (input.count !== undefined) parts.push(`count=${input.count}`);
  if (input.locations !== undefined && input.locations.length > 0) {
    const rendered = input.locations.map((location) => `${location.line}:${location.column}`);
    parts.push(`locations=${rendered.join(', ')}`);
  }
  return `${parts.join(' ')}: ${input.detail}. ${HINTS[input.code]}`;
}

/** Converts a character offset in `text` into a 1-based line/column pair. */
export function offsetToLocation(text: string, offset: number): SourceLocation {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** Renders an unknown thrown value without exposing file or prompt bodies. */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    if ('code' in error && typeof error.code === 'string') {
      return `${error.code}: ${error.message}`;
    }
    return error.message;
  }
  return String(error);
}
