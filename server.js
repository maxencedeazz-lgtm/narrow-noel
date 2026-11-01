// Narrow Noël : serveur du site + relais temps réel (WebSocket fait maison, aucune dépendance)
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const gz = zlib.gzipSync(html, { level: 9 });

/* ============================================================
   Comptes : pseudo + mot de passe (scrypt), jeton signé (HMAC)
   Stockage : fichier JSON (par défaut) ou Upstash Redis (persistant, gratuit)
   ============================================================ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
function fileStore() {
  const file = path.join(DATA_DIR, 'accounts.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  let t = null;
  const flush = () => { clearTimeout(t); t = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('save failed', e.message); }
  }, 200); };
  return {
    kind: 'fichier ' + file,
    async get(k) { return db[k] === undefined ? null : db[k]; },
    async set(k, v) { db[k] = v; flush(); },
    async setNX(k, v) { if (db[k] !== undefined) return false; db[k] = v; flush(); return true; },
  };
}
function upstashStore() {
  const cmd = async (...args) => {
    const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
  };
  return {
    kind: 'Upstash Redis',
    async get(k) { return cmd('GET', k); },
    async set(k, v) { await cmd('SET', k, v); },
    async setNX(k, v) { return (await cmd('SET', k, v, 'NX')) === 'OK'; },
  };
}
const store = UP_URL && UP_TOKEN ? upstashStore() : fileStore();
let SECRET = process.env.SESSION_SECRET || null;
async function secret() {
  if (SECRET) return SECRET;
  let s = await store.get('nn:secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); if (!(await store.setNX('nn:secret', s))) s = await store.get('nn:secret'); }
  return (SECRET = s);
}
const USER_RE = /^[A-Za-z0-9_-]{3,16}$/;
const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? ko(e) : ok(k)));
async function makeToken(user) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 60;                  // 60 jours
  const body = Buffer.from(JSON.stringify({ u: user, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  return body + '.' + sig;
}
async function readToken(tok) {
  if (typeof tok !== 'string' || tok.length > 600 || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const good = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() && USER_RE.test(o.u) ? o.u : null; } catch (e) { return null; }
}
// profile sent by the game : keep only known fields, clamp numbers
function cleanProfile(p) {
  const out = { coins: 0, total: 0, kills: 0, assists: 0, caps: 0, games: 0, wins: 0, owned: { hat: [0], trail: [0] }, eq: { hat: 0, trail: 0 } };
  if (!p || typeof p !== 'object') return out;
  for (const k of ['coins', 'total', 'kills', 'assists', 'caps', 'games', 'wins']) { const v = Math.floor(Number(p[k])); out[k] = isFinite(v) ? Math.min(1e9, Math.max(0, v)) : 0; }
  for (const k of ['hat', 'trail']) {
    const arr = p.owned && Array.isArray(p.owned[k]) ? p.owned[k] : [];
    out.owned[k] = [...new Set([0, ...arr.filter(i => Number.isInteger(i) && i >= 0 && i < 32)])];
    const e = p.eq ? p.eq[k] : 0; out.eq[k] = out.owned[k].includes(e) ? e : 0;
  }
  const LIM = { fur: 8, belly: 5, beak: 5, eyes: 5, shape: 3, cheeks: 2, acc: 5 };
  out.look = {};
  for (const k in LIM) { const v = p.look ? p.look[k] : 0; out.look[k] = Number.isInteger(v) && v >= 0 && v < LIM[k] ? v : 0; }
  return out;
}
const tries = new Map();                                              // anti brute force : 12 essais / 5 min / IP
function limited(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 300000);
  t.push(now); tries.set(ip, t); return t.length > 12;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (!v.some(x => now - x < 300000)) tries.delete(k); }, 60000);
function readBody(req) {
  return new Promise((ok, ko) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 16384) { ko(new Error('trop gros')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { ko(e); } });
    req.on('error', ko);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function api(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
      if (limited(ip)) return json(res, 429, { error: 'Trop d’essais. Attends quelques minutes.' });
      const b = await readBody(req);
      const user = String(b.username || '').trim(), pw = String(b.password || '');
      if (!USER_RE.test(user)) return json(res, 400, { error: 'Pseudo : 3 à 16 caractères (lettres, chiffres, _ ou -).' });
      if (pw.length < 6 || pw.length > 72) return json(res, 400, { error: 'Mot de passe : 6 à 72 caractères.' });
      const key = 'nn:user:' + user.toLowerCase();
      if (url === '/api/register') {
        const salt = crypto.randomBytes(16);
        const hash = await scrypt(pw, salt);
        const rec = { name: user, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(), profile: cleanProfile(b.profile) };
        if (!(await store.setNX(key, JSON.stringify(rec)))) return json(res, 409, { error: 'Ce pseudo est déjà pris.' });
        return json(res, 200, { token: await makeToken(user.toLowerCase()), username: user, profile: rec.profile });
      }
      const raw = await store.get(key);
      const rec = raw ? JSON.parse(raw) : null;
      const salt = rec ? Buffer.from(rec.salt, 'hex') : crypto.randomBytes(16);
      const hash = await scrypt(pw, salt);                          // même coût que le compte existe ou pas
      if (!rec || !crypto.timingSafeEqual(hash, Buffer.from(rec.hash, 'hex'))) return json(res, 401, { error: 'Pseudo ou mot de passe incorrect.' });
      tries.delete(ip);
      return json(res, 200, { token: await makeToken(user.toLowerCase()), username: rec.name, profile: cleanProfile(rec.profile) });
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const who = await readToken(auth);
    if (!who) return json(res, 401, { error: 'Session expirée, reconnecte-toi.' });
    const key = 'nn:user:' + who;
    const raw = await store.get(key); if (!raw) return json(res, 401, { error: 'Compte introuvable.' });
    const rec = JSON.parse(raw);
    if (req.method === 'GET' && url === '/api/me') return json(res, 200, { username: rec.name, profile: cleanProfile(rec.profile) });
    if (req.method === 'PUT' && url === '/api/profile') {
      const b = await readBody(req);
      rec.profile = cleanProfile(b.profile); rec.updated = Date.now();
      await store.set(key, JSON.stringify(rec));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Inconnu' });
  } catch (e) {
    console.error('api', e.message);
    return json(res, 500, { error: 'Erreur du serveur, réessaie.' });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url.startsWith('/api/')) { api(req, res); return; }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(gz); }
  else { res.writeHead(200, h); res.end(html); }
});

const clients = new Map();   // id -> client
const rooms = new Map();     // nom -> Map(id -> presence)
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_IN_ROOM = 24;

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const id = 'p' + crypto.randomBytes(6).toString('hex');
  const c = { id, sock, rooms: new Set(), buf: Buffer.alloc(0), msgs: 0 };
  clients.set(id, c);
  send(c, { t: 'hello', id });
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 1 << 20) return drop(c); parseFrames(c); });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});

function parseFrames(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, masked = b1 & 128;
    let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 65536) return drop(c);
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let payload = Buffer.from(c.buf.subarray(off + (masked ? 4 : 0), need));
    if (masked) { const m = c.buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(need);
    if (!(b0 & 128)) return drop(c);          // messages fragmentés : non utilisés par le jeu
    if (op === 8) return drop(c);
    if (op === 9) { frame(c, 10, payload); continue; }
    if (op === 1) { let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; } onMsg(c, m); }
  }
}
function frame(c, op, data) {
  if (c.sock.destroyed) return;
  const len = data.length; let head;
  if (len < 126) head = Buffer.from([128 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 128 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 128 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  c.sock.write(Buffer.concat([head, data]));
}
function send(c, obj) { frame(c, 1, Buffer.from(JSON.stringify(obj))); }
function broadcast(r, obj, except) {
  const R = rooms.get(r); if (!R) return;
  const buf = Buffer.from(JSON.stringify(obj));
  for (const id of R.keys()) if (id !== except) { const o = clients.get(id); if (o) frame(o, 1, buf); }
}
function onMsg(c, m) {
  if (!m || typeof m !== 'object') return;
  if (++c.msgs > 120) return;                   // anti-flood : 120 messages par seconde max
  const r = typeof m.room === 'string' && ROOM_RE.test(m.room) ? m.room : null;
  if (!r) return;
  if (m.t === 'join') {
    let R = rooms.get(r); if (!R) rooms.set(r, R = new Map());
    if (!R.has(c.id)) { if (R.size >= MAX_IN_ROOM) return send(c, { t: 'full', room: r }); R.set(c.id, {}); }
    c.rooms.add(r);
    send(c, { t: 'peers', room: r, peers: [...R].map(([peer, presence]) => ({ peer, presence })) });
    broadcast(r, { t: 'p', room: r, peer: c.id, presence: R.get(c.id) }, c.id);
  } else if (m.t === 'pres') {
    const R = rooms.get(r); if (!R || !R.has(c.id)) return;
    const p = m.p && typeof m.p === 'object' && !Array.isArray(m.p) ? m.p : {};
    if (JSON.stringify(p).length > 4096) return;
    R.set(c.id, p);
    broadcast(r, { t: 'p', room: r, peer: c.id, presence: p }, c.id);
  } else if (m.t === 'leave') leaveRoom(c, r);
}
function leaveRoom(c, r) {
  const R = rooms.get(r); if (!R) return;
  R.delete(c.id); c.rooms.delete(r);
  if (!R.size) rooms.delete(r); else broadcast(r, { t: 'gone', room: r, peer: c.id });
}
function drop(c) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  for (const r of [...c.rooms]) leaveRoom(c, r);
  try { c.sock.destroy(); } catch (e) { }
}
setInterval(() => { for (const c of clients.values()) c.msgs = 0; }, 1000);
setInterval(() => { for (const c of clients.values()) frame(c, 9, Buffer.alloc(0)); }, 25000);   // garde la connexion ouverte derrière les proxys
server.listen(PORT, () => console.log('Narrow Noël en ligne sur http://localhost:' + PORT + ' (comptes : ' + store.kind + ')'));
