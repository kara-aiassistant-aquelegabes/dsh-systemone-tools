/**
 * Audit log for decisions.
 *
 * One JSONL line per judgement: tool, action, certainty, thresholds and the
 * hash of the state. The state itself is never logged, because it is built
 * from session content.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const day = () => new Date().toISOString().slice(0, 10);

/**
 * @param {string} dir - log directory (created on demand).
 * @param {boolean} enabled - configuration switch.
 * @returns {(entry: object) => void} recorder; never throws.
 */
export function makeRecorder(dir, enabled) {
  return function record(entry) {
    if (!enabled) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      fs.appendFileSync(path.join(dir, `${day()}.jsonl`), `${line}\n`);
    } catch {
      /* logging must never break a turn */
    }
  };
}

/** @param {string} state */
export const stateHash = (state) =>
  crypto.createHash('sha256').update(state).digest('hex').slice(0, 16);
