import { useId } from 'react';
import { LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import type { VehicleState } from '../../types/tesla';
import { openingState, openingLabel, type OpeningState } from '../../utils/vehicleIndicators';

const stroke = (state: OpeningState) => state === 'open' ? '#fbbf24' : state === 'closed' ? '#afb8c4' : '#525963';
const doors = [
  { door: 'df', window: 'fd_window', label: '左前', x: 49, y: 101, left: true },
  { door: 'pf', window: 'fp_window', label: '右前', x: 151, y: 101, left: false },
  { door: 'dr', window: 'rd_window', label: '左后', x: 49, y: 152, left: true },
  { door: 'pr', window: 'rp_window', label: '右后', x: 151, y: 152, left: false },
] as const;

export default function VehicleVisualizer({ state }: { state?: VehicleState | null }) {
  const titleId = useId();
  const gradientId = useId();
  const front = openingState(state?.ft);
  const rear = openingState(state?.rt);
  const allClosures = [state?.ft, state?.rt, ...doors.flatMap(({ door, window }) => [state?.[door], state?.[window]])].map(openingState);
  const openCount = allClosures.filter((item) => item === 'open').length;
  const unknownCount = allClosures.filter((item) => item === 'unknown').length;
  return (
    <section aria-labelledby={titleId} className="flex min-h-72 flex-col items-center rounded-2xl bg-white/[0.025] p-5 sm:p-6">
      <div className="flex w-full items-center justify-between">
        <h2 id={titleId} className="text-sm font-medium tracking-wide text-neutral-300">车辆状态</h2>
        <span className="flex items-center gap-1.5 text-xs text-neutral-400">
          {state?.locked === true ? <LockKeyhole size={14} /> : state?.locked === false ? <LockKeyholeOpen size={14} /> : null}
          {state?.locked === true ? '已锁车' : state?.locked === false ? '未锁车' : '锁车状态未知'}
        </span>
      </div>
      <svg role="img" aria-label="车辆俯视图：门板表示车门，蓝色线条表示车窗开启，黄色表示车门或备箱开启" viewBox="0 0 200 280" className="mt-3 h-64 w-full max-w-60">
        <defs><linearGradient id={gradientId} x1="0" x2="1"><stop stopColor="#343c47" /><stop offset="0.5" stopColor="#737f8e" /><stop offset="1" stopColor="#343c47" /></linearGradient></defs>
        <ellipse cx="100" cy="147" rx="69" ry="120" fill="#000" opacity="0.2" />
        {[80, 189].flatMap((y) => [41, 147].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="12" height="35" rx="5" fill="#101216" />))}
        <path d="M72 15 Q100 4 128 15 Q148 30 151 74 L151 205 Q148 246 128 257 Q100 269 72 257 Q52 246 49 205 L49 74 Q52 30 72 15Z" fill={`url(#${gradientId})`} stroke="#919dab" strokeWidth="1.2" />
        <path d="M66 87 Q100 65 134 87 L128 111 H72Z" fill="#121c28" stroke="#667483" />
        <path d="M72 115 H128 V175 H72Z" fill="#1c2835" stroke="#697787" />
        <path d="M72 181 H128 L135 208 Q100 229 65 208Z" fill="#121c28" stroke="#667483" />
        <path d="M61 67 Q100 52 139 67 L133 33 Q100 20 67 33Z" fill={front === 'open' ? '#fbbf2425' : 'none'} stroke={stroke(front)} strokeDasharray={front === 'unknown' ? '3 3' : undefined} strokeWidth="2"><title>前备箱{openingLabel[front]}</title></path>
        <path d="M65 225 Q100 236 135 225 L128 248 Q100 258 72 248Z" fill={rear === 'open' ? '#fbbf2425' : 'none'} stroke={stroke(rear)} strokeDasharray={rear === 'unknown' ? '3 3' : undefined} strokeWidth="2"><title>后备箱{openingLabel[rear]}</title></path>
        {doors.map(({ door, window, label, x, y, left }) => {
          const doorState = openingState(state?.[door]);
          const windowState = openingState(state?.[window]);
          return <g key={door}>
            <path d={`M${x} ${y} l${doorState === 'open' ? (left ? -30 : 30) : 0} 40`} fill="none" stroke={stroke(doorState)} strokeWidth="4" strokeLinecap="round" strokeDasharray={doorState === 'unknown' ? '3 4' : undefined}><title>{label}车门{openingLabel[doorState]}</title></path>
            <path d={`M${left ? 62 : 138} ${y + 6} v25`} stroke={windowState === 'open' ? '#7dd3fc' : stroke(windowState)} strokeWidth="3" strokeDasharray={windowState === 'unknown' ? '2 4' : undefined}><title>{label}车窗{openingLabel[windowState]}</title></path>
          </g>;
        })}
      </svg>
      <p className={`mt-1 text-xs ${openCount ? 'text-amber-300' : 'text-neutral-400'}`}>{openCount ? `${openCount} 处门窗 / 备箱开启` : unknownCount ? '门窗 / 备箱状态不完整' : '门窗与备箱均关闭'}</p>
      <div className="mt-3 grid w-full grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-neutral-500">
        {doors.map(({ door, window, label }) => <p key={door}>{label}门 {openingLabel[openingState(state?.[door])]} · 窗 {openingLabel[openingState(state?.[window])]}</p>)}
        <p>前备箱 {openingLabel[front]}</p><p>后备箱 {openingLabel[rear]}</p>
      </div>
      <p className="mt-3 text-[10px] text-neutral-500">车灯状态未接入 · 灰色虚线表示未知</p>
    </section>
  );
}
