#!/usr/bin/env node
/**
 * qa/restart-resume.mjs — live regression for the region-missing restart bug.
 *
 * Reproduces the host path that used to block: turns are in flight when the
 * server dies, so boot resumes them through `session.synthetic`, which bypasses
 * the `prompt` hook. The first model requests then reach `session.context`
 * with a native system and no owned markers.
 *
 * Two sessions share one managed agent so the second recovery must reuse the
 * pre-takeover native snapshot captured by the first, not read the registry
 * after it was already seeded. A neighbor plugin registered before this one
 * unshifts a guard part, proving recovery replaces only the native role part.
 *
 * Run: `node qa/restart-resume.mjs` (override with OPENCODE_V2_BINARY=...).
 * Isolated HOME/XDG/config/db/tmp and a loopback mock provider; no production
 * config, credential, service or port is touched.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Any v2 binary works; the production path is the managed `serve --service` mode.
const binary = process.env.OPENCODE_V2_BINARY ?? 'opencode2';

const BODY = 'RESTART_OWNED_BODY';
const NATIVE = 'RESTART_NATIVE_SYSTEM';
const GUARD = 'RESTART_GUARD_PART';
const GUARD_TWO = 'RESTART_SECOND_GUARD_PART';
const PREFIX = 'RESTART_ROLE_PREFIX';
const SUFFIX = 'RESTART_ROLE_SUFFIX';
const TAIL = 'RESTART_NEIGHBOR_TAIL';
const CASE = 'restart-resume';
const DONE = 'QA_FINISHED restart-resume';
const MARKER = '<<<opencode-prompts|';
const systemMode = process.env.QA_SYSTEM_MODE ?? 'configured';
assert(['configured', 'omitted', 'empty'].includes(systemMode), `unknown QA_SYSTEM_MODE: ${systemMode}`);
const neighborMode = process.env.QA_NEIGHBOR_MODE ?? 'parts';
assert(['parts', 'wrapped'].includes(neighborMode), `unknown QA_NEIGHBOR_MODE: ${neighborMode}`);

let sandbox;
let project;
let configDir;
let neighborDir;
let logPath;
let definitionPath;
let env;
let port;
let password;
let server;
let exitPromise;
let hostLog = '';
const captures = [];
const held = new Set();

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('\n')
      : JSON.stringify(content);
const readJsonl = (path) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [{ parseError: true }];
          }
        })
    : [];

async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve().then(check).catch(() => false);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await pause(intervalMs);
  }
}

function respond(response, body, answer) {
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'qa-restart',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({ id: 'qa-restart', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`,
    );
  emit({ role: 'assistant' });
  emit({ content: answer });
  emit({}, 'stop');
  response.end('data: [DONE]\n\n');
}

const mock = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const messages = body.messages ?? [];
  const system = messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n');
  const kind = system.includes('You are a title generator.') ? 'title' : 'primary';
  const sessionID = String(request.headers['x-opencode-session-id'] ?? 'unknown');
  const capture = { sessionID, kind, model: body.model, system, messages, at: Date.now(), held: false, resumed: false };
  captures.push(capture);
  if (kind === 'title') return respond(response, body, 'QA synthetic title');
  if (!held.has(sessionID)) {
    // Hold the first turn of each session open so the server dies with a
    // durable execution claim and boot has something to resume.
    held.add(sessionID);
    capture.held = true;
    return;
  }
  capture.resumed = true;
  respond(response, body, DONE);
});

function neighborPluginSource() {
  return `export default {
  id: 'qa-restart-neighbor',
  async setup(ctx) {
    const registration = await ctx.session.hook('context', (event) => {
      if (${neighborMode === 'wrapped'}) {
        const role = event.system[0];
        if (role) role.text = '${PREFIX}\\n' + role.text + '\\n${SUFFIX}';
      }
      event.system.unshift({ type: 'text', text: '${GUARD_TWO}' });
      event.system.unshift({ type: 'text', text: '${GUARD}' });
      const last = event.system[event.system.length - 1];
      if (last) last.text = last.text + '\\n${TAIL}';
    });
    return () => registration.dispose();
  },
};
`;
}

function buildFixtures() {
  const dirs = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map((name) => [name, join(sandbox, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  configDir = dirs.config;
  project = join(sandbox, 'project');
  const qaDir = join(project, '.qa');
  for (const dir of [project, qaDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  definitionPath = join(qaDir, 'definition.jsonc');
  logPath = join(qaDir, 'prompts.log.jsonl');
  neighborDir = join(sandbox, 'neighbor');
  mkdirSync(neighborDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(neighborDir, 'server.js'), neighborPluginSource(), { mode: 0o600 });
  writeFileSync(join(project, 'AGENTS.md'), '# Synthetic restart QA\n', { mode: 0o600 });
  writeFileSync(definitionPath, JSON.stringify({
    version: 1,
    agents: {
      tester: {
        template: `${BODY}\nQA_MODEL=GPT {{model}}`,
        slots: { model: { runtime: 'model' } },
        rules: [{ models: ['mock/kimi-*'], template: `${BODY}\nQA_MODEL=KIMI {{model}}` }],
      },
    },
  }, null, 2), { mode: 0o600 });
  execFileSync('git', ['init', '-q'], { cwd: project });
  return dirs;
}

function writeConfig() {
  const modelSpec = (id) => ({
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: '2025-01-01',
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
  });
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/gpt-x',
    default_agent: 'tester',
    permission: 'allow',
    update: 'disable',
    snapshots: false,
    plugins: [
      { package: neighborDir },
      { package: repo, options: { definition: '.qa/definition.jsonc', logFile: '.qa/prompts.log.jsonl' } },
    ],
    provider: {
      mock: {
        name: 'Mock',
        id: 'mock',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: { 'gpt-x': modelSpec('gpt-x'), 'kimi-x': modelSpec('kimi-x') },
        options: { apiKey: 'qa-synthetic-key', baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      },
    },
    agents: {
      tester: {
        description: 'QA restart role',
        mode: 'primary',
        ...(systemMode === 'omitted' ? {} : { system: systemMode === 'empty' ? '' : NATIVE }),
      },
    },
  };
  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
}

const api = async (endpoint, method = 'GET', body, options = {}) => {
  const url = new URL(endpoint, `http://127.0.0.1:${port}`);
  url.searchParams.set('location[directory]', options.directory ?? project);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!options.allowError) assert(response.ok, `${method} ${endpoint}: ${response.status} ${String(text).slice(0, 200)}`);
  return { status: response.status, ok: response.ok, json };
};

async function startServer() {
  hostLog = '';
  server = spawn(binary, ['serve', '--service', '--hostname', '127.0.0.1', '--port', String(port)], {
    env,
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exitPromise = once(server, 'exit');
  server.stdout.on('data', (chunk) => {
    hostLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    hostLog += chunk.toString();
  });
  await waitFor('isolated server up', async () => (await api('/api/info', 'GET', undefined, { allowError: true })).ok, 45_000, 250);
  await waitFor(
    'o3p.prompt.templates active',
    async () => {
      const list = (await api('/api/plugin')).json.data ?? [];
      return list.some((plugin) => plugin.id === 'o3p.prompt.templates' && plugin.state?.status === 'active');
    },
    45_000,
    250,
  );
}

async function killServer() {
  server.kill('SIGKILL');
  await exitPromise.catch(() => {});
}

async function assistantText(sessionID) {
  const context = (await api(`/api/session/${sessionID}/context`)).json.data;
  return context
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function main() {
  sandbox = mkdtempSync(join(process.env.QA_TMPDIR ?? tmpdir(), 'o3p-restart-'));
  const dirs = buildFixtures();
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  writeConfig();
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  port = listener.address().port;
  await new Promise((done) => listener.close(done));
  assert(![4097, 4098].includes(port), `refusing production port ${port}`);
  password = 'qa-restart-password';
  env = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    OPENCODE_TEST_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp,
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCODE_DB: join(dirs.data, 'qa.db'),
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_AUTH_CONTENT: '{}',
    NO_COLOR: '1',
  };
  // `serve --service` takes its password from the service config, not the
  // environment, and keeps it across restarts.
  execFileSync(binary, ['service', 'set', 'password', password], { env, encoding: 'utf8' });
  const versionOutput = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  assert(/opencode v2\.\d+\.\d+/.test(versionOutput), `unexpected binary version: ${versionOutput}`);

  await startServer();
  const create = async (title, model) =>
    (await api('/api/session', 'POST', { location: { directory: project }, agent: 'tester', model: { providerID: 'mock', id: model }, title })).json.data;
  const sessions = [await create('QA restart A', 'gpt-x'), await create('QA restart B', 'kimi-x')];
  await Promise.all(sessions.map((session) => api(`/api/session/${session.id}/prompt`, 'POST', { text: `QA_CASE=${CASE}` })));
  await waitFor('two held primary requests', () => captures.filter((capture) => capture.kind === 'primary' && capture.held).length >= 2, 30_000, 100);
  const first = captures.filter((capture) => capture.kind === 'primary' && capture.held);
  for (const capture of first) {
    assert(capture.system.includes(BODY), 'first request was not managed');
    assert(capture.system.includes(GUARD), 'first request lost the neighbor guard');
    assert(!capture.system.includes(NATIVE), 'first request kept the native system');
    assert.equal(capture.system.split(MARKER).length - 1, 2, 'first request has an invalid owned region');
  }
  await pause(1000);

  const logBeforeRestart = readJsonl(logPath).length;
  await killServer();
  await startServer();
  await pause(500);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (captures.filter((capture) => capture.kind === 'primary' && capture.resumed).length >= 2) break;
    const records = readJsonl(logPath).slice(logBeforeRestart);
    const blocked = records.find((record) => record.phase === 'context' && record.code === 'region-missing');
    if (blocked !== undefined) throw new Error(`resumed request was blocked: ${JSON.stringify(blocked)}`);
    if (Date.now() >= deadline) throw new Error('timeout waiting for both resumed primary requests');
    await pause(250);
  }
  await Promise.all(sessions.map((session) => api(`/api/experimental/session/${session.id}/wait`, 'POST')));

  const resumed = captures.filter((capture) => capture.kind === 'primary' && capture.resumed);
  assert.equal(resumed.length, 2, 'expected one resumed request per session');
  for (const capture of resumed) {
    assert(capture.system.includes(BODY), 'resumed request kept the native system');
    assert(capture.system.includes(GUARD), 'resumed request lost the neighbor guard part');
    assert(capture.system.includes(GUARD_TWO), 'resumed request lost the second neighbor guard part');
    if (neighborMode === 'wrapped') {
      assert(capture.system.includes(PREFIX), 'resumed request lost the role prefix');
      assert(capture.system.includes(SUFFIX), 'resumed request lost the role suffix');
    }
    assert(capture.system.includes(TAIL), 'resumed request lost the neighbor tail');
    assert(!capture.system.includes(NATIVE), 'resumed request still carries the native role body');
    assert(!capture.system.includes('You are an AI agent running in OpenCode'), 'resumed request kept the host default role body');
    const family = capture.model === 'kimi-x' ? 'KIMI' : 'GPT';
    assert(capture.system.includes(`QA_MODEL=${family}`), 'resumed request used another model template');
    assert(capture.system.includes(`"id": "${capture.model}"`), 'resumed model binding is stale');
    assert.equal(capture.system.split(MARKER).length - 1, 2, 'resumed request does not have exactly one owned pair');
    assert(capture.system.includes('|begin>>>') && capture.system.includes('|end>>>'), 'resumed request has no owned region');
    assert(capture.system.indexOf(GUARD) < capture.system.indexOf(BODY), 'owned region moved before the neighbor guard');
    assert(
      capture.messages.some((message) => message.role === 'user' && textOf(message.content).includes('The server restarted')),
      'resumed request does not carry the restart synthetic prompt',
    );
  }
  const records = readJsonl(logPath).slice(logBeforeRestart);
  const reseeded = records.filter((record) => record.phase === 'context' && record.code === 'reseeded');
  assert.equal(reseeded.length, 2, `expected two context reseeds, saw ${JSON.stringify(reseeded)}`);
  assert(!records.some((record) => record.phase === 'context' && record.code === 'region-missing'), 'region-missing was logged');
  const admissions = records.filter((record) => record.phase === 'admission' && record.code === 'ok');
  assert.equal(admissions.length, 0, `resume path unexpectedly admitted first: ${JSON.stringify(admissions)}`);
  const answers = await Promise.all(sessions.map((session) => assistantText(session.id)));
  assert(answers.every((answer) => answer.includes(DONE)), 'a resumed turn produced no assistant answer');

  const summary = {
    verdict: 'pass',
    systemMode,
    neighborMode,
    models: resumed.map((capture) => capture.model).sort(),
    sessions: sessions.map((session) => session.id),
    firstAt: first.map((capture) => new Date(capture.at).toISOString()),
    resumedAt: resumed.map((capture) => new Date(capture.at).toISOString()),
    reseeded: reseeded.length,
    admissionsOnResume: admissions.length,
    guardPreserved: resumed.every((capture) => capture.system.includes(GUARD)),
    tailPreserved: resumed.every((capture) => capture.system.includes(TAIL)),
    nativeRemoved: resumed.every((capture) => !capture.system.includes(NATIVE)),
    answers: answers.filter((answer) => answer.includes(DONE)).length,
    logRecordsBeforeRestart: logBeforeRestart,
    version: versionOutput,
  };
  const evidence = join(repo, `.omo/evidence/restart-resume-${systemMode}-${neighborMode}.json`);
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`[pass] restart-resume ${JSON.stringify(summary)} evidence: ${evidence}`);
}

try {
  await main();
} catch (error) {
  console.error(`[fail] restart-resume: ${String(error?.stack ?? error).slice(0, 2000)}`);
  if (hostLog) console.error(`host log tail:\n${hostLog.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exitPromise?.catch(() => {});
    clearTimeout(timer);
  }
  mock.closeAllConnections();
  await new Promise((done) => mock.close(done));
  if (sandbox !== undefined) {
    if (process.env.KEEP === '1') console.log(`sandbox kept: ${sandbox}`);
    else rmSync(sandbox, { recursive: true, force: true });
  }
}
