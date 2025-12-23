// src/index.js
import express from "express";
import morgan from "morgan";
import {
  authorizeByPedido,
  resyncDevice,
  revokeBySession
} from "./services/authorize.js";
import { executeAction } from "./services/actionHandler.js";
import { registerOrUpdateDevice } from "./services/deviceRegistry.js";
import EventConsumer from "./services/eventConsumer.js";
import jobRunner from "./services/jobRunner.js";
import { renderPrometheus } from "./services/metrics.js";
import jobStore from "./services/jobStore.js";
import logger from "./services/logger.js";
import relayManager from "./services/relayManager.js";
import { RelayError } from "./services/errors.js";
import crypto from 'crypto';
import wgManager from './services/wireguardManager.js';
import wireguardStatus from './services/wireguardStatus.js';
import peerBinding from './services/peerBinding.service.js';
import mikrotikProbe from './services/mikrotikProbe.service.js';
import routerRegistry from './routes/routerRegistry.js';
import reconciler from './services/reconciler.js';
import expressRateLimit from "express-rate-limit";

// auth: if RELAY_API_SECRET is set, require HMAC signature on POST/DELETE/SYNC endpoints
const RELAY_API_SECRET = process.env.RELAY_API_SECRET || null;

const authLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs on protected routes
});

// basic in-memory rate limiter per IP
const rateWindowMs = Number(process.env.RELAY_RATE_WINDOW_MS || 60000);
const rateLimit = Number(process.env.RELAY_RATE_LIMIT || 60);
const rateMap = new Map();

function checkRate(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > rateWindowMs) {
    rec.ts = now; rec.count = 1;
    rateMap.set(ip, rec);
    return true;
  }
  rec.count += 1;
  rateMap.set(ip, rec);
  return rec.count <= rateLimit;
}

function verifyHmac(req) {
  if (!RELAY_API_SECRET) return true; // not enforced
  const sig = req.headers['x-relay-signature'];
  if (!sig) return false;
  const body = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', RELAY_API_SECRET).update(body).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b;
  try { b = Buffer.from(sig, 'hex'); } catch (e) { return false; }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const app = express();

// capture raw body for HMAC verification
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { req.rawBody = data; next(); });
});
const PORT = process.env.PORT || 3001;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
if (!RELAY_TOKEN) {
  logger.error('missing required env: RELAY_TOKEN - this service requires RELAY_TOKEN to run and will exit');
  // fail-fast to avoid running with default/unsafe credentials
  process.exit(1);
}
if (process.env.RELAY_STRICT_SECURITY === '1' || process.env.RELAY_STRICT_SECURITY === 'true') {
  if (!process.env.RELAY_API_SECRET) {
    logger.error('missing RELAY_API_SECRET while RELAY_STRICT_SECURITY enabled');
    process.exit(1);
  }
  if (!process.env.RELAY_INTERNAL_TOKEN) {
    logger.error('missing RELAY_INTERNAL_TOKEN while RELAY_STRICT_SECURITY enabled');
    process.exit(1);
  }
}
if (!process.env.RELAY_INTERNAL_TOKEN) {
  logger.warn('warning: RELAY_INTERNAL_TOKEN not set; internal endpoints may be exposed');
}

app.use(express.json());
// Keep morgan for access logs, but keep minimal formatting to avoid double-logging
app.use(morgan("combined"));

// Auth simples por header
app.use((req, res, next) => {
  const token = req.headers["x-relay-token"];
  if (!token || token !== RELAY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized relay token" });
  }
  next();
});

// Healthcheck
app.get("/relay/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Router registry endpoints (backend UI)
app.use('/relay/routers', routerRegistry);

// Prometheus-style metrics snapshot
app.get("/relay/metrics", async (req, res) => {
  try {
    // base metrics from in-memory counters
    let body = renderPrometheus();

    // augment with job store counts (works with file/sqlite/redis)
    try {
      const jobs = await Promise.resolve(jobStore.listJobs());
      const now = Date.now();
      const total = Array.isArray(jobs) ? jobs.length : 0;
      const due = Array.isArray(jobs) ? jobs.filter(j => (Number(j.runAt || 0) <= now)).length : 0;
      const pending = total - due;
      const oldest = Array.isArray(jobs) && jobs.length ? Math.min(...jobs.map(j => Number(j.runAt || Infinity))) : 0;

      body += `relay_jobs_total ${total}\n`;
      body += `relay_jobs_due ${due}\n`;
      body += `relay_jobs_pending ${pending}\n`;
      body += `relay_jobs_oldest_run_at ${oldest}\n`;

      // processed events (dedupe set)
      try {
        const processed = await Promise.resolve(jobStore.listProcessedEventIds());
        const processedCount = Array.isArray(processed) ? processed.length : 0;
        body += `relay_processed_events_total ${processedCount}\n`;
      } catch (pe) {
        console.error('[relay] metrics processed events error', pe && pe.message);
        body += `# error reading processed event ids for metrics\n`;
      }
    } catch (e) {
      console.error('[relay] metrics jobStore error', e && e.message);
      body += `# error reading jobStore for metrics\n`;
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(body);
  } catch (err) {
    logger.error('/relay/metrics error', err && err.message);
    res.status(500).send("# error generating metrics\n");
  }
});

/**
 * 1) device/hello
 * - Backend chama quando a página cativa carrega
 * - Se não tiver token, relay cria
 * - Se tiver, relay atualiza ip/mac
 */
app.post("/relay/device/hello", (req, res) => {
  try {
    const { deviceToken, mikId, ip, mac, userAgent } = req.body;

    if (!mikId || !ip || !mac) {
      return res.status(400).json({
        error: "Campos obrigatórios: mikId, ip, mac"
      });
    }

    const dev = registerOrUpdateDevice({ deviceToken, mikId, ip, mac, userAgent });

    res.json({
      ok: true,
      deviceToken: dev.token,
      mikId: dev.mikId,
      ipAtual: dev.ipAtual,
      macAtual: dev.macAtual
    });
  } catch (err) {
    console.error("[relay] device/hello error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Helper to handle structured errors
function handleError(res, err) {
  if (err instanceof RelayError) {
    return res.status(err.status).json({ ok: false, code: err.code, message: err.message, meta: err.meta });
  }
  logger.error('http.unhandled_error', { message: err && err.message });
  return res.status(500).json({ ok: false, code: 'internal_error', message: 'internal error' });
}

// Devices API (provision/deprovision/sync/status)
app.post('/devices', async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (!verifyHmac(req)) return res.status(401).json({ ok: false, code: 'invalid_signature' });
    const payload = req.body;
    const result = await relayManager.provisionDevice(payload);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.delete('/devices/:id', async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (!verifyHmac(req)) return res.status(401).json({ ok: false, code: 'invalid_signature' });
    const id = req.params.id;
    const result = await relayManager.deprovisionDevice(id);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.post('/devices/:id/sync', async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (!verifyHmac(req)) return res.status(401).json({ ok: false, code: 'invalid_signature' });
    const id = req.params.id;
    const result = await relayManager.syncDevice(id);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.get('/devices/:id/status', async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    // GETs can use token auth only
    const token = req.headers['x-relay-token'];
    if (!token || token !== RELAY_TOKEN) return res.status(401).json({ ok: false, code: 'unauthorized' });
    const id = req.params.id;
    const status = await relayManager.healthCheck(id);
    res.json(status);
  } catch (e) { return handleError(res, e); }
});

/**
 * POST /mikrotik/bootstrap
 * Body: { deviceId, devicePublicKey?, tunnelIp, allowedIps? }
 * If devicePublicKey provided: create peer on VPS and return Mikrotik CLI to apply on device (safe, no private keys).
 * If not provided: return step-by-step instructions to generate key on Mikrotik and continue.
 */
app.post('/mikrotik/bootstrap', async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (!verifyHmac(req)) return res.status(401).json({ ok: false, code: 'invalid_signature' });

    const { deviceId, devicePublicKey, tunnelIp, allowedIps } = req.body || {};
    if (!deviceId || !tunnelIp) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'deviceId and tunnelIp required' });

    const vpsPub = process.env.WG_VPS_PUBLIC_KEY;
    const vpsEndpoint = process.env.WG_VPS_ENDPOINT; // host:port or host
    if (!vpsPub || !vpsEndpoint) {
      return res.status(500).json({ ok: false, code: 'vps_config_missing', message: 'WG_VPS_PUBLIC_KEY and WG_VPS_ENDPOINT must be configured in env' });
    }

    // Build basic mikrotik commands template (no private keys, placeholders where needed)
    const endpointParts = vpsEndpoint.split(':');
    const endpointHost = endpointParts[0];
    const endpointPort = endpointParts[1] || '51820';

    const allowed = allowedIps || `${tunnelIp}/32`;

    if (!devicePublicKey) {
      const instructions = [
        'STEP 1: On the MikroTik device (Winbox/Terminal) generate a WireGuard keypair and note the public key.',
        '  - In recent RouterOS: use Winbox > Interfaces > WireGuard > Generate Key (or use a suitable tool to create keypair).',
        '  - Save the private key on the MikroTik interface; do NOT send it to anyone.',
        '',
        'STEP 2: After generating the public key, call your backend API to register the device public key and re-run this bootstrap endpoint.',
        '  - Example payload to backend: { deviceId: "<id>", publicKey: "<mikrotik-public-key>", tunnelIp: "<tunnel-ip>" }',
        '',
        'STEP 3: Once backend has registered the public key, re-run this endpoint to create the VPS peer and obtain the final MikroTik commands.'
      ];
      return res.json({ ok: true, needPublicKey: true, instructions });
    }

    // create peer on VPS (idempotent)
    try {
      const wgRes = await wgManager.addPeer({ deviceId, publicKey: devicePublicKey, allowedIps: allowed });
      // Compose MikroTik CLI commands to paste (no private keys)
      const commands = [];
      commands.push('# Create WireGuard interface (choose a name, here wg-relay)');
      commands.push(`/interface/wireguard add name=wg-relay comment="managed-by-relay deviceId:${deviceId}"`);
      commands.push('# Assign tunnel address to the MikroTik side');
      commands.push(`/ip address add address=${tunnelIp}/32 interface=wg-relay comment="tunnel for deviceId:${deviceId}"`);
      commands.push('# Add VPS as peer on the MikroTik: replace <vps-public-key> and <endpoint> already filled below');
      commands.push(`/interface/wireguard peers add interface=wg-relay public-key="${vpsPub}" allowed-address=${allowed} endpoint-address=${endpointHost} endpoint-port=${endpointPort} persistent-keepalive=25 comment="vps-peer deviceId:${deviceId}"`);
      commands.push('');
      commands.push('# Notes:');
      commands.push('# - You must generate a private key on the MikroTik WireGuard interface (do NOT send it to the relay).');
      commands.push('# - After adding the VPS peer, verify handshake with: /interface/wireguard print and /interface/wireguard peers print');

      return res.json({ ok: true, createdPeer: wgRes, commands });
    } catch (e) {
      logger.error('mikrotik.bootstrap_error', { message: e && e.message });
      return res.status(500).json({ ok: false, code: 'wg_peer_failed', message: e && e.message });
    }
  } catch (e) {
    if (e instanceof RelayError) return res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    logger.error('mikrotik.bootstrap_unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// POST /relay/manager/register
app.post('/relay/manager/register', authLimiter, async (req, res) => {
  try {
    if (!checkRate(req.ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (!verifyHmac(req)) return res.status(401).json({ ok: false, code: 'invalid_signature' });

    const body = req.body || {};
    const { deviceId, deviceName, mikrotik = {}, wireguard = {} } = body;
    if (!deviceId || !mikrotik.publicIp || !mikrotik.apiUser || !mikrotik.apiPassword || !wireguard.peerPublicKey) {
      return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'deviceId, mikrotik.publicIp, mikrotik.apiUser, mikrotik.apiPassword and wireguard.peerPublicKey are required' });
    }

    // Do not persist passwords. Store metadata without apiPassword.
    const vpsPub = process.env.WG_VPS_PUBLIC_KEY;
    const vpsEndpoint = process.env.WG_VPS_ENDPOINT;
    if (!vpsPub || !vpsEndpoint) return res.status(500).json({ ok: false, code: 'vps_config_missing', message: 'WG_VPS_PUBLIC_KEY and WG_VPS_ENDPOINT required in env' });

    // deterministic tunnel IP allocation in 10.200.0.0/16 based on deviceId
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(deviceId).digest();
    const a = hash[0] % 254 + 1; // 1..254
    const b = hash[1] % 254 + 1;
    const tunnelIp = `10.200.${a}.${b}`;

    const allowedIps = wireguard.allowedIps || `${tunnelIp}/32`;

    // create peer on VPS (idempotent)
    const addRes = await wgManager.addPeer({ deviceId, publicKey: wireguard.peerPublicKey, allowedIps });

    // persist metadata (without storing apiPassword)
    try {
      await deviceRegistry.registerDevice({ deviceId, publicKey: wireguard.peerPublicKey, allowedIps, meta: { deviceName, mikrotik: { publicIp: mikrotik.publicIp, apiUser: mikrotik.apiUser, apiPort: mikrotik.apiPort || 8728 }, tunnelIp } });
    } catch (e) {
      logger.error('register.persist_error', { message: e && e.message });
    }

    // prepare Mikrotik script
    const endpointParts = vpsEndpoint.split(':');
    const endpointHost = endpointParts[0];
    const endpointPort = endpointParts[1] || '51820';
    const scriptLines = [];
    scriptLines.push('/interface/wireguard add name=wg-relay comment="managed-by-relay deviceId:' + deviceId + '"');
    scriptLines.push('# Set the private key on the MikroTik interface (do NOT send it to the relay)');
    scriptLines.push('# Example (on MikroTik): /interface/wireguard set wg-relay private-key="<PASTE_PRIVATE_KEY_HERE>"');
    scriptLines.push(`/ip address add address=${tunnelIp}/32 interface=wg-relay comment="tunnel for deviceId:${deviceId}"`);
    scriptLines.push('/interface/wireguard peers add interface=wg-relay public-key="' + vpsPub + '" endpoint-address=' + endpointHost + ' endpoint-port=' + endpointPort + ' allowed-address=' + allowedIps + ' persistent-keepalive=25 comment="vps-peer deviceId:' + deviceId + '"');
    scriptLines.push('# After applying, verify handshake and routes.');

    return res.json({ success: true, mikrotikScript: scriptLines.join('\n'), createdPeer: addRes, tunnelIp });
  } catch (e) {
    logger.error('relay.manager.register_error', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

/**
 * 2) authorize-by-pedido
 * - Webhook Pix confirmando pagamento
 * - Backend manda pedidoId, mikId, deviceToken
 */
app.post("/relay/authorize-by-pedido", authLimiter, async (req, res) => {
  try {
    const { pedidoId, mikId, deviceToken } = req.body;
    if (!pedidoId || !mikId || !deviceToken) {
      return res.status(400).json({
        error: "Campos obrigatórios: pedidoId, mikId, deviceToken"
      });
    }

    const result = await authorizeByPedido({ pedidoId, mikId, deviceToken });
    res.json(result);
  } catch (err) {
    console.error("[relay] authorize-by-pedido error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3) resync-device
 * - Botão "já paguei e não liberou"
 * - Backend manda pedidoId, mikId, deviceToken, ipAtual, macAtual
 */
app.post("/relay/resync-device", authLimiter, async (req, res) => {
  try {
    const { pedidoId, mikId, deviceToken, ipAtual, macAtual } = req.body;

    if (!pedidoId || !mikId || !deviceToken || !ipAtual || !macAtual) {
      return res.status(400).json({
        error: "Campos obrigatórios: pedidoId, mikId, deviceToken, ipAtual, macAtual"
      });
    }

    const result = await resyncDevice({ pedidoId, mikId, deviceToken, ipAtual, macAtual });
    res.json(result);
  } catch (err) {
    console.error("[relay] resync-device error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4) revoke
 * - Usado por scheduler ou painel técnico pra derrubar sessão
 */
app.post("/relay/revoke", async (req, res) => {
  try {
    const { mikId, ip, mac } = req.body;
    if (!mikId || (!ip && !mac)) {
      return res.status(400).json({
        error: "Campos obrigatórios: mikId e (ip ou mac)"
      });
    }

    const result = await revokeBySession({ mikId, ip, mac });
    res.json(result);
  } catch (err) {
    console.error("[relay] revoke error:", err);
    res.status(500).json({ error: err.message });
  }
});

// New unified action endpoint (allowlist + audit + validation)
app.post("/relay/action", async (req, res) => {
  try {
    const { action, payload, source, traceId } = req.body || {};
    const result = await executeAction({ action, payload, source, traceId });
    if (result && result.ok) {
      res.json(result);
    } else {
      const status = result && result.status ? result.status : 400;
      res.status(status).json(result);
    }
  } catch (err) {
    console.error("[relay] /relay/action error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Internal WireGuard peers status (protected by RELAY_INTERNAL_TOKEN or optional whitelist)
app.get('/internal/wireguard/peers/status', async (req, res) => {
  try {
    const internalToken = process.env.RELAY_INTERNAL_TOKEN;
    const whitelist = (process.env.RELAY_INTERNAL_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = req.ip;
    if (!internalToken) return res.status(403).json({ ok: false, code: 'internal_token_not_configured' });
    const provided = req.headers['x-relay-internal-token'];
    if (provided !== internalToken && !(whitelist.length && whitelist.includes(ip))) {
      return res.status(403).json({ ok: false, code: 'forbidden' });
    }

    // get raw status from wg reader
    const raw = await wireguardStatus.getPeersStatus();

    // enrich with binding information (deviceId, mikrotikIp) when available
    try {
      const bindings = await peerBinding.listBindings();
      const map = new Map(bindings.map(b => [b.publicKey, { deviceId: b.deviceId, mikrotikIp: b.mikrotikIp, createdAt: b.createdAt }]));
      const peers = (raw.peers || []).map(p => {
        const device = map.get(p.publicKey) || null;
        return { ...p, device };
      });
      return res.json({ timestamp: raw.timestamp, peers });
    } catch (e) {
      // if binding lookup fails, return raw status but log error
      logger.error('internal.wireguard.enrich_bindings_error', { message: e && e.message });
      return res.json(raw);
    }
  } catch (e) {
    logger.error('internal.wireguard.status_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Internal endpoints to manage peer bindings (protected)
app.post('/internal/wireguard/peers/bind', async (req, res) => {
  try {
    const internalToken = process.env.RELAY_INTERNAL_TOKEN;
    const whitelist = (process.env.RELAY_INTERNAL_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = req.ip;
    if (!internalToken) return res.status(403).json({ ok: false, code: 'internal_token_not_configured' });
    const provided = req.headers['x-relay-internal-token'];
    if (provided !== internalToken && !(whitelist.length && whitelist.includes(ip))) {
      return res.status(403).json({ ok: false, code: 'forbidden' });
    }

    const { publicKey, deviceId, mikrotikIp } = req.body || {};
    if (!publicKey || !deviceId || !mikrotikIp) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey, deviceId and mikrotikIp required' });
    const binding = await peerBinding.bindPeer({ publicKey, deviceId, mikrotikIp });
    res.json({ ok: true, binding });
  } catch (e) {
    logger.error('internal.wireguard.bind_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

app.delete('/internal/wireguard/peers/:publicKey', async (req, res) => {
  try {
    const internalToken = process.env.RELAY_INTERNAL_TOKEN;
    const whitelist = (process.env.RELAY_INTERNAL_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = req.ip;
    if (!internalToken) return res.status(403).json({ ok: false, code: 'internal_token_not_configured' });
    const provided = req.headers['x-relay-internal-token'];
    if (provided !== internalToken && !(whitelist.length && whitelist.includes(ip))) {
      return res.status(403).json({ ok: false, code: 'forbidden' });
    }

    const publicKey = req.params.publicKey;
    if (!publicKey) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey required' });
    const removed = await peerBinding.unbindPeer(publicKey);
    res.json({ ok: true, removed });
  } catch (e) {
    logger.error('internal.wireguard.unbind_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

app.get('/internal/wireguard/peers/bindings', async (req, res) => {
  try {
    const internalToken = process.env.RELAY_INTERNAL_TOKEN;
    const whitelist = (process.env.RELAY_INTERNAL_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = req.ip;
    if (!internalToken) return res.status(403).json({ ok: false, code: 'internal_token_not_configured' });
    const provided = req.headers['x-relay-internal-token'];
    if (provided !== internalToken && !(whitelist.length && whitelist.includes(ip))) {
      return res.status(403).json({ ok: false, code: 'forbidden' });
    }
    const list = await peerBinding.listBindings();
    res.json({ ok: true, bindings: list });
  } catch (e) {
    logger.error('internal.wireguard.list_bindings_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Internal: probe mikrotik via tunnel. Body: { publicKey, username, password }
app.post('/internal/mikrotik/probe', async (req, res) => {
  try {
    const internalToken = process.env.RELAY_INTERNAL_TOKEN;
    const whitelist = (process.env.RELAY_INTERNAL_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = req.ip;
    if (!internalToken) return res.status(403).json({ ok: false, code: 'internal_token_not_configured' });
    const provided = req.headers['x-relay-internal-token'];
    if (provided !== internalToken && !(whitelist.length && whitelist.includes(ip))) {
      return res.status(403).json({ ok: false, code: 'forbidden' });
    }

    const { publicKey, username, password } = req.body || {};
    if (!publicKey || !username || !password) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey, username and password required' });

    // resolve binding
    const binding = await peerBinding.getPeerBinding(publicKey);
    if (!binding || !binding.mikrotikIp) return res.status(404).json({ ok: false, code: 'binding_not_found' });

    // probe mikrotik (do not log password)
    try {
      const probe = await mikrotikProbe.probeMikrotik({ ip: binding.mikrotikIp, username, password });
      // include deviceId from binding
      return res.json({ ok: true, deviceId: binding.deviceId, identity: probe.identity || null, version: probe.version || null, board: probe.board || null });
    } catch (err) {
      const code = err && err.code ? err.code : 'probe_failed';
      logger.info('internal.mikrotik.probe_error', { publicKey, deviceId: binding.deviceId, code, message: err && err.message });
      return res.status(502).json({ ok: false, code, message: err && err.message });
    }
  } catch (e) {
    logger.error('internal.mikrotik.probe_unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

app.listen(PORT, () => {
  logger.info('relay.online', { port: PORT });
  // Start background event consumer and job runner
  try {
    const consumer = new EventConsumer();
    consumer.start();
    jobRunner.startJobRunner();
    reconciler.start();
  } catch (e) {
    logger.error('failed to start background services', e && e.message);
    // fail-fast on background startup failure
    process.exit(1);
  }
});
