import type { VehicleData } from '../types/tesla.ts';

export interface ChargingSite {
  name: string;
  distanceKm: number;
  availableStalls: number | null;
  totalStalls: number | null;
}

export const mockChargingSites: ChargingSite[] = [
  { name: '示例 · 城市中心超级充电站', distanceKm: 2.4, availableStalls: 4, totalStalls: 8 },
  { name: '示例 · 科技园超级充电站', distanceKm: 5.8, availableStalls: 2, totalStalls: 12 },
];

export function createMobileMock(): VehicleData {
  const timestamp = Date.now();
  return {
    id_s: 'mock-vehicle', display_name: '示例车辆', state: 'online',
    charge_state: {
      battery_level: 80, usable_battery_level: 80, battery_range: 250,
      charging_state: 'Stopped', charge_limit_soc: 80, charger_power: 0,
      charger_voltage: 220, charger_actual_current: 0, charge_energy_added: 0,
      time_to_full_charge: 0, charge_port_door_open: true, conn_charge_cable: 'IEC', timestamp,
    },
    climate_state: {
      inside_temp: 22, outside_temp: 20, driver_temp_setting: 22,
      passenger_temp_setting: 22, is_climate_on: false, is_preconditioning: false, fan_status: 0, timestamp,
    },
    drive_state: {
      shift_state: 'P', speed: 0, power: 0, latitude: 0, longitude: 0,
      heading: 90, gps_as_of: Math.floor(timestamp / 1000), active_route_destination: null, timestamp,
    },
    vehicle_state: {
      vehicle_name: '示例车辆', odometer: 1000, locked: true,
      df: 0, dr: 0, pf: 0, pr: 0, ft: 0, rt: 0,
      fd_window: 0, fp_window: 0, rd_window: 0, rp_window: 0,
      tpms_pressure_fl: 2.7, tpms_pressure_fr: 2.8, tpms_pressure_rl: 2.7, tpms_pressure_rr: 2.8,
      tpms_soft_warning_fl: false, tpms_soft_warning_fr: false,
      tpms_soft_warning_rl: false, tpms_soft_warning_rr: false,
      tpms_hard_warning_fl: false, tpms_hard_warning_fr: false,
      tpms_hard_warning_rl: false, tpms_hard_warning_rr: false, timestamp,
    },
  };
}
