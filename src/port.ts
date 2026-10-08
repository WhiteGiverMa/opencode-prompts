/**
 * Host port for the opencode-prompts runtime.
 *
 * The v2 server adapter implements this narrow view; unit tests drive a fake
 * implementation. Keeping the port free of host framework types is what makes
 * the runtime testable without casting stubs into the plugin context.
 */
import type { SystemPartLike } from './markers.ts';

export interface RuntimeOptionsInput {
  readonly definition?: unknown;
  readonly logFile?: unknown;
  readonly enabled?: unknown;
  /** Every host option reaches validation; unknown keys are rejected by name. */
  readonly [key: string]: unknown;
}

export interface ModelRefLike {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

export interface ModelSummary extends ModelRefLike {
  readonly package?: string;
  readonly capabilities?: { readonly input: readonly string[] } | undefined;
}

export interface AgentSummary {
  readonly id: string;
  readonly model?: ModelRefLike;
  readonly system?: string;
}

export interface SessionSummary {
  readonly agent?: string;
  readonly model?: ModelRefLike;
}

export interface ToolRecord {
  readonly name: string;
  readonly description: string;
  readonly input?: unknown;
}

export interface ToolShape {
  readonly description: string;
  readonly input: unknown;
}

export interface AgentRecord {
  readonly id: string;
  readonly model?: ModelRefLike;
  system?: string;
}

export interface AgentEditor {
  list(): readonly AgentRecord[];
  update(id: string, update: (agent: AgentRecord) => void): void;
}

export interface Registration {
  dispose(): void | Promise<void>;
}

export interface PromptEvent {
  readonly sessionID: string;
}

export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: ModelRefLike;
  system: SystemPartLike[];
  readonly tools: Readonly<Record<string, ToolShape>>;
}

export interface RuntimeHost {
  readonly directory: string;
  transformAgents(callback: (editor: AgentEditor) => void): Promise<Registration>;
  reloadAgents(): Promise<void>;
  onPrompt(callback: (event: PromptEvent) => Promise<void> | void): Promise<Registration>;
  onContext(callback: (event: ContextEvent) => Promise<void> | void): Promise<Registration>;
  listAgents(): Promise<readonly AgentSummary[]>;
  getSession(sessionID: string): Promise<SessionSummary | undefined>;
  defaultModel(): Promise<ModelSummary | undefined>;
  listModels(): Promise<readonly ModelSummary[]>;
  listTools(): Promise<readonly ToolRecord[]>;
}
