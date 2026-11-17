/**
 * Privacy guard.
 *
 * The gates build their state from session content and the decision endpoint
 * is remote. Private stores never leave the container, so the state is scanned
 * for markers before any call. The check is lexical: a bare value with no
 * file name, path or store id around it does escape. That limit is documented
 * in the README instead of being papered over.
 */

/**
 * @param {string} state - text about to be sent to the provider.
 * @param {readonly string[]} markers - private file names, paths and store ids.
 * @returns {string|undefined} the first marker found, if any.
 */
export function privateMarker(state, markers) {
  if (!Array.isArray(markers) || markers.length === 0) return undefined;
  const haystack = state.toLowerCase();
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker.length === 0) continue;
    if (haystack.includes(marker.toLowerCase())) return marker;
  }
  return undefined;
}
