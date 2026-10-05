/** 只使用手机传感器报告的速度，不通过两次坐标猜速度，不回退 Fleet API。 */
export function gpsSpeed(position: Pick<GeolocationPosition, 'timestamp' | 'coords'>, now = Date.now()) {
  const { speed, accuracy } = position.coords;
  const fresh = Number.isFinite(position.timestamp) && now - position.timestamp <= 10000 && position.timestamp <= now + 1000;
  const reliable = Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 50;
  const kmh = fresh && reliable && speed !== null && Number.isFinite(speed) && speed >= 0 && speed <= 100
    ? Math.round(speed * 36) / 10 : null;
  return { kmh, accuracy: Number.isFinite(accuracy) ? accuracy : null, timestamp: position.timestamp };
}
