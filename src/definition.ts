import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { PromptsError, describeUnknownError, offsetToLocation } from './errors.ts';
import { isValidSlotName } from './template.ts';

export type RuntimeBinding = 'agent' | 'model' | 'tools';

export interface FileSource {
  readonly file: string;
}

export type TemplateSource = string | FileSource;
export type SlotSource = string | FileSource | { readonly runtime: RuntimeBinding };

export interface Rule {
  readonly models: readonly string[];
  readonly excludeModels?: readonly string[];
  readonly template?: TemplateSource;
  readonly slots?: Readonly<Record<string, SlotSource>>;
  readonly allowRepeatedSlots?: boolean;
}

export interface Policy {
  readonly template?: TemplateSource;
  readonly slots?: Readonly<Record<string, SlotSource>>;
  readonly allowRepeatedSlots?: boolean;
  readonly rules?: readonly Rule[];
}

export interface Definition {
  readonly version?: 1;
  readonly $schema?: string;
  readonly agents: Readonly<Record<string, Policy>>;
}

const ROOT_KEYS: readonly string[] = ['$schema', 'version', 'agents'];
const POLICY_KEYS: readonly string[] = ['template', 'slots', 'allowRepeatedSlots', 'rules'];
const RULE_KEYS: readonly string[] = ['models', 'excludeModels', 'template', 'slots', 'allowRepeatedSlots'];
const TEMPLATE_KEYS: readonly string[] = ['file'];
const SLOT_KEYS: readonly string[] = ['file', 'runtime'];

/** Reads and parses a JSONC definition fresh on every call. */
export function loadDefinition(path: string): Definition {
  const file = expandUser(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new PromptsError({ code: 'definition-read', file, detail: describeUnknownError(error) });
  }
  return parseDefinition(text, file);
}

/** Parses already-read JSONC text into a validated definition. */
export function parseDefinition(text: string, file: string): Definition {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: false });
  const first = errors[0];
  if (first !== undefined) {
    throw new PromptsError({
      code: 'definition-json',
      file,
      count: errors.length,
      locations: [offsetToLocation(text, first.offset)],
      detail: printParseErrorCode(first.error),
    });
  }
  return validateDefinition(tree === undefined ? undefined : nodeToValue(tree), file);
}

// Security: walk the tree and define own properties via Object.fromEntries so
// names like `__proto__` survive parsing instead of touching the object prototype.
function nodeToValue(node: Node): unknown {
  if (node.type === 'object') {
    const entries: Array<[string, unknown]> = [];
    for (const child of node.children ?? []) {
      const keyNode = child.children?.[0];
      const valueNode = child.children?.[1];
      if (keyNode === undefined || valueNode === undefined) continue;
      const key: unknown = keyNode.value;
      if (typeof key !== 'string') continue;
      entries.push([key, nodeToValue(valueNode)]);
    }
    return Object.fromEntries(entries);
  }
  if (node.type === 'array') {
    const items: unknown[] = [];
    for (const child of node.children ?? []) items.push(nodeToValue(child));
    return items;
  }
  const value: unknown = node.value;
  return value ?? null;
}

/** Resolves a file source against the definition directory, supporting ~ and absolute paths. */
export function resolveSourcePath(definitionPath: string, source: string): string {
  const expanded = expandUser(source);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(dirname(resolve(definitionPath)), expanded);
}

function expandUser(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function validateDefinition(value: unknown, file: string): Definition {
  const record = expectRecord(value, file, 'definition');
  rejectUnknownKeys(record, ROOT_KEYS, file, 'definition');
  const version = 'version' in record ? validateVersion(record.version, file) : undefined;
  const $schema = '$schema' in record ? expectNonEmptyString(record.$schema, file, '$schema') : undefined;
  if (!('agents' in record)) throw shapeError(file, 'missing required "agents" object');
  return { version, $schema, agents: validateAgents(record.agents, file) };
}

function validateVersion(value: unknown, file: string): 1 {
  if (value !== 1) throw shapeError(file, 'version must be the number 1');
  return 1;
}

function validateAgents(value: unknown, file: string): Readonly<Record<string, Policy>> {
  const record = expectRecord(value, file, 'agents');
  const entries: Array<[string, Policy]> = [];
  for (const [agentID, policy] of Object.entries(record)) {
    if (agentID.length === 0) throw shapeError(file, 'agent IDs must not be empty');
    entries.push([agentID, validatePolicy(agentID, policy, file)]);
  }
  return Object.fromEntries(entries);
}

function validatePolicy(agentID: string, value: unknown, file: string): Policy {
  const where = `agents.${agentID}`;
  const record = expectRecord(value, file, where);
  rejectUnknownKeys(record, POLICY_KEYS, file, where);
  const template = 'template' in record ? validateTemplateSource(record.template, file, `${where}.template`) : undefined;
  const slots = 'slots' in record ? validateSlots(record.slots, file, `${where}.slots`) : undefined;
  const allowRepeatedSlots =
    'allowRepeatedSlots' in record ? expectBoolean(record.allowRepeatedSlots, file, `${where}.allowRepeatedSlots`) : undefined;
  const rules = 'rules' in record ? validateRules(record.rules, file, `${where}.rules`) : undefined;
  return { template, slots, allowRepeatedSlots, rules };
}

function validateTemplateSource(value: unknown, file: string, where: string): TemplateSource {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if ('runtime' in value) {
      throw shapeError(file, `${where} cannot be a runtime binding; templates must be text or { "file": "..." }`);
    }
    rejectUnknownKeys(value, TEMPLATE_KEYS, file, where);
    if (!('file' in value)) throw shapeError(file, `${where} must be a string or { "file": "..." }`);
    return { file: expectNonEmptyString(value.file, file, `${where}.file`) };
  }
  throw shapeError(file, `${where} must be a string or { "file": "..." }`);
}

function validateSlots(value: unknown, file: string, where: string): Readonly<Record<string, SlotSource>> {
  const record = expectRecord(value, file, where);
  const entries: Array<[string, SlotSource]> = [];
  for (const [name, source] of Object.entries(record)) {
    if (!isValidSlotName(name)) {
      throw new PromptsError({
        code: 'definition-shape',
        file,
        slot: name,
        detail: `invalid slot name in ${where}; names must be nonempty and free of whitespace, braces and colons`,
      });
    }
    entries.push([name, validateSlotSource(source, file, `${where}.${name}`, name)]);
  }
  return Object.fromEntries(entries);
}

function validateSlotSource(value: unknown, file: string, where: string, name: string): SlotSource {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    rejectUnknownKeys(value, SLOT_KEYS, file, where);
    const hasFile = 'file' in value;
    const hasRuntime = 'runtime' in value;
    if (hasFile && hasRuntime) {
      throw new PromptsError({ code: 'definition-shape', file, slot: name, detail: `${where} cannot set both "file" and "runtime"` });
    }
    if (hasFile) return { file: expectNonEmptyString(value.file, file, `${where}.file`) };
    if (hasRuntime) {
      const binding = value.runtime;
      if (!isRuntimeBinding(binding)) {
        throw new PromptsError({ code: 'definition-shape', file, slot: name, detail: `${where}.runtime must be "agent", "model" or "tools"` });
      }
      return { runtime: binding };
    }
    throw new PromptsError({
      code: 'definition-shape',
      file,
      slot: name,
      detail: `${where} must be an inline string, { "file": "..." } or { "runtime": "agent" | "model" | "tools" }`,
    });
  }
  throw new PromptsError({ code: 'definition-shape', file, slot: name, detail: `${where} must be a string or an object` });
}

function validateRules(value: unknown, file: string, where: string): readonly Rule[] {
  if (!Array.isArray(value)) throw shapeError(file, `${where} must be an array`);
  const items: readonly unknown[] = value;
  return items.map((item, index) => validateRule(item, file, `${where}[${index}]`));
}

function validateRule(value: unknown, file: string, where: string): Rule {
  const record = expectRecord(value, file, where);
  rejectUnknownKeys(record, RULE_KEYS, file, where);
  if (!('models' in record)) throw shapeError(file, `${where}.models is required`);
  const models = expectStringArray(record.models, file, `${where}.models`, true);
  const excludeModels =
    'excludeModels' in record ? expectStringArray(record.excludeModels, file, `${where}.excludeModels`, false) : undefined;
  const template = 'template' in record ? validateTemplateSource(record.template, file, `${where}.template`) : undefined;
  const slots = 'slots' in record ? validateSlots(record.slots, file, `${where}.slots`) : undefined;
  const allowRepeatedSlots =
    'allowRepeatedSlots' in record ? expectBoolean(record.allowRepeatedSlots, file, `${where}.allowRepeatedSlots`) : undefined;
  return { models, excludeModels, template, slots, allowRepeatedSlots };
}

function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  return value === 'agent' || value === 'model' || value === 'tools';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, file: string, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw shapeError(file, `${where} must be an object`);
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], file: string, where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw shapeError(file, `unknown field ${JSON.stringify(key)} in ${where}`);
  }
}

function expectNonEmptyString(value: unknown, file: string, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw shapeError(file, `${where} must be a nonempty string`);
  return value;
}

function expectBoolean(value: unknown, file: string, where: string): boolean {
  if (typeof value !== 'boolean') throw shapeError(file, `${where} must be a boolean`);
  return value;
}

function expectStringArray(value: unknown, file: string, where: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value)) throw shapeError(file, `${where} must be an array of nonempty strings`);
  const items: readonly unknown[] = value;
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0) throw shapeError(file, `${where} must contain nonempty strings`);
    result.push(item);
  }
  if (requireNonEmpty && result.length === 0) throw shapeError(file, `${where} must not be empty`);
  return result;
}

function shapeError(file: string, detail: string): PromptsError {
  return new PromptsError({ code: 'definition-shape', file, detail });
}
