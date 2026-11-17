/**
 * Adapter for the System One decision endpoint.
 *
 * `POST /systemone` takes a free-text `state` plus typed `questions` and
 * answers with calibrated probabilities only. It never streams and never
 * produces text, so every gate turns probabilities into a policy decision on
 * its own.
 *
 * Reference provider: Command Code, `POST https://api.commandcode.ai/provider/v1/systemone`
 * with `{ model, state, questions }` and `{ answers }` back.
 *
 * @module @kara/dsh-systemone-tools/adapters/systemone
 */
import crypto from 'node:crypto';

export const id = 'systemone';

/** Where this adapter posts when the configuration leaves `baseURL` empty. */
export const defaultBaseURL = 'https://api.commandcode.ai/provider/v1/systemone';

/** The model this adapter is calibrated for. */
export const defaultModel = 'typesafe/jev';

const inFlight = new Map();

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * Ask one state a set of typed questions.
 *
 * @param {object} options
 * @param {string} options.baseURL - endpoint; falls back to the reference provider.
 * @param {string} options.apiKey - provider key, resolved per operation.
 * @param {string} options.model - decision model id.
 * @param {number} options.timeoutMs - hard deadline for the whole call.
 * @param {string} options.state - free-text state the questions are about.
 * @param {object} options.questions - `{ name: { type, instructions, criteria? } }`.
 * @param {AbortSignal} [options.signal] - caller cancellation (tool call, turn).
 * @returns {Promise<{model: string, answers: object, usage: object|undefined}>}
 */
export async function ask({ baseURL, apiKey, model, timeoutMs, state, questions, signal }) {
  const url = typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : defaultBaseURL;
  const body = JSON.stringify({ model, state, questions });
  const key = digest(`${model}\u0000${body}`);
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

  const call = (async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body,
      signal: composed,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`systemone ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`systemone answered non-JSON: ${text.slice(0, 200)}`);
    }
    if (payload.answers === null || typeof payload.answers !== 'object') {
      throw new Error('systemone answered without an answers object');
    }
    return payload;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, call);
  return call;
}

/**
 * Models the endpoint lists. Decision models may be absent from it: the
 * reference provider answers with its chat catalogue, so an empty or chat-only
 * list is not an error.
 *
 * @param {object} options
 * @param {string} options.baseURL
 * @param {string} options.apiKey
 * @returns {Promise<{id: string, raw: object}[]>}
 */
export async function listModels({ baseURL, apiKey }) {
  const url = `${(baseURL || defaultBaseURL).replace(/\/systemone\/?$/, '')}/models`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`models ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : (payload.data ?? payload.models ?? []);
  return list
    .filter((model) => typeof model?.id === 'string')
    .map((model) => ({ id: model.id, raw: model }));
}

/** Clear the single-flight table (tests only). */
export function resetInFlight() {
  inFlight.clear();
}
