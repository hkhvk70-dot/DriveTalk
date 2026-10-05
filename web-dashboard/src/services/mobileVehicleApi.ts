import type { VehicleData, VehicleConnectionState } from '../types/tesla.ts';
import { createMobileMock } from '../mocks/mobileVehicle.ts';

export type VehicleCommand =
  | { name: 'lock'; locked: boolean }
  | { name: 'climate'; enabled: boolean }
  | { name: 'temperature'; celsius: number }
  | { name: 'navigation'; destination: string }
  | { name: 'trunk'; trunk: 'front' | 'rear' }
  | { name: 'rearTrunk'; open: boolean }
  | { name: 'vent' | 'closeWindows' | 'horn' | 'lights' | 'findCar' }
  | { name: 'charging'; enabled: boolean }
  | { name: 'chargeLimit'; percent: number }
  | { name: 'chargePort'; open: boolean };

export interface MobileVehicleApi {
  connectionStatus?: () => Promise<VehicleConnectionState>;
  capabilities?: () => Promise<{ commands: boolean; navigation?: boolean; rearTrunkClose?: boolean }>;
  dispose?: () => void;
  read(): Promise<VehicleData>;
  wake(): Promise<void>;
  command(command: VehicleCommand): Promise<void>;
  simulateSleep?: (asleep: boolean) => void;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Isolated mock instance per store/test. No fetch or vehicle credentials. */
export function createMobileMockApi(latency = 250): MobileVehicleApi {
  let data = createMobileMock();
  return {
    async read() { await pause(latency); return structuredClone(data); },
    async wake() { await pause(latency * 6); data.state = 'online'; },
    simulateSleep(asleep) { data.state = asleep ? 'asleep' : 'online'; },
    async command(command) {
      await pause(latency);
      if (data.state !== 'online') throw new Error('车辆尚未上线');
      const v = data.vehicle_state!;
      const c = data.climate_state!;
      const battery = data.charge_state!;
      switch (command.name) {
        case 'lock': v.locked = command.locked; break;
        case 'climate': c.is_climate_on = command.enabled; c.is_preconditioning = command.enabled; break;
        case 'temperature': c.driver_temp_setting = command.celsius; c.passenger_temp_setting = command.celsius; break;
        case 'navigation': data.drive_state!.active_route_destination = command.destination; break;
        case 'trunk': {
          const key = command.trunk === 'front' ? 'ft' : 'rt';
          // Physical front trunk release cannot close a raised hood.
          v[key] = 1;
          break;
        }
        case 'rearTrunk': v.rt = command.open ? 1 : 0; break;
        case 'vent': v.fd_window = v.fp_window = v.rd_window = v.rp_window = 1; break;
        case 'closeWindows': v.fd_window = v.fp_window = v.rd_window = v.rp_window = 0; break;
        case 'charging': {
          if (command.enabled && (!battery.conn_charge_cable || battery.conn_charge_cable === '<invalid>')) throw new Error('未连接充电线');
          if (command.enabled && (battery.battery_level ?? 0) >= (battery.charge_limit_soc ?? 0)) throw new Error('已达到充电限值');
          battery.charging_state = command.enabled ? 'Charging' : 'Stopped';
          battery.charger_power = command.enabled ? 7 : 0;
          battery.time_to_full_charge = command.enabled ? 0.8 : 0;
          break;
        }
        case 'chargeLimit': battery.charge_limit_soc = command.percent; break;
        case 'chargePort':
          if (!command.open && battery.conn_charge_cable !== '' && battery.conn_charge_cable !== '<invalid>') throw new Error('未确认充电线已拔除，无法关闭充电口盖');
          battery.charge_port_door_open = command.open; break;
        case 'horn': case 'lights': case 'findCar': break;
      }
      v.timestamp = c.timestamp = battery.timestamp = Date.now();
    },
  };
}

/** Fail closed until a server-owned, authenticated command contract is implemented. */
export function createBlockedLiveApi(proxyUrl: string): MobileVehicleApi {
  const fail = (): never => {
    throw new Error(proxyUrl ? '真实控车适配器尚未接入，未发送请求' : '真实控车签名代理尚未配置');
  };
  return { async read() { return fail(); }, async wake() { fail(); }, async command() { fail(); } };
}
