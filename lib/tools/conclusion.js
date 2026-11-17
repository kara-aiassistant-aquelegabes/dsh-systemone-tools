/**
 * Conclusion checker.
 *
 * Runs on `agent/turn-stopping`. One typed question decides whether the final
 * message claims work is done, and whether the turn's raw tool output backs
 * that claim. A `nao_sustentada` verdict steers the agent into one more step,
 * which is the only way to keep a turn open in this harness.
 */

export const id = 'conclusion';

export const questions = {
  alegacao: {
    type: 'choice',
    instructions:
      'A mensagem final do agente afirma que trabalho foi concluido ou que algo esta funcionando. ' +
      'A evidencia de ferramentas do turno atual, sozinha ou junto com a do turno anterior, sustenta essa afirmacao? ' +
      'Evidencia do turno anterior so vale para o que a afirmacao herda dela; o que so aparece no turno atual nao lastreia o outro.',
    criteria: {
      sem_alegacao: 'a mensagem nao afirma conclusao de trabalho, so conversa ou descreve o que faria',
      sustentada: 'a evidencia exibida confirma o que foi afirmado, incluindo saida e codigo de saida',
      nao_sustentada:
        'a evidencia falta, veio de outro alvo, ou contradiz a afirmacao (erro, codigo de saida diferente de zero)',
    },
  },
};

/**
 * Cheap pre-filter: a turn with no tool call cannot have evidence, and a final
 * message that does not look like a completion claim is not worth a call.
 * The typed question still decides; this only avoids obvious waste.
 *
 * @param {object} options
 * @param {boolean} options.hadToolCalls
 * @param {string} options.finalText
 * @returns {boolean}
 */
export function shouldJudge({ hadToolCalls, finalText }) {
  if (String(finalText ?? '').trim().length === 0) return false;
  if (!hadToolCalls) return false;
  return true;
}

/**
 * @param {object} answer
 * @param {object} config - `conclusion` section.
 * @param {number} askBelow - global certainty threshold.
 * @returns {{action: 'allow'|'steer'|'log', reason?: string, certainty: number, unsupported: number}}
 */
export function decide(answer, config, askBelow) {
  const probabilities = answer?.alegacao?.probabilities ?? {};
  const unsupported = typeof probabilities.nao_sustentada === 'number' ? probabilities.nao_sustentada : 0;
  const certainty = answer?.alegacao?.confidence ?? Math.max(0, ...Object.values(probabilities).map(Number));

  if (unsupported > config.blockBelow) {
    return {
      action: 'steer',
      unsupported,
      certainty,
      reason:
        'O checador de conclusao nao encontrou evidencia que sustente a afirmacao final ' +
        `(nao_sustentada ${(unsupported * 100).toFixed(1)}%). ` +
        'Ou rode a verificacao e mostre a saida, ou reformule a mensagem como pendencia explicita.',
    };
  }

  if (certainty < askBelow) {
    return { action: 'log', unsupported, certainty, reason: 'veredito inconclusivo, sem bloqueio' };
  }

  return { action: 'allow', unsupported, certainty };
}
