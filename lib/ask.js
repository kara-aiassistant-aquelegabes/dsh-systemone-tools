/**
 * Provider boundary.
 *
 * Every gate asks the same question: given one state, what do the typed
 * questions score? How that travels is the adapter's business. A decision
 * endpoint answers with probabilities; a chat API answers with text that has to
 * be asked for JSON. The gates never see the difference.
 *
 * Adding a provider means adding one module under `adapters/` with `id`, `ask`
 * and `listModels`, then registering it here.
 *
 * @module @kara/dsh-systemone-tools/ask
 */
import * as systemone from './adapters/systemone.js';
import * as openai from './adapters/openai.js';

const ADAPTERS = { systemone, openai };

/** Provider ids this build ships. */
export const PROVIDERS = Object.keys(ADAPTERS);

/**
 * @param {string} [provider]
 * @returns {object} the adapter, defaulting to the calibrated decision endpoint.
 */
export function adapterFor(provider) {
  return ADAPTERS[provider] ?? ADAPTERS.systemone;
}

/** Endpoint the adapter uses when the configuration leaves `baseURL` empty. */
export function defaultBaseURL(provider) {
  return adapterFor(provider).defaultBaseURL;
}

/** Model the adapter uses when the configuration leaves `model` empty. */
export function defaultModel(provider) {
  return adapterFor(provider).defaultModel;
}

/**
 * Ask one state a set of typed questions through the configured provider.
 *
 * @param {object} options - adapter options plus `provider`.
 * @returns {Promise<{model: string, answers: object, usage: object|undefined}>}
 */
export async function ask(options) {
  return adapterFor(options.provider).ask(options);
}

/**
 * @param {object} options - `provider`, `baseURL`, `apiKey`.
 * @returns {Promise<{id: string, raw: object}[]>}
 */
export async function listModels(options) {
  return adapterFor(options.provider).listModels(options);
}
