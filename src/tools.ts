/**
 * Tool inventory projection for the `tools` runtime binding.
 *
 * Seeds may only carry real, JSON-representable tool inputs. Plain JSON
 * schemas, Effect schemas (converted through the public schema API) and
 * StandardJSONSchemaV1 converters are accepted; anything else is rejected as a
 * whole instead of being faked. The per-request context uses the host's
 * authoritative tools.
 */
import { Schema } from 'effect';
import type { ToolRecord, ToolShape } from './port.ts';

export interface ToolSnapshot {
  readonly tools?: Readonly<Record<string, ToolShape>>;
  /** Unsupported tool count, or -1 when the inventory API itself failed. */
  readonly rejected: number;
}

export function snapshotTools(records: readonly ToolRecord[]): ToolSnapshot {
  const entries: Array<[string, ToolShape]> = [];
  let rejected = 0;
  for (const record of records) {
    const input = toolInput(record.input);
    if (input === undefined) {
      rejected += 1;
      continue;
    }
    entries.push([record.name, { description: record.description, input: input.value }]);
  }
  // Object.fromEntries defines own data properties, so reserved names such as
  // __proto__ stay in the snapshot instead of touching the map prototype.
  return rejected > 0 ? { rejected } : { tools: Object.fromEntries(entries), rejected: 0 };
}

const STANDARD_JSON_SCHEMA = '~standard';

interface StandardJsonSchemaLike {
  readonly jsonSchema: {
    readonly input: (options: { readonly target: string }) => unknown;
  };
}

function toolInput(input: unknown): { readonly value: unknown } | undefined {
  if (input === undefined || input === null) return { value: {} };
  if (isPlainJson(input)) return { value: input };
  if (Schema.isSchema(input)) return effectJsonSchema(input);
  const standard = standardJsonSchema(input);
  if (standard === undefined) return undefined;
  try {
    const converted = standard.jsonSchema.input({ target: 'draft-2020-12' });
    return isPlainJson(converted) ? { value: converted } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts an Effect schema with the public schema API. `$ref`s in the
 * document point into `#/$defs/...`, so the definitions pool is attached under
 * that key; no host-side normalization is copied.
 */
export function effectJsonSchema(schema: Schema.Top): { readonly value: unknown } | undefined {
  try {
    const document = Schema.toJsonSchemaDocument(schema);
    const composed =
      Object.keys(document.definitions).length === 0
        ? document.schema
        : { ...document.schema, $defs: document.definitions };
    return isPlainJson(composed) ? { value: composed } : undefined;
  } catch {
    return undefined;
  }
}

function standardJsonSchema(value: unknown): StandardJsonSchemaLike | undefined {
  if (typeof value !== 'object' || value === null || !(STANDARD_JSON_SCHEMA in value)) return undefined;
  const standard: unknown = value[STANDARD_JSON_SCHEMA];
  return isStandardJsonSchema(standard) ? standard : undefined;
}

function isStandardJsonSchema(value: unknown): value is StandardJsonSchemaLike {
  if (typeof value !== 'object' || value === null || !('jsonSchema' in value)) return false;
  const schema: unknown = value['jsonSchema'];
  if (typeof schema !== 'object' || schema === null || !('input' in schema)) return false;
  return typeof schema['input'] === 'function';
}

function isPlainJson(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value !== 'object') return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries: readonly unknown[] = Object.values(value);
  for (const item of entries) {
    if (!isPlainJson(item)) return false;
  }
  return true;
}
