import { useEffect } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import BottomNav from './components/layout/BottomNav';
import ConfirmButton from './components/common/ConfirmButton';
import HomePage from './pages/HomePage';
import LocationPage from './pages/LocationPage';
import ChargingPage from './pages/ChargingPage';
import SettingsPage from './pages/SettingsPage';
import GrokPage from './pages/GrokPage';
import VoicePage from './pages/VoicePage';
import LegacyDashboard from './LegacyDashboard';
import { useVehicleStore } from './stores/mobileVehicleStore';

const titles: Record<string, string> = { '/': '车辆', '/location': '位置', '/charging': '充电', '/settings': '控制与设置', '/ai': 'DeepSeek 助手', '/voice': '语音助手' };

function MobileLayout() {
  const { pathname } = useLocation();
  const busy = useVehicleStore((s) => s.isLoading);
  const error = useVehicleStore((s) => s.error);
  const notice = useVehicleStore((s) => s.notice);
  const wakeState = useVehicleStore((s) => s.wakeState);
  const wake = useVehicleStore((s) => s.checkAndWakeUp);
  const vehicleState = useVehicleStore((s) => s.vehicleData?.state);
  const source = useVehicleStore((s) => s.source);
  const theme = useVehicleStore((s) => s.theme);
  const title = titles[pathname] ?? '车辆';
  useEffect(() => { document.title = `${title} · DriveTalk`; window.scrollTo(0, 0); }, [pathname, title]);
  return <div className={`mobile-app min-h-dvh bg-[#111318] text-neutral-100 ${theme === 'light' ? 'mobile-light' : ''}`}>
    <div className="mobile-shell mx-auto min-h-dvh max-w-lg bg-[#171a20]">
      <header className="px-5 pb-5" style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top))' }}>
        <div className="flex items-center justify-between"><div><p className="text-[10px] tracking-[0.25em] text-neutral-500">DRIVETALK</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1></div>
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-neutral-400">{source === 'mock' ? '模拟模式' : '后端模式'}</span></div>
      </header>
      <main className="px-5" style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
        <div aria-live="polite" aria-atomic="true" className="mb-4 space-y-2">
          {busy && <p role="status" className="flex items-center gap-2 rounded-xl bg-sky-400/10 p-3 text-sm text-sky-200"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />{wakeState === 'waking' ? '正在唤醒车辆……' : '正在处理，请稍候……'}</p>}
          {error && <p role="alert" className="rounded-xl bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}
          {!busy && notice && <p className="text-xs leading-5 text-neutral-500">{notice}</p>}
        </div>
        {(vehicleState === 'asleep' || wakeState === 'needs-confirmation') && <div className="mobile-card mb-4 p-4"><p className="mb-3 text-sm text-amber-300">车辆休眠中 · 当前可能为旧快照</p>
          <ConfirmButton title="确认唤醒车辆？" description="可能需要等待。唤醒后不会自动补发之前的命令。" action={() => wake(true)}>确认唤醒</ConfirmButton>
        </div>}
        <Outlet />
      </main>
      <BottomNav />
    </div>
  </div>;
}

export default function App() {
  useEffect(() => { void useVehicleStore.getState().restoreSession(); }, []);
  return <HashRouter><Routes>
    <Route element={<MobileLayout />}>
      <Route index element={<HomePage />} />
      <Route path="location" element={<LocationPage />} />
      <Route path="charging" element={<ChargingPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="ai" element={<GrokPage />} />
      <Route path="voice" element={<VoicePage />} />
    </Route>
    <Route path="legacy" element={<LegacyDashboard />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></HashRouter>;
}
