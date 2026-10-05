import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertGpsForAMap, type AMapApi } from '../src/services/amap.ts';

test('GPS input is reordered and converted without modifying original coordinates', async () => {
  const input: [number, number] = [39.9, 116.4];
  let calls = 0;
  const api = { convertFrom(point, type, callback) { calls++; assert.deepEqual(point, [116.4, 39.9]); assert.equal(type, 'gps'); callback('complete', { info: 'ok', locations: [{ getLng: () => 116.406, getLat: () => 39.901 }] }); } } as AMapApi;
  assert.deepEqual(await convertGpsForAMap(api, input), [116.406, 39.901]);
  assert.deepEqual(input, [39.9, 116.4]); assert.equal(calls, 1);
});
test('failed conversion never falls back to raw GPS', async () => {
  const api = { convertFrom(_point, _type, callback) { callback('error', { info: 'INVALID_USER_SCODE' }); } } as AMapApi;
  await assert.rejects(convertGpsForAMap(api, [39.9, 116.4]), /转换失败/);
});
test('invalid GPS is rejected before SDK request', async () => {
  const api = { convertFrom() { assert.fail('must not call SDK'); } } as unknown as AMapApi;
  await assert.rejects(convertGpsForAMap(api, [91, 116]), /无效/);
});
test('conversion has a bounded timeout and no automatic retry', async () => {
  let calls = 0;
  const api = { convertFrom() { calls++; } } as unknown as AMapApi;
  await assert.rejects(convertGpsForAMap(api, [39.9, 116.4], 1), /超时/); assert.equal(calls, 1);
});
