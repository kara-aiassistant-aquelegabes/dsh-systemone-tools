/**
 * Deprecated entry point.
 *
 * The provider boundary moved to `lib/ask.js` and `lib/adapters/`. This module
 * stays so a checkout that still imports the old path keeps loading; new code
 * imports `./ask.js` directly.
 *
 * @deprecated
 */
export { ask, listModels, PROVIDERS, adapterFor } from './ask.js';
