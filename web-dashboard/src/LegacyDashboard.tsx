import { Bluetooth, Signal, Thermometer } from 'lucide-react';
import { useState } from 'react';
import VehicleVisualizer from './components/dashboard/VehicleVisualizer';
import TirePressureCard from './components/dashboard/TirePressureCard';
import BatteryCard from './components/dashboard/BatteryCard';
import Speedometer from './components/dashboard/Speedometer';
import { mockScenarioLabels, type MockScenario } from './mocks/vehicleData';
import { useVehicleStore } from './stores/vehicleStore';
import { displayNumber, milesToKm, vehicleBatteryProps } from './utils/vehicleFormatters';
import { useVehicleData } from './hooks/useVehicleData';

/** Step 4: the dashboard subscribes to the shared raw Fleet API snapshot. */
export default function LegacyDashboard() {
  const [mode, setMode] = useState<'mock' | 'live'>(import.meta.env.VITE_DATA_MODE === 'live' ? 'live' : 'mock');
  const [ownerAccessToken, setOwnerAccessToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [showConnection, setShowConnection] = useState(false);
  const { refresh, wakeUp, busy, notice, configured } = useVehicleData({ mode, backendPath: import.meta.env.VITE_VEHICLE_BACKEND_PATH ?? '/v1/vehicle', ownerAccessToken });
  const data = useVehicleStore((s) => s.vehicleData);
  const source = useVehicleStore((s) => s.source);
  const scenario = useVehicleStore((s) => s.mockScenario);
  const loadMock = useVehicleStore((s) => s.loadMock);
  const connection = useVehicleStore((s) => s.connectionState);
  const requestStatus = useVehicleStore((s) => s.requestStatus);
  const error = useVehicleStore((s) => s.error);
  const lastUpdatedAt = useVehicleStore((s) => s.lastUpdatedAt);
  const gear = data?.drive_state?.shift_state ?? null;
  const speedKph = connection === 'online' && requestStatus === 'success' ? milesToKm(data?.drive_state?.speed) : null;
  return (
    <main className="min-h-dvh bg-cockpit px-4 py-5 text-neutral-100 sm:px-8 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[760px] flex-col">
        {/* DashboardHeader: gear at left, connectivity and clock at right. */}
        <header className="flex items-center justify-between gap-4">
          <div aria-label={gear ? `档位 ${gear}` : '档位暂无数据'} className="flex gap-4 text-xl font-medium sm:gap-5 sm:text-2xl">
            {(['P', 'R', 'N', 'D'] as const).map((gear) => (
              <span key={gear} className={gear === data?.drive_state?.shift_state ? 'text-white' : 'text-neutral-600'}>{gear}</span>
            ))}
          </div>
          <div className="flex items-center gap-4 text-neutral-500">
            <Signal aria-label="信号状态待接入" size={18} />
            <Bluetooth aria-label="蓝牙状态待接入" size={18} />
            <span aria-label="时间占位" className="text-sm tabular-nums">--:--</span>
          </div>
        </header>

        <div className="mt-4 flex items-center gap-2 text-[11px] tracking-widest text-neutral-500">
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
          {source === 'mock' ? '模拟数据 · 未连接真实车辆' : configured ? (data && requestStatus === 'success' ? '后端快照 · 非实时数据流' : '后端模式 · 尚未读取成功') : '未输入仪表盘访问令牌 · 未连接车辆'}
        </div>
        <button type="button" onClick={() => setShowConnection(!showConnection)} className="mt-3 self-start text-xs text-neutral-400 hover:text-white">{showConnection ? '收起连接设置' : '连接设置'}</button>
        {showConnection && (
          <form className="mt-3 rounded-xl bg-white/5 p-4" onSubmit={(event) => {
            event.preventDefault();
            if (!tokenInput.trim()) return;
            setOwnerAccessToken(tokenInput.trim()); setTokenInput(''); setMode('live');
          }}>
            <label htmlFor="owner-token" className="text-xs text-neutral-300">移动控制台仪表盘访问令牌</label>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">使用服务器的手机访问令牌，保存在本页面内存中。连接需要网页与后端部署在同一域名。</p>
            <input id="owner-token" type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" placeholder="输入 DriveTalk 访问令牌" className="mt-3 w-full rounded-lg bg-black/20 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-neutral-400" />
            <div className="mt-3 flex gap-3">
              <button type="submit" disabled={!tokenInput.trim() || busy} className="rounded-full bg-white/10 px-4 py-2 text-xs disabled:opacity-40">连接后端</button>
              <button type="button" onClick={() => { setOwnerAccessToken(''); setTokenInput(''); setMode('mock'); }} className="rounded-full px-4 py-2 text-xs text-neutral-400">断开并返回模拟</button>
            </div>
          </form>
        )}
        {source === 'mock' && (
        <div aria-label="模拟场景" className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(mockScenarioLabels) as MockScenario[]).map((key) => (
            <button key={key} type="button" aria-pressed={scenario === key} onClick={() => loadMock(key)}
              className={`rounded-full px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${scenario === key ? 'bg-white/10 text-white' : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-300'}`}>
              {mockScenarioLabels[key]}
            </button>
          ))}
        </div>
        )}

        {/* Speedometer / VehicleVisualizer: main visual hierarchy. */}
        <div className="my-7 grid flex-1 grid-cols-1 items-stretch gap-5 sm:grid-cols-[0.9fr_1.1fr] sm:gap-8">
          <Speedometer speedKph={speedKph} />
          <VehicleVisualizer state={data?.vehicle_state} />
        </div>

        {/* BatteryCard / TirePressureCard: lower information row. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
          <BatteryCard {...vehicleBatteryProps(data)} className="min-h-40" />
          <TirePressureCard state={data?.vehicle_state} />
        </div>

        {/* VehicleStatus will render loading, errors and explicit wake controls here. */}
        <p role="status" className="mt-5 text-center text-xs text-neutral-500">
          {requestStatus === 'error' ? `读取失败：${error}` : busy ? '正在处理请求…' : connection === 'asleep' ? '车辆休眠中 · 车速暂无数据' : data ? (source === 'mock' ? '模拟车辆状态' : '车辆状态已更新') : '暂无车辆数据'}
        </p>
        {notice && <p role="status" className="mt-2 text-center text-xs text-neutral-400">{notice}</p>}
        {lastUpdatedAt !== null && <p className="mt-2 text-center text-[11px] text-neutral-500">{source === 'mock' ? '模拟数据生成于' : '快照接收于'} {new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}{requestStatus === 'error' || connection !== 'online' ? ' · 保留的历史快照' : ' · 非实时数据流'}</p>}
        <div className="mt-3 flex justify-center gap-3">
          {connection === 'asleep' && <button type="button" disabled={busy} onClick={() => void wakeUp()} className="rounded-full bg-white/10 px-5 py-2 text-sm text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white">{source === 'mock' ? '模拟唤醒' : '车辆休眠中，点击唤醒'}</button>}
          {mode === 'live' && configured && <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-full bg-white/5 px-5 py-2 text-sm text-neutral-300 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white">刷新车辆状态</button>}
        </div>

        {/* DashboardFooter: climate and odometer. */}
        <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-neutral-400">
          <div className="flex items-center gap-2"><Thermometer size={15} /><span>车内 {displayNumber(data?.climate_state?.inside_temp, 1)}° / 车外 {displayNumber(data?.climate_state?.outside_temp, 1)}°</span></div>
          <span className="tabular-nums">总里程 {displayNumber(milesToKm(data?.vehicle_state?.odometer))} km</span>
        </footer>
      </div>
    </main>
  );
}
