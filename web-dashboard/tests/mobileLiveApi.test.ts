import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileLiveApi } from '../src/services/mobileLiveApi.ts';
import { createMobileVehicleStore } from '../src/stores/mobileVehicleStore.ts';
import { createMobileMock } from '../src/mocks/mobileVehicle.ts';

const response = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

test('live sleeping read requests status only, never data or wake', async () => {
  const calls: string[] = [];
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async (url) => { calls.push(String(url)); return response({ response: { state: 'asleep' } }); });
  assert.deepEqual(await api.read(), { state: 'asleep' });
  assert.deepEqual(calls, ['/v1/vehicle/status']);
});
test('online reads raw units, validates payload and sends owner header only', async () => {
  const calls: string[] = [];
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async (url, init) => {
    calls.push(String(url)); assert.equal((init?.headers as Record<string,string>)['X-DriveTalk-Token'], 'test-only');
    assert.equal((init?.headers as Record<string,string>).Authorization, undefined);
    return response({ response: String(url).endsWith('/status') ? { state: 'online' } : createMobileMock() });
  });
  assert.equal((await api.read()).charge_state?.battery_level, 80);
  assert.deepEqual(calls, ['/v1/vehicle/status', '/v1/vehicle/data']);
});
test('invalid JSON/schema not retried', async () => {
  let count = 0;
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async () => { count++; return response({ response: { state: 'online', charge_state: { battery_level: 'oops' } } }); });
  await assert.rejects(api.read()); assert.equal(count, 2);
});
test('429 command cooldown prevents duplicate writes without blocking reads', async () => {
  let count = 0;
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async () => { count++; return response({}, 429, { 'Retry-After': '90' }); });
  await assert.rejects(api.command({ name: 'horn' }));
  await assert.rejects(api.command({ name: 'horn' })); assert.equal(count, 1);
  await assert.rejects(api.read()); assert.equal(count, 2);
  await assert.rejects(api.read()); assert.equal(count, 2);
});
test('proxy capabilities on old backend fail closed', async () => {
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async () => response({}, 404));
  assert.deepEqual(await api.capabilities!(), { commands: false, navigation: false });
});
test('external URL and invalid token are rejected before transmission', () => {
  assert.throws(() => createMobileLiveApi('test-only', 'https://evil.test'));
  assert.throws(() => createMobileLiveApi('bad\ntoken'));
});
test('disposed session cannot make further network calls', async () => {
  let count = 0;
  const api = createMobileLiveApi('test-only', '/v1/vehicle', async () => { count++; return response({}); });
  api.dispose!(); await assert.rejects(api.read()); assert.equal(count, 0);
});
test('live store default read-only command action never calls vehicle', async () => {
  let count = 0;
  const store = createMobileVehicleStore({ async read() { return createMobileMock(); }, async wake() { count++; }, async command() { count++; } }, { source: 'live' });
  assert.equal(await store.getState().executeCommand({ name: 'horn' }), false);
  assert.equal(count, 0);
});
test('failed live connection clears mock snapshot and disconnect clears session', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({}, 401);
  try {
    const store = createMobileVehicleStore();
    assert.equal(await store.getState().connect('test-only'), false);
    assert.equal(store.getState().source, 'live');
    assert.equal(store.getState().vehicleData, null);
    assert.equal(store.getState().lastUpdatedAt, null);
    assert.equal(store.getState().commandsEnabled, false);
    store.getState().disconnect();
    assert.equal(store.getState().source, 'mock');
    assert.equal(store.getState().error, null);
  } finally { globalThis.fetch = original; }
});
