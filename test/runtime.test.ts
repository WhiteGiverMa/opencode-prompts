import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Schema } from 'effect';
import { DiagnosticsLog } from '../src/log.ts';
import { resolvePath } from '../src/paths.ts';
import {
  PromptsRuntime,
  beginMarker,
  endMarker,
  type AgentEditor,
  type ContextEvent,
  type ModelRefLike,
  type ModelSummary,
  type PromptEvent,
  type Registration,
  type RuntimeHost,
  type RuntimeOptionsInput,
  type SessionSummary,
  type ToolRecord,
} from '../src/runtime.ts';

interface FakeAgent {
  readonly id: string;
  readonly model?: ModelRefLike;
  system?: string;
}

const OPENAI: ModelRefLike = { id: 'gpt-x', providerID: 'openai' };
const ANTHROPIC: ModelRefLike = { id: 'claude-y', providerID: 'anthropic' };

class FakeHost implements RuntimeHost {
  readonly directory: string;
  readonly agents = new Map<string, FakeAgent>();
  readonly configuredSystem = new Map<string, string>();
  readonly transforms: Array<(editor: AgentEditor) => void> = [];
  readonly prompts: Array<(event: PromptEvent) => Promise<void> | void> = [];
  readonly contexts: Array<(event: ContextEvent) => Promise<void> | void> = [];
  readonly sessions = new Map<string, SessionSummary>();
  readonly modelList: ModelSummary[] = [];
  preferredModel: ModelSummary | undefined;
  tools: readonly ToolRecord[] = [];
  toolsFailure = false;
  sessionError: Error | undefined;
  reloads = 0;
  disposals = 0;
  private readonly toolGates: Array<Promise<void>> = [];
  private readonly transformGates: Array<Promise<void>> = [];

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Parks the next tool-inventory call until the returned release runs. */
  blockTools(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    this.toolGates.push(gate);
    return release;
  }

  /** Parks the next transform registration until the returned release runs. */
  holdNextTransform(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    this.transformGates.push(gate);
    return release;
  }

  role(id: string, model?: ModelRefLike): void {
    this.agents.set(id, { id, model });
  }

  /** Simulates the internal post plugin that creates roles and writes configured systems. */
  post(systemFor: (id: string) => string | undefined): void {
    this.transforms.push((editor) => {
      for (const agent of editor.list()) {
        const system = systemFor(agent.id);
        if (system !== undefined) {
          editor.update(agent.id, (target) => {
            target.system = system;
          });
        }
      }
    });
  }

  transformAgents(callback: (editor: AgentEditor) => void): Promise<Registration> {
    this.transforms.push(callback);
    const gate = this.transformGates.shift();
    const done = () =>
      this.registration(() => {
        const index = this.transforms.indexOf(callback);
        if (index !== -1) this.transforms.splice(index, 1);
      });
    return gate === undefined ? Promise.resolve(done()) : gate.then(done);
  }

  reloadAgents(): Promise<void> {
    this.reloads += 1;
    this.rebuild();
    return Promise.resolve();
  }

  onPrompt(callback: (event: PromptEvent) => Promise<void> | void): Promise<Registration> {
    this.prompts.push(callback);
    return Promise.resolve(this.registration(() => {
      const index = this.prompts.indexOf(callback);
      if (index !== -1) this.prompts.splice(index, 1);
    }));
  }

  onContext(callback: (event: ContextEvent) => Promise<void> | void): Promise<Registration> {
    this.contexts.push(callback);
    return Promise.resolve(this.registration(() => {
      const index = this.contexts.indexOf(callback);
      if (index !== -1) this.contexts.splice(index, 1);
    }));
  }

  listAgents(): Promise<readonly FakeAgent[]> {
    return Promise.resolve([...this.agents.values()].map((agent) => ({ ...agent })));
  }

  getSession(sessionID: string): Promise<SessionSummary | undefined> {
    if (this.sessionError !== undefined) return Promise.reject(this.sessionError);
    return Promise.resolve(this.sessions.get(sessionID));
  }

  defaultModel(): Promise<ModelSummary | undefined> {
    return Promise.resolve(this.preferredModel);
  }

  listModels(): Promise<readonly ModelSummary[]> {
    return Promise.resolve(this.modelList);
  }

  listTools(): Promise<readonly ToolRecord[]> {
    const gate = this.toolGates.shift();
    if (gate !== undefined) return gate.then(() => this.toolResult());
    return this.toolResult();
  }

  private toolResult(): Promise<readonly ToolRecord[]> {
    return this.toolsFailure ? Promise.reject(new Error('tool inventory unavailable')) : Promise.resolve(this.tools);
  }

  async firePrompt(sessionID: string): Promise<void> {
    for (const hook of [...this.prompts]) await hook({ sessionID });
  }

  async fireContext(event: ContextEvent): Promise<string> {
    for (const hook of [...this.contexts]) await hook(event);
    return systemText(event.system);
  }

  seedOf(agentID: string): string {
    return this.agents.get(agentID)?.system ?? '';
  }

  contextOf(sessionID: string, agentID: string, model: ModelRefLike, prefix = '', suffix = ''): ContextEvent {
    const seed = this.seedOf(agentID);
    return {
      sessionID,
      agent: agentID,
      model,
      system: [{ text: `${prefix}${seed}${suffix}` }],
      tools: {},
    };
  }

  private registration(remove: () => void): Registration {
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        remove();
        this.disposals += 1;
      },
    };
  }

  private rebuild(): void {
    const next = new Map<string, FakeAgent>();
    for (const [id, agent] of this.agents) next.set(id, { id, model: agent.model });
    const editor: AgentEditor = {
      list: () => [...next.values()],
      update: (id, update) => {
        const agent = next.get(id);
        if (agent === undefined) throw new Error(`update on missing role ${id}`);
        const view: FakeAgent = { ...agent };
        update(view);
        agent.system = view.system;
      },
    };
    for (const transform of [...this.transforms]) transform(editor);
    this.agents.clear();
    for (const [id, agent] of next) this.agents.set(id, agent);
  }
}

function systemText(system: readonly { readonly text: string }[]): string {
  return system.map((part) => part.text).join('\n');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-prompts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function definition(agents: string): string {
  return `{ "version": 1, "agents": { ${agents} } }`;
}

function buildPolicy(template: string): string {
  return `"build": { "template": ${JSON.stringify(template)} }`;
}

async function start(
  host: FakeHost,
  options: RuntimeOptionsInput = { definition: 'prompts.jsonc' },
): Promise<{ runtime: PromptsRuntime; cleanup: () => Promise<void> }> {
  const runtime = new PromptsRuntime(host, options);
  const cleanup = await runtime.start();
  return { runtime, cleanup };
}

describe('startup and options', () => {
  test('enabled false registers nothing, reads nothing and writes no log', async () => {
    const host = new FakeHost(dir);
    const { cleanup } = await start(host, { definition: 'missing.jsonc', enabled: false });
    expect(host.prompts.length).toBe(0);
    expect(host.contexts.length).toBe(0);
    expect(host.transforms.length).toBe(0);
    expect(existsSync(join(dir, 'missing.jsonc'))).toBe(false);
    expect(existsSync(join(dir, 'opencode-prompts.log'))).toBe(false);
    await cleanup();
  });

  test('enabled false ignores extra fields and definition absence with zero IO', async () => {
    const host = new FakeHost(dir);
    const { cleanup } = await start(host, {
      enabled: false,
      enabeld: false,
      definition: 'missing.jsonc',
      extra: { nested: true },
    });
    expect(host.prompts.length).toBe(0);
    expect(host.contexts.length).toBe(0);
    expect(host.transforms.length).toBe(0);
    expect(existsSync(join(dir, 'missing.jsonc'))).toBe(false);
    expect(existsSync(join(dir, 'opencode-prompts.log'))).toBe(false);
    await cleanup();
  });

  test('an unknown option key blocks with its name and never echoes the value', async () => {
    const host = new FakeHost(dir);
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { cleanup } = await start(host, { definition: 'prompts.jsonc', enabeld: false });
      expect(host.prompts.length).toBe(1);
      expect(host.contexts.length).toBe(1);
      await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
      await expect(
        host.fireContext({ sessionID: 's', agent: 'build', model: OPENAI, system: [{ text: '' }], tools: {} }),
      ).rejects.toMatchObject({ code: 'options-invalid' });
      const emitted = spy.mock.calls.map((call) => String(call[0])).join('');
      const startup = emitted.split('\n').find((line) => line.includes('"phase":"startup"'));
      expect(startup).toContain('"slot":"enabeld"');
      expect(startup).not.toContain('false');
      await cleanup();
    } finally {
      spy.mockRestore();
    }
  });

  test('invalid options keep blocking guards registered', async () => {
    const host = new FakeHost(dir);
    const { cleanup } = await start(host, { definition: 42 });
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
    await expect(
      host.fireContext({ sessionID: 's', agent: 'build', model: OPENAI, system: [{ text: '' }], tools: {} }),
    ).rejects.toMatchObject({ code: 'options-invalid' });
    expect(host.prompts.length).toBe(1);
    expect(host.contexts.length).toBe(1);
    await cleanup();
    expect(host.prompts.length).toBe(0);
    expect(host.contexts.length).toBe(0);
  });

  test('missing definition at startup blocks then recovers when repaired', async () => {
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'definition-read' });
    write('prompts.jsonc', definition(buildPolicy('RECOVERED')));
    await host.firePrompt('s');
    const text = await host.fireContext(host.contextOf('s', 'build', OPENAI));
    expect(text).toContain('RECOVERED');
    await cleanup();
  });
});

describe('input protection', () => {
  test('a definition named like the default log is rejected without touching its bytes', async () => {
    const path = write('opencode-prompts.log', definition(buildPolicy('BODY')));
    const before = readFileSync(path);
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { cleanup } = await start(host, { definition: 'opencode-prompts.log' });
      expect(host.prompts.length).toBe(1);
      expect(host.contexts.length).toBe(1);
      await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
      await expect(
        host.fireContext({ sessionID: 's', agent: 'build', model: OPENAI, system: [{ text: '' }], tools: {} }),
      ).rejects.toMatchObject({ code: 'options-invalid' });
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(spy.mock.calls.map((call) => String(call[0])).join('')).toContain('"code":"options-invalid"');
      await cleanup();
    } finally {
      spy.mockRestore();
    }
  });

  test('a logFile that names the definition is rejected without touching its bytes', async () => {
    const path = write('prompts.jsonc', definition(buildPolicy('BODY')));
    const before = readFileSync(path);
    const absolute = new FakeHost(dir);
    absolute.role('build');
    const relative = new FakeHost(dir);
    relative.role('build');
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = await start(absolute, { definition: 'prompts.jsonc', logFile: path });
      await expect(absolute.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
      const second = await start(relative, { definition: 'prompts.jsonc', logFile: 'prompts.jsonc' });
      await expect(relative.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
      expect(readFileSync(path).equals(before)).toBe(true);
      await first.cleanup();
      await second.cleanup();
    } finally {
      spy.mockRestore();
    }
  });

  test('declared template and slot sources, including rule sources, never receive diagnostics', async () => {
    const variants = [
      { source: 'policy-template.md', policy: '"build": { "template": { "file": "policy-template.md" } }' },
      {
        source: 'policy-slot.txt',
        policy: '"build": { "template": "{{v}}", "slots": { "v": { "file": "policy-slot.txt" } } }',
      },
      {
        source: 'rule-template.md',
        policy:
          '"build": { "template": "BASE", "rules": [ { "models": ["openai/*"], "template": { "file": "rule-template.md" } } ] }',
      },
      {
        source: 'rule-slot.txt',
        policy:
          '"build": { "template": "{{v}}", "slots": { "v": "base" }, "rules": [ { "models": ["openai/*"], "slots": { "v": { "file": "rule-slot.txt" } } } ] }',
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const sourcePath = write(variant.source, `SOURCE ${index}`);
      const definitionPath = write(`collision-${index}.jsonc`, definition(variant.policy));
      const sourceBytes = readFileSync(sourcePath);
      const definitionBytes = readFileSync(definitionPath);
      const host = new FakeHost(dir);
      host.role('build');
      host.sessions.set('s', { agent: 'build', model: OPENAI });
      const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { cleanup } = await start(host, { definition: `collision-${index}.jsonc`, logFile: variant.source });
        await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
        expect(readFileSync(sourcePath).equals(sourceBytes)).toBe(true);
        expect(readFileSync(definitionPath).equals(definitionBytes)).toBe(true);
        expect(spy.mock.calls.map((call) => String(call[0])).join('')).toContain('"code":"options-invalid"');
        await cleanup();
      } finally {
        spy.mockRestore();
      }
    }
  });

  test('symlink and hardlink aliases of input files reject the log path', async () => {
    const definitionPath = write('prompts.jsonc', definition(buildPolicy('BODY')));
    const definitionBytes = readFileSync(definitionPath);
    symlinkSync(definitionPath, join(dir, 'definition-alias.log'));

    write('template.md', 'TEMPLATE CONTENT');
    const templatePath = join(dir, 'template.md');
    const templateBytes = readFileSync(templatePath);
    symlinkSync(templatePath, join(dir, 'template-alias.log'));
    linkSync(templatePath, join(dir, 'template-hard.log'));
    write('hard.jsonc', definition(`"build": { "template": { "file": "template.md" } }`));

    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const viaDefinition = new FakeHost(dir);
      viaDefinition.role('build');
      const first = await start(viaDefinition, { definition: 'prompts.jsonc', logFile: 'definition-alias.log' });
      await expect(viaDefinition.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });

      const viaSymlink = new FakeHost(dir);
      viaSymlink.role('build');
      const second = await start(viaSymlink, { definition: 'hard.jsonc', logFile: 'template-alias.log' });
      await expect(viaSymlink.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });

      const viaHardlink = new FakeHost(dir);
      viaHardlink.role('build');
      const third = await start(viaHardlink, { definition: 'hard.jsonc', logFile: 'template-hard.log' });
      await expect(viaHardlink.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });

      expect(readFileSync(definitionPath).equals(definitionBytes)).toBe(true);
      expect(readFileSync(templatePath).equals(templateBytes)).toBe(true);
      await first.cleanup();
      await second.cleanup();
      await third.cleanup();
    } finally {
      spy.mockRestore();
    }
  });

  test('a dangling symlink log alias of a missing definition is rejected', async () => {
    symlinkSync(join(dir, 'prompts.jsonc'), join(dir, 'dangling.log'));
    const host = new FakeHost(dir);
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { cleanup } = await start(host, { definition: 'prompts.jsonc', logFile: 'dangling.log' });
      await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
      expect(existsSync(join(dir, 'prompts.jsonc'))).toBe(false);
      await cleanup();
    } finally {
      spy.mockRestore();
    }
  });

  test('a hot definition edit that collides the log with a declared source blocks without appending', async () => {
    write('prompts.jsonc', definition(buildPolicy('BODY')));
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host, { definition: 'prompts.jsonc', logFile: 'hot.log' });
    await host.firePrompt('s');
    const logPath = join(dir, 'hot.log');
    const before = readFileSync(logPath, 'utf8');
    write('prompts.jsonc', definition(`"build": { "template": { "file": "hot.log" } }`));
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'options-invalid' });
    expect(readFileSync(logPath, 'utf8')).toBe(before);
    await cleanup();
  });
});

describe('role selection and seeding', () => {
  test('default role and native model fallback are used for an unset session', async () => {
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "agent={{agent}} model={{model}}", "slots": {
          "agent": { "runtime": "agent" }, "model": { "runtime": "model" } } }`,
      ),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.role('plan');
    host.sessions.set('s', {});
    host.modelList.push({ id: 'first-text', providerID: 'pkg', package: 'pkg/provider', capabilities: { input: ['text'] } });
    const { runtime, cleanup } = await start(host);
    await host.firePrompt('s');
    const seed = host.seedOf('build');
    expect(seed.startsWith(beginMarker(runtime.generation, 'build'))).toBe(true);
    expect(seed).toContain('agent=build');
    expect(seed).toContain('"id": "first-text"');
    expect(host.seedOf('plan')).toBe('');
    await cleanup();
  });

  test('preferred packaged default model wins over the first text model', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{model}}", "slots": { "model": { "runtime": "model" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build' });
    host.preferredModel = { id: 'preferred', providerID: 'pkg', package: 'pkg/provider' };
    host.modelList.push({ id: 'other', providerID: 'pkg', package: 'pkg/provider', capabilities: { input: ['text'] } });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('build')).toContain('"id": "preferred"');
    await cleanup();
  });

  test('a custom role configured by the post plugin keeps the owned seed', async () => {
    write('prompts.jsonc', definition(`"meidocho": { "template": "OWNED" }`));
    const host = new FakeHost(dir);
    host.role('meidocho');
    host.configuredSystem.set('meidocho', 'CONFIG SYSTEM');
    host.post((id) => host.configuredSystem.get(id));
    host.sessions.set('s', { agent: 'meidocho', model: ANTHROPIC });
    const { runtime, cleanup } = await start(host);
    await host.firePrompt('s');
    const seed = host.seedOf('meidocho');
    expect(host.transforms.length).toBe(2);
    expect(seed.startsWith(beginMarker(runtime.generation, 'meidocho'))).toBe(true);
    expect(seed).toContain('OWNED');
    expect(seed).not.toBe('CONFIG SYSTEM');
    await cleanup();
  });

  test('an unmanaged role is never touched or created', async () => {
    write('prompts.jsonc', definition(buildPolicy('OWNED')));
    const host = new FakeHost(dir);
    host.role('build');
    host.role('plan');
    host.sessions.set('s', { agent: 'plan', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.transforms.length).toBe(0);
    expect(host.seedOf('plan')).toBe('');
    expect(host.agents.size).toBe(2);
    await cleanup();
  });

  test('a managed role missing from the host blocks instead of being created', async () => {
    write('prompts.jsonc', definition(`"ghost": { "template": "GHOST" }`));
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'ghost', model: OPENAI });
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'agent-missing' });
    expect(host.agents.size).toBe(1);
    await cleanup();
  });
});

describe('render freshness and replacement scope', () => {
  test('sessions with different models select different rules without stale renders', async () => {
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "DEFAULT", "rules": [
          { "models": ["openai/*"], "template": "OPENAI BODY" },
          { "models": ["anthropic/*"], "template": "ANTHROPIC BODY" }
        ] }`,
      ),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('one', { agent: 'build', model: OPENAI });
    host.sessions.set('two', { agent: 'build', model: ANTHROPIC });
    const { cleanup } = await start(host);
    await host.firePrompt('one');
    await host.firePrompt('two');
    const first = await host.fireContext(host.contextOf('one', 'build', OPENAI));
    const second = await host.fireContext(host.contextOf('two', 'build', ANTHROPIC));
    expect(first).toContain('OPENAI BODY');
    expect(first).not.toContain('ANTHROPIC BODY');
    expect(second).toContain('ANTHROPIC BODY');
    await cleanup();
  });

  test('context replaces only the owned body and preserves prefixes, suffixes and other parts', async () => {
    write('prompts.jsonc', definition(buildPolicy('BODY ONE')));
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { runtime, cleanup } = await start(host);
    await host.firePrompt('s');
    write('prompts.jsonc', definition(buildPolicy('BODY TWO')));
    const prefix = 'HOST PREFIX\n';
    const suffix = '\nHOST SUFFIX';
    const event: ContextEvent = {
      sessionID: 's',
      agent: 'build',
      model: OPENAI,
      system: [{ text: `${prefix}${host.seedOf('build')}${suffix}` }, { text: 'SECOND PART' }],
      tools: {},
    };
    await host.fireContext(event);
    const expected = `${prefix}${beginMarker(runtime.generation, 'build')}\nBODY TWO\n${endMarker(runtime.generation, 'build')}${suffix}`;
    expect(event.system[0]?.text).toBe(expected);
    expect(event.system[1]?.text).toBe('SECOND PART');
    await cleanup();
  });

  test('literal braces, dollars and backslashes in slot data stay verbatim', async () => {
    const data = '$& $1 {{evil}} \\d+ \\n';
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "[{{data}}]", "slots": { "data": ${JSON.stringify(data)} } }`,
      ),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    const text = await host.fireContext(host.contextOf('s', 'build', OPENAI));
    expect(text).toContain(`[${data}]`);
    expect(text).toContain('$& $1');
    await cleanup();
  });

  test('template file and definition rule changes take effect on the next request', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": { "file": "body.md" } }`),
    );
    write('body.md', 'FIRST');
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(await host.fireContext(host.contextOf('s', 'build', OPENAI))).toContain('FIRST');
    write('body.md', 'SECOND');
    expect(await host.fireContext(host.contextOf('s', 'build', OPENAI))).toContain('SECOND');
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "DEFAULT", "rules": [ { "models": ["openai/*"], "template": { "file": "rule.md" } } ] }`,
      ),
    );
    write('rule.md', 'RULE BODY');
    expect(await host.fireContext(host.contextOf('s', 'build', OPENAI))).toContain('RULE BODY');
    await cleanup();
  });

  test('invalid definition at startup recovers after repair and logs safely', async () => {
    write('prompts.jsonc', '{ "version": 1, "agents": { "build": { "template": "BROKEN" } ');
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'definition-json' });
    await expect(host.fireContext(host.contextOf('s', 'build', OPENAI))).rejects.toMatchObject({
      code: 'definition-json',
    });
    const logPath = join(dir, 'opencode-prompts.log');
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('"code":"definition-json"');
    expect(log).not.toContain('BROKEN');
    write('prompts.jsonc', definition(buildPolicy('FIXED')));
    await host.firePrompt('s');
    expect(await host.fireContext(host.contextOf('s', 'build', OPENAI))).toContain('FIXED');
    await cleanup();
  });
});

describe('region integrity and removal', () => {
  test('missing, duplicated, reordered or altered regions block', async () => {
    write('prompts.jsonc', definition(buildPolicy('BODY')));
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { runtime, cleanup } = await start(host);
    await host.firePrompt('s');
    const seed = host.seedOf('build');
    const context = (text: string): ContextEvent => ({
      sessionID: 's',
      agent: 'build',
      model: OPENAI,
      system: [{ text }],
      tools: {},
    });
    await expect(host.fireContext(context('no markers here'))).rejects.toMatchObject({ code: 'region-missing' });
    await expect(host.fireContext(context(`${seed}\n${seed}`))).rejects.toMatchObject({ code: 'region-duplicate' });
    await expect(
      host.fireContext(context(`${endMarker(runtime.generation, 'build')}X${beginMarker(runtime.generation, 'build')}`)),
    ).rejects.toMatchObject({ code: 'region-malformed' });
    await expect(
      host.fireContext(context(seed.replace('|begin>>>', '|be gin>>>'))),
    ).rejects.toMatchObject({ code: 'region-malformed' });
    await cleanup();
  });

  test('removing a policy restores the configured native system through reload', async () => {
    write('prompts.jsonc', definition(`${buildPolicy('OWNED')}, "meidocho": { "template": "OWNED MEIDOCHO" }`));
    const host = new FakeHost(dir);
    host.role('build');
    host.role('meidocho');
    host.configuredSystem.set('meidocho', 'CONFIG SYSTEM');
    host.post((id) => host.configuredSystem.get(id));
    host.sessions.set('s', { agent: 'meidocho', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('meidocho')).toContain('OWNED MEIDOCHO');
    write('prompts.jsonc', definition(buildPolicy('OWNED')));
    await host.firePrompt('s');
    expect(host.seedOf('meidocho')).toBe('CONFIG SYSTEM');
    expect(host.seedOf('meidocho')).not.toContain('opencode-prompts');
    await cleanup();
  });

  test('cleanup disposes registrations and restores configured systems', async () => {
    write('prompts.jsonc', definition(`"meidocho": { "template": "OWNED" }`));
    const host = new FakeHost(dir);
    host.role('meidocho');
    host.configuredSystem.set('meidocho', 'CONFIG SYSTEM');
    host.post((id) => host.configuredSystem.get(id));
    host.sessions.set('s', { agent: 'meidocho', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('meidocho')).toContain('OWNED');
    await cleanup();
    expect(host.seedOf('meidocho')).toBe('CONFIG SYSTEM');
    expect(host.prompts.length).toBe(0);
    expect(host.contexts.length).toBe(0);
    expect(host.transforms.length).toBe(1);
    expect(host.disposals).toBeGreaterThanOrEqual(3);
    await cleanup();
  });
});

describe('tools runtime binding', () => {
  test('plain JSON tool inputs seed and render authoritatively', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "TOOLS={{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [{ name: 'read', description: 'Read files', input: { type: 'object' } }];
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('build')).toContain('"read"');
    expect(host.seedOf('build')).toContain('"type": "object"');
    const event = host.contextOf('s', 'build', OPENAI);
    const withTools: ContextEvent = {
      ...event,
      tools: { read: { description: 'Read files', input: { type: 'object' } } },
    };
    const text = await host.fireContext(withTools);
    expect(text).toContain('Read files');
    await cleanup();
  });

  test('__proto__ and constructor tool names stay own entries in the seed', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [
      { name: '__proto__', description: 'proto tool', input: { type: 'object' } },
      { name: 'constructor', description: 'ctor tool', input: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'read', description: 'read tool', input: { type: 'object' } },
    ];
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    const seed = host.seedOf('build');
    const body = seed.slice(seed.indexOf('\n') + 1, seed.lastIndexOf('\n'));
    const tools: Record<string, { description: string }> = JSON.parse(body);
    expect(Object.hasOwn(tools, '__proto__')).toBe(true);
    expect(Object.hasOwn(tools, 'constructor')).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(['__proto__', 'constructor', 'read']);
    expect(tools['__proto__']?.description).toBe('proto tool');
    expect(tools['constructor']?.description).toBe('ctor tool');
    await cleanup();
  });

  test('real Effect schema tool inputs convert through the public schema API', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [
      {
        name: 'read',
        description: 'Read files',
        input: Schema.Struct({ path: Schema.String.annotate({ description: 'File to read' }) }),
      },
    ];
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    const seed = host.seedOf('build');
    expect(seed).toContain('"read"');
    expect(seed).toContain('"path"');
    expect(seed).toContain('File to read');
    await cleanup();
  });

  test('standard json schema converters are accepted', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [
      {
        name: 'custom',
        description: 'Custom tool',
        input: {
          '~standard': {
            version: 1,
            vendor: 'test',
            jsonSchema: { input: () => ({ type: 'object', properties: { x: { type: 'string' } } }) },
          },
        },
      },
    ];
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('build')).toContain('"custom"');
    expect(host.seedOf('build')).toContain('"x"');
    await cleanup();
  });

  test('non-JSON tool inputs are rejected instead of faked', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [{ name: 'read', description: 'Read files', input: { type: 'object', created: new Date() } }];
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'tools-unavailable' });
    await cleanup();
  });

  test('one unconvertible tool rejects the whole seed snapshot', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.tools = [
      { name: 'read', description: 'Read files', input: Schema.Struct({ path: Schema.String }) },
      { name: 'broken', description: 'Broken', input: { nested: new Date() } },
    ];
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'tools-unavailable' });
    await cleanup();
  });

  test('an unavailable tool inventory rejects clearly', async () => {
    write(
      'prompts.jsonc',
      definition(`"build": { "template": "{{tools}}", "slots": { "tools": { "runtime": "tools" } } }`),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.toolsFailure = true;
    const { cleanup } = await start(host);
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'tools-unavailable' });
    await cleanup();
  });
});

describe('concurrency and seed isolation', () => {
  test('an invalid concurrent admission cannot poison a valid model seed', async () => {
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "DEFAULT", "rules": [
          { "models": ["openai/*"], "template": "GPT BODY" },
          { "models": ["moonshot/*"], "template": { "file": "missing.md" } }
        ] }`,
      ),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('valid', { agent: 'build', model: { id: 'gpt-x', providerID: 'openai' } });
    host.sessions.set('invalid', { agent: 'build', model: { id: 'kimi', providerID: 'moonshot' } });
    const { cleanup } = await start(host);

    const release = host.blockTools();
    const valid = host.firePrompt('valid');
    await new Promise((settle) => setTimeout(settle, 0));
    await expect(host.firePrompt('invalid')).rejects.toMatchObject({ code: 'template-file' });
    release();
    await valid;

    const seed = host.seedOf('build');
    expect(seed).toContain('GPT BODY');
    expect(seed).not.toContain('missing.md');
    await cleanup();
  });

  test('concurrent admissions share a single seed transform', async () => {
    write('prompts.jsonc', definition(`"build": { "template": "BUILD" }, "plan": { "template": "PLAN" }`));
    const host = new FakeHost(dir);
    host.role('build');
    host.role('plan');
    host.sessions.set('b', { agent: 'build', model: OPENAI });
    host.sessions.set('p', { agent: 'plan', model: OPENAI });
    const { cleanup } = await start(host);

    const releaseBuildTools = host.blockTools();
    const releasePlanTools = host.blockTools();
    const releaseTransform = host.holdNextTransform();
    const first = host.firePrompt('b');
    const second = host.firePrompt('p');
    await new Promise((settle) => setTimeout(settle, 0));
    releaseBuildTools();
    releasePlanTools();
    await new Promise((settle) => setTimeout(settle, 0));
    releaseTransform();
    await Promise.all([first, second]);

    expect(host.transforms.length).toBe(1);
    expect(host.seedOf('build')).toContain('BUILD');
    expect(host.seedOf('plan')).toContain('PLAN');
    await cleanup();
  });
});

describe('seed metadata lifecycle', () => {
  test('registry rebuilds reuse prepared seeds without reading files', async () => {
    write('prompts.jsonc', definition(`"build": { "template": { "file": "body.md" } }`));
    write('body.md', 'ORIGINAL');
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    const before = host.seedOf('build');
    expect(before).toContain('ORIGINAL');

    rmSync(join(dir, 'body.md'));
    await host.reloadAgents();
    expect(host.seedOf('build')).toBe(before);

    await expect(host.fireContext(host.contextOf('s', 'build', OPENAI))).rejects.toMatchObject({
      code: 'template-file',
    });
    write('body.md', 'REPAIRED');
    const text = await host.fireContext(host.contextOf('s', 'build', OPENAI));
    expect(text).toContain('REPAIRED');
    await cleanup();
  });

  test('an unused broken policy never blocks a valid active role', async () => {
    write(
      'prompts.jsonc',
      definition(
        `"build": { "template": "BUILD BODY" },
         "kimi-role": { "template": { "file": "kimi.md" } }`,
      ),
    );
    const host = new FakeHost(dir);
    host.role('build');
    host.role('kimi-role');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    const { cleanup } = await start(host);
    await host.firePrompt('s');
    expect(host.seedOf('build')).toContain('BUILD BODY');
    expect(host.seedOf('kimi-role')).toBe('');
    const reloads = host.reloads;
    await host.firePrompt('s');
    expect(host.reloads).toBe(reloads);
    await cleanup();
  });
});

describe('path resolution', () => {
  test('~ and ~/ expand like core source references', () => {
    expect(resolvePath('/base', '~')).toBe(homedir());
    expect(resolvePath('/base', '~/prompts.jsonc')).toBe(join(homedir(), 'prompts.jsonc'));
    expect(resolvePath('/base', 'relative.jsonc')).toBe(resolve('/base', 'relative.jsonc'));
    expect(resolvePath('/base', '/absolute/prompts.jsonc')).toBe('/absolute/prompts.jsonc');
  });
});

describe('diagnostics', () => {
  test('writes sanitized JSONL and creates the file private', () => {
    const path = join(dir, 'diag', 'prompts.log');
    mkdirSync(dirname(path), { recursive: true });
    const log = new DiagnosticsLog(path);
    log.write({ phase: 'admission', code: 'definition-json', file: 'x.jsonc', slot: 'body', count: 2 });
    const raw = readFileSync(path, 'utf8').trim();
    const line: unknown = JSON.parse(raw);
    expect(line).toMatchObject({ phase: 'admission', code: 'definition-json', count: 2 });
    expect(raw).not.toContain('{{');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('never renders bodies or unknown error messages', () => {
    const path = join(dir, 'diag.log');
    const log = new DiagnosticsLog(path);
    log.write({ phase: 'admission', code: 'slot-value', slot: 'SECRET_SLOT_NAME' });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('SECRET_SLOT_NAME');
    expect(raw).not.toContain('PROMPT BODY');
  });

  test('falls back to stderr when the log file cannot be written', () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file');
    const log = new DiagnosticsLog(join(blocker, 'prompts.log'));
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      log.write({ phase: 'startup', code: 'options-invalid', slot: 'definition' });
      expect(spy).toHaveBeenCalledTimes(1);
      const first = spy.mock.calls[0]?.[0];
      expect(String(first)).toContain('"code":"options-invalid"');
    } finally {
      spy.mockRestore();
    }
  });

  test('never appends to a protected input and reports through stderr instead', () => {
    const path = join(dir, 'protected.log');
    writeFileSync(path, 'ORIGINAL');
    const log = new DiagnosticsLog(path, () => [path]);
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      log.write({ phase: 'startup', code: 'ok' });
      expect(readFileSync(path, 'utf8')).toBe('ORIGINAL');
      expect(spy.mock.calls.map((call) => String(call[0])).join('')).toContain('"code":"ok"');
    } finally {
      spy.mockRestore();
    }
  });

  test('unknown host failures log a sanitized code and honor the logFile override', async () => {
    write('prompts.jsonc', definition(buildPolicy('BODY')));
    const host = new FakeHost(dir);
    host.role('build');
    host.sessions.set('s', { agent: 'build', model: OPENAI });
    host.sessionError = new Error('SECRET CREDENTIAL VALUE');
    const { cleanup } = await start(host, { definition: 'prompts.jsonc', logFile: 'custom.log' });
    await expect(host.firePrompt('s')).rejects.toMatchObject({ code: 'unexpected' });
    const raw = readFileSync(join(dir, 'custom.log'), 'utf8');
    expect(raw).toContain('"code":"unexpected"');
    expect(raw).not.toContain('SECRET CREDENTIAL VALUE');
    await cleanup();
  });
});

test('root server.js forwards the built server entry', () => {
  const root = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  expect(root).toContain('export { default } from "./dist/server.js"');
});
