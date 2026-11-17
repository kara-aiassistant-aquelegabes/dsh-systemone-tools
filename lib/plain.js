/**
 * Volatile references to ordinary values.
 *
 * The settings service only projects fields declared `.volatile()` into an
 * editable form, and schemastery then parses those fields into a reference read
 * with `.get()`. The gates compare numbers, so every consumer reads through
 * `plain()` and never sees the wrapper.
 *
 * Duck-typed on purpose: schemastery exports only `Schema` as default, so there
 * is no `isVolatile` to import. No section of this Config is an object with a
 * `get` key, which keeps the check unambiguous.
 *
 * @module @kara/dsh-systemone-tools/plain
 */

/**
 * @param {unknown} value - parsed Config value, possibly holding volatile refs.
 * @returns {unknown} the same shape with every reference resolved.
 */
export function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function') return plain(value.get());
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = plain(child);
  return result;
}
