#!/usr/bin/env node
/**
 * qa/hot-reload.mjs — live regression for the seed-missing hot-reload bug.
 *
 * Starts an isolated OpenCode v2 service with a copy of this plugin, admits a
 * managed role once, then touches the copied plugin artifact to force a plugin
 * hot reload. The next request in the same session must not be blocked with
 * seed-missing and must carry the fresh generation's owned region.
 *
 * Run: `node qa/hot-reload.mjs` (override with OPENCODE_V2_BINARY=...).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.OPENCODE_V2_BINARY ?? 'opencode2';
const reloadMode = process.env.QA_RELOAD_MODE ?? 'artifact';
const BODY = 'HOT_RELOAD_OWNED_BODY';
const NATIVE = 'HOT_RELOAD_NATIVE_SYSTEM';
const MARKER = '<<<opencode-prompts|';

let sandbox;
let project;
let configDir;
let pluginDir;
let noopDir;
let logPath;
let definitionPath;
let env;
let port;
let password;
let server;
let exitPromise;
let hostLog = '';
const primaryCounts = new Map();

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

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('\n')
      : JSON.stringify(content);

function respond(response, body, answer) {
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'qa-hot-reload',
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
      `data: ${JSON.stringify({ id: 'qa-hot-reload', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`,
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
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n');
  const kind = system.includes('You are a title generator.') ? 'title' : 'primary';
  if (kind === 'title') return respond(response, body, 'QA hot reload title');
  const sessionID = String(request.headers['x-opencode-session-id'] ?? 'unknown');
  const count = (primaryCounts.get(sessionID) ?? 0) + 1;
  primaryCounts.set(sessionID, count);
  if (count === 1 && body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'qa-hot-reload', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_qa_reload', type: 'function', function: { name: 'shell', arguments: '{"command":"sleep 3"}' } }] });
    emit({}, 'tool_calls');
    response.end('data: [DONE]\n\n');
    return;
  }
  respond(response, body, 'HOT_RELOAD_OK');
});

async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve().then(check).catch(() => false);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await pause(intervalMs);
  }
}

function buildFixtures() {
  const dirs = Object.fromEntries(
    ['home', 'config', 'data', 'state', 'cache', 'tmp'].map((name) => [name, join(sandbox, name)]),
  );
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  configDir = dirs.config;
  project = join(sandbox, 'project');
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const qaDir = join(project, '.qa');
  mkdirSync(qaDir, { recursive: true, mode: 0o700 });
  definitionPath = join(qaDir, 'definition.jsonc');
  logPath = join(qaDir, 'prompts.log.jsonl');
  noopDir = join(sandbox, 'noop');
  mkdirSync(noopDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(noopDir, 'server.js'), "export default { id: 'qa-hot-reload-noop', async setup() { return () => {}; } };\n", { mode: 0o600 });
  pluginDir = join(sandbox, 'plugin');
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  cpSync(join(repo, 'dist'), join(pluginDir, 'dist'), { recursive: true });
  cpSync(join(repo, 'server.js'), join(pluginDir, 'server.js'));
  cpSync(join(repo, 'package.json'), join(pluginDir, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(pluginDir, 'node_modules'), 'dir');
  writeFileSync(join(project, 'AGENTS.md'), '# Synthetic hot-reload QA\n', { mode: 0o600 });
  writeFileSync(
    definitionPath,
    JSON.stringify({ version: 1, agents: { tester: { template: `${BODY}\nQA_MODEL={{model}}`, slots: { model: { runtime: 'model' } } } } }, null, 2),
    { mode: 0o600 },
  );
  execFileSync('git', ['init', '-q'], { cwd: project });
  return dirs;
}

function writeConfig(withNoop = false) {
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
      ...(withNoop ? [{ package: noopDir }] : []),
      { package: pluginDir, options: { definition: '.qa/definition.jsonc', logFile: '.qa/prompts.log.jsonl' } },
    ],
    provider: {
      mock: {
        name: 'Mock',
        id: 'mock',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: { 'gpt-x': modelSpec('gpt-x') },
        options: { apiKey: 'qa-synthetic-key', baseURL: `http://127.0.0.1:${mock.address().port}/v1` },
      },
    },
    agents: { tester: { description: 'QA hot reload role', mode: 'primary', system: NATIVE } },
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
  sandbox = mkdtempSync(join(process.env.QA_TMPDIR ?? tmpdir(), 'o3p-hot-reload-'));
  const dirs = buildFixtures();
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  writeConfig();
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  port = listener.address().port;
  await new Promise((done) => listener.close(done));
  assert(![4097, 4098].includes(port), `refusing production port ${port}`);
  password = 'qa-hot-reload-password';
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
  execFileSync(binary, ['service', 'set', 'password', password], { env, encoding: 'utf8' });
  const versionOutput = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  assert(/opencode v2\.\d+\.\d+/.test(versionOutput), `unexpected binary version: ${versionOutput}`);

  await startServer();
  const session = (
    await api('/api/session', 'POST', {
      location: { directory: project },
      agent: 'tester',
      model: { providerID: 'mock', id: 'gpt-x' },
      title: 'QA hot reload',
    })
  ).json.data;
  await api(`/api/session/${session.id}/prompt`, 'POST', { text: 'HOT_RELOAD_FIRST' });
  await waitFor('first primary request', () => (primaryCounts.get(session.id) ?? 0) >= 1, 30_000, 100);
  const before = readJsonl(logPath);
  assert(before.some((record) => record.phase === 'admission' && record.code === 'ok'), 'first admission did not seed');
  const firstContext = before.find((record) => record.phase === 'context' && record.code === 'ok');
  assert(firstContext !== undefined, 'first context was not ok');

  const beforeReload = before.length;
  if (reloadMode === 'config') {
    writeConfig(true);
    await waitFor('noop plugin active', async () => {
      const list = (await api('/api/plugin')).json.data ?? [];
      return list.some((plugin) => plugin.id === 'qa-hot-reload-noop' && plugin.state?.status === 'active');
    }, 15_000, 100);
  } else {
    const artifact = join(pluginDir, 'dist', 'server.js');
    appendFileSync(artifact, '\n// qa hot-reload trigger\n');
    await waitFor('plugin reload cleanup/startup', () => {
      const records = readJsonl(logPath).slice(beforeReload);
      return records.some((record) => record.phase === 'startup' && record.code === 'ok');
    }, 15_000, 100);
  }
  await waitFor('second primary request after reload', () => (primaryCounts.get(session.id) ?? 0) >= 2, 30_000, 100);
  await waitFor('final assistant answer', async () => (await assistantText(session.id)).includes('HOT_RELOAD_OK'), 30_000, 250);

  const prompt = await api(`/api/session/${session.id}/generate`, 'POST', { prompt: 'HOT_RELOAD_GENERATE' }, { allowError: true });
  const after = readJsonl(logPath).slice(beforeReload);
  const answer = typeof prompt.json?.data?.text === 'string' ? prompt.json.data.text : '';

  console.log(
    JSON.stringify(
      {
        version: versionOutput,
        secondStatus: prompt.status,
        secondBody: typeof prompt.json === 'string' ? prompt.json.slice(0, 400) : prompt.json,
        answer: answer.slice(-200),
        recordsAfterReload: after,
      },
      null,
      2,
    ),
  );

  assert.equal(prompt.ok, true, `second request failed: ${prompt.status}`);
  assert(after.some((record) => record.phase === 'context' && record.code === 'reseeded'), 'generate request did not reseed');
  assert(!after.some((record) => record.code === 'seed-missing'), 'seed-missing was logged after reload');
  assert(answer.includes('HOT_RELOAD_OK'), 'generate request produced no answer');
}

try {
  await main();
  console.log('[pass] hot-reload');
} catch (error) {
  console.error(`[fail] hot-reload: ${String(error?.stack ?? error).slice(0, 4000)}`);
  if (hostLog) console.error(`host log tail:\n${hostLog.slice(-6000)}`);
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
