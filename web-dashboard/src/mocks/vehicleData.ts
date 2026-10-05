import type { VehicleDataResponse } from '../types/tesla';
import { KM_PER_MILE } from '../utils/vehicleFormatters';

export const mockScenarioLabels = {
  parked: '驻车', driving: '行驶', charging: '充电', lowBattery: '低电量', alerts: '门窗与胎压告警', unavailable: '无数据', asleep: '休眠',
} as const;
export type MockScenario = keyof typeof mockScenarioLabels;

/** Fresh, separate response object each time; never uses a real VIN or account ID. */
export function createMockVehicleResponse(scenario: MockScenario): VehicleDataResponse {
  if (scenario === 'unavailable') return { response: null };
  if (scenario === 'asleep') return { response: { id_s: 'mock-vehicle', display_name: '示例车辆 · 模拟', state: 'asleep' } };
  const timestamp = Date.now();
  const charging = scenario === 'charging';
  const low = scenario === 'lowBattery';
  const driving = scenario === 'driving';
  const alerts = scenario === 'alerts';
  return {
    response: {
      id_s: 'mock-vehicle', display_name: '示例车辆 · 模拟', state: 'online',
      charge_state: {
        battery_level: low ? 9 : charging ? 64 : driving ? 76 : 80,
        battery_range: (low ? 47 : charging ? 336 : driving ? 398 : 420) / KM_PER_MILE,
        charging_state: charging ? 'Charging' : 'Disconnected',
        charge_limit_soc: 80,
        charger_power: charging ? 72 : 0,
        time_to_full_charge: charging ? 25 / 60 : 0,
        timestamp,
      },
      drive_state: { shift_state: driving ? 'D' : 'P', speed: driving ? 86 / KM_PER_MILE : 0, power: driving ? 18 : 0, timestamp },
      climate_state: { inside_temp: 22, outside_temp: 28, is_climate_on: true, timestamp },
      vehicle_state: {
        vehicle_name: '示例车辆 · 模拟', odometer: 1286 / KM_PER_MILE, locked: true,
        df: alerts ? 1 : 0, dr: 0, pf: 0, pr: 0, ft: 0, rt: alerts ? 1 : 0,
        fd_window: 0, rd_window: 0, fp_window: alerts ? 1 : 0, rp_window: 0,
        tpms_pressure_fl: alerts ? 1.8 : 2.9, tpms_pressure_fr: 2.9, tpms_pressure_rl: 3.0, tpms_pressure_rr: alerts ? 2.3 : 3.0,
        tpms_soft_warning_fl: alerts, tpms_hard_warning_fl: alerts,
        tpms_soft_warning_fr: false, tpms_hard_warning_fr: false,
        tpms_soft_warning_rl: false, tpms_hard_warning_rl: false,
        tpms_soft_warning_rr: alerts, tpms_hard_warning_rr: false,
        timestamp,
      },
    },
  };
}
