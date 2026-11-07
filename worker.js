// TradePro phone alerts: Cloudflare Worker (cron every minute) -> Telegram.
// Handles price, funding and PCR alerts. Quiet hours: hold and summarize, or drop.
// Bindings needed: KV namespace TP; secrets BOT_TOKEN, WEBHOOK_SECRET; vars BOT_USERNAME, ALLOWED_ORIGIN.

const BASES = ['https://api.india.delta.exchange', 'https://cdn.india.deltaex.org'];
const TOKEN_RE = /^[a-f0-9]{32}$/;
const MAX_RULES = 50, MAX_DEVICES = 20, MAX_BODY = 30000, MAX_HELD = 60, MAX_SCANS = 10;
const TFS = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (url.pathname === '/tg' && req.method === 'POST') return await tgWebhook(req, env);
      if (url.pathname === '/sync' && req.method === 'POST') return await sync(req, env);
      if (url.pathname === '/state' && req.method === 'GET') return await state(url, env);
      if (url.pathname === '/test' && req.method === 'POST') return await test(req, env);
      if (url.pathname === '/check' && req.method === 'POST') return await check(req, env);
      if (url.pathname === '/debug') { if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('no', { status: 401 }); return json(env, await debug(env)); }
    } catch (e) { return json(env, { ok: false, error: 'server error' }, 500); }
    return json(env, { ok: true, service: 'tradepro-alerts' });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};

const cors = env => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
const json = (env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
async function body(req) { const t = await req.text(); if (t.length > MAX_BODY) throw new Error('big'); return JSON.parse(t || '{}'); }
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

/* ---------- storage ---------- */
const getDev = async (env, t) => JSON.parse((await env.TP.get('dev:' + t)) || 'null');
const putDev = (env, t, d) => env.TP.put('dev:' + t, JSON.stringify(d));
const newDev = () => ({ rules: [], quiet: { on: false, start: '23:30', end: '07:00', tz: 'Asia/Kolkata', mode: 'hold' }, on: true, chat: null, hits: {}, held: [], scans: [], bars: {} });
async function register(env, t) {
  const idx = JSON.parse((await env.TP.get('idx')) || '[]');
  if (idx.includes(t)) return true;
  if (idx.length >= MAX_DEVICES) return false;
  idx.push(t); await env.TP.put('idx', JSON.stringify(idx)); return true;
}

/* ---------- validation ---------- */
function cleanRules(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_RULES).map(r => {
    if (!r || !['price', 'funding', 'pcr'].includes(r.type)) return null;
    const sym = String(r.sym || ''), val = num(r.val), id = num(r.id);
    if (!/^[A-Z0-9]{2,14}$/.test(sym) || val == null || id == null) return null;
    return { id, type: r.type, sym, op: r.op === '<' ? '<' : '>', val, ver: num(r.ver) || id, hit: num(r.hit) || 0, always: !!r.always };
  }).filter(Boolean);
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (e) { return false; } }
function cleanQuiet(q) {
  const t = /^([01]\d|2[0-3]):[0-5]\d$/;
  q = q || {};
  return { on: !!q.on, start: t.test(q.start) ? q.start : '23:30', end: t.test(q.end) ? q.end : '07:00', tz: typeof q.tz === 'string' && validTz(q.tz) ? q.tz : 'Asia/Kolkata', mode: q.mode === 'drop' ? 'drop' : 'hold' };
}

/* ---------- app endpoints ---------- */
const arr = (a, lo, hi) => { if (!Array.isArray(a)) return null; const o = a.slice(0, 8).map(num); return o.length && o.every(x => x != null && x >= lo && x <= hi) ? o : null; };
function cleanScans(list) {
  if (!Array.isArray(list)) return [];
  const T = /^([01]\d|2[0-3]):[0-5]\d$/;
  return list.slice(0, MAX_SCANS).map(s => {
    if (!s || !TFS[s.tf]) return null;
    const id = num(s.id); if (id == null) return null;
    const und = (Array.isArray(s.und) ? s.und : []).map(String).filter(u => /^[A-Z0-9]{2,10}$/.test(u)).slice(0, 4); if (!und.length) return null;
    const conds = (Array.isArray(s.conds) ? s.conds : []).slice(0, 6).map(c => {
      if (!c || !['gmma', 'gsq', 'st', 'ema', 'sma'].includes(c.k)) return null;
      const o = { op: c.op === 'below' ? 'below' : 'above', k: c.k };
      if (c.k === 'gmma' || c.k === 'gsq') {
        if (c.s != null) { o.s = arr(c.s, 1, 500); if (!o.s) return null; }
        if (c.l != null) { o.l = arr(c.l, 1, 500); if (!o.l) return null; }
        if (c.k === 'gmma') o.mode = c.mode === 'all' ? 'all' : 'avg';
        else { o.a = num(c.a); o.n = num(c.n); o.m = num(c.m); if ([o.a, o.n, o.m].some(x => x != null && (x <= 0 || x > 100))) return null; }
      } else if (c.k === 'st') { o.p = num(c.p); o.m = num(c.m); if (!(o.p >= 2 && o.p <= 100 && o.m > 0 && o.m <= 20)) return null; }
      else { o.p = num(c.p); if (!(o.p >= 1 && o.p <= 500)) return null; }
      return o;
    });
    if (!conds.length || conds.some(c => !c)) return null;
    const p = s.pause || {};
    const pause = { on: !!p.on, sd: Math.min(6, Math.max(0, (num(p.sd) || 0) | 0)), st: T.test(p.st) ? p.st : '19:00', ed: Math.min(6, Math.max(0, (num(p.ed) || 0) | 0)), et: T.test(p.et) ? p.et : '19:00', tz: typeof p.tz === 'string' && validTz(p.tz) ? p.tz : 'Asia/Kolkata' };
    return { id, name: String(s.name || 'Guppy alert').slice(0, 80), side: s.side === 'Sell' ? 'Sell' : 'Buy', und, tf: s.tf, conds, ver: num(s.ver) || id, pause };
  }).filter(Boolean);
}

const reply = (env, d) => json(env, { ok: true, linked: !!d.chat, bot: env.BOT_USERNAME || '', hits: d.hits, bars: d.bars || {} });
async function sync(req, env) {
  const b = await body(req); if (!TOKEN_RE.test(b.token || '')) return json(env, { ok: false, error: 'bad token' }, 400);
  const d = (await getDev(env, b.token)) || newDev();
  if (!(await register(env, b.token))) return json(env, { ok: false, error: 'device limit' }, 429);
  d.rules = cleanRules(b.rules); d.quiet = cleanQuiet(b.quiet); d.on = b.on !== false;
  d.scans = cleanScans(b.scans); d.bars = d.bars || {};
  { const sid = new Set(d.scans.map(x => String(x.id))); for (const k of Object.keys(d.bars)) if (!sid.has(k.split('|')[0])) delete d.bars[k]; }
  const ids = new Set(d.rules.map(r => r.id)), hits = {};
  d.rules.forEach(r => { const h = d.hits[r.id]; if (r.hit && (!h || h.t < r.hit)) hits[r.id] = { t: r.hit, v: null }; else if (h) hits[r.id] = h; });
  d.hits = hits; for (const k of Object.keys(d.hits)) if (!ids.has(+k)) delete d.hits[k];
  await putDev(env, b.token, d);
  return reply(env, d);
}
async function state(url, env) {
  const t = url.searchParams.get('token') || ''; if (!TOKEN_RE.test(t)) return json(env, { ok: false, error: 'bad token' }, 400);
  const d = await getDev(env, t); return d ? reply(env, d) : json(env, { ok: true, linked: false, bot: env.BOT_USERNAME || '', hits: {}, bars: {} });
}
async function test(req, env) {
  const b = await body(req), d = TOKEN_RE.test(b.token || '') ? await getDev(env, b.token) : null;
  if (!d || !d.chat) return json(env, { ok: false, error: 'not linked' }, 400);
  const r = await tgSend(env, d.chat, '✅ TradePro test alert. Phone alerts are working.');
  return json(env, { ok: r.ok });
}

/* ---------- Telegram ---------- */
async function tgSend(env, chat, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    return { ok: r.ok, blocked: r.status === 403 };
  } catch (e) { return { ok: false, blocked: false }; }
}
async function tgWebhook(req, env) {
  if (!env.WEBHOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 401 });
  const u = await req.json().catch(() => ({})), m = u.message; if (!m || !m.chat || typeof m.text !== 'string') return new Response('ok');
  const mm = /^\/start(?:@\w+)?\s+([a-f0-9]{32})$/.exec(m.text.trim());
  if (mm) {
    const d = await getDev(env, mm[1]);
    if (!d) await tgSend(env, m.chat.id, 'Open TradePro > Markets > Alerts first, then tap Link Telegram again.');
    else { d.chat = m.chat.id; await putDev(env, mm[1], d); await tgSend(env, m.chat.id, '✅ Linked. TradePro alerts will arrive here, even when the app is closed.'); }
  } else if (/^\/start/.test(m.text)) await tgSend(env, m.chat.id, 'Open TradePro > Markets > Alerts and tap Link Telegram.');
  return new Response('ok');
}

/* ---------- watcher ---------- */
async function getJson(path, log) {
  for (const b of BASES) {
    try {
      const r = await fetch(b + path, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; TradeProAlerts/1.0)' } });
      if (log) log.push(b.replace('https://', '') + ' HTTP ' + r.status);
      if (r.ok) return await r.json();
    } catch (e) { if (log) log.push(b.replace('https://', '') + ' error ' + String(e).slice(0, 80)); }
  }
  return null;
}
function parseOpt(sym) { const m = /^([CP])-([A-Z0-9]+)-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/.exec(sym || ''); return m ? { type: m[1], und: m[2], exp: '20' + m[6] + '-' + m[5] + '-' + m[4] } : null; }
function mins(s) { const [h, m] = s.split(':'); return +h * 60 + +m; }
function inQuiet(q, now) {
  if (!q || !q.on) return false;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: q.tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const c = (+p.find(x => x.type === 'hour').value % 24) * 60 + +p.find(x => x.type === 'minute').value, s = mins(q.start), e = mins(q.end);
  if (s === e) return false;
  return s < e ? c >= s && c < e : c >= s || c < e;
}
const money = v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmt = (r, v) => r.type === 'price' ? money(v) : r.type === 'funding' ? v.toFixed(4) + '%' : v.toFixed(2);
const label = r => r.sym.replace(/USD$/, '') + (r.type === 'price' ? ' price' : r.type === 'funding' ? ' funding' : ' PCR (all expiries)');
const message = (r, cur) => '🔔 ' + label(r) + (r.op === '>' ? ' rose above ' : ' fell below ') + fmt(r, r.val) + ' (now ' + fmt(r, cur) + ')';
const clock = (tz, t) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));

/* ---------- strategy (Guppy) alerts: same maths as the app's scanner ---------- */
function emaS(values, period) {
  const out = new Array(values.length).fill(null), k = 2 / (period + 1); let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) { let sum = 0; for (let j = 0; j < period; j++) sum += values[j]; prev = sum / period; out[i] = prev; }
    else if (i >= period) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}
const smaS = (v, p) => v.map((_, i) => i < p - 1 ? null : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
function supertrendS(candles, period, mult) {
  const n = candles.length, tr = new Array(n).fill(0), atr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) { const c = candles[i]; tr[i] = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)); }
  for (let i = period - 1; i < n; i++) {
    if (i === period - 1) { let sum = 0; for (let j = 0; j < period; j++) sum += tr[j]; atr[i] = sum / period; }
    else atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  const up = new Array(n).fill(null), lo = new Array(n).fill(null), line = new Array(n).fill(null), tu = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const c = candles[i], bu = (c.h + c.l) / 2 + mult * atr[i], bl = (c.h + c.l) / 2 - mult * atr[i];
    const pu = i > 0 ? up[i - 1] : null, pl = i > 0 ? lo[i - 1] : null, pc = i > 0 ? candles[i - 1].c : c.c;
    up[i] = (pu != null && (bu < pu || pc > pu)) ? bu : (pu != null ? pu : bu);
    lo[i] = (pl != null && (bl > pl || pc < pl)) ? bl : (pl != null ? pl : bl);
    if (tu[i - 1] == null) tu[i] = true;
    else if (tu[i - 1] && c.c < lo[i]) tu[i] = false;
    else if (!tu[i - 1] && c.c > up[i]) tu[i] = true;
    else tu[i] = tu[i - 1];
    line[i] = tu[i] ? lo[i] : up[i];
  }
  return line;
}
const G = { s: [10, 12, 15], l: [30, 35, 40] }, SQ = { a: 1.0, n: 10, m: 3 };
function gmmaLine(candles, c) {
  const closes = candles.map(x => x.c), avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const S = (c.s || G.s).map(p => emaS(closes, p)), L = (c.l || G.l).map(p => emaS(closes, p));
  return candles.map((_, i) => {
    const sv = S.map(a => a[i]), lv = L.map(a => a[i]);
    if (sv.concat(lv).some(v => v == null || !isFinite(v))) return null;
    return { sa: avg(sv), la: avg(lv), smin: Math.min(...sv), smax: Math.max(...sv), lmin: Math.min(...lv), lmax: Math.max(...lv) };
  });
}
function squeezeLine(candles, c) {
  const closes = candles.map(x => x.c), N = candles.length;
  const a = c.a > 0 ? c.a : SQ.a, n = c.n >= 1 ? c.n : SQ.n, m = c.m >= 1 ? c.m : SQ.m;
  const S = (c.s || G.s).map(p => emaS(closes, p)), L = (c.l || G.l).map(p => emaS(closes, p));
  const tr = candles.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - candles[i - 1].c), Math.abs(x.l - candles[i - 1].c)) : x.h - x.l);
  const atr = tr.map((_, i) => i < 14 ? null : tr.slice(i - 13, i + 1).reduce((x, y) => x + y, 0) / 14);
  const lo = new Array(N).fill(null), hi = new Array(N).fill(null), sq = new Array(N).fill(false);
  for (let i = 0; i < N; i++) {
    const all = S.concat(L).map(r => r[i]);
    if (all.some(v => v == null || !isFinite(v)) || !atr[i]) continue;
    lo[i] = Math.min(...all); hi[i] = Math.max(...all); sq[i] = (hi[i] - lo[i]) / atr[i] <= a;
  }
  return candles.map((cd, i) => {
    if (lo[i] == null) return null;
    let cnt = 0; for (let k = Math.max(0, i - n); k < i; k++) if (sq[k]) cnt++;
    const ctx = cnt >= m;
    return { ctx, dn: ctx && cd.c < lo[i], up: ctx && cd.c > hi[i] };
  });
}
function refLine(candles, c) {
  if (c.k === 'gmma') return gmmaLine(candles, c);
  if (c.k === 'gsq') return squeezeLine(candles, c);
  const closes = candles.map(x => x.c);
  if (c.k === 'ema') return emaS(closes, c.p);
  if (c.k === 'sma') return smaS(closes, c.p);
  return supertrendS(candles, c.p, c.m);
}
function condOk(c, px, v) {
  const below = c.op === 'below';
  if (c.k === 'gsq') return below ? v.dn : v.up;
  if (c.k === 'gmma') return c.mode === 'all' ? (below ? v.smax < v.lmin : v.smin > v.lmax) : (below ? v.sa < v.la : v.sa > v.la);
  return below ? px < v : px > v;
}
const condLabel = c => c.k === 'gsq' ? 'Squeeze ' + (c.op === 'below' ? 'breakdown' : 'breakout') : c.k === 'gmma' ? 'Guppy' : c.k === 'st' ? 'Supertrend' : c.k.toUpperCase() + c.p;
function evalConds(candles, conds) {
  const lines = conds.map(c => refLine(candles, c)), n = candles.length - 1;
  const at = i => conds.map((c, j) => { const v = lines[j][i]; return v != null && condOk(c, candles[i].c, v); });
  const now = at(n), prev = n > 0 ? at(n - 1) : [false];
  return { allNow: now.every(Boolean), allPrev: prev.every(Boolean), details: conds.map((c, j) => ({ label: condLabel(c), ok: now[j] })) };
}
async function candlesFor(u, tf, nowSec, cache, log) {
  const k = u + '|' + tf; if (cache.has(k)) return cache.get(k);
  const secs = TFS[tf], j = await getJson('/v2/history/candles?symbol=' + encodeURIComponent(u + 'USD') + '&resolution=' + tf + '&start=' + (nowSec - secs * 400) + '&end=' + nowSec, log);
  let c = ((j && j.result) || []).map(r => { let t = num(r.time); if (t == null) return null; if (t > 1e12) t = Math.floor(t / 1000); return { t, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close) }; })
    .filter(x => x && x.o != null && x.h != null && x.l != null && x.c != null).sort((a, b) => a.t - b.t).filter((x, i, a) => !i || x.t !== a[i - 1].t);
  const last = c[c.length - 1]; if (last && last.t + secs > nowSec) c = c.slice(0, -1);
  cache.set(k, c); return c;
}
function paused(p, now) {
  if (!p || !p.on) return false;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: p.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.find(x => x.type === 'weekday').value);
  const m = dow * 1440 + (+f.find(x => x.type === 'hour').value % 24) * 60 + +f.find(x => x.type === 'minute').value, s = p.sd * 1440 + mins(p.st), e = p.ed * 1440 + mins(p.et);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}
async function scanRows(d, now, cache, log, all) {
  const rows = [], nowSec = Math.floor(now / 1000);
  for (const sc of d.scans || []) for (const u of sc.und) {
    const secs = TFS[sc.tf];
    if (!all && secs > 360 && (nowSec % secs) > 400) continue;   // bigger timeframes: look only just after a candle closes
    const candles = await candlesFor(u, sc.tf, nowSec, cache, log);
    if (!candles || candles.length < 60) { if (all) rows.push({ sc, u, err: 'not enough candles' }); continue; }
    rows.push({ sc, u, ev: evalConds(candles, sc.conds), price: candles[candles.length - 1].c, closeT: (candles[candles.length - 1].t + secs) * 1000, key: sc.id + '|' + u + '|' + sc.tf });
  }
  return rows;
}
const sigMsg = (sc, r, tz) => (sc.side === 'Buy' ? '📈 BUY' : '📉 SELL') + ' signal: ' + r.u + ' ' + sc.tf + ' at ' + money(r.price) + ' (candle closed ' + clock(tz, r.closeT) + '). ' + sc.name
async function check(req, env) {
  const b = await body(req), d = TOKEN_RE.test(b.token || '') ? await getDev(env, b.token) : null;
  if (!d || !d.chat) return json(env, { ok: false, error: 'not linked' }, 400);
  if (!(d.scans || []).length) { await tgSend(env, d.chat, '🔎 No Guppy alerts are switched on in TradePro yet.'); return json(env, { ok: true, text: 'none' }); }
  const rows = await scanRows(d, Date.now(), new Map(), [], true);
  const lines = rows.map(r => r.err ? r.u + ' ' + r.sc.tf + ': ' + r.err : r.u + ' ' + r.sc.tf + ' at ' + money(r.price) + ': ' + (r.ev.allNow ? 'ALL conditions met now' : 'not met') + ' (' + r.ev.details.map(x => x.label + (x.ok ? ' ✓' : ' ✗')).join(', ') + ')');
  const text = '🔎 Guppy check now:\n' + lines.join('\n') + '\nAlerts fire only when a NEW signal forms on a closed candle' + (d.scans.some(x => paused(x.pause, Date.now())) ? ' (a pause window is active right now).' : '.');
  const r = await tgSend(env, d.chat, text); return json(env, { ok: r.ok, text });
}

async function market(devs, now, log) {
  const needPerp = devs.some(([, d]) => d.rules.some(r => r.type !== 'pcr')), unders = new Set();
  devs.forEach(([, d]) => d.rules.forEach(r => { if (r.type === 'pcr') unders.add(r.sym); }));
  const perp = {}, pcr = {};
  if (needPerp) { const j = await getJson('/v2/tickers?contract_types=perpetual_futures', log); ((j && j.result) || []).forEach(t => { if (t && /^[A-Z0-9]+USD$/.test(t.symbol || '')) perp[t.symbol] = { price: num(t.mark_price) != null ? num(t.mark_price) : num(t.close), fund: num(t.funding_rate) }; }); }
  const today = new Date(now).toISOString().slice(0, 10);
  for (const u of unders) {
    const j = await getJson('/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=' + encodeURIComponent(u), log); let c = 0, p = 0;
    ((j && j.result) || []).forEach(t => { const o = parseOpt(t && t.symbol); if (!o || o.und !== u || o.exp < today) return; const v = num(t.oi_contracts != null ? t.oi_contracts : t.oi) || 0; if (o.type === 'C') c += v; else p += v; });
    if (c) pcr[u] = p / c;
  }
  return { perp, pcr, cur: r => r.type === 'pcr' ? (pcr[r.sym] != null ? pcr[r.sym] : null) : (perp[r.sym] ? (r.type === 'price' ? perp[r.sym].price : perp[r.sym].fund) : null) };
}
async function loadDevs(env) {
  const idx = JSON.parse((await env.TP.get('idx')) || '[]'), devs = [];
  for (const t of idx) { const d = await getDev(env, t); if (d && d.on && d.chat) { d.scans = d.scans || []; d.bars = d.bars || {}; devs.push([t, d]); } }
  return devs;
}
async function run(env) {
  let s;
  try { s = await watch(env); } catch (e) { s = { err: String(e).slice(0, 200) }; }
  const now = Date.now(), prev = JSON.parse((await env.TP.get('last')) || 'null');
  if (!prev || now - prev.t > 600000 || s.err || s.fired) await env.TP.put('last', JSON.stringify({ t: now, ...s }));
}
async function debug(env) {
  const devs = await loadDevs(env), log = [], now = Date.now(), m = await market(devs, now, log);
  return { ok: true, now: new Date(now).toISOString(), last: JSON.parse((await env.TP.get('last')) || 'null'), fetch: log, perpCount: Object.keys(m.perp).length, perpSample: m.perp.BTCUSD || null,
    scans: await Promise.all(devs.map(async ([, d]) => (await scanRows(d, now, new Map(), log, true)).map(r => ({ name: r.sc.name, und: r.u, tf: r.sc.tf, paused: paused(r.sc.pause, now), err: r.err || null, price: r.price, allNow: r.ev && r.ev.allNow, allPrev: r.ev && r.ev.allPrev, conds: r.ev && r.ev.details, lastClose: r.closeT ? new Date(r.closeT).toISOString() : null })))),
    devices: devs.map(([, d]) => ({ linked: !!d.chat, quiet: d.quiet, held: d.held.length, rules: d.rules.map(r => { const c = m.cur(r), hitAt = Math.max(r.hit || 0, (d.hits[r.id] && d.hits[r.id].t) || 0); return { type: r.type, sym: r.sym, op: r.op, val: r.val, current: c, met: c != null && (r.op === '>' ? c >= r.val : c <= r.val), alreadyHit: hitAt >= r.ver }; }) })) };
}

async function watch(env) {
  const devs = await loadDevs(env);
  if (!devs.length) return { devices: 0 };
  const now = Date.now(), log = [], m = await market(devs, now, log); let fired = 0;
  const cur = m.cur, cache = new Map();
  for (const [t, d] of devs) {
    let dirty = false, quiet = false;
    try { quiet = inQuiet(d.quiet, now); } catch (e) { quiet = false; }
    for (const r of d.rules) {
      const hitAt = Math.max(r.hit || 0, (d.hits[r.id] && d.hits[r.id].t) || 0); if (hitAt >= r.ver) continue;
      const c = cur(r); if (c == null || !(r.op === '>' ? c >= r.val : c <= r.val)) continue;
      const msg = message(r, c);
      if (quiet && !r.always) {
        d.hits[r.id] = { t: now, v: c }; dirty = true;
        if (d.quiet.mode !== 'drop') { d.held.push({ t: now, m: msg }); d.held = d.held.slice(-MAX_HELD); }
        continue;
      }
      const s = await tgSend(env, d.chat, msg);
      if (s.blocked) { d.chat = null; dirty = true; break; }
      if (s.ok) { d.hits[r.id] = { t: now, v: c }; dirty = true; fired++; }
    }
    if (d.chat && d.scans.length) {
      const rows = await scanRows(d, now, cache, log, false);
      for (const r of rows) {
        const sc = r.sc;
        if (!(r.ev.allNow && !r.ev.allPrev)) continue;
        if (r.closeT < sc.ver || now - r.closeT > 900000 || r.closeT <= (d.bars[r.key] || 0)) continue;
        if (paused(sc.pause, now)) continue;
        const msg = sigMsg(sc, r, d.quiet.tz);
        if (quiet) { d.bars[r.key] = r.closeT; dirty = true; if (d.quiet.mode !== 'drop') { d.held.push({ t: now, m: msg }); d.held = d.held.slice(-MAX_HELD); } continue; }
        const s = await tgSend(env, d.chat, msg);
        if (s.blocked) { d.chat = null; dirty = true; break; }
        if (s.ok) { d.bars[r.key] = r.closeT; dirty = true; fired++; }
      }
    }
    if (d.chat && !quiet && d.held.length) {
      const tz = d.quiet.tz, text = '🌙 While you were away (' + d.held.length + '):\n' + d.held.map(h => clock(tz, h.t) + '  ' + h.m.replace(/^🔔 /, '')).join('\n');
      const s = await tgSend(env, d.chat, text); if (s.ok) { d.held = []; dirty = true; }
    }
    if (dirty) await putDev(env, t, d);
  }
  return { devices: devs.length, fired, perp: Object.keys(m.perp).length, fetch: log };
}
