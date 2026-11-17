/**
 * Bash risk gate.
 *
 * Runs before dispatch on `tools/pre-execute`. Only commands that can write or
 * destroy are judged; reads pass without a provider call. The gate never
 * decides on the user's behalf: it denies with an actionable reason so the
 * agent rewrites the command reversibly or asks the human explicitly.
 *
 * Known blind spot: the gate reads the command line. A script that deletes from
 * the inside, variable substitution and base64 payloads pass. Documented, not
 * hidden.
 */

export const id = 'bashRisk';

/** Shell tools the gate applies to; `pwsh` is absent by default here. */
export const toolNames = ['bash', 'pwsh'];

/**
 * @param {string} command - the command line as written by the model.
 * @param {object} config - `bashRisk` section.
 * @returns {boolean} whether this command deserves a provider call.
 */
export function shouldInspect(command, config) {
  const text = String(command ?? '');
  if (text.trim().length === 0) return false;
  // A partial config must not throw here: the hook's catch would fail open and
  // the gate would vanish without a trace. A missing list means "inspect nothing".
  const exempt = (config.exemptPatterns ?? []).some((pattern) => pattern.length > 0 && text.includes(pattern));
  if (exempt) return false;
  return (config.inspectPatterns ?? []).some((pattern) => pattern.length > 0 && text.includes(pattern));
}

export const questions = {
  risco: {
    type: 'score',
    instructions:
      'Qual o grau de irreversibilidade e o alcance do comando, considerando o pedido do usuario?',
    criteria: [
      'leitura',
      'escrita reversivel',
      'escrita destrutiva local',
      'destrutiva irreversivel ou fora do escopo',
    ],
  },
  escopo: {
    type: 'noul',
    instructions:
      'O comando executa exatamente o que o usuario pediu, sem alcancar nada alem do pedido?',
  },
};

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string} options.cwd
 * @param {string} options.request - the user's request this turn, shortened.
 * @returns {string}
 */
export function buildState({ command, cwd, request }) {
  return [
    'AMBIENTE: agente com acesso total ao sistema de arquivos do container.',
    `DIRETORIO: ${cwd}`,
    `PEDIDO DO USUARIO: ${request || '(nao disponivel)'}`,
    'COMANDO A EXECUTAR:',
    command,
  ].join('\n');
}

/**
 * @param {object} answer - `answers` of the systemone response.
 * @param {object} config - `bashRisk` section.
 * @param {number} askBelow - global certainty threshold.
 * @param {'ask'|'allow'|'deny'} onLowConfidence
 * @returns {{action: 'allow'|'deny'|'ask', reason?: string, risk: number, scope: number, certainty: number}}
 */
export function decide(answer, config, askBelow, onLowConfidence) {
  const risk = answer?.risco?.score ?? 0;
  const scope = answer?.escopo?.noul ?? 1;
  const certainty = Math.min(
    typeof answer?.risco?.confidence === 'number' ? answer.risco.confidence : 1,
    typeof answer?.escopo?.confidence === 'number' ? answer.escopo.confidence : 1,
  );

  // A read cannot overreach. `escopo` measures how far the command departs from
  // the request, and a read that departs is still a read: `>` sits in
  // `inspectPatterns`, so `ls ... 2>&1` reached the provider with risk 0.01 and
  // was denied on scope alone. Measured in this container on 2026-11-17.
  if (risk < 1) return { action: 'allow', risk, scope, certainty };

  if (risk >= config.blockAtRisk) {
    return {
      action: 'deny',
      risk,
      scope,
      certainty,
      reason:
        `O porteiro de risco classificou este comando como risco ${risk.toFixed(2)}/3 ` +
        `(limite ${config.blockAtRisk}). O comando nao foi executado. ` +
        'Reescreva de forma reversivel (listar antes de apagar, copiar para /tmp antes de sobrescrever, ' +
        'usar --dry-run) ou pergunte ao usuario com ask_user_question antes de repetir.',
    };
  }

  if (scope < config.scopeBelow) {
    return {
      action: 'deny',
      risk,
      scope,
      certainty,
      reason:
        `O porta-risco nao reconheceu este comando como o pedido do usuario ` +
        `(escopo ${(scope * 100).toFixed(1)}%, minimo ${(config.scopeBelow * 100).toFixed(1)}%). ` +
        'Reduza o alcance ao que foi pedido ou confirme com o usuario via ask_user_question.',
    };
  }

  if (certainty < askBelow) {
    if (onLowConfidence === 'deny') {
      return {
        action: 'deny',
        risk,
        scope,
        certainty,
        reason:
          `Confianca insuficiente na classificacao de risco (${(certainty * 100).toFixed(1)}%, ` +
          `minimo ${(askBelow * 100).toFixed(1)}%). Reformule o comando ou confirme com o usuario.`,
      };
    }
    if (onLowConfidence === 'ask') {
      return {
        action: 'ask',
        risk,
        scope,
        certainty,
        reason:
          `Confianca insuficiente na classificacao de risco (${(certainty * 100).toFixed(1)}%, ` +
          `minimo ${(askBelow * 100).toFixed(1)}%). Use ask_user_question para confirmar antes de executar.`,
      };
    }
  }

  return { action: 'allow', risk, scope, certainty };
}
