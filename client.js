/**
 * Browser half of dsh-session-cost.
 *
 * Renders one pill into `conversation.composer.dock` with a negative `order`, so
 * it sits to the LEFT of the built-in stats pill row («N 轮 M 步 · … tok/s» and
 * «… tok · 缓存命中 …»). The geometry and typography declarations mirror the
 * host's own stats pill one-for-one, and every colour/measurement comes from the
 * host theme tokens, so the pill is indistinguishable from its neighbours in
 * either theme.
 *
 * This half holds no pricing logic: it polls the Host route once a second (the
 * same cadence the balance widget uses) and renders whatever exact figure comes
 * back. `sessionId` is part of the standard props of this slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-session-cost';
    const ENDPOINT = '/dsh-session-cost/cost.json';
    const POLL_MS = 1000;

    // Declarations copied verbatim from the host's stats pill; only the class
    // prefix differs.
    const CSS = '.dshSessionCost_root{box-sizing:border-box;min-width:0;max-width:100%;'
      + 'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);'
      + 'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));'
      + 'justify-content:center;gap:12px;display:flex}'
      + '.dshSessionCost_pill{box-sizing:border-box;corner-shape:round;max-width:100%;'
      + 'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;'
      + 'line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;'
      + 'align-items:center;gap:6px;padding:1px 8px;display:inline-flex}';

    function money(value) {
      if (!(value > 0)) return '¥0.00';
      if (value < 0.01) return '<¥0.01';
      return '¥' + value.toFixed(2);
    }

    function SessionCost(props) {
      const { sessionId, t } = props;
      const [view, setView] = React.useState(null);

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let alive = true;
        const url = ENDPOINT + '?session=' + encodeURIComponent(sessionId);
        const poll = () => {
          fetch(url, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
              if (!alive) return;
              setView(body && body.ok === true && typeof body.cost === 'number' ? body : null);
            })
            .catch(() => {
              if (alive) setView(null);
            });
        };
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      if (view === null || !(view.cost > 0)) return null;

      const word = (key, fallback) => {
        try {
          const text = t && t(key);
          return typeof text === 'string' && text !== '' && text !== key ? text : fallback;
        } catch (err) {
          return fallback;
        }
      };

      const tip = [
        word('tip.title', '本会话累计花费') + ' ' + money(view.cost),
        word('tip.exact', '精确计价：每次请求按当时的时段价与所用模型分别计费'),
        word('tip.requests', '已计费请求') + ' ' + Number(view.requests || 0) + ' ' + word('tip.times', '次'),
      ].join('\n');

      return h('div', { className: 'dshSessionCost_root' }, [
        h('style', { key: 'css' }, CSS),
        h('span', {
          key: 'pill',
          className: 'dshSessionCost_pill',
          title: tip,
          role: 'status',
          'data-session-cost': Number(view.cost).toFixed(6),
        }, money(view.cost)),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.locale && typeof ctx.locale.register === 'function'
          && typeof ctx.effect === 'function') {
          try {
            ctx.effect(() => ctx.locale.register(NS, {
              zh: {
                'tip.title': '本会话累计花费',
                'tip.exact': '精确计价：每次请求按当时的时段价与所用模型分别计费',
                'tip.requests': '已计费请求',
                'tip.times': '次',
              },
              en: {
                'tip.title': 'Cost of this session',
                'tip.exact': 'Exact: each request priced at its own rate and model',
                'tip.requests': 'Billed requests',
                'tip.times': '',
              },
            }), 'dsh-session-cost: dictionaries');
          } catch (err) {
            // Copy falls back to the inline zh strings; the pill still renders.
          }
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-cost',
          order: -10,
          locale: NS,
        }, SessionCost));
      },
    };
  },
});
