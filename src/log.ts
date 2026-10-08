/**
 * JSONL diagnostics for opencode-prompts.
 *
 * Records carry structured identifiers and repair hints only. Prompt bodies,
 * slot values, file contents and credentials are never rendered, and a failed
 * file append falls back to stderr instead of surfacing to the caller. A log
 * path that aliases a declared input (definition, template or slot source) is
 * never appended to: every write re-checks the current protected set and falls
 * back to stderr instead.
 */
import { appendFileSync } from 'node:fs';
import { sameFile } from './paths.ts';

export type LogPhase = 'startup' | 'admission' | 'context' | 'seed' | 'cleanup';

export interface LogLocation {
  readonly line: number;
  readonly column: number;
}

export interface LogRecord {
  readonly phase: LogPhase;
  readonly code: string;
  readonly session?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly file?: string;
  readonly slot?: string;
  readonly count?: number;
  readonly locations?: readonly LogLocation[];
}

const FALLBACK_HINT = 'check the plugin definition and the host logs';

/** Repair guidance per diagnostic code; keys outside this map use the fallback. */
export const LOG_HINTS: Readonly<Record<string, string>> = {
  ok: 'no action required',
  unmanaged: 'no action required; the agent is not managed by the definition',
  restored: 'no action required; the role left the definition and its native system was restored',
  'options-invalid':
    'set { "definition": "<path>" } (and optionally "logFile"/"enabled"); unknown keys are rejected and logFile must not alias the definition, a template or a slot source',
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
  'agent-unresolved': 'select an agent for the session or configure a default primary agent',
  'model-unresolved': 'select a model for the session or configure a default model',
  'agent-missing': 'the definition manages an agent that does not exist; enable it or remove the policy',
  'tools-unavailable': 'the seed needs JSON-schema tool inputs; fix the definition or the tool plugin',
  'seed-missing': 'the managed role was not seeded; check the definition and retry admission',
  'unmanaged-marked': 'a role left the definition while marked; retry after the restored system is reloaded',
  'region-missing': 'the admitted system lost the owned region; retry admission to reseed',
  'region-duplicate': 'the owned region appears more than once; remove the duplicate content',
  'region-malformed': 'the owned markers are reordered or altered; remove the modified content',
  unexpected: 'inspect the host logs; the failing error is not part of the plugin surface',
};

const MAX_FIELD_LENGTH = 512;

export class DiagnosticsLog {
  private readonly file: string | undefined;
  private readonly protectedInputs: (() => readonly string[]) | undefined;

  constructor(file?: string, protectedInputs?: () => readonly string[]) {
    this.file = file;
    this.protectedInputs = protectedInputs;
  }

  /** Appends one sanitized JSON line; never throws and never reads prompt data. */
  write(record: LogRecord): void {
    const line = JSON.stringify(renderRecord(record));
    const file = this.file;
    if (file === undefined || this.collides(file)) {
      writeStderr(line);
      return;
    }
    try {
      appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      writeStderr(line);
    }
  }

  /** A log path that aliases a known input must stay byte-identical. */
  private collides(file: string): boolean {
    return (this.protectedInputs?.() ?? []).some((input) => sameFile(file, input));
  }
}

function renderRecord(record: LogRecord): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ts: new Date().toISOString(),
    phase: record.phase,
    code: record.code,
    hint: LOG_HINTS[record.code] ?? FALLBACK_HINT,
  };
  put(output, 'session', record.session);
  put(output, 'agent', record.agent);
  put(output, 'model', record.model);
  put(output, 'file', record.file);
  put(output, 'slot', record.slot);
  if (record.count !== undefined) output['count'] = record.count;
  if (record.locations !== undefined && record.locations.length > 0) {
    output['locations'] = record.locations.map((location) => ({ line: location.line, column: location.column }));
  }
  return output;
}

function put(output: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined) return;
  output[key] = value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH - 3)}...` : value;
}

function writeStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Diagnostics must never break the host request path.
  }
}
