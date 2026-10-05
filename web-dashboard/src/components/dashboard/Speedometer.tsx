export interface SpeedometerProps {
  /** Display value in km/h. Missing or stale readings should be passed as null. */
  speedKph: number | null;
  maxSpeedKph?: number;
  className?: string;
}

export default function Speedometer({ speedKph, maxSpeedKph = 240, className = '' }: SpeedometerProps) {
  const speed = speedKph !== null && Number.isFinite(speedKph) && speedKph >= 0
    ? Math.round(speedKph)
    : null;
  const maximum = Number.isFinite(maxSpeedKph) && maxSpeedKph > 0 ? maxSpeedKph : 240;
  const fraction = speed === null ? 0 : Math.min(speed / maximum, 1);
  const trackHeight = 152;

  return (
    <section aria-label="当前车速" className={`flex min-h-64 min-w-0 items-center px-5 py-6 sm:px-6 ${className}`}>
      <div className="flex w-full items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.2em] text-neutral-500">当前车速</p>
          <p aria-label={speed === null ? '车速暂无数据' : `${speed} 公里每小时`}
            className="mt-5 text-[clamp(5rem,17vw,8.5rem)] font-light leading-[0.85] tracking-[-0.065em] text-white tabular-nums">
            {speed ?? '—'}
          </p>
          <p className="mt-5 text-sm tracking-[0.18em] text-neutral-400">km/h</p>
        </div>
        {/* Decorative scale, not a speed-limit or safety indicator. */}
        <svg aria-hidden="true" viewBox="0 0 20 168" className="h-40 w-5 shrink-0 overflow-visible">
          <path d="M10 8 V160" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="3" strokeLinecap="round" />
          {fraction > 0 && (
            <path d={`M10 160 V${160 - trackHeight * fraction}`} stroke="#e5e7eb" strokeWidth="3" strokeLinecap="round" />
          )}
          {[8, 46, 84, 122, 160].map((y) => (
            <path key={y} d={`M16 ${y} H20`} stroke="#ffffff" strokeOpacity="0.18" />
          ))}
        </svg>
      </div>
    </section>
  );
}
