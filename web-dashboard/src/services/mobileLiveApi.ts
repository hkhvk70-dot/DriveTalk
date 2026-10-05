import type { VehicleData } from '../types/tesla.ts';
import { createVehicleApi } from './vehicleApi.ts';
import type { MobileVehicleApi } from './mobileVehicleApi.ts';

/** Same-origin only. This URL is DriveTalk's authenticated gateway, not Tesla's proxy. */
export function createMobileLiveApi(token: string | null, base = '/v1/vehicle', fetcher: typeof fetch = fetch): MobileVehicleApi {
  if (token !== null && (!token.trim() || /[\r\n]/.test(token))) throw new Error('请输入有效的 DriveTalk 访问令牌');
  if (!/^\/v1\/vehicle\/?$/.test(base)) throw new Error('仅允许同源 /v1/vehicle 接口');
  let blockedUntil = 0;
  let commandBlockedUntil = 0;
  const controller = new AbortController();
  const transport = createVehicleApi(base, token?.trim() ?? '', fetcher);
  function check() {
    controller.signal.throwIfAborted();
    if (Date.now() < blockedUntil) throw Object.assign(new Error(`读取冷却中，还需等待 ${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒；保留上次快照`), { status: 429 });
  }
  async function protectedCall<T>(operation: () => Promise<T>): Promise<T> {
    check();
    try { return await operation(); }
    catch (error) {
      const e = error as { status?: number; retryAfterMs?: number };
      if (e.status === 429) blockedUntil = Date.now() + (e.retryAfterMs && e.retryAfterMs > 0 ? e.retryAfterMs : 60_000);
      throw error;
    }
  }
  async function gateway(path: string, body?: unknown): Promise<unknown> {
    controller.signal.throwIfAborted();
    if (path === '/command' && Date.now() < commandBlockedUntil) {
      throw Object.assign(new Error(`控车冷却中，请等待 ${Math.ceil((commandBlockedUntil - Date.now()) / 1000)} 秒`), { commandSent: false });
    }
    {
      const response = await fetcher(`${base.replace(/\/$/, '')}${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        headers: { Accept: 'application/json', ...(token ? { 'X-DriveTalk-Token': token.trim() } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if (response.status === 429) {
          const h = response.headers.get('Retry-After');
          const seconds = h && /^\d+$/.test(h) ? Number(h) : 60;
          if (path === '/command') commandBlockedUntil = Date.now() + seconds * 1000;
        }
        const failure = await response.json().catch(() => null) as { message?: unknown; commandSent?: unknown } | null;
        const message = typeof failure?.message === 'string' && failure.message.length <= 200 ? failure.message : null;
        const cooldown = path === '/command' && response.status === 429 ? `；需等待 ${Math.ceil((commandBlockedUntil - Date.now()) / 1000)} 秒` : '';
        const error = new Error((response.status === 401 || response.status === 403 ? '车辆服务未授权，请重新连接' : message ?? `车辆服务返回 HTTP ${response.status}；未自动重试`) + cooldown);
        Object.assign(error, { commandSent: failure?.commandSent });
        throw error;
      }
      return response.json();
    }
  }
  return {
    // Commands already perform a fresh, server-side parked-state check. Do not
    // duplicate vehicle_data here just to establish online/asleep status.
    async connectionStatus() { return transport.getStatus(controller.signal); },
    async read(): Promise<VehicleData> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await protectedCall(async () => {
            const state = await transport.getStatus(controller.signal);
            if (state !== 'online') return { state };
            const data = (await transport.getData(controller.signal)).response;
            if (!data) throw new Error('车辆接口未返回快照');
            return data;
          });
        } catch (error) {
          const status = (error as { status?: number }).status;
          const transient = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError') || [502, 503, 504].includes(status ?? 0);
          if (controller.signal.aborted || !transient || attempt >= 2) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    },
    async capabilities() {
      try {
        const payload = await gateway('/capabilities') as { commands?: unknown; navigation?: unknown; rearTrunkClose?: unknown };
        return { commands: payload.commands === true, navigation: payload.commands === true && payload.navigation === true, rearTrunkClose: payload.commands === true && payload.rearTrunkClose === true };
      } catch { return { commands: false, navigation: false }; } // Older backend remains usable read-only.
    },
    async wake() { await protectedCall(() => transport.wake(controller.signal)); },
    async command(command) {
      const payload = await gateway('/command', { command, requestId: crypto.randomUUID() }) as { accepted?: unknown };
      if (payload.accepted !== true) throw new Error('命令受理结果未确认，请刷新，勿重复操作');
      blockedUntil = 0; // Bounded readback is now permitted; upstream 429 still stops reads.
    },
    dispose() { controller.abort(); },
  };
}
