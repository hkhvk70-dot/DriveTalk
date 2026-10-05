export interface AMapPoint { getLng(): number; getLat(): number }
export interface AMapMarker { setMap(map: AMapMap | null): void }
export interface AMapMap { setZoomAndCenter(zoom: number, center: [number, number]): void; destroy(): void }
export interface AMapApi {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AMapMap;
  Marker: new (options: Record<string, unknown>) => AMapMarker;
  convertFrom(position: [number, number], type: string, callback: (status: string, result: { info?: string; locations?: AMapPoint[] }) => void): void;
}
declare global { interface Window { AMap?: AMapApi; _AMapSecurityConfig?: { serviceHost: string } } }
let sdkPromise: Promise<AMapApi> | undefined;

export function loadAMap(key: string): Promise<AMapApi> {
  if (!/^[a-f0-9]{32}$/i.test(key)) return Promise.reject(new Error('未配置高德网页 Key'));
  if (sdkPromise) return sdkPromise;
  if (window.AMap) return Promise.resolve(window.AMap);
  window._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` };
  sdkPromise = new Promise<AMapApi>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('高德地图加载失败，请检查网络及服务器安全代理')); };
    const timer = setTimeout(fail, 18000);
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onload = () => { clearTimeout(timer); if (window.AMap) resolve(window.AMap); else fail(); };
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch(error => { sdkPromise = undefined; throw error; });
  return sdkPromise;
}

// Fleet GPS uses [latitude, longitude]; AMap uses GCJ-02 [longitude, latitude].
// Never silently mark unconverted GPS coordinates on the Chinese map.
export function convertGpsForAMap(api: AMapApi, position: [number, number], timeoutMs = 8000): Promise<[number, number]> {
  const [lat, lng] = position;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return Promise.reject(new Error('车辆坐标无效'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('高德坐标转换超时')), timeoutMs);
    const fail = () => { clearTimeout(timer); reject(new Error('高德坐标转换失败，请检查安全代理配置')); };
    try {
      api.convertFrom([lng, lat], 'gps', (status, result) => {
        try {
          const point = result?.locations?.[0];
          if (status !== 'complete' || result.info?.toLowerCase() !== 'ok' || !point) return fail();
          const converted: [number, number] = [point.getLng(), point.getLat()];
          if (!converted.every(Number.isFinite) || Math.abs(converted[0]) > 180 || Math.abs(converted[1]) > 90) return fail();
          clearTimeout(timer); resolve(converted);
        } catch { fail(); }
      });
    } catch { fail(); }
  });
}
