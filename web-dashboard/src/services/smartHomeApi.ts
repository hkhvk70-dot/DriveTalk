export interface HomeDevice {
  id: string; name: string; model: string; kind: string; online: boolean | null;
  home: string; room: string; enabled: boolean; integration_status: string;
  capabilities: string[];
}
export interface HomeAccount {
  available: boolean; configured: boolean; controlConnected: boolean; controlGranted: boolean;
  syncedAt: string | null; devices: HomeDevice[];
  retryAfter: number;
  job: { state: string; loginUrl?: string; qrSvg?: string };
  storageError?: boolean;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const states = new Set(['idle', 'starting', 'waiting_scan', 'syncing', 'done', 'failed', 'timeout', 'cancelled']);
export const jobActive = (state: string) => ['starting', 'waiting_scan', 'syncing'].includes(state);
export function parseHomeAccount(value: unknown): HomeAccount {
  if (!object(value) || typeof value.available !== 'boolean' || typeof value.configured !== 'boolean' ||
      typeof value.controlConnected !== 'boolean' || !object(value.job) || typeof value.job.state !== 'string' ||
      !states.has(value.job.state) || !Array.isArray(value.devices) || value.devices.length > 2000 ||
      !(value.syncedAt === null || typeof value.syncedAt === 'string')) throw new Error('米家响应无效');
  const devices = value.devices.map((d): HomeDevice => {
    if (!object(d) || !['id', 'name', 'model', 'kind', 'home', 'room', 'integration_status'].every(k => typeof d[k] === 'string' && d[k].length <= 200) ||
        !/^device_[a-f0-9]{24}$/.test(String(d.id)) || typeof d.enabled !== 'boolean' ||
        !(d.online === null || typeof d.online === 'boolean') || !Array.isArray(d.capabilities) ||
        d.capabilities.length > 100 || !d.capabilities.every(c => typeof c === 'string' && c.length <= 100) ||
        ['did', 'token', 'serviceToken', 'properties', 'binding'].some(k => k in d)) throw new Error('米家设备目录无效');
    return { id: d.id as string, name: d.name as string, model: d.model as string, kind: d.kind as string,
      home: d.home as string, room: d.room as string, integration_status: d.integration_status as string,
      enabled: d.enabled, online: d.online, capabilities: d.capabilities as string[] };
  });
  if (new Set(devices.map(d => d.id)).size !== devices.length) throw new Error('米家设备重复');
  const retryAfter = value.retryAfter ?? 0;
  const controlGranted = value.controlGranted ?? false;
  if (typeof controlGranted !== 'boolean' || (controlGranted && !value.controlConnected)) throw new Error('米家授权状态无效');
  if (typeof retryAfter !== 'number' || !Number.isInteger(retryAfter) || retryAfter < 0 || retryAfter > 30)
    throw new Error('米家冷却时间无效');
  const job: HomeAccount['job'] = { state: value.job.state };
  if (job.state === 'waiting_scan') {
    if (typeof value.job.loginUrl !== 'string' || value.job.loginUrl.length > 4000 ||
        typeof value.job.qrSvg !== 'string' || value.job.qrSvg.length > 200000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value.job.qrSvg)) throw new Error('米家二维码无效');
    const url = new URL(value.job.loginUrl);
    if (url.protocol !== 'https:' || !['account.xiaomi.com', 'ak.account.xiaomi.com'].includes(url.hostname) || url.username || url.password ||
        (url.port && url.port !== '443')) throw new Error('米家登录来源无效');
    job.loginUrl = url.href; job.qrSvg = value.job.qrSvg;
  }
  return { available: value.available, configured: value.configured, controlConnected: value.controlConnected, controlGranted,
    syncedAt: value.syncedAt as string | null, devices, job, retryAfter, storageError: value.storageError === true };
}
/** Cookie-only owner API. No secrets in storage, no automatic POST retries. */
export async function homeAccount(action: 'status' | 'login' | 'sync' | 'cancel' | 'select' = 'status',
  deviceIds?: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch, enableControl = false): Promise<HomeAccount> {
  const response = await fetcher(`/v1/smarthome/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(action !== 'status' ? { 'Content-Type': 'application/json' } : {}) },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    ...(action !== 'status' ? { body: JSON.stringify(action === 'select'
      ? { deviceIds: deviceIds ?? [], ...(enableControl ? { enableControl: true } : {}) } : {}) } : {}),
  });
  if (!response.ok) throw new Error(response.status === 401 ? '请先登录 DriveTalk' :
    response.status === 404 ? '米家接口尚未部署' : '米家操作未确认，请读取状态后再试；未自动重试');
  return parseHomeAccount(await response.json());
}
