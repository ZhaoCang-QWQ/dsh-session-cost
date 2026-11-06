/**
 * Host half of dsh-session-cost.
 *
 * DSH records no money, only provider-reported token usage. This half answers
 * one question over HTTP — "what has this session cost so far?" — by folding the
 * session's own event log:
 *
 *   - `request/header` remembers the model and the request-start instant of a
 *     `(turn, step)`;
 *   - `assistant/message` / `assistant/attempt` contribute their usage, priced
 *     with that model at that instant;
 *   - `llm/retry-started` re-arms the slot, because a retried attempt is another
 *     billed request and both count;
 *   - a repeated `(turn, step)` sample REPLACES its predecessor instead of
 *     adding, mirroring `tokenUsage`'s own fold so the two never disagree.
 *
 * So each request is billed at the rate in force when it was sent, not at
 * whatever the rate happens to be when you look — that is the whole difference
 * between an exact figure and an approximation.
 *
 * Nothing is cached across requests beyond a `(session, seq)` memo, and nothing
 * is persisted: the answer is always re-derived from the log DSH already keeps,
 * so a restart, a reload, or opening an old session all produce the same number.
 */
import { URLSearchParams } from 'node:url';

/** Plugin display name. */
export const name = 'dsh-session-cost-exact';

/** Money is accumulated in 1e-6 CNY, far below any display precision. */
export const MICRO = 1e6;

/** The one route the browser half calls. */
export const ROUTE = '/dsh-session-cost-exact/cost.json';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** Peak windows, as Beijing-local [startHour, endHour). */
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
];

/** CNY per million tokens, as [valley, peak]. https://api-docs.deepseek.com/zh-cn/quick_start/pricing */
export const PRICING = {
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] },
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
};

/** Tariff used for a model the table does not know, or before one is reported. */
export const FALLBACK_TARIFF = 'deepseek-flash';

/** Longest key first, so a specific id wins over a shorter substring of it. */
const TARIFF_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/**
 * Statutory holidays that bill at valley rates all day (official 2026
 * arrangement). **Update this list once the State Council publishes the next
 * year** — a missing date only ever mis-prices hours that would otherwise be
 * peak.
 */
export const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
]);

/** The weekend-valley rule took effect at Beijing 2026-08-23 00:00. */
export const WEEKEND_VALLEY_FROM = Date.UTC(2026, 7, 22, 16, 0, 0);
/** The statutory-holiday-valley rule took effect at Beijing 2026-09-19 00:00. */
export const HOLIDAY_VALLEY_FROM = Date.UTC(2026, 8, 18, 16, 0, 0);

/** Resolve the tariff row for one model id. */
export function tariffFor(model) {
  const lowered = String(model || '').toLowerCase();
  for (const key of TARIFF_KEYS) {
    if (lowered.indexOf(key) !== -1) return { key, table: PRICING[key], matched: true };
  }
  return { key: FALLBACK_TARIFF, table: PRICING[FALLBACK_TARIFF], matched: false };
}

/** Whether one instant bills at peak rates (Beijing calendar, statutory rules). */
export function isPeak(atMs) {
  if (!Number.isFinite(atMs)) return false;
  const beijing = new Date(atMs + 8 * 3600 * 1000);
  const day = beijing.getUTCDay();
  if (atMs >= WEEKEND_VALLEY_FROM && (day === 0 || day === 6)) return false;
  if (atMs >= HOLIDAY_VALLEY_FROM && HOLIDAY_VALLEY.has(beijing.toISOString().slice(0, 10))) return false;
  const hour = beijing.getUTCHours();
  for (const [from, to] of PEAK_HOURS) if (hour >= from && hour < to) return true;
  return false;
}

function tokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Price one request's buckets, in micro-yuan.
 * Cache writes bill as uncached input, which is the provider's own "cache miss"
 * charge; usage `inputTokens` already excludes them.
 * @param buckets - [uncachedInput, cacheRead, cacheWrite, output] token counts.
 */
export function costUnits(buckets, model, atMs) {
  const price = tariffFor(model).table;
  const charged = isPeak(atMs) ? 1 : 0;
  const yuan = (buckets[0] / 1e6) * price.miss[charged]
    + (buckets[1] / 1e6) * price.hit[charged]
    + (buckets[2] / 1e6) * price.miss[charged]
    + (buckets[3] / 1e6) * price.out[charged];
  return Math.round(yuan * MICRO);
}

/**
 * The usage one durable Assistant settlement reports, mirroring dsh-token-meter:
 * a settled message carries `data.usage`, an attempt carries it in its last
 * `usage` stream chunk.
 */
export function usageOf(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};
  if (type === 'assistant/message' && data.usage !== undefined) return data.usage;
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined;
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}

function bucketsOf(usage) {
  return [
    tokens(usage.inputTokens),
    tokens(usage.cacheReadTokens),
    tokens(usage.cacheWriteTokens),
    tokens(usage.outputTokens),
  ];
}

/** Fresh fold state. */
export function initState() {
  return { totalUnits: 0, requests: 0, last: null, pending: null };
}

/**
 * Fold one committed Session event.
 *
 * Returns the SAME reference when nothing moved.
 */
export function foldEvent(state, event) {
  const current = state;
  const type = event && event.type;
  const data = (event && event.data) || {};
  const at = Number(event && event.time);

  if (type === 'request/header') {
    const config = data.header && data.header.config;
    if (!config) return state;
    const turn = Number(data.turn);
    const step = Number(data.step);
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;
    const pending = {
      turn,
      step,
      model: String(config.model || ''),
      at: Number.isFinite(at) && at > 0 ? at : 0,
      costUnits: 0,
    };
    const before = current.pending;
    if (before !== null && before.turn === pending.turn && before.step === pending.step
      && before.model === pending.model && before.at === pending.at) return state;
    return { totalUnits: current.totalUnits, requests: current.requests, last: current.last, pending };
  }

  if (type === 'llm/retry-started') {
    const last = current.last;
    if (last !== null && last.turn === Number(data.turn) && last.step === Number(data.step)) {
      return { totalUnits: current.totalUnits, requests: current.requests, last: null, pending: current.pending };
    }
    return state;
  }

  const usage = usageOf(event);
  if (usage === undefined) return state;
  const turn = Number(data.turn);
  const step = Number(data.step);
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;

  const pending = current.pending !== null
    && current.pending.turn === turn && current.pending.step === step
    ? current.pending
    : null;
  const model = pending !== null
    ? pending.model
    : String((data.message && data.message.source && data.message.source.model) || '');
  const billedAt = pending !== null && pending.at > 0
    ? pending.at
    : (Number.isFinite(at) && at > 0 ? at : 0);
  const cost = costUnits(bucketsOf(usage), model, billedAt);

  const replaced = current.last !== null
    && current.last.turn === turn && current.last.step === step;
  const previous = replaced ? current.last.costUnits : 0;
  const totalUnits = current.totalUnits - previous + cost;
  if (totalUnits < 0) return state; // defensive: never publish a negative bill

  return {
    totalUnits,
    requests: current.requests + (replaced ? 0 : 1),
    last: { turn, step, model, at: billedAt, costUnits: cost },
    pending: current.pending,
  };
}

/** Fold a whole session log. */
export function costOfEvents(events) {
  let state = initState();
  for (const event of events) state = foldEvent(state, event);
  return state;
}

/** The client-visible shape: yuan plus the number of billed requests. */
export function costView(state) {
  const totalUnits = Number(state && state.totalUnits);
  const requests = Number(state && state.requests);
  return {
    cost: Number.isFinite(totalUnits) && totalUnits > 0 ? totalUnits / MICRO : 0,
    requests: Number.isSafeInteger(requests) && requests > 0 ? requests : 0,
  };
}

/**
 * Mount the route.
 * @param root - Host plugin context.
 */
export function apply(root) {
  // `webServer` is awaited locally rather than through an object-level `inject`,
  // so mounting this row never depends on a service being ready first.
  root.inject(['webServer'], (ctx) => {
    const live = new Map(); // sessionId -> Session
    const memo = new Map(); // sessionId -> { seq, view }

    const remember = (session) => {
      if (session && typeof session.id === 'string' && session.id !== '') live.set(session.id, session);
    };
    ctx.on('session/created', remember);
    ctx.on('session/event', remember);
    ctx.on('session/disposed', (session) => {
      if (!session || typeof session.id !== 'string') return;
      live.delete(session.id);
      memo.delete(session.id);
    });

    /** Exact cost for one session, re-derived from its own log. */
    const viewFor = (id) => {
      const session = live.get(id);
      if (!session) return null;
      const cached = memo.get(id);
      if (cached !== undefined && cached.seq === session.seq) return cached.view;
      let view;
      try {
        view = costView(costOfEvents(session.snapshotEvents()));
      } catch (err) {
        return null;
      }
      memo.set(id, { seq: session.seq, view });
      return view;
    };

    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        let id = '';
        try {
          const url = String((req && req.url) || '');
          const mark = url.indexOf('?');
          if (mark >= 0) id = new URLSearchParams(url.slice(mark + 1)).get('session') || '';
        } catch (err) {
          id = '';
        }
        const view = id === '' ? null : viewFor(id);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(view === null
          ? { ok: false, cost: 0, requests: 0 }
          : { ok: true, cost: view.cost, requests: view.requests }));
      },
    });
  });
}
