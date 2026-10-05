import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileVehicleStore } from '../src/stores/mobileVehicleStore.ts';
import { createMobileMockApi, createBlockedLiveApi, type MobileVehicleApi, type VehicleCommand } from '../src/services/mobileVehicleApi.ts';
import { createMobileMock } from '../src/mocks/mobileVehicle.ts';
import { fetchWithRetry, HttpRequestError } from '../src/services/fetchWithRetry.ts';
import { validPosition, distanceMeters } from '../src/utils/mobileLocation.ts';

test('assistant snapshot uses real timestamp only when fresh and does not change mock', () => {
  const live = createMobileVehicleStore(createMobileMockApi(0), { source: 'live' });
  live.setState({ lastUpdatedAt: 123 });
  live.getState().receiveAssistantSnapshot(createMobileMock(), false);
  assert.equal(live.getState().lastUpdatedAt, 123);
  live.getState().receiveAssistantSnapshot(createMobileMock(), true);
  assert.notEqual(live.getState().lastUpdatedAt, 123);
  const mock = createMobileVehicleStore(createMobileMockApi(0));
  const original = mock.getState().vehicleData;
  mock.getState().receiveAssistantSnapshot(createMobileMock(), true);
  assert.equal(mock.getState().vehicleData, original);
});

test('assistant participates in existing global command mutex', async () => {
  const store = createMobileVehicleStore(createMobileMockApi(0));
  let finish!: () => void;
  const pending = store.getState().runAssistant(() => new Promise<void>(resolve => { finish = resolve; }));
  assert.equal(store.getState().isLoading, true);
  assert.equal(await store.getState().runAssistant(async () => assert.fail('second request')), false);
  assert.equal(await store.getState().toggleLock(), false);
  finish(); assert.equal(await pending, true);
  assert.equal(store.getState().isLoading, false);
});

test('live trunk close follows delayed readback without replaying command', async () => {
  let reads = 0, commands = 0;
  const store = createMobileVehicleStore({
    async read() { const data = createMobileMock(); data.vehicle_state!.rt = ++reads < 3 ? 1 : 0; return data; },
    async wake() { assert.fail('must not wake'); },
    async command() { commands++; },
  }, { source: 'live', syncWaitMs: 0 });
  store.setState({ commandsEnabled: true, rearTrunkCloseEnabled: true });
  assert.equal(await store.getState().executeCommand({ name: 'rearTrunk', open: false }), true);
  assert.equal(reads, 3);
  assert.equal(commands, 1);
  assert.equal(store.getState().vehicleData?.vehicle_state?.rt, 0);
});

test('readback stops after two stale snapshots and never invents trunk state', async () => {
  let reads = 0, commands = 0;
  const store = createMobileVehicleStore({
    async read() { reads++; const data = createMobileMock(); data.vehicle_state!.rt = 1; return data; },
    async wake() { assert.fail('must not wake'); }, async command() { commands++; },
  }, { source: 'live', syncWaitMs: 0 });
  store.setState({ commandsEnabled: true, rearTrunkCloseEnabled: true });
  await store.getState().executeCommand({ name: 'rearTrunk', open: false });
  assert.equal(reads, 3); // One preflight and two post-command reads.
  assert.equal(commands, 1);
  assert.equal(store.getState().vehicleData?.vehicle_state?.rt, 1);
  assert.match(store.getState().notice!, /尚未确认/);
});

test('live command checks status without redundant data read and preserves snapshot time', async () => {
  let reads = 0, status = 0;
  const store = createMobileVehicleStore({
    async read() { reads++; const data = createMobileMock(); data.vehicle_state!.rt = 0; return data; },
    async connectionStatus() { status++; return 'online'; },
    async wake() { assert.fail('must not wake'); }, async command() {},
  }, { source: 'live', syncWaitMs: 0 });
  store.setState({ commandsEnabled: true, rearTrunkCloseEnabled: true, vehicleData: createMobileMock() });
  await store.getState().executeCommand({ name: 'rearTrunk', open: false });
  assert.equal(reads, 1);
  assert.equal(status, 1);
});

test('mock command updates read-back without mutating another session', async () => {
  const a = createMobileVehicleStore(createMobileMockApi(0));
  const b = createMobileVehicleStore(createMobileMockApi(0));
  assert.equal(await a.getState().toggleLock(), true);
  assert.equal(a.getState().vehicleData?.vehicle_state?.locked, false);
  assert.equal(b.getState().vehicleData?.vehicle_state?.locked, true);
});

test('explicit lock remains available after stale unlock snapshot and sends requested state', async () => {
  const sent: unknown[] = [];
  const store = createMobileVehicleStore({ async read() { return createMobileMock(); }, async wake() {}, async command(command) { sent.push(command); } });
  assert.equal(await store.getState().executeCommand({ name: 'lock', locked: false }), true);
  assert.equal(store.getState().vehicleData?.vehicle_state?.locked, true); // deliberately stale readback
  assert.equal(await store.getState().executeCommand({ name: 'lock', locked: true }), true);
  assert.deepEqual(sent, [{ name: 'lock', locked: false }, { name: 'lock', locked: true }]);
});

test('explicit climate and charging stop work with stale off snapshots', async () => {
  const sent: unknown[] = [];
  const snapshot = createMobileMock();
  snapshot.climate_state!.is_climate_on = false;
  snapshot.charge_state!.charging_state = 'Stopped';
  const store = createMobileVehicleStore({ async read() { return structuredClone(snapshot); }, async wake() { assert.fail('no wake'); }, async command(c) { sent.push(c); } });
  for (const name of ['climate', 'charging'] as const) {
    assert.equal(await store.getState().executeCommand({ name, enabled: true }), true);
    assert.equal(await store.getState().executeCommand({ name, enabled: false }), true);
  }
  assert.deepEqual(sent, [{ name: 'climate', enabled: true }, { name: 'climate', enabled: false }, { name: 'charging', enabled: true }, { name: 'charging', enabled: false }]);
});

test('mock rear trunk and windows use explicit open/close without toggle', async () => {
  const store = createMobileVehicleStore(createMobileMockApi(0));
  for (const open of [true, true, false, false]) {
    assert.equal(await store.getState().executeCommand({ name: 'rearTrunk', open }), true);
    assert.equal(store.getState().vehicleData?.vehicle_state?.rt, open ? 1 : 0);
  }
  assert.equal(await store.getState().executeCommand({ name: 'vent' }), true);
  assert.equal(store.getState().vehicleData?.vehicle_state?.fd_window, 1);
  assert.equal(await store.getState().executeCommand({ name: 'closeWindows' }), true);
  assert.equal(store.getState().vehicleData?.vehicle_state?.fd_window, 0);
});

test('live rear close unsupported fails before vehicle request', async () => {
  const store = createMobileVehicleStore({ async read() { assert.fail('no read'); }, async wake() { assert.fail('no wake'); }, async command() { assert.fail('no command'); } }, { source: 'live' });
  store.setState({ commandsEnabled: true });
  assert.equal(await store.getState().executeCommand({ name: 'rearTrunk', open: false }), false);
});

test('enabled live navigation sends exactly one address command and does not fake route readback', async () => {
  const sent: unknown[] = [];
  const store = createMobileVehicleStore({ async read() { return createMobileMock(); }, async wake() { assert.fail('must not wake'); }, async command(command) { sent.push(command); } }, { source: 'live' });
  store.setState({ commandsEnabled: true, navigationEnabled: true, vehicleData: createMobileMock() });
  const previous = store.getState().vehicleData?.drive_state?.active_route_destination;
  assert.equal(await store.getState().sendNavigation(' 示例目的地 '), true);
  assert.deepEqual(sent, [{ name: 'navigation', destination: '示例目的地' }]);
  assert.equal(store.getState().vehicleData?.drive_state?.active_route_destination, previous);
  assert.match(store.getState().notice!, /车机确认/);
});

test('navigation links/control characters are rejected before any request', async () => {
  const store = createMobileVehicleStore({ async read() { assert.fail('unexpected request'); }, async wake() { assert.fail('unexpected wake'); }, async command() { assert.fail('unexpected command'); } });
  for (const destination of ['https://example.com', '北京\n示例区域甲', 'x'.repeat(301)]) assert.equal(await store.getState().sendNavigation(destination), false);
});
test('manual sleep requires confirmation, wakes exactly once, never replays original command', async () => {
  const base = createMobileMockApi(0); let wakes = 0; let commands = 0;
  const api: MobileVehicleApi = { ...base, async wake() { wakes++; await base.wake(); }, async command(c) { commands++; await base.command(c); } };
  const store = createMobileVehicleStore(api);
  store.getState().simulateSleep(true);
  assert.equal(await store.getState().toggleLock(), false);
  assert.equal(store.getState().wakeState, 'needs-confirmation');
  assert.equal(wakes, 0); assert.equal(commands, 0);
  assert.equal(await store.getState().checkAndWakeUp(true), true);
  assert.equal(wakes, 1); assert.equal(commands, 0);
  assert.equal(await store.getState().toggleLock(), true);
  assert.equal(commands, 1);
});
test('concurrent clicks cannot issue duplicate trunk commands', async () => {
  const base = createMobileMockApi(1); let commands = 0;
  const store = createMobileVehicleStore({ ...base, async command(c) { commands++; await base.command(c); } });
  const [a, b] = await Promise.all([store.getState().executeCommand({ name: 'trunk', trunk: 'rear' }), store.getState().executeCommand({ name: 'trunk', trunk: 'rear' })]);
  assert.deepEqual([a, b], [true, false]); assert.equal(commands, 1);
});
test('invalid command input performs no reads, wake or commands', async () => {
  let calls = 0;
  const store = createMobileVehicleStore({ async read() { calls++; return createMobileMock(); }, async wake() { calls++; }, async command() { calls++; } });
  assert.equal(await store.getState().setTemperature(NaN), false);
  assert.equal(await store.getState().executeCommand({ name: 'chargeLimit', percent: 101 }), false);
  assert.equal(await store.getState().sendNavigation(' '), false);
  assert.equal(calls, 0);
});
test('non-idempotent command failure never retries or optimistically changes snapshot', async () => {
  let commands = 0;
  const store = createMobileVehicleStore({ async read() { return createMobileMock(); }, async wake() {}, async command() { commands++; throw new Error('network timeout'); } });
  assert.equal(await store.getState().executeCommand({ name: 'trunk', trunk: 'rear' }), false);
  assert.equal(commands, 1); assert.equal(store.getState().vehicleData?.vehicle_state?.rt, 0);
  assert.equal(store.getState().isLoading, false); assert.match(store.getState().error!, /未自动重试/);
});
test('command accepted but snapshot refresh fails is not presented as command rejection', async () => {
  let reads = 0;
  const store = createMobileVehicleStore({ async read() { if (++reads > 1) throw new Error('read failed'); return createMobileMock(); }, async wake() {}, async command() {} });
  assert.equal(await store.getState().setTemperature(22), true);
  assert.equal(store.getState().error, null); assert.match(store.getState().notice!, /命令已受理/);
});
test('partial find-car failure stops and reports partial acceptance', async () => {
  const names: string[] = [];
  const store = createMobileVehicleStore({ async read() { return createMobileMock(); }, async wake() {}, async command(c) { names.push(c.name); if (c.name === 'lights') throw new Error('timeout'); } });
  assert.equal(await store.getState().findCar(), false);
  assert.deepEqual(names, ['horn', 'lights']); assert.match(store.getState().error!, /鸣笛已受理/);
});
test('unknown gear blocks park-only command at store boundary', async () => {
  const data = createMobileMock(); data.drive_state!.shift_state = null; let commands = 0;
  const store = createMobileVehicleStore({ async read() { return data; }, async wake() {}, async command() { commands++; } });
  assert.equal(await store.getState().executeCommand({ name: 'chargePort', open: true }), false); assert.equal(commands, 0);
});

test('front/rear trunks and charge port require park, other supported controls accept every gear', async () => {
  const protectedCommands: VehicleCommand[] = [{name:'trunk',trunk:'front'},{name:'trunk',trunk:'rear'},
    {name:'rearTrunk',open:true},{name:'rearTrunk',open:false},{name:'chargePort',open:true},{name:'chargePort',open:false}];
  const otherCommands: VehicleCommand[] = [{name:'lock',locked:true},{name:'lock',locked:false},
    {name:'climate',enabled:true},{name:'climate',enabled:false},{name:'temperature',celsius:22},
    {name:'chargeLimit',percent:80},{name:'charging',enabled:true},{name:'charging',enabled:false},
    {name:'vent'},{name:'closeWindows'},{name:'horn'},{name:'lights'},{name:'findCar'},{name:'navigation',destination:'测试地点'}];
  for (const gear of ['P','R','N','D',null] as const) {
    for (const command of [...protectedCommands,...otherCommands]) {
      const data = createMobileMock(); data.drive_state!.shift_state = gear; let dispatched = 0;
      const store = createMobileVehicleStore({async read(){return data;},async wake(){assert.fail('no wake');},async command(){dispatched++;}});
      const expected = !protectedCommands.includes(command) || gear === 'P';
      assert.equal(await store.getState().executeCommand(command),expected,`${gear} ${JSON.stringify(command)}`);
      assert.equal(dispatched,expected?1:0);
    }
  }
});
test('wake timeout sends a single wake and unlocks UI', async () => {
  let wakes = 0; const data = createMobileMock(); data.state = 'asleep';
  const store = createMobileVehicleStore({ async read() { return data; }, async wake() { wakes++; }, async command() { assert.fail('must not command asleep car'); } }, { waitMs: 1, wakeTimeoutMs: 2 });
  assert.equal(await store.getState().checkAndWakeUp(true), false); assert.equal(wakes, 1);
  assert.equal(store.getState().wakeState, 'error'); assert.equal(store.getState().isLoading, false);
});
test('live skeleton fails closed without credentials or requests', async () => {
  const store = createMobileVehicleStore(createBlockedLiveApi(''), { source: 'live' });
  assert.equal(await store.getState().refresh(), false); assert.equal(store.getState().vehicleData, null);
  assert.match(store.getState().error!, /尚未配置/);
});
test('charging and limit mocks read back; cable prevents closing charge port', async () => {
  const store = createMobileVehicleStore(createMobileMockApi(0));
  // Synthetic battery is already at its default limit; raise the limit first.
  assert.equal(await store.getState().executeCommand({ name: 'chargeLimit', percent: 90 }), true);
  assert.equal(await store.getState().executeCommand({ name: 'charging', enabled: true }), true);
  assert.equal(store.getState().vehicleData?.charge_state?.charger_power, 7);
  assert.equal(await store.getState().executeCommand({ name: 'chargeLimit', percent: 90 }), true);
  assert.equal(store.getState().vehicleData?.charge_state?.charge_limit_soc, 90);
  assert.equal(await store.getState().executeCommand({ name: 'chargePort', open: false }), false);
});
test('GET retries bounded transient failure but POST is never retried', async () => {
  for (const method of ['GET', 'POST']) {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response('', { status: 503 }); }) as typeof fetch;
    await assert.rejects(fetchWithRetry('https://example.invalid', { method }, { fetcher, sleep: async () => {} }), HttpRequestError);
    assert.equal(calls, method === 'GET' ? 3 : 1);
  }
});
test('authorization errors and long Retry-After are not automatically retried', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response('', { status, headers: { 'Retry-After': '60' } }); }) as typeof fetch;
    await assert.rejects(fetchWithRetry('https://example.invalid', {}, { fetcher }), HttpRequestError);
    assert.equal(calls, 1);
  }
});
test('cancelled request performs no fetch; zero coordinates valid, NaN invalid', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(fetchWithRetry('https://example.invalid', { signal: controller.signal }, { fetcher: (async () => { calls++; return new Response(); }) as typeof fetch }));
  assert.equal(calls, 0); assert.deepEqual(validPosition(0, 0), [0, 0]);
  assert.equal(validPosition(NaN, 116), null); assert.equal(validPosition(91, 0), null);
  assert.equal(distanceMeters([0, 0], [0, 0]), 0);
});
