import { useEffect, useState } from 'react';
import { gpsSpeed } from './gps_speed';

export function usePhoneSpeed(enabled: boolean) {
  const [reading, setReading] = useState<ReturnType<typeof gpsSpeed> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setReading(null); setError('');
    if (!enabled) return;
    if (!navigator.geolocation) { setError('此设备不支持定位'); return; }
    let active = true;
    const id = navigator.geolocation.watchPosition(position => {
      if (active) {setReading(gpsSpeed(position)); setError('');}
    }, failure => {if (active) {setReading(null); setError(failure.code === 1 ? '定位权限未允许' : 'GPS 信号不可用');}},
    {enableHighAccuracy:true, maximumAge:0, timeout:15000});
    const timer = setInterval(() => setReading(previous => previous && Date.now() - previous.timestamp > 10000 ? {...previous, kmh:null} : previous), 1000);
    return () => { active = false; navigator.geolocation.clearWatch(id); clearInterval(timer); };
  }, [enabled]);
  return {...reading, kmh: reading?.kmh ?? null, error};
}
