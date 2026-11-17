/**
 * Adapter for any OpenAI-compatible chat API.
 *
 * The reference providers (Command Code's `/systemone`, and decision models in
 * general) answer with probabilities directly. Most APIs do not: they answer
 * with chat. This adapter asks a chat model for the same typed answer as JSON
 * and normalizes it back into the shape the gates consume.
 *
 * Honest limitation: a chat model's numbers are prompted, not calibrated. They
 * are useful for thresholds, not for measurements. Prefer a decision endpoint
 * when one exists.
 *
 * @module @kara/dsh-systemone-tools/adapters/openai
 */
export const id = 'openai';

/** Where this adapter posts when the configuration leaves `baseURL` empty. */
export const defaultBaseURL = 'https://api.openai.com/v1';

/** The model this adapter asks for by default. */
export const defaultModel = 'gpt-4o-mini';

const SYSTEM = [
  'You are a decision scorer inside an agent harness. You receive a STATE and typed QUESTIONS about it.',
  '',
  'Rules:',
  '- Answer with one JSON object. No prose, no code fences, no explanation.',
  '- Every probability is between 0 and 1. Choice probabilities sum to 1 across the named criteria.',
  '- confidence is your own certainty about that answer, 0 to 1.',
  '- Judge only what the state shows. If the state lacks what a question asks about, say so with low confidence instead of inventing evidence.',
  '',
  'Answer shape:',
  '{"answers": {"<question name>": <answer>}}',
  '',
  'Answer per question type:',
  '- score: {"type":"score","score":<number>,"confidence":<number>}, where the lowest criterion is 0 and the highest is 3.',
  '- noul: {"type":"noul","noul":<probability of yes>,"confidence":<number>}.',
  '- choice: {"type":"choice","probabilities":{"<criterion>":<number>},"confidence":<number>}.',
].join('\n');

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** @param {object} questions */
export function describeQuestions(questions) {
  const lines = ['QUESTIONS:'];
  for (const [name, spec] of Object.entries(questions)) {
    lines.push(`- ${name} (${spec.type}): ${spec.instructions}`);
    if (spec.criteria !== undefined && !Array.isArray(spec.criteria)) {
      for (const [criterion, meaning] of Object.entries(spec.criteria)) lines.push(`  - ${criterion}: ${meaning}`);
    } else if (Array.isArray(spec.criteria)) {
      spec.criteria.forEach((criterion, index) => lines.push(`  - ${index}: ${criterion}`));
    }
  }
  return lines.join('\n');
}

/** Message content may be a string or an array of text parts. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Strip a fenced block, which chat models add even when told not to. */
function unfence(text) {
  const trimmed = String(text ?? '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match === null ? trimmed : match[1];
}

/**
 * Turn a chat model's answer into the typed shape, dropping what it got wrong
 * so the calling gate can fall back honestly.
 *
 * @param {object} questions
 * @param {object} answers
 * @returns {object}
 */
export function normalize(questions, answers) {
  const result = {};
  for (const [name, spec] of Object.entries(questions)) {
    const answer = answers?.[name];
    if (answer === null || typeof answer !== 'object') continue;
    const confidence = Number(answer.confidence);
    const withConfidence = Number.isFinite(confidence) ? { confidence: clamp(confidence, 0, 1) } : {};

    if (spec.type === 'score') {
      const score = Number(answer.score);
      if (!Number.isFinite(score)) continue;
      result[name] = { type: 'score', score: clamp(score, 0, 3), ...withConfidence };
      continue;
    }
    if (spec.type === 'noul') {
      const noul = Number(answer.noul);
      if (!Number.isFinite(noul)) continue;
      result[name] = { type: 'noul', noul: clamp(noul, 0, 1), ...withConfidence };
      continue;
    }
    if (spec.type === 'choice') {
      const probabilities = {};
      for (const criterion of Object.keys(spec.criteria ?? {})) {
        const value = Number(answer.probabilities?.[criterion] ?? answer[criterion]);
        if (Number.isFinite(value) && value > 0) probabilities[criterion] = clamp(value, 0, 1);
      }
      const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
      if (total <= 0) continue;
      for (const criterion of Object.keys(probabilities)) {
        probabilities[criterion] = Math.round((probabilities[criterion] / total) * 1000) / 1000;
      }
      result[name] = { type: 'choice', probabilities, ...withConfidence };
    }
  }
  return result;
}

/**
 * Ask one state the typed questions through chat completions.
 *
 * @param {object} options
 * @param {string} options.baseURL - API root, for example `https://api.openai.com/v1`.
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} options.timeoutMs
 * @param {string} options.state
 * @param {object} options.questions
 * @param {boolean} [options.jsonMode] - send `response_format: json_object`.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{model: string, answers: object, usage: object|undefined}>}
 */
export async function ask({ baseURL, apiKey, model, timeoutMs, state, questions, jsonMode, signal }) {
  const root = typeof baseURL === 'string' && baseURL.length > 0 ? baseURL.replace(/\/+$/, '') : defaultBaseURL;
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${describeQuestions(questions)}\n\nSTATE:\n${state}` },
    ],
  };
  if (jsonMode !== false) body.response_format = { type: 'json_object' };

  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

  const response = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: composed,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`chat ${response.status}: ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`chat answered non-JSON: ${text.slice(0, 200)}`);
  }
  const content = contentText(payload.choices?.[0]?.message?.content);
  let parsed;
  try {
    parsed = JSON.parse(unfence(content));
  } catch {
    throw new Error(`chat answered without a JSON object: ${content.slice(0, 200)}`);
  }
  const answers = normalize(questions, parsed?.answers ?? parsed);
  if (Object.keys(answers).length === 0) {
    throw new Error('chat answered without any usable answer');
  }
  return { model: payload.model ?? model, answers, usage: payload.usage };
}

/** @param {object} options */
export async function listModels({ baseURL, apiKey }) {
  const root = typeof baseURL === 'string' && baseURL.length > 0 ? baseURL.replace(/\/+$/, '') : defaultBaseURL;
  const response = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`models ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : (payload.data ?? []);
  return list.filter((model) => typeof model?.id === 'string').map((model) => ({ id: model.id, raw: model }));
}
