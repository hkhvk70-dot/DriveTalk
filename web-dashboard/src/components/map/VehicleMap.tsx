import { useEffect, useRef, useState } from 'react';
import { convertGpsForAMap, loadAMap, type AMapApi, type AMapMap, type AMapMarker } from '../../services/amap';

const carMarker = '<div style="width:40px;height:40px;border-radius:50%;background:#171a20;border:3px solid white;display:grid;place-items:center;box-shadow:0 3px 12px #0006"><svg width="16" height="24" viewBox="0 0 16 24"><rect x="1" y="1" width="14" height="22" rx="5" fill="#ddd"/><path d="M4 5h8v5H4zM4 15h8v4H4z" fill="#171a20"/></svg></div>';

export default function VehicleMap({ position, recenter, isMock }: { position: [number, number] | null; recenter: number; isMock: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<AMapMap | null>(null);
  const api = useRef<AMapApi | null>(null);
  const marker = useRef<AMapMarker | null>(null);
  const converted = useRef<[number, number] | null>(null);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState('正在加载高德地图…');
  const [failed, setFailed] = useState(false);
  const lat = position?.[0]; const lng = position?.[1];

  useEffect(() => {
    let disposed = false;
    setReady(false); setFailed(false); setNotice('正在加载高德地图…');
    loadAMap(import.meta.env.VITE_AMAP_JS_KEY || '').then(sdk => {
      if (disposed || !container.current) return;
      api.current = sdk;
      map.current = new sdk.Map(container.current, { zoom: 4, center: [105, 35], viewMode: '2D', mapStyle: 'amap://styles/dark', resizeEnable: true });
      setReady(true);
    }).catch(error => { if (!disposed) { setNotice(error instanceof Error ? error.message : '地图加载失败'); setFailed(true); } });
    return () => { disposed = true; marker.current?.setMap(null); marker.current = null; converted.current = null; map.current?.destroy(); map.current = null; api.current = null; };
  }, [retry]);

  useEffect(() => {
    if (!ready || !api.current || !map.current) return;
    let disposed = false;
    marker.current?.setMap(null); marker.current = null; converted.current = null;
    setFailed(false);
    if (lat == null || lng == null) { setNotice('未获得有效车辆坐标，未标记车辆。'); return; }
    setNotice('正在转换车辆 GPS 坐标…');
    convertGpsForAMap(api.current, [lat, lng]).then(point => {
      if (disposed || !api.current || !map.current) return;
      converted.current = point;
      marker.current = new api.current.Marker({ position: point, map: map.current, anchor: 'center', title: isMock ? '模拟车辆位置' : '车辆上次报告的位置', content: carMarker });
      map.current.setZoomAndCenter(15, point); setNotice('');
    }).catch(error => { if (!disposed) { setNotice(error instanceof Error ? error.message : '坐标转换失败'); setFailed(true); } });
    return () => { disposed = true; };
  }, [ready, lat, lng, isMock, retry]);

  useEffect(() => { if (converted.current) map.current?.setZoomAndCenter(15, converted.current); }, [recenter]);
  return <div className="relative isolate z-0 overflow-hidden rounded-3xl bg-[#171a20]">
    <div ref={container} aria-label="高德车辆位置地图" className="h-[min(55dvh,520px)] min-h-72 w-full" />
    {notice && <div role="status" className="absolute inset-x-3 top-3 z-10 rounded-xl bg-[#171a20]/95 p-3 text-xs text-amber-200">{notice}{failed && <button onClick={() => setRetry(value => value + 1)} className="ml-3 rounded-lg bg-white/10 px-3 py-2">重试地图</button>}</div>}
    {!notice && <p className="pointer-events-none absolute left-3 top-3 rounded-lg bg-[#171a20]/90 px-3 py-2 text-xs text-white">{isMock ? '模拟位置' : '车辆位置快照'} · 高德地图</p>}
  </div>;
}
