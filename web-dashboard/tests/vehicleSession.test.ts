import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleSession } from '../src/services/vehicleSession.ts';
import { VehicleApiError, parseVehicleResponse, type VehicleTransport } from '../src/services/vehicleApi.ts';

const signal = () => new AbortController().signal;
function transport(overrides: Partial<VehicleTransport> = {}): VehicleTransport {
  return { getStatus: async () => 'online', getData: async () => ({ response: { state: 'online', drive_state: { speed: 0 } } }), wake: async () => {}, ...overrides };
}

test('asleep vehicle never reads vehicle_data or wakes automatically', async () => {
  let dataCalls = 0, wakeCalls = 0;
  const session = new VehicleSession(transport({ getStatus: async () => 'asleep', getData: async () => { dataCalls++; return { response: {} }; }, wake: async () => { wakeCalls++; } }));
  assert.deepEqual(await session.read(signal()), { state: 'asleep', data: null });
  assert.equal(dataCalls, 0); assert.equal(wakeCalls, 0);
});

test('transient reads retry at 1s and 2s, then succeed', async () => {
  let calls = 0;
  const waits: number[] = [];
  const session = new VehicleSession(transport({ getStatus: async () => { if (++calls < 3) throw new VehicleApiError(503, 'unavailable'); return 'online'; } }), Date.now, async (ms) => { waits.push(ms); });
  assert.equal((await session.read(signal()))?.state, 'online');
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
});

test('permission error is never retried', async () => {
  let calls = 0;
  const session = new VehicleSession(transport({ getStatus: async () => { calls++; throw new VehicleApiError(401, 'unauthorized'); } }));
  await assert.rejects(session.read(signal())); assert.equal(calls, 1);
});

test('429 respects Retry-After across subsequent manual requests', async () => {
  let now = 0, calls = 0;
  const session = new VehicleSession(transport({ getStatus: async () => { calls++; throw new VehicleApiError(429, 'rate limit', 180_000); } }), () => now);
  await assert.rejects(session.read(signal()));
  now = 60_001; assert.equal(await session.read(signal()), null); assert.equal(calls, 1);
  now = 180_001; await assert.rejects(session.read(signal())); assert.equal(calls, 2);
});

test('wake POST is not retried and duplicate clicks are throttled', async () => {
  let calls = 0;
  const session = new VehicleSession(transport({ wake: async () => { calls++; throw new TypeError('connection lost'); } }));
  await assert.rejects(session.wake(signal()));
  assert.equal(await session.wake(signal()), false); assert.equal(calls, 1);
});

test('parallel refreshes cannot duplicate requests', async () => {
  let release: (state: 'online') => void = () => {};
  const session = new VehicleSession(transport({ getStatus: () => new Promise((resolve) => { release = resolve; }) }));
  const first = session.read(signal());
  assert.equal(await session.read(signal()), null);
  release('online'); assert.equal((await first)?.state, 'online');
});

test('abort stops retry before another request', async () => {
  const abort = new AbortController(); let calls = 0;
  const session = new VehicleSession(transport({ getStatus: async () => { calls++; throw new TypeError('network'); } }), Date.now, async () => { abort.abort(); });
  await assert.rejects(session.read(abort.signal)); assert.equal(calls, 1);
});

test('payload validation accepts missing/null fields and rejects wrong types', () => {
  assert.doesNotThrow(() => parseVehicleResponse({ response: { state: 'online', drive_state: { speed: null } } }));
  assert.throws(() => parseVehicleResponse({ response: null }));
  assert.throws(() => parseVehicleResponse({ response: { drive_state: { speed: '86' } } }));
  assert.throws(() => parseVehicleResponse({ response: { vehicle_state: { locked: 1 } } }));
  assert.throws(() => parseVehicleResponse({ response: { drive_state: { shift_state: 'X' } } }));
});
