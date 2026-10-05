export function validPosition(latitude: number | null | undefined, longitude: number | null | undefined): [number, number] | null {
  return latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? [latitude, longitude] : null;
}

export function distanceMeters(a: [number, number], b: [number, number]): number {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const value = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, value)), Math.sqrt(Math.max(0, 1 - value)));
}

/** GPS timestamp is seconds; never substitute the fetch time for a missing fix. */
export function gpsAgeLabel(gpsAsOf: number | null | undefined, now = Date.now()): string {
  if (gpsAsOf == null || !Number.isFinite(gpsAsOf) || gpsAsOf <= 0) return '定位时间未知，无法判断位置是否最新';
  const age = Math.floor((now - gpsAsOf * 1000) / 1000);
  if (age < -60) return '定位时间晚于当前时间，请检查设备时钟';
  if (age < 60) return '定位上报距本次显示不足 1 分钟';
  if (age < 3600) return `定位上报距本次显示 ${Math.floor(age / 60)} 分钟`;
  if (age < 86400) return `定位上报距本次显示 ${Math.floor(age / 3600)} 小时`;
  return `定位上报距本次显示 ${Math.floor(age / 86400)} 天`;
}
