import test from 'node:test';
import assert from 'node:assert/strict';
import { gpsSpeed } from '../src/services/voice/gps_speed.ts';
const now = 100000;
const position = (speed: number | null, accuracy = 5, timestamp = now) => ({timestamp,coords:{speed,accuracy}} as GeolocationPosition);
test('GPS uses sensor m/s, preserves zero and refuses absent/non-finite speeds', () => {
  assert.equal(gpsSpeed(position(10),now).kmh,36);
  assert.equal(gpsSpeed(position(0),now).kmh,0);
  for (const speed of [null,NaN,Infinity,-1,101]) assert.equal(gpsSpeed(position(speed),now).kmh,null);
});
test('stale, future or inaccurate GPS does not fabricate speed or use Fleet fallback', () => {
  for (const input of [position(10,51),position(10,-1),position(10,NaN),position(10,5,now-10001),position(10,5,now+1001)]) assert.equal(gpsSpeed(input,now).kmh,null);
});
