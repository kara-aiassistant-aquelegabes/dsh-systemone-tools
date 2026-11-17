/**
 * Probability to policy.
 *
 * Every decision model answers with numbers, so the gates own the thresholds.
 * `certainty` is the one number the global `askBelow` compares against: the
 * model's own confidence when it reports one, otherwise the probability margin
 * of the answer.
 */

/** @param {number} value - 0..1 probability. */
export const pct = (value) => `${Math.round(Number(value) * 1000) / 10}%`;

/**
 * Confidence of one answer, 0..1.
 *
 * @param {object|undefined} answer - one entry of `answers`.
 * @returns {number} certainty, 0 when the answer carries nothing usable.
 */
export function certaintyOf(answer) {
  if (answer === null || typeof answer !== 'object') return 0;
  if (typeof answer.confidence === 'number') return clamp(answer.confidence);
  if (answer.type === 'choice' && answer.probabilities !== undefined) {
    return clamp(Math.max(...Object.values(answer.probabilities).map(Number)));
  }
  if (answer.type === 'noul' && typeof answer.noul === 'number') {
    return clamp(Math.abs(answer.noul - 0.5) * 2);
  }
  return 0;
}

/**
 * Decision for a low-certainty answer.
 *
 * @param {object} options
 * @param {number} options.certainty - computed certainty.
 * @param {number} options.askBelow - global threshold from the configuration.
 * @param {'ask'|'allow'|'deny'|'log'} options.onLowConfidence - per-tool action.
 * @returns {{low: boolean, action: 'ask'|'allow'|'deny'|'log'}}
 */
export function lowConfidence({ certainty, askBelow, onLowConfidence }) {
  const low = certainty < askBelow;
  return { low, action: low ? onLowConfidence : 'allow' };
}

/**
 * Read a `noul` probability of "yes".
 *
 * @param {object|undefined} answer
 * @returns {number} 0..1
 */
export function yesOf(answer) {
  return answer?.type === 'noul' && typeof answer.noul === 'number' ? clamp(answer.noul) : 0;
}

/**
 * Read a `choice` probability for one criterion.
 *
 * @param {object|undefined} answer
 * @param {string} criterion
 * @returns {number} 0..1
 */
export function choiceOf(answer, criterion) {
  const value = answer?.probabilities?.[criterion];
  return typeof value === 'number' ? clamp(value) : 0;
}

/**
 * Read a `score` value, keeping the decimals the model returned.
 *
 * @param {object|undefined} answer
 * @returns {number}
 */
export function scoreOf(answer) {
  return typeof answer?.score === 'number' ? answer.score : 0;
}

const clamp = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
