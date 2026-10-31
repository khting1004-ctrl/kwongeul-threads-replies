import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { JsonStore } from './lib/store.js';
import { ThreadsApi } from './lib/threads.js';
import { ReplyEngine } from './lib/engine.js';

const root = path.dirname(fileURLToPath(import.meta.url));
// Lightweight dotenv reader to keep the app dependency-free.
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
}
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminPassword.length < 12) {
  console.error('ADMIN_PASSWORD를 12자 이상으로 설정하세요.');
  process.exit(1);
}
const store = new JsonStore(path.resolve(root, process.env.DATA_DIR || './data', 'state.json'));
const api = process.env.THREADS_ACCESS_TOKEN && !process.env.THREADS_ACCESS_TOKEN.startsWith('YOUR_')
  ? new ThreadsApi(process.env.THREADS_ACCESS_TOKEN) : null;
const engine = api ? new ReplyEngine(store, api) : null;

const statePayload = () => {
  const s = store.state;
  return { connected: !!api, busy: engine?.busy || false,
    settings: s.settings, sync: s.sync,
    stats: { pending: Object.values(s.replies).filter(r => r.status === 'pending').length,
      sent: Object.values(s.replies).filter(r => r.status === 'sent').length,
      uncertain: Object.values(s.replies).filter(r => r.status === 'uncertain').length,
      sentToday: engine?.sentToday() || 0 },
    replies: Object.values(s.replies).sort((a, b) => (b.timestamp || b.firstSeenAt).localeCompare(a.timestamp || a.firstSeenAt)).slice(0, 1000),
    history: s.history.slice(0, 150),
  };
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const requireApi = () => { if (!api) fail('서버 환경변수 THREADS_ACCESS_TOKEN을 설정하세요.', 503); };
const operations = {
  'GET /api/state': () => statePayload(),
  'GET /api/profile': async () => { requireApi(); return api.me(); },
  'GET /api/connection': async () => { requireApi(); const profile = await api.me(); return { connected: true, username: profile.username, id: profile.id }; },
  'GET /api/posts': async () => { requireApi(); const r = await api.listPosts(); return { posts: (r.data || []).filter(p => p.is_reply !== true) }; },
  'POST /api/target': body => {
    if (engine?.busy) fail('작업 중에는 게시물을 변경할 수 없습니다.', 409);
    const id = String(body?.id || '').trim();
    const permalink = String(body?.permalink || '').trim();
    if (!/^\d{5,30}$/.test(id)) fail('Threads API 게시물 ID가 필요합니다.');
    if (store.state.settings.targetPostId !== id) store.resetForPost(id, permalink);
    else { store.state.settings.targetPermalink = permalink; store.save(); }
    return statePayload();
  },
  'POST /api/settings': body => {
    if (engine?.busy) fail('발송 중에는 변경할 수 없습니다.', 409);
    const { message, dailyMax, perBatchMax, delaySeconds } = body || {};
    if (typeof message !== 'string' || message.trim().length < 5 || [...message].length > 500)
      fail('답글 문구는 5~500자로 입력해 주세요.');
    const validInt = (n, lo, hi) => Number.isInteger(Number(n)) && Number(n) >= lo && Number(n) <= hi;
    if (!validInt(dailyMax, 0, 1000000) || !validInt(perBatchMax, 1, 20) || !validInt(delaySeconds, 3, 60)) fail('설정값 범위를 확인하세요. 하루 최대 0은 프로그램 자체 일일 제한 없음입니다.');
    Object.assign(store.state.settings, { message: message.trim(), dailyMax: Number(dailyMax),
      perBatchMax: Number(perBatchMax), delaySeconds: Number(delaySeconds) });
    store.save(); return statePayload();
  },
  'POST /api/sync': async () => { requireApi(); return engine.exclusive(async () => ({ ...await engine.sync(), state: statePayload() })); },
  'POST /api/auto': async body => { requireApi(); return engine.exclusive(async () => {
    if (body?.enabled === false) { store.state.settings.autoEnabled = false; store.save(); return statePayload(); }
    if (body?.enabled !== true) fail('올바르지 않은 요청입니다.');
    if (!store.state.settings.targetPostId) fail('이벤트 게시물을 선택하세요.');
    // Establish a baseline. Older replies stay pending for explicit manual sending.
    await engine.sync();
    store.state.settings.autoActivatedAt = new Date().toISOString();
    store.state.settings.autoEnabled = true; store.save();
    return statePayload();
  }); },
  'POST /api/send': async body => { requireApi(); return engine.exclusive(async () => {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some(x => typeof x !== 'string'))
      fail('발송할 댓글을 1~20개 선택하세요.');
    return { result: await engine.send({ mode: 'manual', ids }), state: statePayload() };
  }); },
  'POST /api/mark-reviewed': body => {
    if (engine?.busy) fail('진행 중인 작업이 있습니다.', 409);
    const item = store.state.replies[String(body?.id || '')];
    if (!item || item.status !== 'uncertain') fail('확인 필요 상태의 댓글만 처리할 수 있습니다.');
    const status = body?.status;
    if (status !== 'sent' && status !== 'pending') fail('sent 또는 pending만 허용됩니다.');
    item.status = status; item.error = null;
    if (status === 'sent') { item.sentAt ||= new Date().toISOString();
      store.state.history.unshift({ replyId: item.id, username: item.username, status: 'reviewed_sent', at: new Date().toISOString() }); }
    store.save(); return statePayload();
  },
};
const sendJSON = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
};
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const publicFiles = new Set(['/','/index.html','/app.js','/style.css']);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
  if (req.url === '/health' && req.method === 'GET') return sendJSON(res, 200, { ok: true });
  const credentials = req.headers.authorization || '';
  let parsed = '';
  try { if (credentials.startsWith('Basic ')) parsed = Buffer.from(credentials.slice(6), 'base64').toString('utf8'); } catch {}
  const password = parsed.slice(parsed.indexOf(':') + 1);
  const a = Buffer.from(password), b = Buffer.from(adminPassword);
  if (!(parsed.includes(':') && a.length === b.length && timingSafeEqual(a, b))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Threads Event Admin", charset="UTF-8"');
    res.writeHead(401); return res.end('관리자 인증이 필요합니다.');
  }
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const key = `${req.method} ${pathname}`;
    if (operations[key]) {
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString('utf8');
          if (raw.length > 30000) fail('요청 크기가 너무 큽니다.', 413);
        }
        try { body = JSON.parse(raw); } catch { fail('올바른 JSON 형식이 아닙니다.'); }
      }
      const output = await operations[key](body);
      return sendJSON(res, 200, output);
    }
    if (req.method === 'GET' && publicFiles.has(pathname)) {
      const file = path.join(root, 'public', pathname === '/' ? 'index.html' : pathname.slice(1));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain' });
      return fs.createReadStream(file).pipe(res);
    }
    sendJSON(res, 404, { error: '찾을 수 없습니다.' });
  } catch (err) {
    console.error(new Date().toISOString(), err.message);
    sendJSON(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 500, { error: err.message });
  }
});
const seconds = Math.max(60, Number(process.env.POLL_SECONDS) || 120);
if (engine) setInterval(() => engine.tick().catch(err => console.error('자동 확인 오류:', err.message)), seconds * 1000).unref();
const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Threads Event Admin: http://localhost:${port} / API ${api ? 'configured' : 'missing'}`));
