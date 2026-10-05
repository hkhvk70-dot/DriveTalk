import { CarFront, MapPin, Mic, SlidersHorizontal, Zap } from 'lucide-react';
import { NavLink } from 'react-router-dom';

const items = [
  { to: '/', label: '车辆', icon: CarFront }, { to: '/location', label: '位置', icon: MapPin },
  { to: '/voice', label: '语音', icon: Mic },
  { to: '/charging', label: '充电', icon: Zap }, { to: '/settings', label: '控制', icon: SlidersHorizontal },
];

export default function BottomNav() {
  return <nav aria-label="主要页面" className="mobile-nav fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg border-t border-white/5 bg-[#171a20]/95 backdrop-blur-xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
    <div className="grid grid-cols-5 p-2">{items.map(({ to, label, icon: Icon }) =>
      <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-1.5 rounded-2xl text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-white ${isActive ? 'bg-white/5 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
        <Icon size={23} strokeWidth={1.7} aria-hidden="true" />{label}
      </NavLink>,
    )}</div>
  </nav>;
}
