#!/usr/bin/env node
/**
 * qa/native-v2.mjs — one-shot isolated QA driver for the opencode-prompts plugin against the
 * official OpenCode v2 binary (default 2.0.24) with a loopback mock provider.
 * Run: `node qa/native-v2.mjs` (override with `OPENCODE_V2_BINARY=/path/to/opencode2`).
 *
 * Everything is synthetic/MIT: isolated HOME/XDG/config/db/tmp, random loopback ports (never
 * 4097/4098), canned mock responses, generated definitions. No production config, credentials,
 * services or ports are touched; only the spawned host and mock are stopped, never process-wide.
 * Evidence keeps markers/counters/hashes only. Writes .omo/evidence/native-v2-2.0.24.json.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = repo;
const evidencePath = join(repo, '.omo/evidence/native-v2-2.0.24.json');
const binary = process.env.OPENCODE_V2_BINARY ?? join(homedir(), '.local/opt/opencode-v2/2.0.24/node_modules/.bin/opencode2');
const expectedVersion = '2.0.24';

// Synthetic markers: SECRET_* are embedded in failing fixtures and must never reach the JSONL
// diagnostics; ORIGINAL/NATIVE_* prove seed replacement and restoration.
const ORIGINAL = 'ORIGINAL_NATIVE_SYSTEM';
const NATIVE_TAIL = 'NATIVE_TAIL_MARKER';
const AGENTS_MARKER = 'O3P_AGENTS_MARKER_SYNTHETIC';
const NEIGHBOR_PREFIX = '<<qa-neighbor-prefix>>';
const NEIGHBOR_SUFFIX = '<<qa-neighbor-suffix>>';
const SECRET_BODY = 'SECRET_BODY_SYNTHETIC_VALUE';
const SECRET_SLOT = 'SECRET_SLOT_SYNTHETIC_VALUE';
const TOOLS_BEGIN = 'QA_TOOLS_JSON_BEGIN';
const TOOLS_END = 'QA_TOOLS_JSON_END';
const MODEL_BEGIN = 'QA_MODEL_JSON_BEGIN';
const MODEL_END = 'QA_MODEL_JSON_END';
const MODELS = ['gpt-x', 'kimi-x', 'glm-x', 'fresh-x'];

const sha = (data) => createHash('sha256').update(data).digest('hex');
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return [{ parseError: true }]; } }) : []);
const joinLines = (...lines) => lines.join('\n');

async function waitFor(label, check, timeoutMs = 20_000, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await pause(intervalMs);
  }
}

// ---------- synthetic fixtures ----------------------------------------------------------

const familyTemplate = () => joinLines('QA_TEMPLATE=family', 'QA_AGENT={{AGENT_RT}}', MODEL_BEGIN, '{{MODEL_RT}}', MODEL_END,
  'QA_SLOT={{SLOT_TEXT}}', 'QA_LITERAL_BEGIN', '{{LITERAL}}', 'QA_LITERAL_END', 'QA_OMIT=ok{{OMIT_MISSING:omit}}', TOOLS_BEGIN, '{{TOOLS_RT}}', TOOLS_END);
const specificTemplate = () => familyTemplate().replace('QA_TEMPLATE=family', 'QA_TEMPLATE=specific');
const freshTemplate = () => joinLines('FRESH_STEP=INITIAL', '{{FRESH}}');
const freshEdited = () => joinLines('FRESH_STEP=EDITED', '{{FRESH}}');
const literalSlot = () => joinLines('LITERAL_OPEN {{AGENT_RT}} {{NOPE}}', "LITERAL_DOLLAR $& $' $1 $`");

const validDefinitionObject = () => ({
  version: 1,
  agents: {
    tester: {
      template: { file: '../templates/family.md' },
      slots: {
        AGENT_RT: { runtime: 'agent' }, MODEL_RT: { runtime: 'model' }, TOOLS_RT: { runtime: 'tools' },
        SLOT_TEXT: { file: '../slots/family.txt' }, OMIT_MISSING: { file: '../slots/absent-never-read.txt' }, LITERAL: { file: '../slots/literal.txt' },
      },
      rules: [
        { models: ['mock/*'], template: { file: '../templates/family.md' }, slots: { SLOT_TEXT: { file: '../slots/family.txt' } } },
        { models: ['mock/kimi*'], template: { file: '../templates/specific.md' }, slots: { SLOT_TEXT: { file: '../slots/specific.txt' } } },
      ],
    },
    repeat: { template: 'REPEAT_BEGIN\n{{REPEAT}}|{{REPEAT}}\nREPEAT_END', slots: { REPEAT: 'DUP_SYNTHETIC_VALUE' }, allowRepeatedSlots: true },
    fresh: { template: { file: '../templates/fresh.md' }, slots: { FRESH: { file: '../slots/fresh.txt' } } },
    researcher: {
      template: { file: '../templates/family.md' },
      slots: {
        AGENT_RT: { runtime: 'agent' }, MODEL_RT: { runtime: 'model' }, TOOLS_RT: { runtime: 'tools' },
        SLOT_TEXT: { file: '../slots/family.txt' }, OMIT_MISSING: { file: '../slots/absent-never-read.txt' }, LITERAL: { file: '../slots/literal.txt' },
      },
    },
    broken: { template: { file: '../templates/broken-never-written.md' } },
  },
});

const validDefinitionText = () => `// o3p synthetic QA definition (MIT); a JSONC comment exercises the parser.\n${JSON.stringify(validDefinitionObject(), null, 2)}\n`;
const withoutTesterDefinitionText = () => { const definition = validDefinitionObject(); delete definition.agents.tester; return JSON.stringify(definition, null, 2) + '\n'; };

const invalidSpecs = [
  { name: 'missing', code: 'slot-missing', json: () => ({ version: 1, agents: { tester: { template: `unreferenced ${SECRET_BODY}`, slots: { S: SECRET_SLOT } } } }) },
  { name: 'duplicate', code: 'slot-repeated', json: () => ({ version: 1, agents: { tester: { template: `{{S}}|{{S}} ${SECRET_BODY}`, slots: { S: SECRET_SLOT } } } }) },
  { name: 'unknown', code: 'slot-unknown', json: () => ({ version: 1, agents: { tester: { template: `{{NOPE}} ${SECRET_BODY}`, slots: { S: SECRET_SLOT } } } }) },
  { name: 'conflict', code: 'slot-conflict', json: () => ({ version: 1, agents: { tester: { template: `{{S}} ${SECRET_BODY} {{S:omit}}`, slots: { S: SECRET_SLOT } } } }) },
  { name: 'file', code: 'slot-file', json: () => ({ version: 1, agents: { tester: { template: `{{S}} ${SECRET_BODY}`, slots: { S: { file: 'slots/absent-never-read.txt' } } } } }) },
  { name: 'json', code: 'definition-json', raw: () => `{\n  "version": 1,\n  "agents": { "tester": { "template": "${SECRET_BODY}" ,, ]\n` },
];

const neighborPluginSource = () => `export default {
  id: 'qa-neighbor-plugin',
  async setup(ctx) {
    const registration = await ctx.session.hook('context', (event) => {
      const parts = event.system;
      if (parts.length === 0) return;
      parts[0].text = '${NEIGHBOR_PREFIX}\\n' + parts[0].text;
      const last = parts[parts.length - 1];
      last.text = last.text + '\\n${NEIGHBOR_SUFFIX}';
    });
    return () => registration.dispose();
  },
};
`;

// ---------- report + shared state -------------------------------------------------------

const report = {
  driver: 'qa/native-v2.mjs', invocation: 'node qa/native-v2.mjs', version: expectedVersion,
  binary: { path: binary, sha256: null, versionOutput: null },
  plugin: { directory: pluginDir, serverEntrySha256: null, distSha256: null },
  cases: [], hashes: {}, modelCalls: { total: 0, primary: 0, title: 0 },
  log: { file: '.qa/prompts.log.jsonl', records: 0, sha256: null, secretsAbsent: null },
  cleanup: { hostStopped: false, mockStopped: false, sandboxRemoved: false },
  uncertainties: [], failure: null,
};

let sandbox; let project; let configDir; let logPath; let definitionPath; let neighborDir;
let server; let exitPromise; let hostLog = ''; let versionOutput = null; let runPassword = ''; let fatal = null;
const plans = new Map();
const captures = [];

const mock = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : JSON.stringify(content));
    const systemMessages = messages.filter((message) => message.role === 'system');
    const system = (systemMessages.length > 0 ? systemMessages : messages).map((message) => textOf(message.content)).join('\n');
    const tools = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
    const kind = system.includes('You are a title generator.') ? 'title' : 'primary';
    const userText = [...messages].reverse().find((message) => message.role === 'user' && textOf(message.content).includes('QA_CASE='))?.content;
    const capture = { seq: captures.length, kind, case: /QA_CASE=([a-z0-9-]+)/.exec(userText ? textOf(userText) : '')?.[1] ?? null, model: body.model, tools, system, messages, stream: Boolean(body.stream), planMissing: false };
    captures.push(capture);
    if (kind === 'title') return respond(response, body, { text: 'QA synthetic title' });
    const step = capture.case ? plans.get(capture.case)?.shift() : undefined;
    if (step === undefined) { capture.planMissing = true; return respond(response, body, { text: 'QA_NO_PLAN' }); }
    const calls = typeof step.calls === 'function' ? step.calls() : step.calls;
    respond(response, body, calls ? { calls } : { text: step.text ?? 'QA_STEP' });
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(String(error));
  }
});

function respond(response, body, answer) {
  const calls = answer.calls?.map((call, index) => ({ index, id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }));
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: `chatcmpl_${randomUUID().replaceAll('-', '')}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer.text ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'qa-chunk', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);
  emit({ role: 'assistant' });
  emit(calls ? { tool_calls: calls } : { content: answer.text ?? '' });
  emit({}, calls ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
}

// ---------- sandbox layout --------------------------------------------------------------

function buildFixtures() {
  const dirs = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map((name) => [name, join(sandbox, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  configDir = dirs.config;
  project = join(sandbox, 'project');
  const qaDir = join(project, '.qa');
  for (const dir of [project, qaDir, join(project, 'templates'), join(project, 'slots')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  definitionPath = join(qaDir, 'definition.jsonc');
  logPath = join(qaDir, 'prompts.log.jsonl');
  neighborDir = join(sandbox, 'neighbor-plugin');
  mkdirSync(neighborDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(neighborDir, 'server.js'), neighborPluginSource(), { mode: 0o600 });
  writeFileSync(join(project, 'AGENTS.md'), `# Synthetic QA project\n${AGENTS_MARKER} is a driver-generated instruction marker.\n`, { mode: 0o600 });
  writeFileSync(join(project, 'templates', 'family.md'), familyTemplate(), { mode: 0o600 });
  writeFileSync(join(project, 'templates', 'specific.md'), specificTemplate(), { mode: 0o600 });
  writeFileSync(join(project, 'templates', 'fresh.md'), freshTemplate(), { mode: 0o600 });
  writeFileSync(join(project, 'slots', 'family.txt'), 'FAMILY_SLOT_SYNTHETIC_VALUE\n', { mode: 0o600 });
  writeFileSync(join(project, 'slots', 'specific.txt'), 'SPECIFIC_SLOT_SYNTHETIC_VALUE\n', { mode: 0o600 });
  writeFileSync(join(project, 'slots', 'fresh.txt'), 'FRESH_SLOT=INITIAL\n', { mode: 0o600 });
  writeFileSync(join(project, 'slots', 'literal.txt'), literalSlot() + '\n', { mode: 0o600 });
  writeFileSync(definitionPath, `{\n  "version": 1,\n  "agents": { "tester": { "template": "${SECRET_BODY}" ,, ]\n`, { mode: 0o600 });
  execFileSync('git', ['init', '-q'], { cwd: project });
  return dirs;
}

const writeDefinition = (text) => writeFileSync(definitionPath, text, { mode: 0o600 });
const writeValidDefinition = () => writeDefinition(validDefinitionText());

function writeConfig(mode, extraOptions = {}) {
  const plugins = [{ package: neighborDir }];
  if (mode !== 'none') plugins.push({ package: pluginDir, options: { definition: '.qa/definition.jsonc', logFile: '.qa/prompts.log.jsonl', ...(mode === 'disabled' ? { enabled: false } : {}), ...extraOptions } });
  const modelSpec = (id) => ({ id, name: id, attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: '2025-01-01', limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 }, options: {} });
  const config = {
    $schema: 'https://opencode.ai/config.json', model: 'mock/gpt-x', default_agent: 'tester', permission: 'allow', update: 'disable', snapshots: false, plugins,
    provider: { mock: { name: 'Mock', id: 'mock', env: [], npm: '@ai-sdk/openai-compatible', models: Object.fromEntries(MODELS.map((id) => [id, modelSpec(id)])), options: { apiKey: 'qa-synthetic-key', baseURL: `http://127.0.0.1:${mock.address().port}/v1` } } },
    agents: {
      control: { description: 'QA unmanaged control', mode: 'primary', system: 'CONTROL_NATIVE_SYSTEM <<o3p-control>>' },
      tester: { description: 'QA managed tester', mode: 'primary', system: `${ORIGINAL} <<o3p-native>> ${NATIVE_TAIL}` },
      researcher: { description: 'QA managed research child', mode: 'subagent', system: 'RESEARCHER_ORIGINAL_NATIVE_SYSTEM' },
      broken: { description: 'QA role with a broken unused policy', mode: 'primary', system: 'BROKEN_NATIVE_SYSTEM' },
      repeat: { description: 'QA repeat-opt-in role', mode: 'primary', system: 'REPEAT_NATIVE_SYSTEM' },
      fresh: { description: 'QA per-request freshness role', mode: 'primary', system: 'FRESH_NATIVE_SYSTEM' },
    },
  };
  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ---------- shared helpers --------------------------------------------------------------

const managed = (text) => typeof text === 'string' && text.includes('<<<opencode-prompts|') && text.includes('|begin>>>') && text.includes('|end>>>');
const jsonBetween = (text, begin, end) => JSON.parse(text.slice(text.indexOf(begin) + begin.length, text.indexOf(end)).trim());
const primaryFor = (name) => captures.filter((capture) => capture.kind === 'primary' && capture.case === name);
const latestPrimary = (name) => primaryFor(name).at(-1);
const assistantTexts = (messages) => messages.filter((message) => message.type === 'assistant').flatMap((message) => message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text);

async function caseRecord(name, expected, run) {
  const record = { name, expected, observed: null, verdict: null };
  report.cases.push(record);
  try {
    const observed = await run();
    if (observed && observed.gap) { record.verdict = 'gap'; record.observed = { gap: observed.gap }; }
    else { record.verdict = 'pass'; record.observed = observed; }
  } catch (error) {
    record.verdict = 'fail';
    record.observed = { error: String(error?.message ?? error).slice(0, 500) };
  }
  console.log(`[${record.verdict}] ${name}`);
}

// ---------- run -------------------------------------------------------------------------

async function main() {
  sandbox = mkdtempSync(join(tmpdir(), 'o3p-native-v2-'));
  const dirs = buildFixtures();
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  writeConfig('full');
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const password = randomUUID();
  runPassword = password;
  const env = {
    PATH: process.env.PATH, HOME: dirs.home, USERPROFILE: dirs.home, OPENCODE_TEST_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.tmp,
    OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_DB: join(dirs.data, 'qa.db'), OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_AUTH_CONTENT: '{}', NO_COLOR: '1',
  };
  versionOutput = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  assert(versionOutput.includes(expectedVersion), `unexpected binary version: ${versionOutput}`);
  server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  exitPromise = once(server, 'exit');
  server.stdout.on('data', (chunk) => { hostLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { hostLog += chunk.toString(); });
  const api = async (endpoint, method = 'GET', body, options = {}) => {
    const url = new URL(endpoint, `http://127.0.0.1:${port}`);
    url.searchParams.set('location[directory]', options.directory ?? project);
    const response = await fetch(url, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!options.allowError) assert(response.ok, `${method} ${endpoint}: ${response.status} ${String(text).slice(0, 200)}`);
    return { status: response.status, ok: response.ok, json };
  };
  const createSession = async (payload) => (await api('/api/session', 'POST', { location: { directory: project }, ...payload })).json.data;
  const prompt = (id, text, options) => api(`/api/session/${id}/prompt`, 'POST', { text }, options);
  const waitSession = (id) => api(`/api/experimental/session/${id}/wait`, 'POST');
  const sessionContext = async (id) => (await api(`/api/session/${id}/context`)).json.data;
  const pluginList = async () => (await api('/api/plugin')).json.data;
  const testerSystem = async () => (await api('/api/agent')).json.data.find((agent) => agent.id === 'tester')?.system;
  const submit = async (id, caseName, options) => { plans.set(caseName, [{ text: `QA_FINISHED ${caseName}` }]); await prompt(id, `QA_CASE=${caseName}`, options); await waitSession(id); };
  await waitFor('isolated server up', async () => (await api('/api/plugin', 'GET', undefined, { allowError: true })).ok, 45_000, 250);
  await waitFor('o3p.prompt.templates plugin active', async () => (await pluginList()).some((plugin) => plugin.id === 'o3p.prompt.templates' && plugin.state?.status === 'active'), 45_000, 500);
  console.log(`[ready] ${versionOutput} on 127.0.0.1:${port} (isolated)`);
  // 1. startup-invalid definition then repair in the same host/session.
  await caseRecord('startup-invalid-json-repaired', { startupLogCode: 'definition-json', admissionHttpError: true, modelCallDelta: 0, primaryDelta: 0, titleDelta: 0, userRows: 0, repairedSameSession: true }, async () => {
    const session = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA startup' });
    let attempt; let delta = null; let primaryDelta = null; let titleDelta = null;
    try {
      const before = captures.length;
      attempt = await prompt(session.id, 'QA_CASE=startup-invalid', { allowError: true });
      await pause(300);
      const fresh = captures.slice(before);
      delta = fresh.length;
      primaryDelta = fresh.filter((capture) => capture.kind === 'primary').length;
      titleDelta = fresh.filter((capture) => capture.kind === 'title').length;
      const messages = await sessionContext(session.id);
      assert(attempt.status >= 400, `expected HTTP error for startup-invalid admission, got ${attempt.status}`);
      assert.equal(delta, 0, 'model calls during rejected admission');
      assert.equal(messages.filter((message) => message.type === 'user').length, 0, 'user row admitted during rejected admission');
      const records = readJsonl(logPath);
      assert(records.some((record) => record.phase === 'startup' && record.code === 'definition-json'), `startup log missing: ${JSON.stringify(records.slice(0, 4))}`);
      assert(records.some((record) => record.phase === 'admission' && record.code === 'definition-json'), 'admission log missing definition-json');
    } finally { writeValidDefinition(); }
    await submit(session.id, 'startup-repair');
    assert(managed(latestPrimary('startup-repair')?.system), 'managed render after repair');
    assert.equal(primaryDelta + titleDelta, 0, 'primary/title deltas during rejected admission');
    return { startupLogCode: 'definition-json', admissionStatus: attempt.status, modelCallDelta: delta, primaryDelta, titleDelta, userRows: 0, repairedSameSession: true };
  });
  // 2. unmanaged control responds; title request captured separately.
  await caseRecord('control-unmanaged-responds', { nativeSystem: true, ownedMarkers: false, assistantReply: true, titleSeparate: true }, async () => {
    const session = await createSession({ agent: 'control', model: { providerID: 'mock', id: 'gpt-x' } });
    await submit(session.id, 'control');
    const capture = latestPrimary('control');
    assert(capture && capture.system.includes('CONTROL_NATIVE_SYSTEM') && !capture.system.includes('<<<opencode-prompts|'), 'control native passthrough failed');
    assert(assistantTexts(await sessionContext(session.id)).some((text) => text.includes('QA_FINISHED control')), 'control assistant reply missing');
    const title = await waitFor('control title request', async () => captures.find((item) => item.kind === 'title' && item.case === 'control'), 8_000, 500);
    return { nativeSystem: true, ownedMarkers: false, assistantReply: true, titleSeparate: title.system.includes('You are a title generator.') && !title.system.includes('<<<opencode-prompts|') };
  });
  // 3. unmanaged native build unaffected.
  await caseRecord('unmanaged-build-native', { nativeBuildPrompt: true, ownedMarkers: false }, async () => {
    const session = await createSession({ agent: 'build', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA build' });
    await submit(session.id, 'build');
    const capture = latestPrimary('build');
    assert(capture.system.startsWith(`${NEIGHBOR_PREFIX}\nYou are an AI agent running in OpenCode`) && !capture.system.includes('<<<opencode-prompts|'), 'native build prompt changed beyond the explicit neighbor prefix');
    return { nativeBuildPrompt: true, ownedMarkers: false };
  });
  // 4. managed tester fully replaces ORIGINAL, preserves AGENTS/neighbor parts, runtime slots, literals, :omit.
  let rulesSession;
  await caseRecord('tester-replace-preserve-render', { originalReplaced: true, ownedRegion: true, familyRule: true, agentsMarker: true, neighborPrefix: true, neighborSuffix: true, modelSlot: 'mock/gpt-x', toolNamesMatch: true, literalBraces: true, literalDollars: true, omitPositive: true, metadataSeeded: true }, async () => {
    const session = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA tester' });
    rulesSession = session;
    await submit(session.id, 'tester');
    const capture = latestPrimary('tester');
    const text = capture.system;
    assert(!text.includes(ORIGINAL) && !text.includes(NATIVE_TAIL), 'original native system survived the seed');
    assert(managed(text) && text.includes('QA_TEMPLATE=family') && text.includes('FAMILY_SLOT_SYNTHETIC_VALUE'), 'owned region or family rule missing');
    assert(text.includes(AGENTS_MARKER), 'AGENTS.md marker missing');
    assert(text.includes(NEIGHBOR_PREFIX) && text.includes(NEIGHBOR_SUFFIX), 'neighbor prefix/suffix lost');
    const modelSlot = jsonBetween(text, MODEL_BEGIN, MODEL_END);
    assert.equal(modelSlot.providerID, 'mock'); assert.equal(modelSlot.id, 'gpt-x');
    const toolKeys = Object.keys(jsonBetween(text, TOOLS_BEGIN, TOOLS_END)).sort();
    assert.deepEqual(toolKeys, [...capture.tools].sort(), 'tools slot names differ from model-visible tools');
    assert(text.includes('LITERAL_OPEN {{AGENT_RT}} {{NOPE}}') && text.includes("$& $' $1 $`"), 'source values were re-parsed or rewritten');
    assert(/QA_OMIT=ok/.test(text), 'positive :omit placeholder missing');
    assert(!readJsonl(logPath).some((record) => record.slot === 'OMIT_MISSING'), 'omitted file was read');
    const metadata = await waitFor('tester seed metadata', async () => { const system = await testerSystem(); return managed(system) ? system : false; }, 10_000, 1000);
    return { originalReplaced: true, ownedRegion: true, familyRule: true, agentsMarker: true, neighborPrefix: true, neighborSuffix: true, modelSlot: `${modelSlot.providerID}/${modelSlot.id}`, toolNamesMatch: true, toolCount: toolKeys.length, literalBraces: true, literalDollars: true, omitPositive: true, metadataSeeded: managed(metadata) };
  });
  // 5. missing session agent/model uses configured defaults.
  await caseRecord('defaults-session-agent-model', { capturedModel: 'gpt-x', managed: true, originalReplaced: true }, async () => {
    const session = await createSession({});
    const meta = (await api(`/api/session/${session.id}`)).json.data;
    await submit(session.id, 'defaults');
    const capture = latestPrimary('defaults');
    assert(String(capture.model).includes('gpt-x'), `unexpected default model ${capture.model}`);
    assert(managed(capture.system) && !capture.system.includes(ORIGINAL), 'defaults admission did not use the managed tester');
    return { hostAgent: meta.agent ?? null, hostModel: meta.model ? `${meta.model.providerID}/${meta.model.id}` : null, capturedModel: capture.model, managed: true, originalReplaced: true };
  });
  // 6. same tester switches GPT/Kimi/GLM; family and specific rule results differ.
  await caseRecord('model-rules-family-specific', { gpt: 'family', kimi: 'specific', glm: 'family', differ: true }, async () => {
    assert(rulesSession, 'tester session missing');
    await submit(rulesSession.id, 'rules-gpt');
    await api(`/api/session/${rulesSession.id}/model`, 'POST', { model: { providerID: 'mock', id: 'kimi-x' } });
    await submit(rulesSession.id, 'rules-kimi');
    await api(`/api/session/${rulesSession.id}/model`, 'POST', { model: { providerID: 'mock', id: 'glm-x' } });
    await submit(rulesSession.id, 'rules-glm');
    const gpt = latestPrimary('rules-gpt'); const kimi = latestPrimary('rules-kimi'); const glm = latestPrimary('rules-glm');
    assert(gpt.system.includes('QA_TEMPLATE=family'), 'gpt did not match family rule');
    assert(kimi.system.includes('QA_TEMPLATE=specific') && kimi.system.includes('SPECIFIC_SLOT_SYNTHETIC_VALUE'), 'kimi did not match specific rule');
    assert(glm.system.includes('QA_TEMPLATE=family'), 'glm did not match family rule');
    return { gpt: 'family', kimi: 'specific', glm: 'family', differ: gpt.system !== kimi.system };
  });
  // 7. opt-in repeated slots render the actual duplicate text.
  await caseRecord('repeat-optin-duplicates', { occurrences: 2 }, async () => {
    const session = await createSession({ agent: 'repeat', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA repeat' });
    await submit(session.id, 'repeat');
    const occurrences = latestPrimary('repeat').system.split('DUP_SYNTHETIC_VALUE').length - 1;
    assert.equal(occurrences, 2, `expected duplicate slot text twice, saw ${occurrences}`);
    return { occurrences };
  });
  // 8. hot template and slot edits affect the next request.
  await caseRecord('hot-edits-next-request', { templateEdit: true, slotEdit: true }, async () => {
    appendFileSync(join(project, 'templates', 'family.md'), '\nHOT_TEMPLATE_EDIT=V2\n');
    writeFileSync(join(project, 'slots', 'family.txt'), 'HOT_SLOT_EDIT=V2\n', { mode: 0o600 });
    await submit(rulesSession.id, 'hot-edits');
    const text = latestPrimary('hot-edits').system;
    assert(text.includes('HOT_TEMPLATE_EDIT=V2') && text.includes('HOT_SLOT_EDIT=V2'), 'edits did not reach the next request');
    return { templateEdit: true, slotEdit: true };
  });
  // 9. native read + write between two primary steps proves per-request render (no cached seed).
  await caseRecord('seed-fresh-native-read-write', { steps: 2, firstEdited: false, secondEdited: true, toolResultsFedBack: true }, async () => {
    const session = await createSession({ agent: 'fresh', model: { providerID: 'mock', id: 'fresh-x' }, title: 'QA fresh' });
    plans.set('seed-fresh', [
      { calls: () => [
        { name: 'read', args: { path: join(project, 'templates', 'fresh.md') } },
        { name: 'write', args: { path: join(project, 'templates', 'fresh.md'), content: freshEdited() } },
      ] },
      { text: 'QA_FINISHED seed-fresh' },
    ]);
    await prompt(session.id, 'QA_CASE=seed-fresh');
    await waitSession(session.id);
    const steps = primaryFor('seed-fresh');
    assert.equal(steps.length, 2, `expected two primary steps, got ${steps.length}`);
    assert(steps[0].tools.includes('read') && steps[0].tools.includes('write'), 'native read/write tools not model-visible');
    assert(!steps[0].system.includes('FRESH_STEP=EDITED'), 'first request already saw the edit');
    assert(steps[1].system.includes('FRESH_STEP=EDITED'), 'second request did not re-render the edited template');
    assert(steps[1].messages.some((message) => message.role === 'tool'), 'tool results were not fed back before the second step');
    assert(managed(steps[1].system), 'second step lost the owned region');
    return { steps: 2, firstEdited: false, secondEdited: true, toolResultsFedBack: true };
  });
  // 10. invalid admissions: new session each, HTTP error, zero model calls, no user row, log code, no secrets, repair same session.
  await caseRecord('native-subagent-managed-inherits-model', { childAgent: 'researcher', inheritedModel: 'kimi-x', ownedRegion: true, originalReplaced: true, parentContinues: true }, async () => {
    const parent = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'kimi-x' }, title: 'QA subagent parent' });
    plans.set('subagent-child', [{ text: 'QA_CHILD_FINISHED' }]);
    plans.set('subagent-parent', [
      { calls: [{ name: 'subagent', args: { agent: 'researcher', description: 'QA policy child', prompt: 'QA_CASE=subagent-child', background: false } }] },
      { text: 'QA_FINISHED subagent-parent' },
    ]);
    await prompt(parent.id, 'QA_CASE=subagent-parent');
    await waitSession(parent.id);
    const child = latestPrimary('subagent-child');
    assert(child, 'native subagent made no child model request');
    assert.equal(child.model, 'kimi-x', 'child did not inherit parent model');
    assert(child.system.includes('QA_AGENT=researcher') && managed(child.system), 'child role prompt was not rendered');
    assert(!child.system.includes('RESEARCHER_ORIGINAL_NATIVE_SYSTEM'), 'child native body survived replacement');
    assert(assistantTexts(await sessionContext(parent.id)).some((text) => text.includes('QA_FINISHED subagent-parent')), 'parent did not continue after native subagent');
    return { childAgent: 'researcher', inheritedModel: child.model, ownedRegion: true, originalReplaced: true, parentContinues: true };
  });
  for (const spec of invalidSpecs) {
    await caseRecord(`invalid-${spec.name}`, { httpError: true, modelCallDelta: 0, primaryDelta: 0, titleDelta: 0, userRows: 0, logCode: spec.code, secretsAbsent: true, repairedSameSession: true }, async () => {
      writeDefinition(spec.raw ? spec.raw() : JSON.stringify(spec.json(), null, 2) + '\n');
      const session = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' }, title: `QA invalid ${spec.name}` });
      const logBefore = readJsonl(logPath).length;
      const before = captures.length;
      const attempt = await prompt(session.id, `QA_CASE=invalid-${spec.name}`, { allowError: true });
      let delta = null; let primaryDelta = null; let titleDelta = null; let hit;
      try {
        await pause(400);
        const fresh = captures.slice(before);
        delta = fresh.length;
        primaryDelta = fresh.filter((capture) => capture.kind === 'primary').length;
        titleDelta = fresh.filter((capture) => capture.kind === 'title').length;
        const messages = await sessionContext(session.id);
        assert(attempt.status >= 400, `expected HTTP error for invalid-${spec.name}, got ${attempt.status}`);
        assert.equal(delta, 0, 'model calls during rejected admission');
      assert.equal(messages.filter((message) => message.type === 'user').length, 0, 'user row admitted');
        const newRecords = readJsonl(logPath).slice(logBefore);
        hit = newRecords.find((record) => record.phase === 'admission' && record.code === spec.code);
        assert(hit, `log code ${spec.code} missing: ${JSON.stringify(newRecords.slice(0, 3))}`);
        assert(!newRecords.some((record) => JSON.stringify(record).includes(SECRET_BODY) || JSON.stringify(record).includes(SECRET_SLOT)), 'synthetic secret leaked into log');
      } finally { writeValidDefinition(); }
      await submit(session.id, `repair-${spec.name}`);
      assert(managed(latestPrimary(`repair-${spec.name}`)?.system), 'same session not usable after repair');
      return { status: attempt.status, modelCallDelta: delta, primaryDelta, titleDelta, userRows: 0, logCode: hit.code, secretsAbsent: true, repairedSameSession: true };
    });
  }
  // 11. removing tester from the definition between turns restores the native system.
  await caseRecord('remove-tester-restores-native', { nativeSystem: true, ownedMarkers: false, logRestored: true }, async () => {
    writeDefinition(withoutTesterDefinitionText());
    const logBefore = readJsonl(logPath).length;
    try {
      await submit(rulesSession.id, 'remove-tester');
      const text = latestPrimary('remove-tester').system;
      assert(text.includes(ORIGINAL) && text.includes(NATIVE_TAIL), 'native system was not restored');
      assert(!text.includes('<<<opencode-prompts|'), 'owned markers remain after removal');
      assert(readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'admission' && record.code === 'restored'), 'restored log record missing');
    } finally { writeValidDefinition(); }
    return { nativeSystem: true, ownedMarkers: false, logRestored: true };
  });
  // 12. plugin options enabled:false restores native definitions (watch-driven).
  await caseRecord('plugin-disabled-restores-native', { entryStillListed: true, nativeSystem: true, ownedMarkers: false }, async () => {
    const logBefore = readJsonl(logPath).length;
    writeConfig('disabled');
    await waitFor('disabled generation cleanup and native metadata', async () =>
      readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'cleanup' && record.code === 'ok') &&
      String(await testerSystem()).includes(ORIGINAL) && !String(await testerSystem()).includes('<<<opencode-prompts|'), 20_000, 1000);
    await submit(rulesSession.id, 'plugin-disabled');
    const text = latestPrimary('plugin-disabled').system;
    assert(text.includes(ORIGINAL) && !text.includes('<<<opencode-prompts|'), 'native system not restored while disabled');
    assert((await pluginList()).some((plugin) => plugin.id === 'o3p.prompt.templates'), 'plugin entry vanished instead of disabling');
    return { entryStillListed: true, nativeSystem: true, ownedMarkers: false };
  });
  // 13. re-enabling the plugin manages the tester again.
  await caseRecord('plugin-reenabled-manages-again', { managed: true, originalReplaced: true }, async () => {
    const logBefore = readJsonl(logPath).length;
    writeConfig('full');
    await waitFor('reenabled startup log', async () => readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'startup' && record.code === 'ok'), 20_000, 1000);
    await pause(1000);
    await submit(rulesSession.id, 'plugin-reenabled');
    const text = latestPrimary('plugin-reenabled').system;
    assert(managed(text) && !text.includes(ORIGINAL), 're-enable did not manage the tester');
    return { managed: true, originalReplaced: true };
  });
  // 14. removing the plugin entry restores native definitions.
  await caseRecord('plugin-entry-removed-restores-native', { notListed: true, nativeSystem: true, ownedMarkers: false }, async () => {
    writeConfig('none');
    await waitFor('removed convergence', async () => !(await pluginList()).some((plugin) => plugin.id === 'o3p.prompt.templates') && !String(await testerSystem()).includes('<<<opencode-prompts|'), 20_000, 1000);
    await submit(rulesSession.id, 'plugin-removed');
    const text = latestPrimary('plugin-removed').system;
    assert(text.includes(ORIGINAL) && !text.includes('<<<opencode-prompts|'), 'native system not restored after removal');
    return { notListed: true, nativeSystem: true, ownedMarkers: false };
  });
  // 15. restoring the plugin entry manages the tester again.
  await caseRecord('plugin-entry-restored-manages-again', { managed: true }, async () => {
    const logBefore = readJsonl(logPath).length;
    writeConfig('full');
    await waitFor('restored startup log', async () => readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'startup' && record.code === 'ok'), 20_000, 1000);
    await pause(1000);
    await submit(rulesSession.id, 'plugin-restored');
    assert(managed(latestPrimary('plugin-restored').system), 'owned region missing after restore');
    return { managed: true };
  });
  // 16. concurrency isolation: two valid managed sessions (different models) plus one invalid branch.
  await caseRecord('concurrent-isolation-broken-role', { a: 'family', b: 'specific', invalidHttpError: true, invalidReachedModel: false, invalidLogCode: 'template-file', aStillUsable: true }, async () => {
    writeFileSync(join(project, 'templates', 'family.md'), familyTemplate(), { mode: 0o600 });
    writeFileSync(join(project, 'slots', 'family.txt'), 'FAMILY_SLOT_SYNTHETIC_VALUE\n', { mode: 0o600 });
    const a = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA iso A' });
    const b = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'kimi-x' }, title: 'QA iso B' });
    const d = await createSession({ agent: 'broken', model: { providerID: 'mock', id: 'gpt-x' }, title: 'QA iso D' });
    plans.set('iso-a', [{ text: 'QA_FINISHED iso-a' }]);
    plans.set('iso-b', [{ text: 'QA_FINISHED iso-b' }]);
    const logBefore = readJsonl(logPath).length;
    const run = async (id, marker) => { await prompt(id, `QA_CASE=${marker}`); await waitSession(id); };
    const [, , resultD] = await Promise.all([run(a.id, 'iso-a'), run(b.id, 'iso-b'), prompt(d.id, 'QA_CASE=iso-d', { allowError: true })]);
    assert(resultD.status >= 400, `broken role should be rejected, got ${resultD.status}`);
    const captureA = latestPrimary('iso-a'); const captureB = latestPrimary('iso-b');
    assert(captureA.system.includes('QA_TEMPLATE=family') && captureA.system.includes('FAMILY_SLOT_SYNTHETIC_VALUE'), 'session A render wrong');
    assert(captureB.system.includes('QA_TEMPLATE=specific') && captureB.system.includes('SPECIFIC_SLOT_SYNTHETIC_VALUE'), 'session B render wrong');
    assert(!captures.some((capture) => capture.case === 'iso-d'), 'broken role reached the model');
    assert(readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'admission' && record.code === 'template-file'), 'broken role log code missing');
    await run(a.id, 'iso-a2');
    assert(latestPrimary('iso-a2').system.includes('QA_TEMPLATE=family'), 'session A poisoned by invalid branch');
    return { a: 'family', b: 'specific', invalidHttpError: true, invalidStatus: resultD.status, invalidReachedModel: false, invalidLogCode: 'template-file', aStillUsable: true };
  });
  await caseRecord('cross-project-definition-isolation', { separateBody: true, separateRules: true, invalidBDoesNotPoisonA: true }, async () => {
    const secondProject = join(sandbox, 'project-b');
    mkdirSync(join(secondProject, '.qa'), { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-q'], { cwd: secondProject });
    writeFileSync(join(secondProject, 'AGENTS.md'), 'PROJECT_B_AGENTS_MARKER\n', { mode: 0o600 });
    const secondDefinition = join(secondProject, '.qa', 'definition.jsonc');
    writeFileSync(secondDefinition, JSON.stringify({ agents: { tester: { template: 'PROJECT_B_POLICY {{actor}}', slots: { actor: { runtime: 'agent' } } } } }), { mode: 0o600 });
    const secondApi = (endpoint, method = 'GET', body, options = {}) => api(endpoint, method, body, { ...options, directory: secondProject });
    const second = (await secondApi('/api/session', 'POST', { location: { directory: secondProject }, agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' } })).json.data;
    plans.set('project-b', [{ text: 'QA_FINISHED project-b' }]);
    await secondApi(`/api/session/${second.id}/prompt`, 'POST', { text: 'QA_CASE=project-b' });
    await secondApi(`/api/experimental/session/${second.id}/wait`, 'POST');
    const secondCapture = latestPrimary('project-b');
    assert(secondCapture.system.includes('PROJECT_B_POLICY tester'), 'project B did not use its independent definition');
    assert(secondCapture.system.includes('PROJECT_B_AGENTS_MARKER') && !secondCapture.system.includes(AGENTS_MARKER), 'project instruction state crossed locations');
    assert(!secondCapture.system.includes('QA_TEMPLATE=family'), 'project A template leaked into B');
    writeFileSync(secondDefinition, '{ broken-json', { mode: 0o600 });
    const before = captures.length;
    const rejected = await secondApi(`/api/session/${second.id}/prompt`, 'POST', { text: 'QA_CASE=project-b-invalid' }, { allowError: true });
    assert(rejected.status >= 400 && captures.length === before, 'invalid project B definition reached a model');
    await submit(rulesSession.id, 'project-a-after-b-invalid');
    const firstCapture = latestPrimary('project-a-after-b-invalid');
    assert(firstCapture.system.includes('QA_TEMPLATE=family') && firstCapture.system.includes(AGENTS_MARKER) && !firstCapture.system.includes('PROJECT_B_POLICY'), 'project B failure poisoned project A');
    return { separateBody: true, separateRules: true, invalidBDoesNotPoisonA: true };
  });
  for (const safety of [
    { name: 'definition-log-collision', options: { logFile: '.qa/definition.jsonc' }, protectedFile: definitionPath, slot: 'logFile' },
    { name: 'template-log-collision', options: { logFile: 'templates/family.md' }, protectedFile: join(project, 'templates', 'family.md'), slot: 'logFile' },
    { name: 'unknown-option-typo', options: { enabeld: false }, protectedFile: definitionPath, slot: 'enabeld' },
  ]) {
    await caseRecord(safety.name, { rejected: true, modelCallDelta: 0, inputBytesUnchanged: true, diagnosticSlot: safety.slot, repaired: true }, async () => {
      const original = readFileSync(safety.protectedFile);
      const stderrBefore = hostLog.length;
      writeConfig('full', safety.options);
      await waitFor(`${safety.name} rejection guard active`, async () => hostLog.slice(stderrBefore).includes(`"slot":"${safety.slot}"`), 20_000, 1000);
      const session = await createSession({ agent: 'tester', model: { providerID: 'mock', id: 'gpt-x' }, title: `QA ${safety.name}` });
      const before = captures.length;
      const attempt = await prompt(session.id, `QA_CASE=${safety.name}`, { allowError: true });
      assert(attempt.status >= 400, 'unsafe plugin options were accepted');
      assert.equal(captures.length - before, 0, 'unsafe options reached a model');
      assert(readFileSync(safety.protectedFile).equals(original), 'diagnostics modified a user input file');
      assert.equal((await sessionContext(session.id)).filter((message) => message.type === 'user').length, 0, 'unsafe options admitted user input');
      const logBefore = readJsonl(logPath).length;
      writeConfig('full');
      await waitFor(`${safety.name} repaired generation active`, async () => readJsonl(logPath).slice(logBefore).some((record) => record.phase === 'startup' && record.code === 'ok'), 20_000, 1000);
      await submit(session.id, `repair-${safety.name}`);
      assert(managed(latestPrimary(`repair-${safety.name}`).system), 'options repair did not restore the managed prompt');
      return { rejected: true, httpStatus: attempt.status, modelCallDelta: 0, inputBytesUnchanged: true, diagnosticSlot: safety.slot, repaired: true };
    });
  }
  // Summary + explicit uncertainty register.
  const kinds = captures.reduce((counts, capture) => ({ ...counts, [capture.kind]: (counts[capture.kind] ?? 0) + 1 }), {});
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  report.modelCalls = { total: captures.length, primary: kinds.primary ?? 0, title: kinds.title ?? 0 };
  report.log = { file: '.qa/prompts.log.jsonl', records: logText.split('\n').filter(Boolean).length, sha256: sha(logText), secretsAbsent: !logText.includes(SECRET_BODY) && !logText.includes(SECRET_SLOT), diagnostics: readJsonl(logPath).filter((record) => !['ok', 'unmanaged', 'restored'].includes(record.code)).slice(-40) };
  report.uncertainties = [
    'Native read/write carry codemode:false in v2.0.24 (packages/core/src/tool.ts splits direct vs Code Mode definitions; read.ts/write.ts set codemode:false), so they are model-visible directly and are not callable inside execute/Code Mode. The freshness case uses two direct native tool calls; a Code Mode variant is not encoded rather than inventing catalog args.',
    'Blocked admissions are asserted as HTTP status >= 400; the exact status is recorded but not pinned.',
    'Title captures are classified by the title-generator system prefix and never consume case plans.',
    'Config-watcher convergence after plugin toggle edits is bounded at 1s checks up to 20s and verified through plugin list + agent metadata before behavior assertions.',
    'AGENTS.md discovery depends on project root detection; the fixture git-inits the project directory to stabilize the instruction walk.',
  ];
  assert(report.modelCalls.title >= 1, 'no title request was captured');
  assert(report.log.secretsAbsent, 'synthetic secret leaked into log');
  const failed = report.cases.filter((entry) => entry.verdict === 'fail').map((entry) => entry.name);
  if (failed.length > 0) throw new Error(`QA case failures: ${failed.join(', ')}`);
}

try {
  await main();
} catch (error) {
  fatal = error;
  report.failure = String(error?.stack ?? error).slice(0, 2000);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exitPromise?.catch(() => {});
    clearTimeout(timer);
  }
  report.cleanup.hostStopped = !server || server.exitCode !== null || server.signalCode !== null;
  mock.closeAllConnections();
  await new Promise((done) => mock.close(done));
  report.cleanup.mockStopped = true;
  try {
    report.binary.sha256 = sha(readFileSync(binary));
    report.binary.versionOutput = versionOutput;
    report.plugin.serverEntrySha256 = sha(readFileSync(join(pluginDir, 'server.js')));
    report.plugin.distSha256 = sha(readFileSync(join(pluginDir, 'dist/server.js')));
    if (project) report.hashes = { agentsMd: sha(readFileSync(join(project, 'AGENTS.md'))), familyTemplate: sha(readFileSync(join(project, 'templates', 'family.md'))), specificTemplate: sha(readFileSync(join(project, 'templates', 'specific.md'))), neighborPlugin: sha(readFileSync(join(neighborDir, 'server.js'))) };
  } catch (error) {
    report.failure = report.failure ?? `hash prelude failed: ${String(error?.message ?? error)}`;
  }
  if (project && existsSync(logPath)) report.log = { ...report.log, records: readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length, sha256: sha(readFileSync(logPath)) };
  if (sandbox) { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ } }
  report.cleanup.sandboxRemoved = sandbox ? !existsSync(sandbox) : true;
  report.hostLog = runPassword ? hostLog.replaceAll(runPassword, '[redacted]').slice(-4000) : hostLog.slice(-4000);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  console.log(`evidence: ${evidencePath}`);
  if (!fatal) console.log('QA driver finished: all contract checks executed (see case verdicts).');
}
if (fatal) { console.error(fatal); process.exitCode = 1; }
