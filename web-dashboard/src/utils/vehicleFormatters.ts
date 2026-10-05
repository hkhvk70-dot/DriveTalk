import type { BatteryCardProps } from '../components/dashboard/BatteryCard';
import type { VehicleData } from '../types/tesla';

export const KM_PER_MILE = 1.609344;

export function finiteNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function milesToKm(value: number | null | undefined): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number * KM_PER_MILE : null;
}

export function vehicleBatteryProps(data: VehicleData | null): BatteryCardProps {
  const charge = data?.charge_state;
  const minutes = finiteNumber(charge?.minutes_to_full_charge);
  const hours = finiteNumber(charge?.time_to_full_charge);
  return {
    batteryPercent: finiteNumber(charge?.battery_level),
    rangeKm: milesToKm(charge?.battery_range),
    isCharging: charge?.charging_state === 'Charging',
    chargingPowerKw: finiteNumber(charge?.charger_power),
    minutesToChargeLimit: minutes ?? (hours === null ? null : hours * 60),
    chargeLimitPercent: finiteNumber(charge?.charge_limit_soc),
  };
}

export function displayNumber(value: number | null | undefined, decimals = 0): string {
  const number = finiteNumber(value);
  return number === null ? '—' : number.toLocaleString('zh-CN', { maximumFractionDigits: decimals });
}
