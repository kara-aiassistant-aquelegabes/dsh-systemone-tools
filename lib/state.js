/**
 * State builders.
 *
 * The state is the whole input of a decision, and the gates are only as honest
 * as the text assembled here. Rules that hold for all three:
 *
 * - evidence comes from the raw record (tool arguments and outputs), never from
 *   the agent's own summary;
 * - the state is bounded by a character budget, and the cut never splits a
 *   command in half without saying so;
 * - no private marker reaches the provider (the guard runs after this).
 */

/** @param {string} text @param {number} max */
export function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[...truncated ${value.length - max} chars]`;
}

/** @param {unknown} content - message content blocks or plain string. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Tool evidence of one turn, in order, plus its final assistant text.
 *
 * @param {readonly object[]} events
 * @param {number} turn
 * @param {readonly string[]} includeTools
 * @returns {{lines: string[], assistant: string}}
 */
function collect(events, turn, includeTools) {
  const calls = new Map();
  const lines = [];
  let assistant = '';

  for (const event of events) {
    const data = event?.data ?? {};
    const eventTurn = data.turn ?? event.turn;
    if (eventTurn !== undefined && eventTurn !== turn) continue;
    if (event.type === 'tool/call') {
      const args = safeJSON(data.arguments);
      calls.set(data.callId, data.name);
      if (includeTools.includes(data.name)) lines.push(`TOOL ${data.name} ${clip(args, 1200)}`);
    } else if (event.type === 'tool/result') {
      const name = calls.get(data.message?.toolCallId) ?? 'tool';
      if (!includeTools.includes(name)) continue;
      const failed = data.message?.isError === true ? 'FAILED' : 'ok';
      const code = data.error?.code ? ` code=${data.error.code}` : '';
      lines.push(`RESULT ${name} ${failed}${code}: ${clip(textOf(data.message?.content), 1400)}`);
    } else if (event.type === 'assistant/message') {
      const text = textOf(data.message?.content);
      if (text.trim().length > 0) assistant = text;
    }
  }

  return { lines, assistant };
}

/**
 * Evidence of the current turn together with the previous turn's tool output.
 *
 * A claim made at the end of turn N often rests on a measurement taken in turn
 * N-1, and the checker used to see only the current turn. Measured on
 * 2026-11-17: it returned `nao_sustentada` at 95% for a summary whose numbers
 * had been measured one turn earlier. The previous turn therefore travels with
 * the current one, in its own budget slice and without its assistant text, so
 * an old claim can never read as evidence.
 *
 * @param {object} options
 * @param {readonly object[]} options.events - session events.
 * @param {number} options.turn - turn number.
 * @param {number} options.budget - character budget.
 * @param {readonly string[]} options.includeTools - tool names that count as evidence.
 * @returns {string}
 */
export function turnEvidence({ events, turn, budget, includeTools }) {
  const current = collect(events, turn, includeTools);
  const previous = turn > 1 ? collect(events, turn - 1, includeTools) : { lines: [], assistant: '' };

  const claim = current.assistant.length > 0 ? `FINAL CLAIM:\n${clip(current.assistant, 1500)}` : 'FINAL CLAIM: (none)';
  const room = Math.max(0, budget - claim.length);
  const previousRoom = Math.min(Math.floor(room * 0.4), 2400);
  const currentRoom = Math.max(0, room - previousRoom);

  const previousText =
    previous.lines.length === 0
      ? '(no tool output in the previous turn)'
      : clip(previous.lines.join('\n'), previousRoom);
  const currentText =
    current.lines.length === 0 ? '(no tool output in this turn)' : clip(current.lines.join('\n'), currentRoom);

  return [
    `TURN ${turn}`,
    `PREVIOUS TURN (${turn - 1}) EVIDENCE:`,
    previousText,
    'CURRENT TURN EVIDENCE:',
    currentText,
    claim,
  ].join('\n');
}

const safeJSON = (value) => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '<unserializable>';
  }
};
