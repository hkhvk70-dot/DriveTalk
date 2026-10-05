import { useEffect, useState } from 'react';
import { CarFront, Lightbulb, LockKeyhole, LockKeyholeOpen, PackageOpen, RefreshCw, Snowflake, Volume2, Wind } from 'lucide-react';
import { Link } from 'react-router-dom';
import VehicleModel from '../components/dashboard/VehicleModel';
import BatteryCard from '../components/dashboard/BatteryCard';
import TirePressureCard from '../components/dashboard/TirePressureCard';
import ConfirmButton from '../components/common/ConfirmButton';
import { useVehicleStore } from '../stores/mobileVehicleStore';
import { displayNumber, milesToKm, vehicleBatteryProps } from '../utils/vehicleFormatters';

export default function HomePage() {
  const data = useVehicleStore((s) => s.vehicleData);
  const busy = useVehicleStore((s) => s.isLoading);
  const commands = useVehicleStore((s) => s.commandsEnabled);
  const rearTrunkClose = useVehicleStore((s) => s.rearTrunkCloseEnabled);
  const refresh = useVehicleStore((s) => s.refresh);
  const execute = useVehicleStore((s) => s.executeCommand);
  const setTemperature = useVehicleStore((s) => s.setTemperature);
  const lastUpdatedAt = useVehicleStore((s) => s.lastUpdatedAt);
  const [temperature, setDraft] = useState(22);
  const vehicle = data?.vehicle_state;
  const climate = data?.climate_state;
  const locked = vehicle?.locked;
  const disabled = busy || !commands || data?.state !== 'online';
  const physicalDisabled = disabled || data?.drive_state?.shift_state !== 'P';
  useEffect(() => { const value = climate?.driver_temp_setting; if (value != null && Number.isFinite(value)) setDraft(Math.max(15, Math.min(28, value))); }, [climate?.driver_temp_setting]);
  const controls = [
    { label: '锁车', icon: LockKeyhole, title: '锁闭车辆？', description: '将发送明确的锁车指令，请确认钥匙和车辆周边环境安全。', disabled, run: () => execute({ name: 'lock', locked: true }) },
    { label: '解锁', icon: LockKeyholeOpen, title: '解锁车辆？', description: '将发送明确的解锁指令，请确认车辆周边环境安全。', disabled, run: () => execute({ name: 'lock', locked: false }) },
    { label: '开启空调', icon: Snowflake, title: '开启空调？', description: '发送明确的空调开启指令，不依赖快照中的开关状态。', disabled, run: () => execute({ name: 'climate', enabled: true }) },
    { label: '关闭空调', icon: Snowflake, title: '关闭空调？', description: '发送明确的空调关闭指令，不依赖快照中的开关状态。', disabled, run: () => execute({ name: 'climate', enabled: false }) },
    { label: '释放前备箱', icon: CarFront, title: '释放前备箱？', description: '仅释放，需手动关闭前备箱；请确认车辆已停车且周围安全。', disabled: physicalDisabled, run: () => execute({ name: 'trunk', trunk: 'front' }) },
    { label: '打开后备箱', icon: PackageOpen, title: '打开后备箱？', description: '服务器确认备箱关闭后才发送开启动作；已打开则不重复动作。请确认上方无障碍。', disabled: physicalDisabled, run: () => execute({ name: 'rearTrunk', open: true }) },
    { label: '关闭后备箱', icon: PackageOpen, title: '关闭后备箱？', description: '发送明确的关闭指令，仅支持电动后备箱。请确认无人、宠物或物品处于夹合区域，并观察车辆。', disabled: physicalDisabled || !rearTrunkClose, run: () => execute({ name: 'rearTrunk', open: false }) },
    { label: '鸣笛', icon: Volume2, title: '鸣笛？', description: '请确认周围环境适宜鸣笛。', disabled, run: () => execute({ name: 'horn' }) },
    { label: '闪灯', icon: Lightbulb, title: '闪灯寻车？', description: '车辆将短暂闪灯。', disabled, run: () => execute({ name: 'lights' }) },
    { label: '车窗通风', icon: Wind, title: '车窗通风？', description: '请确认无降雨，且车内物品安全。', disabled, run: () => execute({ name: 'vent' }) },
    { label: '关闭车窗', icon: Wind, title: '关闭车窗？', description: '请确认所有车窗夹合区域无人或物品，观察车辆；是否支持以车辆响应为准。', disabled, run: () => execute({ name: 'closeWindows' }) },
  ];
  return <section className="space-y-5">
    <div className="flex items-center justify-between"><h2 className="text-lg font-medium">{data?.display_name ?? '我的车辆'}</h2><button aria-label="刷新车辆状态" disabled={busy} onClick={() => void refresh()} className="mobile-button"><RefreshCw size={17} /></button></div>
    <div className="mobile-card p-6"><p className="text-xs text-neutral-500">预估剩余续航</p><p className="mt-2 text-6xl font-light tracking-tight tabular-nums">{displayNumber(milesToKm(data?.charge_state?.battery_range))}<span className="ml-2 text-lg text-neutral-500">km</span></p>
      <div className="mt-5 grid grid-cols-3 gap-3 text-sm"><div><p className="text-xs text-neutral-500">电量</p><p className="mt-1">{displayNumber(data?.charge_state?.battery_level)}%</p></div><div><p className="text-xs text-neutral-500">车内温度</p><p className="mt-1">{displayNumber(climate?.inside_temp, 1)}°C</p></div><div><p className="text-xs text-neutral-500">锁闭</p><p className="mt-1">{locked === true ? '已锁车' : locked === false ? '未锁车' : '未知'}</p></div></div>
    </div>
    <VehicleModel />
    <section aria-label="快捷控制"><h3 className="mb-3 text-sm">快捷控制</h3><div className="grid grid-cols-4 gap-2">{controls.map(({ label, icon: Icon, title, description, disabled, run }) =>
      <ConfirmButton key={label} title={title} description={description} action={run} disabled={disabled} className="mobile-button min-h-24 flex-col gap-3 px-1 text-[11px]"><Icon size={23} strokeWidth={1.6} />{label}</ConfirmButton>,
    )}<Link to="/charging" className="mobile-button min-h-24 flex-col gap-3 px-1 text-[11px]">充电管理 →</Link></div>
      {physicalDisabled && <p className="mt-3 text-xs text-neutral-500">车辆未上线或未确认 P 档，备箱控制禁用；其他功能按在线状态和权限检查。</p>}
      <p className="mt-3 text-xs leading-6 text-neutral-500">空调快照：{climate?.is_climate_on === true ? '开启' : climate?.is_climate_on === false ? '关闭' : '未知'}。前备箱需手动关闭；鸣笛、闪灯为短暂动作，无需关闭按钮。命令受理不等于状态已同步。</p>
      {!rearTrunkClose && <p className="text-xs text-amber-300">当前服务器未启用明确关闭后备箱的签名指令。</p>}
    </section>
    <section className="mobile-card p-5"><div className="flex items-center justify-between"><label htmlFor="home-temperature" className="text-sm">空调目标温度</label><span className="text-xl tabular-nums">{temperature.toFixed(1)}°C</span></div>
      <input id="home-temperature" type="range" min="15" max="28" step="0.5" value={temperature} disabled={disabled} onChange={(e) => setDraft(Number(e.target.value))} className="mt-5 w-full accent-sky-300" />
      <p className="my-3 text-xs text-neutral-500">拖动不会发送命令，点击应用才执行。</p>
      <ConfirmButton disabled={disabled} className="mobile-button w-full" title="调整目标温度？" description={`将设置为 ${temperature.toFixed(1)}°C。`} action={() => setTemperature(temperature)}>应用温度</ConfirmButton>
    </section>
    <BatteryCard {...vehicleBatteryProps(data)} />
    <TirePressureCard state={vehicle} />
    <div className="grid grid-cols-2 gap-3"><div className="mobile-card p-4"><p className="text-xs text-neutral-500">总里程</p><p className="mt-2 tabular-nums">{displayNumber(milesToKm(vehicle?.odometer))} km</p></div><Link to="/charging" className="mobile-card p-4"><p className="text-xs text-neutral-500">充电摘要</p><p className="mt-2">{data?.charge_state?.charging_state === 'Charging' ? '正在充电' : data?.charge_state?.charging_state ? '当前未充电' : '状态未知'}</p></Link></div>
    <p className="text-center text-[11px] leading-6 text-neutral-500">车外 {displayNumber(climate?.outside_temp, 1)}°C · 接收时间 {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString('zh-CN') : '未读取'}<br />仅为快照，请以车辆与现场状态为准。</p>
  </section>;
}
