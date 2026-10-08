import { readFileSync } from 'node:fs';
import { PromptsError, describeUnknownError } from './errors.ts';
import {
  resolveSourcePath,
  type Definition,
  type Policy,
  type Rule,
  type RuntimeBinding,
  type SlotSource,
  type TemplateSource,
} from './definition.ts';
import { analyzeReferences, parseTemplate, renderTemplate, type ParsedTemplate } from './template.ts';

export { loadDefinition, parseDefinition, resolveSourcePath } from './definition.ts';
export type {
  Definition,
  FileSource,
  Policy,
  Rule,
  RuntimeBinding,
  SlotSource,
  TemplateSource,
} from './definition.ts';
export { PromptsError } from './errors.ts';
export type { PromptsErrorCode, SourceLocation } from './errors.ts';

/** Runtime data supplied to a prepared prompt at render time. */
export interface RenderData {
  readonly agent?: unknown;
  readonly model?: unknown;
  readonly tools?: unknown;
}

type SlotPlan =
  | { readonly kind: 'static'; readonly text: string }
  | { readonly kind: 'runtime'; readonly binding: RuntimeBinding };

export class PreparedPrompt {
  readonly agentID: string;
  readonly modelRef: string;
  readonly definitionFile: string;
  readonly slots: readonly string[];
  private readonly parsed: ParsedTemplate;
  private readonly plans: ReadonlyMap<string, SlotPlan>;

  constructor(
    agentID: string,
    modelRef: string,
    definitionFile: string,
    parsed: ParsedTemplate,
    plans: ReadonlyMap<string, SlotPlan>,
  ) {
    this.agentID = agentID;
    this.modelRef = modelRef;
    this.definitionFile = definitionFile;
    this.parsed = parsed;
    this.plans = plans;
    this.slots = [...plans.keys()];
  }

  /**
   * Renders the prepared template. Static values were snapshotted at prepare
   * time; runtime bindings serialize the supplied raw data. Missing runtime
   * data fails instead of degrading silently.
   */
  render(data: RenderData = {}): string {
    const values = new Map<string, string>();
    for (const [name, plan] of this.plans) {
      if (plan.kind === 'static') {
        values.set(name, plan.text);
        continue;
      }
      const value = data[plan.binding];
      if (value === undefined) {
        throw new PromptsError({
          code: 'runtime-value',
          file: this.definitionFile,
          slot: name,
          detail: `runtime binding ${JSON.stringify(plan.binding)} was not provided`,
        });
      }
      values.set(name, serializeRuntime(value, plan.binding, name, this.definitionFile));
    }
    return renderTemplate(this.parsed, values);
  }
}

/**
 * Selects the policy for an agent/model, validates the final template and
 * loads only the surviving non-omitted file sources. Returns undefined for
 * unmanaged agents; never falls back to native prompts.
 */
export function preparePrompt(
  definition: Definition,
  definitionPath: string,
  agentID: string,
  modelRef: string,
): PreparedPrompt | undefined {
  if (!Object.hasOwn(definition.agents, agentID)) return undefined;
  const policy = definition.agents[agentID];
  if (policy === undefined) return undefined;
  const selected = selectPolicy(policy, modelRef);
  if (selected.template === undefined) {
    throw new PromptsError({
      code: 'template-missing',
      file: definitionPath,
      detail: `agent ${JSON.stringify(agentID)} has no template for model ${JSON.stringify(modelRef)} and no matching rule supplies one`,
    });
  }
  const template = readTemplate(selected.template, definitionPath);
  const parsed = parseTemplate(template.text, template.file);
  const declared = Object.keys(selected.slots);
  const usage = analyzeReferences(parsed, declared, selected.allowRepeatedSlots, template.file);
  const plans = new Map<string, SlotPlan>();
  for (const name of declared) {
    const slotUsage = usage.get(name);
    if (slotUsage === undefined) {
      throw new PromptsError({ code: 'slot-value', file: template.file, slot: name, detail: 'declared slot was not analyzed' });
    }
    if (slotUsage.uses.length === 0) continue;
    plans.set(name, resolveSlotPlan(name, selected.slots[name], definitionPath, template.file));
  }
  return new PreparedPrompt(agentID, modelRef, definitionPath, parsed, plans);
}

interface SelectedPolicy {
  readonly template: TemplateSource | undefined;
  readonly slots: Readonly<Record<string, SlotSource>>;
  readonly allowRepeatedSlots: boolean;
}

function selectPolicy(policy: Policy, modelRef: string): SelectedPolicy {
  let template = policy.template;
  let slots: Record<string, SlotSource> = { ...(policy.slots ?? {}) };
  let allowRepeatedSlots = policy.allowRepeatedSlots ?? false;
  for (const rule of policy.rules ?? []) {
    if (!ruleMatches(rule, modelRef)) continue;
    if (rule.template !== undefined) template = rule.template;
    if (rule.slots !== undefined) slots = { ...slots, ...rule.slots };
    if (rule.allowRepeatedSlots !== undefined) allowRepeatedSlots = rule.allowRepeatedSlots;
  }
  return { template, slots, allowRepeatedSlots };
}

function ruleMatches(rule: Rule, modelRef: string): boolean {
  if (!rule.models.some((pattern) => matchesModelPattern(pattern, modelRef))) return false;
  if (rule.excludeModels?.some((pattern) => matchesModelPattern(pattern, modelRef)) === true) return false;
  return true;
}

/** Anchored, case-sensitive glob for full providerID/modelID refs; `*` and `?` span slashes. */
export function matchesModelPattern(pattern: string, modelRef: string): boolean {
  let expression = '^';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else if (/[.*+?^${}()|[\]\\]/.test(character)) expression += `\\${character}`;
    else expression += character;
  }
  return new RegExp(`${expression}$`).test(modelRef);
}

function readTemplate(source: TemplateSource, definitionPath: string): { text: string; file: string } {
  if (typeof source === 'string') return { text: source, file: definitionPath };
  const file = resolveSourcePath(definitionPath, source.file);
  return { text: readSource(file, 'template-file', undefined, definitionPath), file };
}

function resolveSlotPlan(
  name: string,
  source: SlotSource | undefined,
  definitionPath: string,
  templateFile: string,
): SlotPlan {
  if (source === undefined) {
    throw new PromptsError({ code: 'slot-value', file: templateFile, slot: name, detail: 'declared slot has no source' });
  }
  if (typeof source === 'string') return { kind: 'static', text: source };
  if ('runtime' in source) return { kind: 'runtime', binding: source.runtime };
  const file = resolveSourcePath(definitionPath, source.file);
  return { kind: 'static', text: readSource(file, 'slot-file', name, definitionPath) };
}

function readSource(
  file: string,
  code: 'template-file' | 'slot-file',
  slot: string | undefined,
  definitionFile: string,
): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new PromptsError({
      code,
      file,
      slot,
      detail: `${describeUnknownError(error)} (from definition ${definitionFile})`,
    });
  }
}

function serializeRuntime(value: unknown, binding: RuntimeBinding, slot: string, file: string): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) {
    throw new PromptsError({
      code: 'runtime-value',
      file,
      slot,
      detail: `runtime binding ${JSON.stringify(binding)} is not JSON-serializable`,
    });
  }
  return json;
}
