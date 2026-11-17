#!/usr/bin/env node
/**
 * Self-test for the gates and the three tools.
 *
 * Everything here runs against a local fake endpoint: transport, policy,
 * thresholds, actions, the privacy guard, the circuit breaker, the audit log
 * and the two-turn evidence window, with no provider credit spent and no
 * network access.
 *
 *   node test/selftest.mjs
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/index.js';
import * as plugin from '../lib/index.js';
import { plain } from '../lib/plain.js';
import { resetLiveConfig } from '../lib/live.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(HERE, 'cases/selftest.jsonl');
const KEY = 'DECISION_API_KEY';

/** Marker the suite configures and the guard must never send. */
const PRIVATE_MARKER = 'secrets.env';

const cases = fs
  .readFileSync(CATALOG, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('//'))
  .map((line) => JSON.parse(line));

/** A fake decision endpoint: it answers the probability set the case declared. */
function startFake() {
  const state = { calls: 0, lastState: '' };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      state.calls += 1;
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{ id: 'typesafe/jev', decision: true }, { id: 'chat/model', decision: false }]));
        return;
      }
      if (body.includes('#fake:fail')) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic failure' }));
        return;
      }
      const payload = JSON.parse(body);
      state.lastState = payload.state ?? '';
      const answers = extractFake(payload.state ?? '') ?? { erro: { type: 'noul', noul: 0.5 } };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: payload.model, answers, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${address.port}/systemone` });
    });
  });
}

function fakeContext() {
  const handlers = new Map();
  const registered = new Map();
  const ctx = {
    handlers,
    registered,
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    get() {
      return undefined;
    },
    logger() {
      return { warn() {} };
    },
  };
  return ctx;
}

function fakeAgent(events) {
  const steered = [];
  return {
    steered,
    session: { id: 'selftest', header: { cwd: process.cwd() }, snapshotEvents: () => events },
    options: {},
    steer(message) {
      steered.push(message);
    },
  };
}

const allow = async () => ({ kind: 'allow' });

/** Pull the JSON object that follows `#fake:` out of a state, brace-balanced. */
function extractFake(text) {
  const start = text.indexOf('#fake:');
  if (start === -1) return undefined;
  const open = text.indexOf('{', start);
  if (open === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

async function runCase(ctx, testCase) {
  const handlers = ctx.handlers;
  if (testCase.tool === 'bashRisk') {
    const exec = {
      name: 'bash',
      arguments: { command: testCase.command },
      agent: fakeAgent(testCase.events ?? []),
      signal: AbortSignal.timeout(10_000),
    };
    const decision = await handlers.get('tools/pre-execute')(exec, allow);
    return { decision: { kind: decision?.kind ?? 'allow' } };
  }
  if (testCase.tool === 'injection') {
    const exec = {
      name: 'web_fetch',
      arguments: { url: testCase.url ?? 'https://example.test/doc' },
      agent: fakeAgent([]),
      signal: AbortSignal.timeout(10_000),
    };
    const result = { content: [{ type: 'text', text: testCase.content }], isError: false };
    const decision = await handlers.get('tools/post-execute')(exec, result, allow);
    return { decision: { kind: decision?.kind ?? 'allow' } };
  }
  if (testCase.tool === 'conclusion') {
    const agent = fakeAgent(testCase.events ?? []);
    await handlers.get('agent/turn-stopping')({ agent, turn: testCase.turn ?? 1, signal: AbortSignal.timeout(10_000) });
    return { steered: agent.steered.length };
  }
  if (testCase.tool.startsWith('tools.')) {
    const name = testCase.tool.slice('tools.'.length);
    const definition = ctx.registered.get(name);
    if (definition === undefined) throw new Error(`ferramenta nao registrada: ${name}`);
    const value = await definition.execute(testCase.args ?? {}, { signal: AbortSignal.timeout(10_000) });
    const keys = testCase.pick ?? [];
    return { tool: Object.fromEntries(keys.map((key) => [key, value?.[key]])) };
  }
  throw new Error(`caso sem ferramenta conhecida: ${testCase.tool}`);
}

function check(observed, expected) {
  const problems = [];
  for (const [key, value] of Object.entries(expected ?? {})) {
    const actual = observed?.[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      problems.push(`${key}: esperado ${JSON.stringify(value)}, obtido ${JSON.stringify(actual)}`);
    }
  }
  return problems;
}

const failures = [];
const fake = await startFake();
const logDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'systemone-selftest-'));
process.env[KEY] = process.env[KEY] ?? 'selftest-key';

const config = Config({
  provider: 'systemone',
  baseURL: fake.url,
  timeoutMs: 4000,
  privacy: { markers: [PRIVATE_MARKER] },
  log: { enabled: true, dir: logDir },
});

const ctx = fakeContext();
plugin.apply(ctx, config);

let passed = 0;
const expectedTools = ['systemone_command_risk', 'systemone_conclusion_check', 'systemone_injection_scan'];
const missingTools = expectedTools.filter((name) => !ctx.registered.has(name));
if (missingTools.length > 0) failures.push({ name: 'tools', problems: [`nao registradas: ${missingTools.join(', ')}`] });

for (const testCase of cases) {
  const observed = await runCase(ctx, testCase);
  const problems = check(observed, testCase.expect);
  if (problems.length === 0) passed += 1;
  else failures.push({ name: testCase.name, problems, observed });
}

// A claim at the end of a turn usually cites a measurement from the turn
// before, so both turns must reach the provider, separated and labelled.
fake.state.lastState = '';
await runCase(ctx, {
  tool: 'conclusion',
  turn: 2,
  events: [
    { type: 'tool/call', data: { turn: 1, callId: 'p1', name: 'bash', arguments: '{"command":"node test/selftest.mjs"}' } },
    {
      type: 'tool/result',
      data: { turn: 1, message: { toolCallId: 'p1', isError: false, content: [{ type: 'text', text: 'PREVIOUS-TURN-OUTPUT' }] } },
    },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'the previous check passed' }] } } },
  ],
});
const twoTurnState = fake.state.lastState ?? '';
if (!twoTurnState.includes('PREVIOUS-TURN-OUTPUT')) {
  failures.push({ name: 'evidencia-do-turno-anterior', problems: ['o estado nao trouxe a saida do turno anterior'] });
}
if (!twoTurnState.includes('PREVIOUS TURN (1)')) {
  failures.push({ name: 'evidencia-do-turno-anterior', problems: ['o estado nao separa turno anterior do atual'] });
}

// The privacy guard must stop the call before the wire, so the counter stays put.
const before = fake.state.calls;
await runCase(ctx, {
  tool: 'bashRisk',
  command: `cat ${PRIVATE_MARKER} #fake:{"risco":{"type":"score","score":3,"confidence":0.99},"escopo":{"type":"noul","noul":1,"confidence":0.99}}`,
});
const privateSkipped = fake.state.calls === before;
if (!privateSkipped) failures.push({ name: 'privacy-guard', problems: ['o marcador privado nao impediu a chamada'] });

// A settings save reports only the fields its form projects. That partial value
// must not switch the gates off, so the live value merges section by section.
resetLiveConfig();
const partial = fakeContext();
const plainGet = partial.get;
partial.get = (name) =>
  name === 'settings'
    ? { describe: () => [{ ns: 'systemone-tools', value: { bashRisk: { blockAtRisk: 0, scopeBelow: 0.75 } } }] }
    : plainGet(name);
plugin.apply(partial, config);
const partialDecision = await partial.handlers.get('tools/pre-execute')(
  {
    name: 'bash',
    arguments: {
      command: 'rm -rf ./build #fake:{"risco":{"type":"score","score":1.4,"confidence":0.9},"escopo":{"type":"noul","noul":0.95,"confidence":0.9}}',
    },
    agent: fakeAgent([]),
    signal: AbortSignal.timeout(10_000),
  },
  allow,
);
if (partialDecision?.kind !== 'deny') {
  failures.push({ name: 'config-parcial', problems: [`esperava deny com blockAtRisk 0, obtido ${partialDecision?.kind ?? 'allow'}`] });
}
resetLiveConfig();

// Circuit breaker: three failures park the gate; the fourth call never leaves.
const breakerBefore = fake.state.calls;
for (let index = 0; index < 4; index += 1) {
  await runCase(ctx, { tool: 'bashRisk', command: 'rm -rf ./tmp #fake:fail' });
}
const breakerCalls = fake.state.calls - breakerBefore;
if (breakerCalls > 3) failures.push({ name: 'circuit-breaker', problems: [`esperava 3 chamadas, houve ${breakerCalls}`] });

const logFiles = fs.readdirSync(logDir);
if (logFiles.length === 0) failures.push({ name: 'log', problems: ['nenhum log escrito'] });
const logged = logFiles.map((file) => fs.readFileSync(path.join(logDir, file), 'utf8')).join('');
const hasState = logged.includes(PRIVATE_MARKER);
if (hasState) failures.push({ name: 'log-privacy', problems: ['o log contem o texto enviado'] });

fake.server.close();
fs.rmSync(logDir, { recursive: true, force: true });

console.log(`selftest: ${passed}/${cases.length} casos, ${fake.state.calls} chamadas ao endpoint falso`);
console.log(`  guarda de privacidade: ${privateSkipped ? 'ok' : 'FALHOU'}`);
console.log(`  disjuntor: ${breakerCalls <= 3 ? 'ok' : 'FALHOU'} (${breakerCalls} chamadas com 4 tentativas)`);
console.log(`  log sem texto bruto: ${hasState ? 'FALHOU' : 'ok'}`);
for (const failure of failures) {
  console.error(`  ! ${failure.name}: ${failure.problems.join('; ')}`);
  if (failure.observed !== undefined) console.error(`    observado: ${JSON.stringify(failure.observed)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
