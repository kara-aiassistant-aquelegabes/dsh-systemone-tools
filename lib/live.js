/**
 * Live configuration.
 *
 * The profile patch reloads live, but the gate listeners stay mounted for the
 * lifetime of the plugin instance. Reading the entry's current value from the
 * settings service on every call is what makes "turn this gate off" take
 * effect without a restart, and what makes it take effect even if the loader
 * decides not to re-apply the plugin.
 *
 * The settings service hands back only the fields its form projects, so a
 * section it mentions can arrive holding a single key. A shallow spread
 * replaced the whole section and dropped everything the form does not show:
 * measured on 2026-11-17, one saved form deleted `enabled` from `bashRisk`,
 * `conclusion` and `injection`, and the three gates went silent. Nested objects
 * therefore merge; arrays and scalars replace.
 */

const TTL_MS = 500;
let cached = { at: 0, value: undefined, ns: undefined };

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} base - composition value, schema defaults already applied.
 * @param {unknown} live - value the settings service reports for the namespace.
 * @returns {unknown} the live value merged over the base, section by section.
 */
function merge(base, live) {
  if (!isPlainObject(base) || !isPlainObject(live)) return live;
  const result = { ...base };
  for (const [key, value] of Object.entries(live)) {
    if (value === undefined) continue;
    result[key] = merge(base[key], value);
  }
  return result;
}

/**
 * @param {object} ctx - plugin context; `settings` is optional.
 * @param {string} ns - profile entry id of this plugin.
 * @param {object} fallback - the config handed to `apply`.
 * @returns {object} effective configuration.
 */
export function liveConfig(ctx, ns, fallback) {
  const now = Date.now();
  if (cached.ns === ns && now - cached.at < TTL_MS && cached.value !== undefined) return cached.value;
  let value = fallback;
  try {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
    const described = settings?.describe?.({ redactSecrets: true });
    const entry = Array.isArray(described) ? described.find((item) => item.ns === ns) : undefined;
    if (entry?.value !== null && typeof entry?.value === 'object') value = merge(fallback, entry.value);
  } catch {
    /* settings unavailable: keep the apply-time configuration */
  }
  cached = { at: now, value, ns };
  return value;
}

/** Clear the cache (tests only). */
export function resetLiveConfig() {
  cached = { at: 0, value: undefined, ns: undefined };
}
