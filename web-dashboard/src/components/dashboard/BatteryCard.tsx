import { useId } from 'react';
import { Zap } from 'lucide-react';

export interface BatteryCardProps {
  batteryPercent: number | null;
  rangeKm: number | null;
  isCharging?: boolean;
  chargingPowerKw?: number | null;
  /** Remaining minutes to the configured charge limit, not necessarily 100%. */
  minutesToChargeLimit?: number | null;
  chargeLimitPercent?: number | null;
  className?: string;
}

function nonNegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(value: number | null | undefined): number | null {
  const valid = nonNegative(value);
  return valid === null ? null : Math.min(valid, 100);
}

function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  const rounded = Math.ceil(minutes);
  if (rounded === 0) return '不足 1 分钟';
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return hours > 0 ? `${hours} 小时${remainder > 0 ? ` ${remainder} 分钟` : ''}` : `${rounded} 分钟`;
}

export default function BatteryCard({
  batteryPercent,
  rangeKm,
  isCharging = false,
  chargingPowerKw = null,
  minutesToChargeLimit = null,
  chargeLimitPercent = null,
  className = '',
}: BatteryCardProps) {
  const titleId = useId();
  const level = percent(batteryPercent);
  const range = nonNegative(rangeKm);
  const power = nonNegative(chargingPowerKw);
  const minutes = nonNegative(minutesToChargeLimit);
  const limit = percent(chargeLimitPercent);
  const circumference = 2 * Math.PI * 35;
  const accent = level === null ? '#737373' : level <= 10 ? '#f87171' : level <= 20 ? '#fbbf24' : '#86cba8';

  return (
    <section aria-labelledby={titleId} className={`min-w-0 rounded-2xl bg-white/[0.025] p-5 sm:p-6 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-sm font-medium tracking-wide text-neutral-300">电池与续航</h2>
        {isCharging && <span className="flex items-center gap-1 text-xs text-emerald-300"><Zap size={13} aria-hidden="true" />充电中</span>}
      </div>

      <div className="mt-5 flex items-center gap-5">
        <div className="relative h-22 w-22 shrink-0" aria-label={level === null ? '电量暂无数据' : `电量 ${Math.round(level)}%`}>
          <svg aria-hidden="true" viewBox="0 0 88 88" className="h-full w-full -rotate-90">
            <circle cx="44" cy="44" r="35" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="4" />
            {level !== null && level > 0 && (
              <circle cx="44" cy="44" r="35" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round"
                strokeDasharray={circumference} strokeDashoffset={circumference * (1 - level / 100)}
                className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none" />
            )}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center gap-0.5 tabular-nums">
            <span className="text-2xl font-light text-white">{level === null ? '—' : Math.round(level)}</span>
            <span className="mt-1 text-xs text-neutral-500">%</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-neutral-500">预估续航</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-2 tabular-nums">
            <span className="text-4xl font-light tracking-tight text-white">{range === null ? '—' : Math.round(range)}</span>
            <span className="text-sm text-neutral-400">km</span>
          </p>
          {level !== null && level <= 20 && <p className="mt-2 text-xs" style={{ color: accent }}>{level <= 10 ? '电量很低，请及时充电' : '电量偏低'}</p>}
        </div>
      </div>

      {isCharging && (
        <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-neutral-500">充电功率</p>
            <p className="mt-1 text-neutral-200 tabular-nums">{power === null ? '—' : Number(power.toFixed(1))} kW</p>
          </div>
          <div>
            <p className="text-neutral-500">{limit === null ? '距充电目标' : `距充至 ${Math.round(limit)}%`}</p>
            <p className="mt-1 text-neutral-200 tabular-nums">{duration(minutes)}</p>
          </div>
        </div>
      )}
    </section>
  );
}
