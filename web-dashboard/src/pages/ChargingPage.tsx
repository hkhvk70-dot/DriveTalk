import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import BatteryCard from '../components/dashboard/BatteryCard';
import ConfirmButton from '../components/common/ConfirmButton';
import { useVehicleStore } from '../stores/mobileVehicleStore';
import { vehicleBatteryProps } from '../utils/vehicleFormatters';
import { mockChargingSites } from '../mocks/mobileVehicle';

export default function ChargingPage() {
  const data = useVehicleStore((s) => s.vehicleData);
  const busy = useVehicleStore((s) => s.isLoading);
  const commands = useVehicleStore((s) => s.commandsEnabled);
  const source = useVehicleStore((s) => s.source);
  const execute = useVehicleStore((s) => s.executeCommand);
  const [limit, setLimit] = useState(80);
  const charge = data?.charge_state;
  const disabled = busy || !commands || data?.state !== 'online';
  const parked = data?.drive_state?.shift_state === 'P';
  const unplugged = charge?.conn_charge_cable === '' || charge?.conn_charge_cable === '<invalid>';
  const connected = Boolean(charge?.conn_charge_cable && charge.conn_charge_cable !== '<invalid>');
  useEffect(() => { if (charge?.charge_limit_soc != null && Number.isFinite(charge.charge_limit_soc)) setLimit(Math.max(50, Math.min(100, charge.charge_limit_soc))); }, [charge?.charge_limit_soc]);
  return <section className="space-y-5">
    <BatteryCard {...vehicleBatteryProps(data)} />
    <div className="mobile-card space-y-4 p-5"><div className="flex items-center gap-2 text-sm"><PlugZap size={18} />{connected ? '充电线已连接' : '充电线状态未知 / 未连接'}</div>
      <div className="grid grid-cols-2 gap-3"><ConfirmButton disabled={disabled || !connected} title="开始充电？" description="将按车辆当前充电限值开始充电。" action={() => execute({ name: 'charging', enabled: true })}>开始充电</ConfirmButton><ConfirmButton disabled={disabled} title="停止充电？" description="发送明确停止指令，不依赖快照是否已显示正在充电。" action={() => execute({ name: 'charging', enabled: false })}>停止充电</ConfirmButton></div>
      <div className="grid grid-cols-2 gap-3"><ConfirmButton disabled={disabled || !parked} title="打开充电口？" description="请确认车辆周边安全。" action={() => execute({ name: 'chargePort', open: true })}>打开充电口</ConfirmButton><ConfirmButton disabled={disabled || !parked || !unplugged} title="关闭充电口？" description="需先拔除充电线，服务器再次核验。" action={() => execute({ name: 'chargePort', open: false })}>关闭充电口</ConfirmButton></div>
      {!unplugged && <p className="text-xs text-neutral-500">充电线连接或状态未知时，不允许关闭充电口。</p>}
    </div>
    <section className="mobile-card p-5"><div className="flex items-center justify-between"><label htmlFor="charge-limit" className="text-sm">充电限值</label><span className="text-2xl font-light tabular-nums">{limit}%</span></div>
      <input id="charge-limit" type="range" min="50" max="100" step="1" value={limit} disabled={disabled} onChange={(e) => setLimit(Number(e.target.value))} className="my-5 w-full accent-emerald-300" />
      <ConfirmButton disabled={disabled} className="mobile-button w-full" title="设置充电限值？" description={`设置为 ${limit}%。拖动滑块不会发送命令。`} action={() => execute({ name: 'chargeLimit', percent: limit })}>应用限值</ConfirmButton>
    </section>
    <section><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">附近超级充电站</h2><span className="text-[11px] text-neutral-500">{source === 'mock' ? '模拟列表' : '尚未接入'}</span></div>
      {source === 'mock' ? <div className="space-y-3">{mockChargingSites.map((site) => <div key={site.name} className="mobile-card p-4"><h3 className="text-sm">{site.name}</h3><p className="mt-2 text-xs text-neutral-400">{site.distanceKm} km · 模拟可用 {site.availableStalls}/{site.totalStalls} 桩</p></div>)}</div> : <p className="text-xs text-neutral-500">nearby_charging_sites 真实查询尚未接入。</p>}
    </section>
    <p className="text-xs leading-6 text-neutral-500">预计时间是达到设置限值的时间，不一定是达到 100%。示例站点不代表真实可用情况。</p>
  </section>;
}
