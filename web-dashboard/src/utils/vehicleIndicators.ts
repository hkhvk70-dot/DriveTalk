import type { VehicleState } from '../types/tesla.ts';

export type OpeningState = 'open' | 'closed' | 'unknown';
export function openingState(value: number | null | undefined): OpeningState {
  if (value == null || !Number.isFinite(value) || value < 0) return 'unknown';
  return value === 0 ? 'closed' : 'open';
}
export const openingLabel = { open: '开启', closed: '关闭', unknown: '未知' } as const;

const tireKeys = {
  fl: ['tpms_pressure_fl', 'tpms_soft_warning_fl', 'tpms_hard_warning_fl'],
  fr: ['tpms_pressure_fr', 'tpms_soft_warning_fr', 'tpms_hard_warning_fr'],
  rl: ['tpms_pressure_rl', 'tpms_soft_warning_rl', 'tpms_hard_warning_rl'],
  rr: ['tpms_pressure_rr', 'tpms_soft_warning_rr', 'tpms_hard_warning_rr'],
} as const;
export type TirePosition = keyof typeof tireKeys;
export type TireWarning = 'hard' | 'soft' | 'clear' | 'unknown';

export function tireReading(state: VehicleState | null | undefined, position: TirePosition) {
  const [pressureKey, softKey, hardKey] = tireKeys[position];
  const raw = state?.[pressureKey];
  // Zero can mean a sensor has not reported: never present it as valid tire pressure.
  const bar = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  const soft = state?.[softKey];
  const hard = state?.[hardKey];
  const warning: TireWarning = hard === true ? 'hard' : soft === true ? 'soft'
    : soft === false && hard === false ? 'clear' : 'unknown';
  return { bar, warning };
}
