import test from 'node:test';
import assert from 'node:assert/strict';
import { homeAccount, parseHomeAccount, jobActive } from '../src/services/smartHomeApi.ts';

const account = { available: true, configured: true, controlConnected: false,
  syncedAt: null, devices: [], job: { state: 'idle' } };
const device = { id: `device_${'a'.repeat(24)}`, name: '灯泡', kind: 'light', model: 'vendor.light.test',
  online: null, home: '', room: '', enabled: false, integration_status: 'binding_ready_disabled', capabilities: ['on'] };
test('status GET cookie-only no cloud-action body', async () => {
  let calls = 0;
  assert.equal((await homeAccount('status', undefined, undefined, async (url, init) => {
    calls++; assert.equal(url, '/v1/smarthome/status'); assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined); assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store'); return Response.json(account);
  })).controlConnected, false);
  assert.equal(calls, 1);
});
test('selection uses exact ID array and never automatically retries', async () => {
  let calls = 0;
  await assert.rejects(homeAccount('select', [device.id], undefined, async (_url, init) => {
    calls++; assert.equal(init?.method, 'POST'); assert.equal(init?.body, JSON.stringify({ deviceIds: [device.id] }));
    return Response.json({}, { status: 409 });
  }), /未自动重试/);
  assert.equal(calls, 1);
});
test('unknown online remains unknown, DID and method data rejected', () => {
  assert.equal(parseHomeAccount({ ...account, devices: [device] }).devices[0].online, null);
  for (const invalid of [{ ...device, did: 'secret' }, { ...device, online: 0 }, { ...device, properties: {} }]) {
    assert.throws(() => parseHomeAccount({ ...account, devices: [invalid] }));
  }
});
test('QR origin and task state validation', () => {
  const job = { state: 'waiting_scan', loginUrl: 'https://account.xiaomi.com/pass/qr?test=1', qrSvg: 'YWJj' };
  assert.equal(parseHomeAccount({ ...account, job }).job.loginUrl, job.loginUrl);
  const official = 'https://ak.account.xiaomi.com/longPolling/login?ticket=test';
  assert.equal(parseHomeAccount({ ...account, job: { ...job, loginUrl: official } }).job.loginUrl, official);
  for (const url of ['https://evil.invalid', 'http://account.xiaomi.com', 'https://u@account.xiaomi.com',
    'http://ak.account.xiaomi.com', 'https://ak.account.xiaomi.com.evil.invalid',
    'https://u@ak.account.xiaomi.com', 'https://ak.account.xiaomi.com:8080']) {
    assert.throws(() => parseHomeAccount({ ...account, job: { ...job, loginUrl: url } }));
  }
  assert.equal(parseHomeAccount({ ...account, controlConnected: true }).controlGranted, false);
  assert.throws(() => parseHomeAccount({ ...account, controlConnected: 'true' }));
  assert.equal(jobActive('syncing'), true); assert.equal(jobActive('done'), false);
});

test('control grant must be explicit and cannot exist without a ready bridge', async () => {
  assert.throws(() => parseHomeAccount({ ...account, controlGranted: true }));
  assert.throws(() => parseHomeAccount({ ...account, controlGranted: 1 }));
  assert.equal(parseHomeAccount({ ...account, controlConnected: true, controlGranted: true }).controlGranted, true);
  let calls = 0;
  await homeAccount('select', [device.id], undefined, async (_url, init) => {
    calls++; assert.deepEqual(JSON.parse(String(init?.body)), {deviceIds: [device.id], enableControl: true});
    return Response.json({...account, controlConnected: true, controlGranted: true});
  }, true);
  assert.equal(calls, 1);
});
test('server cooldown is validated; legacy response defaults to zero', () => {
  assert.equal(parseHomeAccount(account).retryAfter, 0);
  assert.equal(parseHomeAccount({ ...account, retryAfter: 30 }).retryAfter, 30);
  for (const retryAfter of [-1, 31, 1.5, '30']) assert.throws(() => parseHomeAccount({ ...account, retryAfter }));
});
test('duplicate devices and unavailable deployed API rejected honestly', async () => {
  assert.throws(() => parseHomeAccount({ ...account, devices: [device, device] }));
  await assert.rejects(homeAccount('status', undefined, undefined,
    async () => Response.json({}, { status: 404 })), /尚未部署/);
});
