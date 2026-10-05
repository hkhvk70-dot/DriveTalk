import { useId, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { VehicleState } from '../../types/tesla';
import { tireReading, type TirePosition } from '../../utils/vehicleIndicators';

const positions: [TirePosition, string][] = [['fl', '左前'], ['fr', '右前'], ['rl', '左后'], ['rr', '右后']];
const warningLabels = { hard: '严重胎压告警', soft: '胎压告警', clear: '车辆未报告告警', unknown: '告警状态未知' };

export default function TirePressureCard({ state }: { state?: VehicleState | null }) {
  const titleId = useId();
  const [unit, setUnit] = useState<'bar' | 'psi'>('bar');
  return (
    <section aria-labelledby={titleId} className="min-w-0 rounded-2xl bg-white/[0.025] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-sm font-medium tracking-wide text-neutral-300">胎压监测</h2>
        <button type="button" aria-label={`胎压单位 ${unit}，点击切换`} onClick={() => setUnit(unit === 'bar' ? 'psi' : 'bar')} className="rounded-full bg-white/5 px-3 py-1 text-xs text-neutral-400 focus-visible:outline-2 focus-visible:outline-white">{unit}</button>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {positions.map(([position, label]) => {
          const { bar, warning } = tireReading(state, position);
          const color = warning === 'hard' ? 'text-red-400 bg-red-400/5' : warning === 'soft' ? 'text-amber-300 bg-amber-400/5' : 'text-neutral-200 bg-white/[0.025]';
          const value = bar === null ? '—' : (unit === 'bar' ? bar : bar * 14.5037738).toFixed(unit === 'bar' ? 1 : 0);
          return (
            <div key={position} className={`rounded-xl p-3 ${color}`} aria-label={`${label} ${value} ${unit}，${warningLabels[warning]}`}>
              <div className="flex items-center justify-between text-[11px] text-neutral-500"><span>{label}</span>{(warning === 'hard' || warning === 'soft') && <TriangleAlert size={14} className={warning === 'hard' ? 'text-red-400' : 'text-amber-300'} aria-hidden="true" />}</div>
              <p className="mt-1 text-2xl font-light tabular-nums">{value}<span className="ml-1 text-[10px] text-neutral-500">{unit}</span></p>
              <p className="mt-1 text-[10px]">{warningLabels[warning]}</p>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-neutral-500">上次测得胎压 · 颜色依据车辆 TPMS 告警，不自行判定标准胎压。</p>
    </section>
  );
}
