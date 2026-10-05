import { useState } from 'react';
import { LocateFixed, Search } from 'lucide-react';
import VehicleMap from '../components/map/VehicleMap';
import ConfirmButton from '../components/common/ConfirmButton';
import { useVehicleStore } from '../stores/mobileVehicleStore';
import { distanceMeters, validPosition, gpsAgeLabel } from '../utils/mobileLocation';

export default function LocationPage() {
  const data = useVehicleStore((s) => s.vehicleData);
  const busy = useVehicleStore((s) => s.isLoading);
  const commands = useVehicleStore((s) => s.commandsEnabled);
  const navigation = useVehicleStore((s) => s.navigationEnabled);
  const source = useVehicleStore((s) => s.source);
  const sendNavigation = useVehicleStore((s) => s.sendNavigation);
  const findCar = useVehicleStore((s) => s.findCar);
  const refresh = useVehicleStore((s) => s.refresh);
  const [destination, setDestination] = useState('');
  const [recenter, setRecenter] = useState(0);
  const position = validPosition(data?.drive_state?.latitude, data?.drive_state?.longitude);
  const mockDistance = position && source === 'mock' ? distanceMeters(position, [39.902, 116.401]) : null;
  const gps = data?.drive_state?.gps_as_of;
  const disabled = busy || data?.state !== 'online';
  return <section className="space-y-4">
    <label htmlFor="destination" className="flex items-center gap-2 rounded-2xl bg-white/5 p-3"><Search size={18} className="text-neutral-500" /><input id="destination" aria-label="目的地地址" placeholder="输入完整地址或地点名称" maxLength={300} value={destination} onChange={(e) => setDestination(e.target.value)} className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
    <p className="text-xs text-neutral-500">手动输入 · 地址搜索和逆地理编码尚未接入</p>
    <VehicleMap position={position} recenter={recenter} isMock={source === 'mock'} />
    <div className="mobile-card space-y-3 p-5"><h2 className="text-sm font-medium">{source === 'mock' ? '模拟车辆位置' : '上次报告的位置'}</h2><p className="text-sm tabular-nums">{position ? `${position[0].toFixed(6)}, ${position[1].toFixed(6)}` : '坐标未知'}</p>
      <p className="text-xs text-neutral-500">GPS 时间：{gps != null && Number.isFinite(gps) && gps > 0 ? new Date(gps * 1000).toLocaleString('zh-CN') : '未知'}</p>
      {source === 'live' && <p className="text-xs text-neutral-400">{gpsAgeLabel(gps)}</p>}
      {source === 'live' && !position && <p className="text-xs text-amber-300">本次快照未提供有效坐标；可能与定位信号、网络或位置授权有关，不代表车辆位于地图中心。</p>}
      <p className="text-xs text-neutral-400">{mockDistance == null ? '手机距离：未启用手机定位' : `模拟直线距离：${Math.round(mockDistance)} m`}</p>
      <div className="grid grid-cols-2 gap-3"><button disabled={!position} className="mobile-button" onClick={() => setRecenter((x) => x + 1)}><LocateFixed size={17} />回到车辆</button><button disabled={busy} className="mobile-button" onClick={() => void refresh()}>刷新位置</button></div>
    </div>
    <ConfirmButton disabled={disabled || !commands || !navigation || !destination.trim()} className="mobile-button w-full" title="发送目的地？" description={`将发送：${destination.trim()}。请在车机确认匹配地点和路线。`} action={() => sendNavigation(destination)}>发送至车机导航</ConfirmButton>
    <p className="text-xs text-neutral-500">请输入包含城市的完整地址或地点名称，不支持地图链接。请由乘客操作或停车后操作手机；受理不代表路线已经同步，请以车机显示为准。</p>
    <ConfirmButton disabled={disabled || !commands} className="mobile-button w-full" title="鸣笛并闪灯？" description="请确认周围适宜鸣笛；驾驶者请勿操作手机。两个命令不自动重试。" action={findCar}>鸣笛并闪灯寻车</ConfirmButton>
    {data?.drive_state?.active_route_destination && <p className="rounded-xl bg-white/5 p-3 text-xs">{source === 'mock' ? '模拟导航目的地' : '快照中的导航目的地'}：{data.drive_state.active_route_destination}</p>}
    <p className="text-xs leading-6 text-neutral-500">这里是位置快照，不是实时追踪。手动刷新，不自动唤醒；服务器快照缓存最多 60 秒。地下车库可能只有旧定位。模拟位置不代表你的车辆位置。地图瓦片需要联网。</p>
  </section>;
}
