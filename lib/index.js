/**
 * System One tools: three decision gates and the configuration that governs
 * them.
 *
 * Every gate turns a typed question about a bounded piece of state into a
 * policy decision. The provider answers with probabilities, so the thresholds
 * live in the schema below and are edited from the Settings > Plugins page,
 * which the settings service generates from this same schema.
 *
 * Design rules that hold here:
 * - a gate that cannot judge fails open and records why, so a provider outage
 *   never traps a session;
 * - nothing built from session content reaches the provider while a private
 *   marker is present;
 * - every judgement is recorded, with the state hashed and never stored.
 *
 * @module @kara/dsh-systemone-tools
 */
import crypto from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import os from 'node:os';
 import path from 'node:path';
 import { ask, defaultBaseURL, defaultModel } from './ask.js';
import { liveConfig } from './live.js';
import { makeRecorder, stateHash } from './log.js';
import { privateMarker } from './guard.js';
import { turnEvidence, textOf, clip } from './state.js';
import * as bashRisk from './tools/bash-risk.js';
import * as conclusion from './tools/conclusion.js';
import * as injection from './tools/injection.js';
import { registerTools } from './exposed.js';
import { plain } from './plain.js';

/** Profile entry id; the settings namespace the live read goes through. */
const NS = 'systemone-tools';
/** A gate is parked after this many consecutive provider failures. */
const BREAKER_FAILURES = 3;
const BREAKER_PARK_MS = 120_000;

export const name = 'systemone-tools';

export const Config = z.object({
  provider: z
    .union([z.const('systemone'), z.const('openai')])
    .default('systemone')
    .description('Como falar com o provedor: endpoint de decisao (systemone) ou chat compativel com OpenAI (openai).'),
  model: z.string().default(defaultModel('systemone')).description('Modelo de decisao usado pelos portoes.'),
  askBelow: z
    .number()
    .min(0)
    .max(1)
    .default(0.65)
    .description('Abaixo desta certeza a ferramenta nao decide sozinha: aplica a acao de baixa confianca do bloco.')
    .volatile(),
  timeoutMs: z.number().min(500).max(30_000).default(8_000).description('Prazo de cada chamada ao modelo de decisao.'),
  baseURL: z
    .string()
    .default('')
    .description('Endpoint do provedor. Vazio usa o padrao do adaptador: ' + defaultBaseURL('systemone') + ' para systemone, ' + defaultBaseURL('openai') + ' para openai.'),
  apiKeyEnv: z
    .string()
    .default('DECISION_API_KEY')
    .description('Nome da variavel de ambiente (ou da credencial no store do host) com a chave do provedor.'),
  jsonMode: z
    .boolean()
    .default(true)
    .description('Pede response_format json_object ao adaptador openai. Desligue em API que rejeita o campo.'),
  failOpen: z.boolean().default(true).description('Falha do provedor libera a acao. Desligar transforma erro em bloqueio.'),
  privacy: z
    .object({
      guard: z.boolean().default(true).description('Nao envia estado que contenha marcador de dado privado.'),
      action: z.union([z.const('skip'), z.const('deny')]).default('skip').description('O que fazer quando a guarda dispara.'),
      markers: z
        .array(z.string())
        .default([])
        .description('Trechos que nunca podem sair do processo: nomes de arquivo, caminhos e stores privados da sua instalacao.'),
    })
    .description('Guarda de privacidade.'),
  log: z
    .object({
      enabled: z.boolean().default(true).description('Registra cada veredito em JSONL.'),
      dir: z
        .string()
        .default('')
        .description('Diretorio do log de auditoria. Vazio grava em systemone-logs dentro do diretorio temporario do sistema.'),
    })
    .description('Auditoria.'),
  conclusion: z
    .object({
      enabled: z.boolean().default(true).description('Checa se a mensagem final tem evidencia.'),
      blockBelow: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .description('Probabilidade minima de "nao sustentada" para devolver o turno ao agente.')
        .volatile(),
      maxRounds: z.number().min(0).max(5).default(2).description('Quantas vezes o checador pode devolver o mesmo turno.'),
      stateChars: z.number().min(1000).max(40_000).default(6_000).description('Orcamento de caracteres da evidencia enviada.'),
      includeTools: z
        .array(z.string())
        .default(['bash', 'write', 'edit', 'str_replace_editor', 'present'])
        .description('Ferramentas cuja saida conta como evidencia.'),
      onLowConfidence: z.union([z.const('log'), z.const('allow')]).default('log').description('Acao quando a certeza fica abaixo de askBelow.'),
    })
    .description('Checador de conclusao.'),
  bashRisk: z
    .object({
      enabled: z.boolean().default(true).description('Julga comandos que escrevem ou apagam antes de executar.'),
      blockAtRisk: z
        .number()
        .min(0)
        .max(3)
        .default(2)
        .description('Nota de risco a partir da qual o comando e barrado.')
        .volatile(),
      scopeBelow: z
        .number()
        .min(0)
        .max(1)
        .default(0.75)
        .description('Escopo minimo para o comando contar como o que o usuario pediu.')
        .volatile(),
      inspectPatterns: z
        .array(z.string())
        .default(['rm ', 'mv ', 'dd ', 'truncate', 'chmod -R', 'chown -R', 'git reset --hard', 'git clean', 'apt', 'docker', 'pkill', 'kill ', 'npm i -g', '>'])
        .description('Trechos que fazem um comando ser inspecionado.'),
      exemptPatterns: z.array(z.string()).default([]).description('Trechos que dispensam inspecao. Enfraquece o porteiro.'),
      onLowConfidence: z.union([z.const('ask'), z.const('allow'), z.const('deny')]).default('ask').description('Acao quando a certeza fica abaixo de askBelow.'),
    })
    .description('Porteiro de risco do shell.'),
  injection: z
    .object({
      enabled: z.boolean().default(true).description('Filtra instrucoes escondidas em conteudo externo.'),
      tools: z.array(z.string()).default(['web_fetch']).description('Ferramentas cujo resultado passa pelo filtro.'),
      blockAbove: z
        .number()
        .min(0)
        .max(1)
        .default(0.6)
        .description('Probabilidade de instrucao explicita que remove o bloco.')
        .volatile(),
      noteAbove: z
        .number()
        .min(0)
        .max(1)
        .default(0.4)
        .description('Probabilidade a partir da qual o bloco fica anotado.')
        .volatile(),
      maxBlocks: z.number().min(1).max(100).default(20).description('Teto de blocos julgados por resultado.'),
      budgetMs: z.number().min(1000).max(120_000).default(20_000).description('Orcamento de tempo por resultado.'),
      blockChars: z.number().min(200).max(10_000).default(2_000).description('Tamanho maximo de cada bloco enviado.'),
      prefilter: z.string().default('(?i)(ignore|disregard|you are|system prompt|instru[cç][oõ]es anteriores|revele|execute|do not tell|n[aã]o mencione)').description('Pre-filtro lexical: so blocos que casam sao julgados.'),
    })
    .description('Filtro de injecao.'),
  tools: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .description('Registra as tres ferramentas chamaveis pelo modelo (risco de comando, checador de conclusao, filtro de injecao).'),
    })
    .description('Ferramentas sob demanda. Desligar exige recarregar o plugin.'),
});

const breakers = new Map();
const rounds = new Map();
const lastHash = new Map();

/**
 * Mount the three gates.
 *
 * @param {object} ctx - cordis context.
 * @param {object} applied - configuration resolved by the loader.
 */
export function apply(ctx, applied) {
  const fallback = plain(applied ?? {});
  const configOf = () => plain(liveConfig(ctx, NS, fallback));

  // One record per mount: proves which process loaded the gates and with which
  // flags, and is the only observable signal of a live patch reload.
  try {
    const config = configOf();
    makeRecorder(logDirOf(config), config.log?.enabled !== false)({
      kind: 'mount',
      version: '0.3.0',
      model: config.model,
      askBelow: config.askBelow,
      settingsService: typeof ctx.get === 'function' && ctx.get('settings') !== undefined,
      conclusion: config.conclusion?.enabled === true,
      bashRisk: config.bashRisk?.enabled === true,
      injection: config.injection?.enabled === true,
      tools: config.tools?.enabled === true,
    });
  } catch {
    /* a diagnostic must never prevent the gates from mounting */
  }

  const judge = async (tool, state, questions, signal) => {
    const config = configOf();
    const record = makeRecorder(logDirOf(config), config.log?.enabled !== false);
    const marker = config.privacy?.guard === false ? undefined : privateMarker(state, config.privacy?.markers ?? []);
    if (marker !== undefined) {
      record({ kind: 'call', tool, action: 'skip', reason: 'private-marker', marker });
      return { skipped: 'private', marker };
    }
    const breaker = breakers.get(tool) ?? { failures: 0, openUntil: 0 };
    if (Date.now() < breaker.openUntil) {
      record({ kind: 'call', tool, action: 'skip', reason: 'circuit-open' });
      return { skipped: 'circuit' };
    }
    const apiKey = await resolveKey(ctx, config.apiKeyEnv);
    if (apiKey === undefined) {
      record({ kind: 'call', tool, action: 'skip', reason: 'no-key' });
      return { skipped: 'no-key' };
    }
    const started = Date.now();
    try {
      const payload = await ask({
        provider: config.provider,
        baseURL: config.baseURL,
        jsonMode: config.jsonMode,
        apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
        state,
        questions,
        signal,
      });
      breakers.set(tool, { failures: 0, openUntil: 0 });
      record({
        kind: 'call',
        tool,
        action: 'answered',
        model: payload.model ?? config.model,
        stateHash: stateHash(state),
        chars: state.length,
        ms: Date.now() - started,
        answers: payload.answers,
      });
      return { answers: payload.answers, model: payload.model ?? config.model };
    } catch (error) {
      breaker.failures += 1;
      if (breaker.failures >= BREAKER_FAILURES) breaker.openUntil = Date.now() + BREAKER_PARK_MS;
      breakers.set(tool, breaker);
      record({
        kind: 'call',
        tool,
        action: 'error',
        reason: clip(String(error?.message ?? error), 200),
        stateHash: stateHash(state),
        ms: Date.now() - started,
      });
      return { failed: String(error?.message ?? error) };
    }
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const config = configOf();
      const section = config.bashRisk;
      if (section?.enabled !== true) return await next();
      if (!bashRisk.toolNames.includes(exec.name)) return await next();
      const command = exec.arguments?.command;
      if (typeof command !== 'string' || !bashRisk.shouldInspect(command, section)) return await next();

      const state = bashRisk.buildState({
        command,
        cwd: cwdOf(exec.agent),
        request: lastUserText(exec.agent),
      });
      const outcome = await judge('bashRisk', state, bashRisk.questions, exec.signal);
      if (outcome.answers === undefined) {
        if (config.failOpen === false) {
          return { kind: 'deny', reason: `Porteiro de risco indisponivel (${outcome.skipped ?? outcome.failed}); failOpen esta desligado.` };
        }
        return await next();
      }

      const decision = bashRisk.decide(outcome.answers, section, config.askBelow, section.onLowConfidence);
      makeRecorder(logDirOf(config), config.log?.enabled !== false)({
        kind: 'decision',
        tool: 'bashRisk',
        action: decision.action,
        risk: decision.risk,
        scope: Number(decision.scope?.toFixed?.(3) ?? decision.scope),
        certainty: Number(decision.certainty?.toFixed?.(3) ?? decision.certainty),
        commandHash: stateHash(command),
        model: outcome.model,
      });

      if (decision.action === 'deny') return { kind: 'deny', reason: decision.reason };
      if (decision.action === 'ask') {
        return { kind: 'ask', reason: decision.reason, displayReason: { en: decision.reason, 'pt-BR': decision.reason } };
      }
      return await next();
    } catch (error) {
      ctx.logger?.('systemone-tools')?.warn?.(`bash gate failed: ${error?.message ?? error}`);
      return await next();
    }
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const config = configOf();
      const section = config.injection;
      if (section?.enabled !== true) return await next();
      if (!section.tools.includes(exec.name)) return await next();
      if (result?.isError === true) return await next();

      const text = textOf(result.content);
      if (text.trim().length === 0) return await next();
      const candidates = injection.blocks(text, section);
      if (candidates.length === 0) return await next();

      const originals = text.split(/\n\s*\n/).map((part) => part.trim());
      const deadline = Date.now() + section.budgetMs;
      const verdicts = [];
      for (const candidate of candidates) {
        if (Date.now() > deadline) break;
        const state = `ORIGEM:\n${clip(sourceOf(exec.arguments), 300)}\nTRECHO:\n${candidate.text}`;
        const outcome = await judge('injection', state, injection.questions, exec.signal);
        if (outcome.answers === undefined) continue;
        verdicts.push({ index: candidate.index, ...injection.decide(outcome.answers, section) });
      }

      const changed = verdicts.filter((verdict) => verdict.action !== 'keep');
      if (changed.length === 0) return await next();

      const { text: rewritten, removed, noted } = injection.rewrite(text, verdicts, originals);
      makeRecorder(logDirOf(config), config.log?.enabled !== false)({
        kind: 'decision',
        tool: 'injection',
        action: removed > 0 ? 'remove' : 'note',
        removed,
        noted,
        judged: verdicts.length,
        candidates: candidates.length,
      });
      return { kind: 'accept', content: [{ type: 'text', text: rewritten }] };
    } catch (error) {
      ctx.logger?.('systemone-tools')?.warn?.(`injection filter failed: ${error?.message ?? error}`);
      return await next();
    }
  });

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const config = configOf();
      const section = config.conclusion;
      if (section?.enabled !== true) return;
      const agent = payload?.agent;
      const turn = payload?.turn;
      if (agent === undefined || typeof agent.steer !== 'function') return;

      const key = `${agent.session?.id ?? 'session'}:${turn}`;
      const round = rounds.get(key) ?? 0;
      if (round >= section.maxRounds) return;

      const events = eventsOf(agent);
      const finalText = finalAssistantText(events, turn);
      const evidence = turnEvidence({ events, turn, budget: section.stateChars, includeTools: section.includeTools });
      const hadToolCalls = /^TOOL /m.test(evidence);
      if (!conclusion.shouldJudge({ hadToolCalls, finalText })) return;

      const hash = stateHash(evidence);
      if (lastHash.get(key) === hash) return;

      const outcome = await judge('conclusion', evidence, conclusion.questions, payload.signal);
      if (outcome.answers === undefined) {
        if (config.failOpen === false) {
          rounds.set(key, round + 1);
          agent.steer(corrective(`Checador de conclusao indisponivel (${outcome.skipped ?? outcome.failed}). Declare a evidencia voce mesmo ou trate como pendencia.`));
        }
        return;
      }

      const decision = conclusion.decide(outcome.answers, section, config.askBelow);
      makeRecorder(logDirOf(config), config.log?.enabled !== false)({
        kind: 'decision',
        tool: 'conclusion',
        action: decision.action,
        unsupported: Number(decision.unsupported?.toFixed?.(3) ?? decision.unsupported),
        certainty: Number(decision.certainty?.toFixed?.(3) ?? decision.certainty),
        stateHash: hash,
        turn,
        model: outcome.model,
      });

      if (decision.action !== 'steer') return;
      lastHash.set(key, hash);
      rounds.set(key, round + 1);
      prune();
      agent.steer(corrective(decision.reason));
    } catch (error) {
      ctx.logger?.('systemone-tools')?.warn?.(`conclusion gate failed: ${error?.message ?? error}`);
    }
  });

  // The tools are optional to this plugin. `inject` keeps the gates mounted even
  // when the tool registry is absent or arrives later, which is why this is a
  // child scope instead of `export const inject = ['tools']`: a hard dependency
  // there would leave the whole entry pending until the registry showed up.
  if (configOf().tools?.enabled === false) return;
  const mountTools = (toolsCtx) => registerTools(toolsCtx, { configOf, judge });
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['tools'], mountTools);
    else if (ctx.tools !== undefined) mountTools(ctx);
  } catch (error) {
    ctx.logger?.('systemone-tools')?.warn?.(`tool registration failed: ${error?.message ?? error}`);
  }
}

/** A corrective user message the loop will consume at its next step. */
function corrective(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `[checador de conclusao] ${text}` }],
    source: {
      kind: 'systemone-conclusion',
      form: 'notice',
      summary: 'o checador de conclusao pediu evidencia antes de fechar o turno',
    },
  };
}

/** @param {object} ctx @param {string} envName */
async function resolveKey(ctx, envName) {
  try {
    const credentials = ctx.get?.('credentials');
    const resolved = await credentials?.resolve?.(envName);
    if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Where the audit log goes when the configuration leaves the directory empty. */
function logDirOf(config) {
  const configured = config.log?.dir;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : path.join(os.tmpdir(), 'systemone-logs');
}

/** Session events, bounded to the recent tail. */
function eventsOf(agent) {
  try {
    const all = agent?.session?.snapshotEvents?.(0) ?? [];
    return Array.isArray(all) ? all.slice(-400) : [];
  } catch {
    return [];
  }
}

/** The last assistant text of one turn, raw. */
function finalAssistantText(events, turn) {
  let text = '';
  for (const event of events) {
    const data = event?.data ?? {};
    if (event?.type !== 'assistant/message') continue;
    const eventTurn = data.turn ?? event.turn;
    if (eventTurn !== undefined && eventTurn !== turn) continue;
    const value = textOf(data.message?.content);
    if (value.trim().length > 0) text = value;
  }
  return text;
}

/** The user's own words this turn, which give a command its scope. */
function lastUserText(agent) {
  try {
    const events = eventsOf(agent);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user/message') continue;
      const text = textOf(event.data?.message?.content);
      if (text.trim().length > 0) return clip(text, 400);
    }
  } catch {
    /* fall through */
  }
  return '';
}

function cwdOf(agent) {
  try {
    return agent?.options?.cwd ?? agent?.session?.header?.cwd ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

function sourceOf(args) {
  if (args === null || typeof args !== 'object') return '(desconhecida)';
  const url = args.url ?? args.href ?? args.command;
  return typeof url === 'string' ? url : JSON.stringify(args).slice(0, 200);
}

/** Keep the per-turn maps small. */
function prune() {
  for (const map of [rounds, lastHash]) {
    if (map.size <= 200) continue;
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}
