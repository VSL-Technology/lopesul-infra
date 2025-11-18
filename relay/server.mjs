// Mikrotik Relay — produção
import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as ROS from 'routeros-api';
import { PrismaClient } from '@prisma/client';
import { requireDeviceRouter } from './device-router.mjs';

dotenv.config({ override: true });

// Inicializa Prisma (opcional - só se DATABASE_URL estiver configurado)
let prisma = null;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (DATABASE_URL) {
  try {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
    console.log('[relay] Prisma Client inicializado (modo inteligente ativo)');
  } catch (err) {
    console.warn('[relay] Prisma não disponível:', err?.message || err);
  }
} else {
  console.warn('[relay] DATABASE_URL não configurado - modo inteligente desabilitado');
}

// Compat ESM/CJS p/ routeros-api
let RouterOSAPI = ROS.RouterOSAPI || ROS.default || ROS;

// Normaliza envs legados (se existirem)
process.env.MKT_HOST = process.env.MKT_HOST || process.env.MIKROTIK_HOST;
process.env.MKT_USER = process.env.MKT_USER || process.env.MIKROTIK_USER;
process.env.MKT_PASS = process.env.MKT_PASS || process.env.MIKROTIK_PASS;
process.env.MKT_PORT = process.env.MKT_PORT || process.env.MIKROTIK_PORT;

const app = express();
const PORT = Number(process.env.PORT || 3001);
const INTERVAL = Number(process.env.INTERVAL || 15000);

// CORS restrito (páginas que chamam o relay)
const allowed = (process.env.CORS_ORIGINS || [
  'https://cativo.lopesuldashboardwifi.com',
  'https://painel.lopesuldashboardwifi.com'
]).toString().split(',').map(s => s.trim()).filter(Boolean);

app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  }
}));
app.options(/.*/, cors()); // libera OPTIONS de qualquer rota

// Auth por Bearer (global)
const MUST_TOKEN = (process.env.RELAY_TOKEN ?? '').trim();
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/status') return next();
  if (!MUST_TOKEN) return res.status(500).json({ ok:false, error:'relay token not set' });

  const raw = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(raw);
  const given = (m?.[1] || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (given !== MUST_TOKEN) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  next();
});

// Tratador leve pra erros do CORS
app.use((err, req, res, next) => {
  if (err?.message === 'CORS blocked') {
    return res.status(403).json({ ok:false, error:'cors' });
  }
  next(err);
});

// Parse lista de MKs
function parseMikList() {
  const raw = process.env.MIK_LIST || '';
  return raw.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [id, host, user, pass] = entry.split('@');
      if (!id || !host || !user || !pass) return null;
      return { id, host, user, pass };
    })
    .filter(Boolean);
}
const mikrotiks = parseMikList();

// Guarda explícita se cair no fallback sem MIK_LIST e sem creds
if (!mikrotiks.length && (!process.env.MKT_HOST || !process.env.MKT_USER || !process.env.MKT_PASS)) {
  console.warn('[relay] Sem MIK_LIST e sem MKT_* completos — apenas /health e /status vão responder.');
}

const status = {}; // status por ID/host
let coldStart = true;

// Cache simples de dispositivos (TTL: 60s)
const deviceCache = new Map();
const CACHE_TTL_MS = 60000;
function getCachedDevice(key) {
  const entry = deviceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    deviceCache.delete(key);
    return null;
  }
  return entry.data;
}
function setCachedDevice(key, data) {
  deviceCache.set(key, { data, timestamp: Date.now() });
}

// Helpers Mikrotik
async function getRouterOS() {
  if (RouterOSAPI) return RouterOSAPI;
  try {
    const mod = await import('routeros-api');
    RouterOSAPI = mod.RouterOSAPI || mod.default || mod;
    return RouterOSAPI;
  } catch {
    const err = new Error('routeros-module-missing');
    err.code = 'ROSMOD_MISSING';
    throw err;
  }
}

async function withROS(mk, fn) {
  const API = await getRouterOS(); // import dinâmico se necessário
  const api = new API({
    host: mk.host,
    user: mk.user,
    password: mk.pass,
    port: Number(process.env.MKT_PORT || 8728),
    timeout: Number(process.env.MKT_TIMEOUT_MS || 12000)
  });
  await api.connect();
  try { return await fn(api); }
  finally { try { await api.close(); } catch {} }
}

async function execROS(sentences, mk) {
  const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS || 7000);
  const runWithTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error('CMD_TIMEOUT'), { code: 'CMD_TIMEOUT' })), CMD_TIMEOUT_MS)
      )
    ]);

  try {
    const out = await withROS(mk, api =>
      runWithTimeout(api.write(Array.isArray(sentences) ? sentences : [String(sentences)]))
    );
    return { ok: true, data: Array.isArray(out) ? out : [] };
  } catch (e) {
    const msg = String(e?.message || '');
    const code = e?.code || e?.errno;
    if (code === 'ROSMOD_MISSING') return { ok:false, error:'routeros-api-not-installed' };
    if (code === 'UNKNOWNREPLY' || /!empty/i.test(msg) || code === 'CMD_TIMEOUT') {
      return { ok:true, data:[] };
    }
    return { ok:false, error: msg || 'routeros-error' };
  }
}

function pickMKFromReq(req) {
  const qid = (req?.query?.id || req?.body?.id || '').toString().trim();
  const qhost = (req?.query?.host || req?.body?.host || '').toString().trim();
  if (qid) return mikrotiks.find(m => m.id === qid) || mikrotiks[0];
  if (qhost) return mikrotiks.find(m => m.host === qhost) || mikrotiks[0];
  if (!mikrotiks.length) {
    return {
      id: process.env.MKT_ID || 'default',
      host: process.env.MKT_HOST || '10.200.200.2',
      user: process.env.MKT_USER,
      pass: process.env.MKT_PASS
    };
  }
  return mikrotiks[0];
}

// ===== Guardas extras (fallback sem MIK_LIST) =====
function hasMkCreds(mk) {
  return !!(mk && mk.host && mk.user && mk.pass);
}
function requireMkOr503(mk, res) {
  if (!hasMkCreds(mk)) {
    res.status(503).json({ ok:false, error:'mikrotik-credentials-missing' });
    return false;
  }
  return true;
}

// Watchdog
async function testarConexao(mk) {
  try {
    const ident = await withROS(mk, api => api.write('/system/identity/print'));
    const idName = (ident && ident[0] && (ident[0].name || ident[0]['.id'])) || mk.id;
    return { ok: true, identity: idName };
  } catch (err) {
    const code = err?.code;
    const msg = String(err?.message || '');
    if (msg.includes('Login failed')) return { ok:false, error:'auth-failed' };
    if (['ECONNREFUSED','EHOSTUNREACH','ETIMEDOUT'].includes(code)) return { ok:false, error:code };
    return { ok:false, error: msg || 'unknown' };
  }
}

async function pollAll() {
  const list = mikrotiks.length ? mikrotiks : [pickMKFromReq({})];
  for (const mk of list) {
    if (!hasMkCreds(mk)) {
      status[mk.id || mk.host || 'fallback'] = {
        online: false,
        identity: null,
        lastOk: null,
        lastErr: 'mikrotik-credentials-missing',
        host: mk.host || null
      };
      continue;
    }
    const r = await testarConexao(mk);
    status[mk.id || mk.host] = {
      online: r.ok,
      identity: r.identity || null,
      lastOk: r.ok ? new Date().toISOString() : (status[mk.id || mk.host]?.lastOk || null),
      lastErr: r.ok ? null : r.error,
      host: mk.host
    };
    if (coldStart) {
      console.log(r.ok ? `✓ ${mk.id || mk.host} ONLINE` : `✗ ${mk.id || mk.host} OFF (${r.error})`);
    }
  }
  coldStart = false;
}
setInterval(() => { pollAll().catch(() => {}); }, INTERVAL);
pollAll().catch(() => {});

// ===== Parse de comando RouterOS =====
function parseCommandToSentences(cmd) {
  if (Array.isArray(cmd)) return cmd;
  const str = String(cmd).trim();
  if (!str) return [];
  
  const parts = str.split(/\s+/);
  const result = [parts[0]]; // primeiro elemento é o path (ex: /ip/hotspot/user/add)
  
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].includes('=')) {
      result.push('=' + parts[i]);
    }
  }
  
  return result;
}

// ===== Rotas =====
app.get('/health', (req, res) =>
  res.json({ ok:true, service:'relay', now:new Date().toISOString() })
);

// /status verboso com tempos/intervalo, CORS e fallbackMk
app.get('/status', (req, res) => {
  const fallbackMk = (!mikrotiks.length) ? {
    id: process.env.MKT_ID || 'default',
    host: process.env.MKT_HOST || null,
    hasCreds: !!(process.env.MKT_HOST && process.env.MKT_USER && process.env.MKT_PASS)
  } : null;

  res.json({
    ok: true,
    service: 'relay',
    config: {
      PORT,
      INTERVAL,
      MKT_PORT: Number(process.env.MKT_PORT || 8728),
      MKT_TIMEOUT_MS: Number(process.env.MKT_TIMEOUT_MS || 12000),
      CMD_TIMEOUT_MS: Number(process.env.CMD_TIMEOUT_MS || 7000),
      cors_allowed: allowed
    },
    mikrotiks: mikrotiks.map(({ id, host }) => ({ id, host })),
    fallbackMk,
    status
  });
});

// ===== Modo Direto (compatibilidade) =====
app.post('/relay/exec', async (req, res) => {
  const mk = pickMKFromReq(req);
  if (!requireMkOr503(mk, res)) return;
  const command = req.body?.command;
  if (!command) return res.status(400).json({ ok:false, error:'missing command' });
  const sentences = parseCommandToSentences(command);
  const r = await execROS(sentences, mk);
  if (!r.ok) return res.status(502).json(r);
  res.json(r);
});

// ===== Modo Inteligente - Exec por Pedido =====
app.post('/relay/exec-by-pedido', async (req, res) => {
  if (!prisma) {
    return res.status(503).json({ ok:false, error:'database_not_available' });
  }

  const pedidoId = (req.body?.pedidoId || req.body?.orderId || '').toString().trim();
  if (!pedidoId) {
    return res.status(400).json({ ok:false, error:'missing pedidoId' });
  }

  const command = req.body?.command;
  if (!command) {
    return res.status(400).json({ ok:false, error:'missing command' });
  }

  try {
    // Busca pedido no banco
    const pedido = await prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { device: true },
    }).catch(() => null);

    if (!pedido) {
      return res.status(404).json({ ok:false, error:'pedido_not_found' });
    }

    // Busca dispositivo usando device-router
    const cacheKey = `pedido:${pedidoId}`;
    let routerInfo = getCachedDevice(cacheKey);
    
    if (!routerInfo) {
      const lookup = {
        deviceId: pedido.deviceId || pedido.device?.id,
        mikId: pedido.device?.mikId || pedido.deviceIdentifier,
      };
      
      routerInfo = await requireDeviceRouter(prisma, lookup);
      setCachedDevice(cacheKey, routerInfo);
    }

    const mk = {
      host: routerInfo.router.host,
      user: routerInfo.router.user,
      pass: routerInfo.router.pass,
      port: routerInfo.router.port || 8728,
    };

    const sentences = parseCommandToSentences(command);
    const r = await execROS(sentences, mk);
    
    if (!r.ok) return res.status(502).json(r);
    res.json({ ...r, deviceId: routerInfo.device.id, mikId: routerInfo.device.mikId });
  } catch (err) {
    const code = err?.code || 'unknown_error';
    const statusCode = code === 'device_not_found' ? 404 : 500;
    return res.status(statusCode).json({ ok:false, error:code, detail:err?.message });
  }
});

// ===== Modo Inteligente - Exec por Device =====
app.post('/relay/exec-by-device', async (req, res) => {
  if (!prisma) {
    return res.status(503).json({ ok:false, error:'database_not_available' });
  }

  const deviceId = (req.body?.deviceId || req.body?.dispositivoId || '').toString().trim();
  const mikId = (req.body?.mikId || req.body?.routerId || '').toString().trim();
  
  if (!deviceId && !mikId) {
    return res.status(400).json({ ok:false, error:'missing deviceId or mikId' });
  }

  const command = req.body?.command;
  if (!command) {
    return res.status(400).json({ ok:false, error:'missing command' });
  }

  try {
    // Busca dispositivo usando device-router (com cache)
    const cacheKey = `device:${deviceId || mikId}`;
    let routerInfo = getCachedDevice(cacheKey);
    
    if (!routerInfo) {
      routerInfo = await requireDeviceRouter(prisma, { deviceId, mikId });
      setCachedDevice(cacheKey, routerInfo);
    }

    const mk = {
      host: routerInfo.router.host,
      user: routerInfo.router.user,
      pass: routerInfo.router.pass,
      port: routerInfo.router.port || 8728,
    };

    const sentences = parseCommandToSentences(command);
    const r = await execROS(sentences, mk);
    
    if (!r.ok) return res.status(502).json(r);
    res.json({ ...r, deviceId: routerInfo.device.id, mikId: routerInfo.device.mikId });
  } catch (err) {
    const code = err?.code || 'unknown_error';
    const statusCode = code === 'device_not_found' ? 404 : 500;
    return res.status(statusCode).json({ ok:false, error:code, detail:err?.message });
  }
});

// Hotspot
app.get('/hotspot/active', async (req, res) => {
  const mk = pickMKFromReq(req);
  if (!requireMkOr503(mk, res)) return;
  const r = await execROS(['/ip/hotspot/active/print'], mk);
  if (!r.ok) return res.status(502).json(r);
  res.json(r);
});

app.get('/hotspot/active/compact', async (req, res) => {
  const mk = pickMKFromReq(req);
  if (!requireMkOr503(mk, res)) return;
  const r = await execROS(['/ip/hotspot/active/print'], mk);
  if (!r.ok) return res.status(502).json(r);
  const compact = (r.data || []).map(x => ({
    id: x['.id'],
    user: x.user,
    mac: x['mac-address'] || x.mac,
    ip: x.address || x['address'],
    uptime: x.uptime,
    server: x.server,
    host: mk.host
  }));
  res.json({ ok: true, data: compact });
});

app.post('/hotspot/kick', async (req, res) => {
  const mk = pickMKFromReq(req);
  if (!requireMkOr503(mk, res)) return;
  const id = (req.body?.id || req.query?.id || '').toString().trim();
  if (!id) return res.status(400).json({ ok:false, error:'missing id' });
  const r = await execROS(['/ip/hotspot/active/remove', `=numbers=${id}`], mk);
  if (!r.ok) return res.status(502).json(r);
  res.json({ ok:true });
});

app.post('/v1/:id/hotspot/authorize', async (req, res) => {
  const mk = pickMKFromReq(req);
  if (!requireMkOr503(mk, res)) return;
  const ip = (req.body?.ip||'').trim();
  const mac = (req.body?.mac||'').trim();
  const server = (req.body?.server||'').trim();
  const comment = (req.body?.comment||'').trim();
  const replace = !!req.body?.replace;

  if (!ip || !mac || !server) return res.status(400).json({ ok:false, error:'missing ip/mac/server' });

  if (replace) {
    await execROS(['/ip/hotspot/ip-binding/remove', '?address='+ip], mk);
    await execROS(['/ip/hotspot/ip-binding/remove', '?mac-address='+mac], mk);
  }
  const sentences = [
    '/ip/hotspot/ip-binding/add',
    '=address='+ip,
    '=mac-address='+mac,
    '=type=bypassed',
    '=server='+server
  ];
  if (comment) sentences.push('=comment='+comment);

  const r = await execROS(sentences, mk);
  if (!r.ok) return res.status(502).json(r);
  res.json({ ok:true, replaced: replace });
});

app.use((req, res) => res.status(404).json({ ok:false, error:'not-found' }));

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[relay] SIGTERM recebido, encerrando...');
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[relay] SIGINT recebido, encerrando...');
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(0);
});

http.createServer(app).listen(PORT, () => {
  console.log(`[relay] http :${PORT}`);
  console.log(`[relay] Modo inteligente: ${prisma ? 'ATIVO' : 'DESATIVADO'}`);
});
