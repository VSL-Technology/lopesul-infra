// device-router.mjs - Relay inteligente para buscar Mikrotik por dispositivo
// Versão ESM pura para uso no relay

/**
 * Normaliza string de entrada
 */
function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^\$\(.+\)$/.test(trimmed)) return null; // Ignora variáveis Mikrotik
  return trimmed;
}

/**
 * Busca dispositivo no banco de dados
 */
export async function findDeviceRecord(prisma, { deviceId, mikId, ip } = {}) {
  const id = normalizeString(deviceId);
  if (id) {
    const byId = await prisma.dispositivo.findUnique({ where: { id } }).catch(() => null);
    if (byId) return byId;
  }

  const mik = normalizeString(mikId);
  if (mik) {
    const byMik = await prisma.dispositivo.findUnique({ where: { mikId: mik } }).catch(() => null);
    if (byMik) return byMik;
  }

  const deviceIp = normalizeString(ip);
  if (deviceIp) {
    const byIp = await prisma.dispositivo.findFirst({ where: { ip: deviceIp } }).catch(() => null);
    if (byIp) return byIp;
  }

  return null;
}

/**
 * Constrói payload do router a partir do dispositivo
 */
export function buildRouterPayloadFromDevice(device) {
  if (!device || !device.mikrotikHost || !device.mikrotikUser || !device.mikrotikPass) {
    throw new Error('device_missing_credentials');
  }

  return {
    host: device.mikrotikHost,
    user: device.mikrotikUser,
    pass: device.mikrotikPass,
    port: device.mikrotikPort || 8728,
    secure: Boolean(device.mikrotikUseSsl),
  };
}

/**
 * Busca dispositivo e retorna router payload
 */
export async function requireDeviceRouter(prisma, input = {}) {
  const device = await findDeviceRecord(prisma, input);
  if (!device) {
    const err = new Error('device_not_found');
    err.code = 'device_not_found';
    throw err;
  }

  const router = buildRouterPayloadFromDevice(device);
  return { device, router };
}

