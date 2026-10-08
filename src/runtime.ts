/**
 * Host-agnostic runtime for the opencode-prompts adapter.
 *
 * The runtime owns three public registrations: an admission guard on
 * `session.prompt` (fresh definition validation before durable admission), a
 * late disposable `agent.transform` (registered once, after host activation
 * completed, so managed roles are seeded after configured systems), and a
 * context renderer on `session.context` (fresh render with the authoritative
 * per-request model and tools). No native prompt is stored or reused.
 *
 * The transform is a pure map application: each admission validates and
 * prepares its own wrapped seed first, then stores it under its agent ID. The
 * transform never reads files, never renders, and never touches policies other
 * than the prepared entries, so a failed admission cannot change another
 * session's seed.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { loadDefinition, preparePrompt, resolveSourcePath, type Definition, type Policy } from './core.ts';
import { AdapterError, PromptsBlockedError, failureFields, isRuntimeValue, toFailure, type Failure } from './failure.ts';
import { DiagnosticsLog, type LogPhase } from './log.ts';
import { hasMarkerNamespace, hasOwnedRegion, replaceOwnedRegion, wrapSeed } from './markers.ts';
import { resolvePath, sameFile } from './paths.ts';
import type {
  AgentEditor,
  AgentSummary,
  ContextEvent,
  ModelRefLike,
  ModelSummary,
  PromptEvent,
  Registration,
  RuntimeHost,
  RuntimeOptionsInput,
} from './port.ts';
import { snapshotTools, type ToolSnapshot } from './tools.ts';

export { PromptsBlockedError } from './failure.ts';
export { beginMarker, endMarker, hasOwnedRegion, replaceOwnedRegion } from './markers.ts';
export type { SystemPartLike } from './markers.ts';
export type {
  AgentEditor,
  AgentRecord,
  AgentSummary,
  ContextEvent,
  ModelRefLike,
  ModelSummary,
  PromptEvent,
  Registration,
  RuntimeHost,
  RuntimeOptionsInput,
  SessionSummary,
  ToolRecord,
  ToolShape,
} from './port.ts';

type Options =
  | { readonly kind: 'valid'; readonly definition: string; readonly logFile?: string }
  | { readonly kind: 'invalid'; readonly failure: Failure };

const OPTION_KEYS: readonly string[] = ['definition', 'logFile', 'enabled'];

function validateOptions(raw: RuntimeOptionsInput): Options {
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return { kind: 'invalid', failure: { code: 'options-invalid', slot: 'enabled' } };
  }
  for (const key of Object.keys(raw)) {
    if (!OPTION_KEYS.includes(key)) {
      return { kind: 'invalid', failure: { code: 'options-invalid', slot: key } };
    }
  }
  if (typeof raw.definition !== 'string' || raw.definition.length === 0) {
    return { kind: 'invalid', failure: { code: 'options-invalid', slot: 'definition' } };
  }
  const logFile = raw.logFile;
  if (logFile !== undefined && (typeof logFile !== 'string' || logFile.length === 0)) {
    return { kind: 'invalid', failure: { code: 'options-invalid', slot: 'logFile' } };
  }
  return { kind: 'valid', definition: raw.definition, logFile };
}

function managedSignature(definition: Definition): string {
  return Object.keys(definition.agents).sort().join('\n');
}

function modelRefString(model: ModelRefLike): string {
  return `${model.providerID}/${model.id}`;
}

/** Source shapes that may name a file read by the core renderer. */
type DeclaredSource = string | { readonly file: string } | { readonly runtime: string };

/** Definition path plus every file source declared by policies and rules, matching or not. */
function collectInputPaths(definition: Definition, definitionPath: string): string[] {
  const paths: string[] = [definitionPath];
  for (const policy of Object.values(definition.agents)) {
    pushPolicySources(paths, definitionPath, policy);
  }
  return paths;
}

function pushPolicySources(paths: string[], definitionPath: string, policy: Policy): void {
  pushSource(paths, definitionPath, policy.template);
  pushSlotSources(paths, definitionPath, policy.slots);
  for (const rule of policy.rules ?? []) {
    pushSource(paths, definitionPath, rule.template);
    pushSlotSources(paths, definitionPath, rule.slots);
  }
}

function pushSlotSources(
  paths: string[],
  definitionPath: string,
  slots: Readonly<Record<string, DeclaredSource>> | undefined,
): void {
  if (slots === undefined) return;
  for (const source of Object.values(slots)) pushSource(paths, definitionPath, source);
}

function pushSource(paths: string[], definitionPath: string, source: DeclaredSource | undefined): void {
  if (source === undefined || typeof source === 'string' || !('file' in source)) return;
  paths.push(resolveSourcePath(definitionPath, source.file));
}

export class PromptsRuntime {
  readonly generation: string;
  private readonly host: RuntimeHost;
  private readonly raw: RuntimeOptionsInput;
  private log: DiagnosticsLog;
  private definitionPath: string | undefined;
  private logPath: string | undefined;
  /** Absolute inputs the log may never append to: definition plus declared file sources. */
  private protectedInputs: string[] = [];
  private invalid: Failure | undefined;
  private readonly registrations: Registration[] = [];
  private transform: Registration | undefined;
  private registering: Promise<void> | undefined;
  private signature: string | undefined;
  /** Prepared wrapped seeds per managed agent; only successful admissions write here. */
  private readonly seeds = new Map<string, string>();
  /** Seeds observed as applied by the transform during the last rebuild. */
  private readonly applied = new Map<string, string>();
  private disposed = false;

  constructor(host: RuntimeHost, raw: RuntimeOptionsInput) {
    this.host = host;
    this.raw = raw;
    this.generation = randomUUID();
    this.log = new DiagnosticsLog(undefined);
  }

  /** Registers the guards, or returns a no-op cleanup when `enabled` is false. */
  async start(): Promise<() => Promise<void>> {
    if (this.raw.enabled === false) return async () => {};
    const options = validateOptions(this.raw);
    if (options.kind === 'invalid') {
      this.invalid = options.failure;
      this.registrations.push(await this.host.onPrompt(this.promptGuard));
      this.registrations.push(await this.host.onContext(this.contextGuard));
      this.log.write({ phase: 'startup', code: options.failure.code, slot: options.failure.slot });
      return this.dispose;
    }
    const definitionPath = resolvePath(this.host.directory, options.definition);
    this.definitionPath = definitionPath;
    this.logPath =
      options.logFile === undefined
        ? join(dirname(definitionPath), 'opencode-prompts.log')
        : resolvePath(this.host.directory, options.logFile);
    this.log = new DiagnosticsLog(this.logPath, () => this.protectedInputs);
    try {
      this.protect([definitionPath]);
      this.load();
      this.log.write({ phase: 'startup', code: 'ok', file: definitionPath });
    } catch (error) {
      const failure = toFailure(error);
      this.log.write({ phase: 'startup', code: failure.code, ...failureFields(failure) });
      if (failure.code === 'options-invalid') {
        this.invalid = failure;
        this.registrations.push(await this.host.onPrompt(this.promptGuard));
        this.registrations.push(await this.host.onContext(this.contextGuard));
        return this.dispose;
      }
    }
    this.registrations.push(await this.host.onPrompt(this.prompt));
    this.registrations.push(await this.host.onContext(this.context));
    return this.dispose;
  }

  private load(): Definition {
    const path = this.definitionPath;
    if (path === undefined) throw new AdapterError({ code: 'options-invalid' });
    const definition = loadDefinition(path);
    this.protect(collectInputPaths(definition, path));
    return definition;
  }

  /**
   * Adds freshly declared inputs to the protected set, then rejects a log path
   * that aliases any of them so diagnostics can never corrupt a source.
   */
  private protect(paths: readonly string[]): void {
    for (const path of paths) {
      if (!this.protectedInputs.includes(path)) this.protectedInputs.push(path);
    }
    const logPath = this.logPath;
    if (logPath !== undefined && this.protectedInputs.some((input) => sameFile(logPath, input))) {
      throw new AdapterError({ code: 'options-invalid', slot: 'logFile' });
    }
  }

  private diagnosticsTarget(): string | undefined {
    const logPath = this.logPath;
    if (logPath === undefined) return undefined;
    return this.protectedInputs.some((input) => sameFile(logPath, input)) ? undefined : logPath;
  }

  private blocked(failure: Failure): PromptsBlockedError {
    return new PromptsBlockedError(failure, this.diagnosticsTarget());
  }

  private readonly promptGuard = async (): Promise<never> => this.reject('admission');

  private readonly contextGuard = async (): Promise<never> => this.reject('context');

  private reject(phase: LogPhase): never {
    const failure: Failure = this.invalid ?? { code: 'options-invalid' };
    this.log.write({ phase, code: failure.code, slot: failure.slot });
    throw this.blocked(failure);
  }

  /** Admission preflight: resolve the effective agent/model, validate and seed before admission. */
  private readonly prompt = async (event: PromptEvent): Promise<void> => {
    let agentID: string | undefined;
    let model: string | undefined;
    try {
      const definition = this.load();
      const signature = managedSignature(definition);
      const resolved = await this.resolve(event.sessionID);
      agentID = resolved.agentID;
      model = modelRefString(resolved.model);
      const current = resolved.agents.find((agent) => agent.id === resolved.agentID);
      if (!Object.hasOwn(definition.agents, resolved.agentID)) {
        if (hasMarkerNamespace(current?.system)) {
          await this.ensureRegistered(signature, true);
          const restored = (await this.host.listAgents()).find((agent) => agent.id === resolved.agentID);
          if (hasMarkerNamespace(restored?.system)) throw new AdapterError({ code: 'unmanaged-marked', slot: 'system' });
          this.log.write({ phase: 'admission', code: 'restored', session: event.sessionID, agent: agentID, model });
          return;
        }
        this.log.write({ phase: 'admission', code: 'unmanaged', session: event.sessionID, agent: agentID, model });
        return;
      }
      if (current === undefined) throw new AdapterError({ code: 'agent-missing' });
      const prepared = preparePrompt(definition, this.definitionFile(), resolved.agentID, modelRefString(resolved.model));
      if (prepared === undefined) {
        this.log.write({ phase: 'admission', code: 'unmanaged', session: event.sessionID, agent: agentID, model });
        return;
      }
      const snapshot = await this.toolSnapshot();
      let body: string;
      try {
        body = prepared.render({ agent: resolved.agentID, model: resolved.model, tools: snapshot.tools });
      } catch (error) {
        if (isRuntimeValue(error) && snapshot.rejected !== 0) {
          throw new AdapterError({
            code: 'tools-unavailable',
            slot: error.slot,
            count: snapshot.rejected >= 0 ? snapshot.rejected : undefined,
          });
        }
        throw error;
      }
      const seed = wrapSeed(this.generation, resolved.agentID, body);
      this.seeds.set(resolved.agentID, seed);
      await this.ensureRegistered(signature);
      if (this.applied.get(resolved.agentID) !== seed) await this.host.reloadAgents();
      const refreshed = (await this.host.listAgents()).find((agent) => agent.id === resolved.agentID);
      if (refreshed === undefined) throw new AdapterError({ code: 'agent-missing' });
      if (!hasOwnedRegion(refreshed.system, this.generation, resolved.agentID)) {
        throw new AdapterError({ code: 'seed-missing', slot: 'system' });
      }
      this.log.write({
        phase: 'admission',
        code: 'ok',
        session: event.sessionID,
        agent: agentID,
        model,
        count: this.seeds.size,
      });
    } catch (error) {
      const failure = toFailure(error);
      this.log.write({
        phase: 'admission',
        code: failure.code,
        session: event.sessionID,
        agent: agentID,
        model,
        ...failureFields(failure),
      });
      throw this.blocked(failure);
    }
  };

  /** Per-request render with the authoritative agent/model/tools, before model dispatch. */
  private readonly context = async (event: ContextEvent): Promise<void> => {
    const session = event.sessionID;
    const agent = event.agent;
    const model = modelRefString(event.model);
    try {
      const definition = this.load();
      const prepared = preparePrompt(definition, this.definitionFile(), event.agent, modelRefString(event.model));
      if (prepared === undefined) {
        if (hasMarkerNamespace(systemText(event.system))) {
          throw new AdapterError({ code: 'unmanaged-marked', slot: 'system' });
        }
        this.log.write({ phase: 'context', code: 'unmanaged', session, agent, model });
        return;
      }
      const body = prepared.render({ agent: event.agent, model: event.model, tools: event.tools });
      replaceOwnedRegion(event.system, this.generation, event.agent, body);
      this.log.write({ phase: 'context', code: 'ok', session, agent, model });
    } catch (error) {
      const failure = toFailure(error);
      this.log.write({
        phase: 'context',
        code: failure.code,
        session,
        agent,
        model,
        ...failureFields(failure),
      });
      throw this.blocked(failure);
    }
  };

  private definitionFile(): string {
    const path = this.definitionPath;
    if (path === undefined) throw new AdapterError({ code: 'options-invalid' });
    return path;
  }

  private async resolve(
    sessionID: string,
  ): Promise<{ agentID: string; model: ModelRefLike; agents: readonly AgentSummary[] }> {
    const [session, agents] = await Promise.all([this.host.getSession(sessionID), this.host.listAgents()]);
    const agentID = session?.agent ?? agents[0]?.id;
    if (agentID === undefined) throw new AdapterError({ code: 'agent-unresolved' });
    const model = session?.model ?? (await this.defaultModel());
    if (model === undefined) throw new AdapterError({ code: 'model-unresolved' });
    return { agentID, model, agents };
  }

  /** Mirrors the native fallback: default model, else first packaged text model. */
  private async defaultModel(): Promise<ModelRefLike | undefined> {
    const preferred = await this.host.defaultModel();
    if (preferred !== undefined && Boolean(preferred.package)) {
      return { id: preferred.id, providerID: preferred.providerID };
    }
    const models: readonly ModelSummary[] = await this.host.listModels();
    const match = models.find(
      (model) => Boolean(model.package) && model.capabilities?.input.includes('text') === true,
    );
    return match === undefined ? undefined : { id: match.id, providerID: match.providerID };
  }

  private async toolSnapshot(): Promise<ToolSnapshot> {
    try {
      return snapshotTools(await this.host.listTools());
    } catch {
      return { rejected: -1 };
    }
  }

  /**
   * Registers the late seed transform once, then reloads only when the managed
   * agent set changed (pruning removed seeds) or a caller forces a restore.
   */
  private async ensureRegistered(signature: string, force = false): Promise<void> {
    if (this.transform === undefined) {
      const pending = this.registering ?? this.register(signature);
      this.registering = pending;
      try {
        await pending;
      } finally {
        if (this.registering === pending) this.registering = undefined;
      }
    }
    if (this.transform === undefined) return;
    if (force) {
      this.signature = signature;
      this.prune(signature);
      await this.host.reloadAgents();
      return;
    }
    if (signature !== this.signature) {
      this.signature = signature;
      if (this.prune(signature) > 0) await this.host.reloadAgents();
    }
  }

  private register(signature: string): Promise<void> {
    return (async () => {
      this.transform = await this.host.transformAgents(this.applySeeds);
      this.registrations.push(this.transform);
      this.signature = signature;
      await this.host.reloadAgents();
    })();
  }

  /** Drops prepared seeds for agents the current definition no longer manages. */
  private prune(signature: string): number {
    const managed = new Set(signature === '' ? [] : signature.split('\n'));
    let removed = 0;
    for (const id of [...this.seeds.keys()]) {
      if (managed.has(id)) continue;
      this.seeds.delete(id);
      this.applied.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Pure map application over existing roles: no definition IO, no rendering. */
  private readonly applySeeds = (editor: AgentEditor): void => {
    for (const agent of editor.list()) {
      const seed = this.seeds.get(agent.id);
      if (seed === undefined) continue;
      editor.update(agent.id, (target) => {
        target.system = seed;
      });
      this.applied.set(agent.id, seed);
    }
  };

  private readonly dispose = async (): Promise<void> => {
    if (this.disposed) return;
    this.disposed = true;
    for (const registration of this.registrations) {
      try {
        await registration.dispose();
      } catch (error) {
        this.log.write({ phase: 'cleanup', code: toFailure(error).code });
      }
    }
    this.registrations.length = 0;
    this.seeds.clear();
    this.applied.clear();
    if (this.transform !== undefined) {
      try {
        await this.host.reloadAgents();
      } catch (error) {
        this.log.write({ phase: 'cleanup', code: toFailure(error).code });
      }
      this.transform = undefined;
    }
    this.log.write({ phase: 'cleanup', code: 'ok' });
  };
}

function systemText(system: readonly { readonly text: string }[]): string {
  return system.map((part) => part.text).join('\n');
}
