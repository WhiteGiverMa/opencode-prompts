import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadDefinition,
  matchesModelPattern,
  parseDefinition,
  preparePrompt,
  PromptsError,
  resolveSourcePath,
  type PromptsErrorCode,
  type RenderData,
} from '../src/core.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-prompts-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function define(agents: unknown, name = 'def.jsonc'): string {
  return write(name, JSON.stringify({ version: 1, agents }));
}

function load(agents: unknown): { definition: ReturnType<typeof loadDefinition>; path: string } {
  const path = define(agents);
  return { definition: loadDefinition(path), path };
}

function prepare(agents: unknown, agentID: string, modelRef: string) {
  const { definition, path } = load(agents);
  return preparePrompt(definition, path, agentID, modelRef);
}

function render(agents: unknown, agentID: string, modelRef: string, data: RenderData = {}): string | undefined {
  return prepare(agents, agentID, modelRef)?.render(data);
}

function reject(run: () => unknown, code: PromptsErrorCode): PromptsError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PromptsError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected PromptsError(${code})`);
}

describe('selection and rendering', () => {
  test('inline policy template with an inline slot renders', () => {
    expect(render({ build: { template: 'A {{topic}} Z', slots: { topic: 'hello' } } }, 'build', 'openai/gpt-5')).toBe(
      'A hello Z',
    );
  });

  test('file template and file slot resolve relative to the definition', () => {
    write('partials/body.md', 'body-{{part}}');
    write('partials/part.md', 'PART');
    const path = define({
      build: { template: { file: '../partials/body.md' }, slots: { part: { file: '../partials/part.md' } } },
    }, 'nested/def.jsonc');
    const prepared = preparePrompt(loadDefinition(path), path, 'build', 'x/y');
    expect(prepared?.render()).toBe('body-PART');
  });

  test('absolute file paths work for template and slots', () => {
    const absolute = write('abs/slot.md', 'ABS');
    expect(render({ build: { template: '{{v}}', slots: { v: { file: absolute } } } }, 'build', 'a/b')).toBe('ABS');
  });

  test('an agent without a policy is unmanaged', () => {
    expect(prepare({ build: { template: 'x' } }, 'general', 'a/b')).toBeUndefined();
  });

  test('a managed policy without a selected template fails', () => {
    const error = reject(() => prepare({ build: { slots: {} } }, 'build', 'a/b'), 'template-missing');
    expect(error.message).toContain('build');
  });

  test('a template without placeholders and without slots renders literally', () => {
    expect(render({ build: { template: 'plain' } }, 'build', 'a/b')).toBe('plain');
  });

  test('matching rule replaces the whole template and keeps other slots', () => {
    expect(
      render(
        {
          build: {
            template: 'base {{x}}',
            slots: { x: 'v' },
            rules: [{ models: ['anthropic/*'], template: 'rule {{x}}' }],
          },
        },
        'build',
        'anthropic/claude-sonnet-4',
      ),
    ).toBe('rule v');
  });

  test('nonmatching model keeps the base template', () => {
    expect(
      render(
        {
          build: {
            template: 'base {{x}}',
            slots: { x: 'v' },
            rules: [{ models: ['anthropic/*'], template: 'rule {{x}}' }],
          },
        },
        'build',
        'openai/gpt-5',
      ),
    ).toBe('base v');
  });

  test('family rule then model refinement apply in declared order', () => {
    const agents = {
      build: {
        template: 'base',
        rules: [
          { models: ['anthropic/*'], template: 'family' },
          { models: ['anthropic/claude-*'], template: 'refined' },
        ],
      },
    };
    expect(render(agents, 'build', 'anthropic/claude-sonnet-4')).toBe('refined');
    expect(render(agents, 'build', 'anthropic/other-model')).toBe('family');
  });

  test('individual slot overrides accumulate and the last matching rule wins', () => {
    const agents = {
      build: {
        template: '{{a}}-{{b}}-{{c}}',
        slots: { a: 'A', b: 'B', c: 'C' },
        rules: [
          { models: ['*/*'], slots: { a: 'R1', b: 'R1B' } },
          { models: ['x/*'], slots: { b: 'R2', c: 'R2C' } },
        ],
      },
    };
    expect(render(agents, 'build', 'x/y')).toBe('R1-R2-R2C');
    expect(render(agents, 'build', 'other/y')).toBe('R1-R1B-C');
  });

  test('a rule without a template keeps the previous template', () => {
    const agents = {
      build: {
        template: '{{v}}',
        slots: { v: 'V' },
        rules: [{ models: ['x/*'], slots: { v: 'W' } }],
      },
    };
    expect(render(agents, 'build', 'x/y')).toBe('W');
  });

  test('excludeModels skips a rule for matching refs only', () => {
    const agents = {
      build: {
        template: 'base',
        rules: [{ models: ['*/*'], excludeModels: ['openai/*'], template: 'rule' }],
      },
    };
    expect(render(agents, 'build', 'openai/gpt-5')).toBe('base');
    expect(render(agents, 'build', 'anthropic/x')).toBe('rule');
  });

  test('a rule template that drops a declared slot fails as missing', () => {
    reject(
      () =>
        prepare(
          {
            build: {
              template: 'x {{a}}',
              slots: { a: 'v' },
              rules: [{ models: ['*'], template: 'no slots' }],
            },
          },
          'build',
          'm/n',
        ),
      'slot-missing',
    );
  });

  test('model patterns are anchored, case-sensitive and wildcards span slashes', () => {
    expect(matchesModelPattern('anthropic/*', 'anthropic/claude/foo')).toBe(true);
    expect(matchesModelPattern('*', 'a/b/c')).toBe(true);
    expect(matchesModelPattern('anthropic/??????', 'anthropic/claude')).toBe(true);
    expect(matchesModelPattern('anthropic/?', 'anthropic/claude')).toBe(false);
    expect(matchesModelPattern('a/b', 'a/b/c')).toBe(false);
    expect(matchesModelPattern('a/b', 'x/a/b')).toBe(false);
    expect(matchesModelPattern('A/*', 'a/b')).toBe(false);
  });
});

describe('slots: omission, repetition and syntax', () => {
  test('explicit omit declares a slot without rendering or opening its file', () => {
    expect(
      render(
        { build: { template: 'a{{gone:omit}}b', slots: { gone: { file: 'nope/missing.md' } } } },
        'build',
        'a/b',
      ),
    ).toBe('ab');
  });

  test('omit plus use is a conflict with name, count and locations', () => {
    const error = reject(
      () => prepare({ build: { template: '{{a}} {{a:omit}}', slots: { a: 'v' } } }, 'build', 'a/b'),
      'slot-conflict',
    );
    expect(error.slot).toBe('a');
    expect(error.count).toBe(2);
    expect(error.locations).toEqual([
      { line: 1, column: 1 },
      { line: 1, column: 7 },
    ]);
    expect(error.message).toContain('slot="a"');
  });

  test('repeated omit markers are rejected even with allowRepeatedSlots', () => {
    reject(
      () =>
        prepare(
          { build: { template: '{{a:omit}}{{a:omit}}', slots: { a: 'v' }, allowRepeatedSlots: true } },
          'build',
          'a/b',
        ),
      'slot-omit-repeated',
    );
  });

  test('a declared slot that is never referenced is rejected', () => {
    const error = reject(() => prepare({ build: { template: 'plain', slots: { a: 'v' } } }, 'build', 'a/b'), 'slot-missing');
    expect(error.slot).toBe('a');
    expect(error.count).toBe(0);
  });

  test('repeated use without opt-in reports count and all locations', () => {
    const error = reject(
      () => prepare({ build: { template: '{{v}}\n{{v}}', slots: { v: 'x' } } }, 'build', 'a/b'),
      'slot-repeated',
    );
    expect(error.count).toBe(2);
    expect(error.locations).toEqual([
      { line: 1, column: 1 },
      { line: 2, column: 1 },
    ]);
    expect(error.message).toContain('locations=1:1, 2:1');
  });

  test('repeated use renders when allowRepeatedSlots is enabled', () => {
    expect(
      render(
        { build: { template: '{{a}}/{{a}}', slots: { a: 'v' }, allowRepeatedSlots: true } },
        'build',
        'a/b',
      ),
    ).toBe('v/v');
  });

  test('a rule can enable repetition for one model only', () => {
    const agents = {
      build: {
        template: '{{a}}|{{a}}',
        slots: { a: 'v' },
        allowRepeatedSlots: false,
        rules: [{ models: ['repeat/*'], allowRepeatedSlots: true }],
      },
    };
    expect(render(agents, 'build', 'repeat/x')).toBe('v|v');
    reject(() => prepare(agents, 'build', 'other/x'), 'slot-repeated');
  });

  test('unknown placeholder names are rejected', () => {
    const error = reject(() => prepare({ build: { template: '{{nope}}' } }, 'build', 'a/b'), 'slot-unknown');
    expect(error.slot).toBe('nope');
    expect(error.count).toBe(1);
  });

  test('unknown modifiers are rejected with a location', () => {
    const error = reject(
      () => prepare({ build: { template: '{{v:wat}}', slots: { v: 'x' } } }, 'build', 'a/b'),
      'template-parse',
    );
    expect(error.locations).toEqual([{ line: 1, column: 1 }]);
    expect(error.message).toContain('modifier');
  });

  test('unclosed placeholders are rejected with the opening location', () => {
    const error = reject(() => prepare({ build: { template: 'a {{v' } }, 'build', 'a/b'), 'template-parse');
    expect(error.locations).toEqual([{ line: 1, column: 3 }]);
  });

  test('empty, whitespace and malformed placeholder names are rejected', () => {
    for (const template of ['{{}}', '{{ v }}', '{{a{{b}}']) {
      reject(() => prepare({ build: { template } }, 'build', 'a/b'), 'template-parse');
    }
  });

  test('an escaped opening brace renders literally', () => {
    expect(render({ build: { template: '\\{{v}}' } }, 'build', 'a/b')).toBe('{{v}}');
  });

  test('escape and real use can appear in the same template', () => {
    expect(render({ build: { template: '\\{{v}} then {{v}}', slots: { v: 'X' } } }, 'build', 'a/b')).toBe(
      '{{v}} then X',
    );
  });

  test('inserted slot values are never interpreted as placeholders', () => {
    expect(
      render(
        { build: { template: '{{a}}', slots: { a: 'before {{b:omit}} after' } } },
        'build',
        'a/b',
      ),
    ).toBe('before {{b:omit}} after');
  });

  test('errors never echo template or slot bodies', () => {
    const secretTemplate = reject(
      () =>
        prepare(
          { build: { template: 'TOP-SECRET-BODY', slots: { hidden: { file: 'secret-slot.md' } } } },
          'build',
          'a/b',
        ),
      'slot-missing',
    );
    expect(secretTemplate.message).not.toContain('TOP-SECRET-BODY');
    expect(secretTemplate.message).not.toContain('secret-slot.md');
    const secretSlot = reject(
      () => prepare({ build: { template: '{{s}} {{s:omit}}', slots: { s: 'SECRET-SLOT-VALUE' } } }, 'build', 'a/b'),
      'slot-conflict',
    );
    expect(secretSlot.message).not.toContain('SECRET-SLOT-VALUE');
  });
});

describe('definition loading and validation', () => {
  test('JSONC comments and trailing commas load', () => {
    const path = write(
      'jsonc.jsonc',
      `{
  // user-owned definition
  "version": 1,
  "agents": {
    "build": {
      "template": "hi {{name}}",
      "slots": { "name": "there" },
    },
  },
}`,
    );
    const prepared = preparePrompt(loadDefinition(path), path, 'build', 'a/b');
    expect(prepared?.render()).toBe('hi there');
  });

  test('malformed JSON fails with the file and a location', () => {
    const error = reject(() => parseDefinition('{ "agents":', '/tmp/def.jsonc'), 'definition-json');
    expect(error.file).toBe('/tmp/def.jsonc');
    expect(error.locations.length).toBeGreaterThan(0);
  });

  test('missing definition files fail as reads', () => {
    reject(() => loadDefinition(join(dir, 'nope.jsonc')), 'definition-read');
  });

  test('version must be 1', () => {
    reject(() => parseDefinition(JSON.stringify({ version: 2, agents: {} }), 'v.jsonc'), 'definition-shape');
  });

  test('unknown fields at every level are rejected instead of ignored', () => {
    const cases: unknown[] = [
      { version: 1, agents: {}, extra: true },
      { version: 1, agents: { build: { template: 'x', slots: {}, extra: 1 } } },
      { version: 1, agents: { build: { rules: [{ models: ['*'], extra: 1 }] } } },
    ];
    cases.forEach((value, index) => {
      const path = write(`unknown-${index}.jsonc`, JSON.stringify(value));
      reject(() => loadDefinition(path), 'definition-shape');
    });
  });

  test('unknown source forms are rejected instead of ignored', () => {
    const cases: unknown[] = [
      { version: 1, agents: { build: { template: { runtime: 'tools' }, slots: {} } } },
      { version: 1, agents: { build: { template: { file: 'x.md', extra: 1 }, slots: {} } } },
      { version: 1, agents: { build: { template: 1 } } },
      { version: 1, agents: { build: { template: { file: '' } } } },
      { version: 1, agents: { build: { template: 'x', slots: { a: { file: 'x.md', runtime: 'tools' } } } } },
      { version: 1, agents: { build: { template: 'x', slots: { a: {} } } } },
      { version: 1, agents: { build: { template: 'x', slots: { a: 1 } } } },
      { version: 1, agents: { build: { template: 'x', slots: { a: { runtime: 'nope' } } } } },
      { version: 1, agents: { build: { template: 'x', slots: { 'bad name': 'v' } } } },
      { version: 1, agents: { build: { template: 'x', slots: { 'bad:name': 'v' } } } },
      { version: 1, agents: { build: { rules: [{ models: [] }] } } },
      { version: 1, agents: { build: { rules: [{ models: ['*'], excludeModels: [1] }] } } },
      { version: 1, agents: { build: { allowRepeatedSlots: 'yes' } } },
    ];
    cases.forEach((value, index) => {
      const path = write(`form-${index}.jsonc`, JSON.stringify(value));
      reject(() => loadDefinition(path), 'definition-shape');
    });
  });
});

describe('files, freshness and runtime data', () => {
  test('a selected broken slot file fails at prepare with its path', () => {
    const error = reject(
      () => prepare({ build: { template: '{{v}}', slots: { v: { file: 'missing.md' } } } }, 'build', 'a/b'),
      'slot-file',
    );
    expect(error.file).toContain('missing.md');
    expect(error.slot).toBe('v');
  });

  test('a slot overridden by a rule never opens the discarded file', () => {
    expect(
      render(
        {
          build: {
            template: '{{v}}',
            slots: { v: { file: 'does-not-exist.md' } },
            rules: [{ models: ['*/*'], slots: { v: 'ok' } }],
          },
        },
        'build',
        'a/b',
      ),
    ).toBe('ok');
  });

  test('a missing template file fails at prepare', () => {
    reject(
      () => prepare({ build: { template: { file: 'no-template.md' } } }, 'build', 'a/b'),
      'template-file',
    );
  });

  test('prepare snapshots file slots and a new prepare sees edits', () => {
    write('v.md', 'one');
    write('tpl.md', 'V={{v}}');
    const path = define({ build: { template: { file: 'tpl.md' }, slots: { v: { file: 'v.md' } } } });
    const definition = loadDefinition(path);
    const first = preparePrompt(definition, path, 'build', 'x/y');
    expect(first?.render()).toBe('V=one');
    write('v.md', 'two');
    expect(first?.render()).toBe('V=one');
    expect(preparePrompt(definition, path, 'build', 'x/y')?.render()).toBe('V=two');
  });

  test('loadDefinition reads the file fresh on every call', () => {
    const path = define({ build: { template: 'one' } });
    expect(preparePrompt(loadDefinition(path), path, 'build', 'm')?.render()).toBe('one');
    write('def.jsonc', JSON.stringify({ version: 1, agents: { build: { template: 'two' } } }));
    expect(preparePrompt(loadDefinition(path), path, 'build', 'm')?.render()).toBe('two');
  });

  test('runtime bindings insert raw data at render time', () => {
    const model = { id: 'm1', provider: 'a' };
    const tools = [{ name: 'read' }];
    const prepared = prepare(
      {
        build: {
          template: 'agent={{agent}} model={{model}} tools={{tools}}',
          slots: {
            agent: { runtime: 'agent' },
            model: { runtime: 'model' },
            tools: { runtime: 'tools' },
          },
        },
      },
      'build',
      'a/b',
    );
    expect(prepared).toBeDefined();
    if (!prepared) return;
    expect(prepared.render({ agent: 'build', model, tools })).toBe(
      `agent=build model=${JSON.stringify(model, null, 2)} tools=${JSON.stringify(tools, null, 2)}`,
    );
  });

  test('prepare works without tools; render fails when a used runtime value is missing', () => {
    const prepared = prepare(
      { build: { template: '{{agent}}|{{tools}}', slots: { agent: { runtime: 'agent' }, tools: { runtime: 'tools' } } } },
      'build',
      'a/b',
    );
    expect(prepared).toBeDefined();
    if (!prepared) return;
    const error = reject(() => prepared.render({ agent: 'build' }), 'runtime-value');
    expect(error.slot).toBe('tools');
    expect(prepared.render({ agent: 'build', tools: ['x'] })).toBe('build|[\n  "x"\n]');
  });

  test('string runtime values are inserted verbatim, not JSON-quoted', () => {
    expect(
      render(
        { build: { template: 'agent={{agent}}', slots: { agent: { runtime: 'agent' } } } },
        'build',
        'a/b',
        { agent: 'build' },
      ),
    ).toBe('agent=build');
  });

  test('resolveSourcePath handles relative, absolute and ~/ paths', () => {
    expect(resolveSourcePath('/tmp/def.jsonc', 'slot.md')).toBe('/tmp/slot.md');
    expect(resolveSourcePath('/tmp/def.jsonc', '/etc/slot.md')).toBe('/etc/slot.md');
    expect(resolveSourcePath('/tmp/def.jsonc', '~/slot.md')).toBe(join(homedir(), 'slot.md'));
  });
});

describe('free names and prototype safety', () => {
  test('an own __proto__ slot from the default policy renders', () => {
    const slots = Object.fromEntries([['__proto__', 'default-proto']]);
    expect(render({ build: { template: '[{{__proto__}}]', slots } }, 'build', 'a/b')).toBe('[default-proto]');
  });

  test('a rule can override an own __proto__ slot source', () => {
    write('rule-slot.md', 'rule-proto');
    const base = Object.fromEntries([['__proto__', 'base-proto']]);
    const override = Object.fromEntries([['__proto__', { file: 'rule-slot.md' }]]);
    expect(
      render(
        { build: { template: '{{__proto__}}', slots: base, rules: [{ models: ['*/*'], slots: override }] } },
        'build',
        'a/b',
      ),
    ).toBe('rule-proto');
  });

  test('an agent named constructor is managed when declared', () => {
    const agents = Object.fromEntries([['constructor', { template: 'ctor {{v}}', slots: { v: 'ok' } }]]);
    expect(render(agents, 'constructor', 'a/b')).toBe('ctor ok');
  });

  test('an agent named __proto__ is managed when declared', () => {
    const agents = Object.fromEntries([['__proto__', { template: 'proto-agent' }]]);
    expect(render(agents, '__proto__', 'a/b')).toBe('proto-agent');
  });

  test('inherited agent names stay unmanaged', () => {
    const { definition, path } = load({ build: { template: 'x' } });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(preparePrompt(definition, path, name, 'a/b')).toBeUndefined();
    }
  });
});
