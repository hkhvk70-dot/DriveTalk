import test from 'node:test';
import assert from 'node:assert/strict';
import { validPosition, gpsAgeLabel } from '../src/utils/mobileLocation.ts';

test('location validates missing, invalid and zero-valued coordinates', () => {
  assert.equal(validPosition(undefined, undefined), null);
  assert.equal(validPosition(91, 20), null);
  assert.equal(validPosition(20, Infinity), null);
  assert.deepEqual(validPosition(0, 0), [0, 0]);
});
test('unknown GPS time never becomes fresh', () => {
  for (const time of [undefined, null, 0, NaN, Infinity]) {
    assert.match(gpsAgeLabel(time, 100000), /未知/);
  }
});
test('GPS seconds are not confused with milliseconds; stale and future fixes are explicit', () => {
  assert.match(gpsAgeLabel(1000, 1030000), /不足 1 分钟/);
  assert.match(gpsAgeLabel(1000, 1120000), /2 分钟/);
  assert.match(gpsAgeLabel(1000, 8200000), /2 小时/);
  assert.match(gpsAgeLabel(1000, 173800000), /2 天/);
  assert.match(gpsAgeLabel(1000, 900000), /检查设备时钟/);
});
