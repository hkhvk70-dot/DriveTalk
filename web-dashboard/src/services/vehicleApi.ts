import type { VehicleDataResponse, VehicleConnectionState } from '../types/tesla.ts';

export class VehicleApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  constructor(status: number, message: string, retryAfterMs = 0) {
    super(message);
    this.name = 'VehicleApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVehicleResponse(value: unknown): VehicleDataResponse {
  if (!record(value) || !record(value.response)) throw new VehicleApiError(0, '车辆响应缺少有效的 response');
  const data = value.response;
  if (value.error) throw new VehicleApiError(0, '车辆接口返回错误');
  if (data.state !== undefined && !['online', 'asleep', 'offline', 'unknown'].includes(String(data.state))) {
    throw new VehicleApiError(0, '车辆连接状态无效');
  }
  const groups: Record<string, { numbers: string[]; booleans?: string[]; strings?: string[] }> = {
    charge_state: {
      numbers: ['battery_level', 'usable_battery_level', 'battery_range', 'est_battery_range', 'ideal_battery_range', 'charge_limit_soc', 'charger_power', 'charger_voltage', 'charger_actual_current', 'charge_rate', 'charge_energy_added', 'time_to_full_charge', 'minutes_to_full_charge', 'timestamp'],
      booleans: ['charge_port_door_open'], strings: ['charging_state', 'conn_charge_cable'],
    },
    climate_state: { numbers: ['inside_temp', 'outside_temp', 'driver_temp_setting', 'passenger_temp_setting', 'fan_status', 'timestamp'], booleans: ['is_climate_on', 'is_preconditioning'] },
    drive_state: { numbers: ['speed', 'power', 'latitude', 'longitude', 'heading', 'gps_as_of', 'active_route_latitude', 'active_route_longitude', 'timestamp'], strings: ['active_route_destination'] },
    vehicle_state: {
      numbers: ['odometer', 'df', 'dr', 'pf', 'pr', 'ft', 'rt', 'fd_window', 'rd_window', 'fp_window', 'rp_window', 'tpms_pressure_fl', 'tpms_pressure_fr', 'tpms_pressure_rl', 'tpms_pressure_rr', 'timestamp'],
      booleans: ['locked', ...['soft', 'hard'].flatMap((severity) => ['fl', 'fr', 'rl', 'rr'].map((tire) => `tpms_${severity}_warning_${tire}`))],
      strings: ['vehicle_name', 'car_version'],
    },
  };
  for (const [name, schema] of Object.entries(groups)) {
    const group = data[name];
    if (group == null) continue;
    if (!record(group)) throw new VehicleApiError(0, `${name} 不是有效对象`);
    for (const field of schema.numbers) {
      const item = group[field];
      if (item != null && (typeof item !== 'number' || !Number.isFinite(item))) throw new VehicleApiError(0, `${name}.${field} 不是有效数字`);
    }
    for (const field of schema.booleans ?? []) {
      if (group[field] != null && typeof group[field] !== 'boolean') throw new VehicleApiError(0, `${name}.${field} 不是布尔值`);
    }
    for (const field of schema.strings ?? []) {
      if (group[field] != null && typeof group[field] !== 'string') throw new VehicleApiError(0, `${name}.${field} 不是字符串`);
    }
  }
  const drive = data.drive_state;
  if (record(drive) && drive.shift_state != null && !['P', 'R', 'N', 'D'].includes(String(drive.shift_state))) throw new VehicleApiError(0, '档位数据无效');
  // The assertion follows validation of the dashboard fields; unknown Tesla fields are preserved.
  return value as unknown as VehicleDataResponse;
}

export interface VehicleTransport {
  getStatus: (signal: AbortSignal) => Promise<VehicleConnectionState>;
  getData: (signal: AbortSignal) => Promise<VehicleDataResponse>;
  wake: (signal: AbortSignal) => Promise<void>;
}

/** Same-origin owner backend; Tesla credentials never enter the browser. */
export function createVehicleApi(baseUrl: string, ownerAccessToken: string, fetcher: typeof fetch = fetch): VehicleTransport {
  const base = baseUrl.replace(/\/$/, '');
  async function request(path: string, signal: AbortSignal, method = 'GET'): Promise<unknown> {
    const response = await fetcher(`${base}${path}`, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(ownerAccessToken ? { 'X-DriveTalk-Token': ownerAccessToken } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    if (!response.ok) {
      const header = response.headers.get('Retry-After');
      const numeric = header === null ? NaN : Number(header);
      const retryAfterMs = header === null ? 0 : Number.isFinite(numeric) ? numeric * 1000 : Math.max(0, Date.parse(header) - Date.now());
      // Only the owner gateway's bounded, safe message is shown; never Tesla's raw body.
      const failure = await response.json().catch(() => null) as { message?: unknown } | null;
      const safeMessage = typeof failure?.message === 'string' && failure.message.length <= 200 ? failure.message : undefined;
      const wait = Math.ceil((Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 60_000) / 1000);
      throw new VehicleApiError(response.status,
        response.status === 401 || response.status === 403 ? '车辆服务未授权，请检查后端登录状态' : response.status === 429 ? `${safeMessage ?? '读取请求限流'}；请等待 ${wait} 秒，保留上次快照` : `车辆服务返回 HTTP ${response.status}`,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new VehicleApiError(0, '车辆服务没有返回有效 JSON'); }
  }
  return {
    getStatus: async (signal) => {
      const payload = await request('/status', signal);
      if (!record(payload) || !record(payload.response) || !['online', 'asleep', 'offline', 'unknown'].includes(String(payload.response.state))) throw new VehicleApiError(0, '车辆状态响应无效');
      return payload.response.state as VehicleConnectionState;
    },
    getData: async (signal) => parseVehicleResponse(await request('/data', signal)),
    wake: async (signal) => {
      const payload = await request('/wake', signal, 'POST');
      if (!record(payload) || payload.accepted !== true) throw new VehicleApiError(0, '唤醒请求未获后端确认');
    },
  };
}
