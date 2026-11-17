/**
 * Configuration page for the System One gates, rendered on the Plugins page.
 *
 * The page registers into `plugins.row.config` under `<package>#<row id>`, the
 * key the Plugins page derives from the bundle and its row, so the row gets a
 * Configure control and this form opens on its own page. The page owner passes
 * `form`, whose `state` is the settings snapshot `{ value, writable, revision }`
 * for the namespace named after the row id (`systemone-tools`).
 *
 * Only `.volatile()` fields reach this form, which is why the six thresholds are
 * declared volatile in the Host Config and unwrapped by `lib/plain.js`.
 *
 * @module @kara/dsh-systemone-tools/client
 */
window.__ModuleLoader__.load({
  id: '@kara/dsh-systemone-tools',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this client half. */
    const NS = 'systemone-tools';

    /** Bundle and row this page configures; the page keys the slot by this pair. */
    const ROW_KEY = '@kara/dsh-systemone-tools#systemone-tools';

    const en = {
      summary: 'Percentages and thresholds for the three gates',
      title: 'Thresholds',
      intro:
        'Each value is the probability, from 0 to 100%, above which the gate acts. The shell gate risk score runs from 0 to 3. Changes apply to the next judgement, without restarting.',
      riskScore: 'Shell gate: risk score that blocks (0 to 3)',
      askBelow: 'Minimum certainty of a verdict',
      conclusionBlock: 'Conclusion checker: "unsupported" that returns the turn',
      bashScope: 'Shell gate: minimum scope of a command',
      injectionBlock: 'Injection filter: explicit instruction that removes the block',
      injectionNote: 'Injection filter: suspicion that annotates the block',
      save: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      refused: 'The Host refused the change',
      failed: 'Could not save',
      reset: 'Restore defaults',
      dirty: 'Unsaved changes',
      readOnly: 'This entry cannot be edited from here.',
      unavailable: 'Configuration is not available yet.',
      percent: '%',
      score: 'of 3',
    };

    const ptBR = {
      summary: 'Porcentagens e limites dos tres portoes',
      title: 'Limiares',
      intro:
        'Cada valor e a probabilidade, de 0 a 100%, a partir da qual o portao age. A nota de risco do shell vai de 0 a 3. A mudanca vale no proximo julgamento, sem reiniciar.',
      riskScore: 'Porteiro do shell: nota de risco que barra (0 a 3)',
      askBelow: 'Certeza minima do veredito',
      conclusionBlock: 'Checador de conclusao: "nao sustentada" que devolve o turno',
      bashScope: 'Porteiro do shell: escopo minimo do comando',
      injectionBlock: 'Filtro de injecao: instrucao explicita que remove o bloco',
      injectionNote: 'Filtro de injecao: suspeita que anota o bloco',
      save: 'Salvar',
      saving: 'Salvando...',
      saved: 'Salvo',
      refused: 'O Host recusou a mudanca',
      failed: 'Nao foi possivel salvar',
      reset: 'Restaurar padroes',
      dirty: 'Alteracoes nao salvas',
      readOnly: 'Esta entrada nao pode ser editada por aqui.',
      unavailable: 'A configuracao ainda nao esta disponivel.',
      percent: '%',
      score: 'de 3',
    };

    /**
     * The six editable thresholds, in display order.
     *
     * `unit` decides the conversion: `percent` shows 0-100 for a 0-1 value,
     * `score` shows the raw 0-3 risk grade.
     */
    const FIELDS = [
      { key: 'conclusionBlock', path: ['conclusion', 'blockBelow'], unit: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'riskScore', path: ['bashRisk', 'blockAtRisk'], unit: 'score', min: 0, max: 3, step: 0.1 },
      { key: 'bashScope', path: ['bashRisk', 'scopeBelow'], unit: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'injectionBlock', path: ['injection', 'blockAbove'], unit: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'injectionNote', path: ['injection', 'noteAbove'], unit: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'askBelow', path: ['askBelow'], unit: 'percent', min: 0, max: 1, step: 0.01 },
    ];

    /** Read a nested value without trusting intermediate objects. */
    function at(value, path) {
      let cursor = value;
      for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = cursor[key];
      }
      return cursor;
    }

    /** Snapshot to input strings; empty when the field has no value yet. */
    function readDraft(state) {
      const draft = {};
      for (const field of FIELDS) {
        const value = at(state?.value, field.path);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          draft[field.key] = '';
          continue;
        }
        draft[field.key] = field.unit === 'percent' ? String(Math.round(value * 1000) / 10) : String(value);
      }
      return draft;
    }

    /** Input string back to the config value, clamped to the declared range. */
    function toValue(field, raw) {
      const parsed = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(parsed)) return undefined;
      const value = field.unit === 'percent' ? parsed / 100 : parsed;
      return Math.min(field.max, Math.max(field.min, Math.round(value * 1000) / 1000));
    }

    /** Operations for every field whose input differs from the current value. */
    function changes(draft, state) {
      const ops = [];
      for (const field of FIELDS) {
        const value = toValue(field, draft[field.key]);
        if (value === undefined) continue;
        if (value === at(state?.value, field.path)) continue;
        ops.push({ op: 'set', path: field.path, value });
      }
      return ops;
    }

    const styles = {
      panel: { display: 'grid', gap: '10px', marginTop: '14px', color: 'inherit' },
      intro: { margin: '0', opacity: 0.75, fontSize: '13px', lineHeight: 1.5, maxWidth: '62ch' },
      row: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 14px', alignItems: 'center' },
      label: { fontSize: '13px', lineHeight: 1.4 },
      input: {
        width: '6em',
        padding: '4px 6px',
        font: 'inherit',
        fontSize: '13px',
        textAlign: 'right',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
        borderRadius: '6px',
      },
      unit: { fontSize: '12px', opacity: 0.6, marginLeft: '6px' },
      actions: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '6px' },
      button: {
        padding: '5px 12px',
        font: 'inherit',
        fontSize: '13px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 45%, transparent)',
        borderRadius: '7px',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', opacity: 0.7 },
      note: { fontSize: '12px', opacity: 0.6, margin: '0' },
    };

    function RowConfigPage(props) {
      const { view, form, t } = props;
      const state = form?.state;
      const [draft, setDraft] = React.useState(function () {
        return readDraft(state);
      });
      const [status, setStatus] = React.useState('idle');

      const revision = state?.revision;
      React.useEffect(
        function () {
          setDraft(readDraft(state));
          setStatus('idle');
        },
        [revision],
      );

      if (view === 'summary') return h('span', null, t('summary'));
      if (form === undefined) return h('p', { style: styles.note }, t('unavailable'));

      const editable = state?.writable === true && status !== 'saving';
      const pending = changes(draft, state);

      function update(key) {
        return function (event) {
          setDraft(function (current) {
            const next = { ...current };
            next[key] = event.target.value;
            return next;
          });
          setStatus('idle');
        };
      }

      function save() {
        const ops = changes(draft, state);
        if (ops.length === 0) return;
        setStatus('saving');
        Promise.resolve(form.mutate(ops, state.revision)).then(
          function (accepted) {
            setStatus(accepted === false ? 'refused' : 'saved');
          },
          function () {
            setStatus('failed');
          },
        );
      }

      function reset() {
        setStatus('saving');
        const ops = FIELDS.map(function (field) {
          return { op: 'unset', path: field.path };
        });
        Promise.resolve(form.mutate(ops, state.revision)).then(
          function (accepted) {
            setStatus(accepted === false ? 'refused' : 'saved');
          },
          function () {
            setStatus('failed');
          },
        );
      }

      const rows = FIELDS.map(function (field) {
        const id = 'systemone-' + field.key;
        return h(
          'div',
          { key: field.key, style: styles.row },
          h('label', { htmlFor: id, style: styles.label }, t(field.key)),
          h(
            'span',
            null,
            h('input', {
              id,
              type: 'number',
              inputMode: 'decimal',
              style: styles.input,
              value: draft[field.key] ?? '',
              min: field.unit === 'percent' ? 0 : field.min,
              max: field.unit === 'percent' ? 100 : field.max,
              step: field.unit === 'percent' ? 1 : field.step,
              disabled: !editable,
              onChange: update(field.key),
            }),
            h('span', { style: styles.unit }, t(field.unit)),
          ),
        );
      });

      const statusText =
        status === 'saved'
          ? t('saved')
          : status === 'saving'
            ? t('saving')
            : status === 'refused'
              ? t('refused')
              : status === 'failed'
                ? t('failed')
                : pending.length > 0
                  ? t('dirty')
                  : '';

      return h(
        'div',
        { style: styles.panel, 'data-systemone-config': true },
        h('p', { style: styles.intro }, t('intro')),
        rows,
        state?.writable === true
          ? null
          : h('p', { style: styles.note }, t('readOnly')),
        h(
          'div',
          { style: styles.actions },
          h('button', { type: 'button', style: buttonStyle(editable && pending.length > 0), disabled: !editable || pending.length === 0, onClick: save }, t('save')),
          h('button', { type: 'button', style: buttonStyle(editable), disabled: !editable, onClick: reset }, t('reset')),
          h('span', { style: styles.status, role: 'status' }, statusText),
        ),
      );
    }

    /** Button style that shows the disabled state, which the browser does not theme here. */
    function buttonStyle(enabled) {
      return enabled ? styles.button : { ...styles.button, opacity: 0.4, cursor: 'default' };
    }

    /** Mount the page while the Plugins slot exists. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { en, 'pt-BR': ptBR });
        },
        'systemone-tools: dictionaries',
      );
      ctx.slots.inject('plugins.row.config', function () {
        return ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: ROW_KEY,
            locale: NS,
          },
          RowConfigPage,
        );
      });
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
