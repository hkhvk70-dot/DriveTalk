/** Fleet API REST names and units are preserved here, not UI-normalized. */
export type VehicleConnectionState = 'online' | 'asleep' | 'offline' | 'unknown';
export type Gear = 'P' | 'R' | 'N' | 'D';

export interface ChargeState {
  battery_level?: number | null;
  usable_battery_level?: number | null;
  battery_range?: number | null; // miles
  est_battery_range?: number | null; // miles
  ideal_battery_range?: number | null; // miles
  charging_state?: string | null;
  charge_limit_soc?: number | null;
  charger_power?: number | null; // kW
  charger_voltage?: number | null;
  charger_actual_current?: number | null;
  charge_rate?: number | null; // miles/hour
  charge_energy_added?: number | null; // kWh
  time_to_full_charge?: number | null; // hours, to configured charge limit
  minutes_to_full_charge?: number | null;
  charge_port_door_open?: boolean | null;
  conn_charge_cable?: string | null;
  timestamp?: number | null;
}

export interface ClimateState {
  inside_temp?: number | null; // Celsius
  outside_temp?: number | null; // Celsius
  driver_temp_setting?: number | null;
  passenger_temp_setting?: number | null;
  is_climate_on?: boolean | null;
  is_preconditioning?: boolean | null;
  fan_status?: number | null;
  timestamp?: number | null;
}

export interface DriveState {
  shift_state?: Gear | null; // null is not automatically interpreted as Park
  speed?: number | null; // mph
  power?: number | null; // kW
  latitude?: number | null;
  longitude?: number | null;
  heading?: number | null;
  gps_as_of?: number | null;
  active_route_destination?: string | null;
  active_route_latitude?: number | null;
  active_route_longitude?: number | null;
  timestamp?: number | null;
}

export interface VehicleState {
  vehicle_name?: string | null;
  odometer?: number | null; // miles
  locked?: boolean | null;
  df?: number | null; // driver front door: 0 closed, nonzero open
  dr?: number | null;
  pf?: number | null;
  pr?: number | null;
  ft?: number | null; // front trunk
  rt?: number | null; // rear trunk
  fd_window?: number | null;
  rd_window?: number | null;
  fp_window?: number | null;
  rp_window?: number | null;
  tpms_pressure_fl?: number | null; // bar
  tpms_pressure_fr?: number | null;
  tpms_pressure_rl?: number | null;
  tpms_pressure_rr?: number | null;
  tpms_soft_warning_fl?: boolean | null;
  tpms_soft_warning_fr?: boolean | null;
  tpms_soft_warning_rl?: boolean | null;
  tpms_soft_warning_rr?: boolean | null;
  tpms_hard_warning_fl?: boolean | null;
  tpms_hard_warning_fr?: boolean | null;
  tpms_hard_warning_rl?: boolean | null;
  tpms_hard_warning_rr?: boolean | null;
  car_version?: string | null;
  timestamp?: number | null;
}

/** Core dashboard fields. Subsections may be omitted due to endpoints/scopes/firmware. */
export interface VehicleData {
  id?: number;
  id_s?: string;
  vehicle_id?: number;
  vin?: string;
  display_name?: string | null;
  state?: VehicleConnectionState;
  charge_state?: ChargeState | null;
  climate_state?: ClimateState | null;
  vehicle_state?: VehicleState | null;
  drive_state?: DriveState | null;
  gui_settings?: Record<string, unknown> | null;
  vehicle_config?: Record<string, unknown> | null;
}

/** vehicle_data is wrapped in response; errors can return a null response. */
export interface VehicleDataResponse {
  response: VehicleData | null;
  error?: string;
  error_description?: string;
}
