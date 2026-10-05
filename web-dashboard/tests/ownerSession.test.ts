import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerSession } from '../src/services/ownerSession.ts';
import { createMobileLiveApi } from '../src/services/mobileLiveApi.ts';
import { createMobileVehicleStore } from '../src/stores/mobileVehicleStore.ts';

test('remembered login exchanges header token for cookie without copying it into body', async () => {
  assert.equal(await ownerSession('login', 'test-only', async (url, init) => {
    assert.equal(url, '/v1/vehicle/session/login'); assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.body, '{}'); assert.equal((init?.headers as Record<string,string>)['X-DriveTalk-Token'], 'test-only');
    return Response.json({ authenticated: true });
  }), true);
});
test('expired session is not retried and does not wake vehicle', async () => {
  let calls = 0;
  assert.equal(await ownerSession('status', undefined, async () => { calls++; return Response.json({}, { status: 401 }); }), false);
  assert.equal(calls, 1);
});
test('cookie transport does not send raw owner token', async () => {
  const api = createMobileLiveApi(null, '/v1/vehicle', async (_url, init) => {
    assert.equal((init?.headers as Record<string,string>)['X-DriveTalk-Token'], undefined);
    assert.equal(init?.credentials, 'same-origin');
    return Response.json({ response: { state: 'asleep' } });
  });
  assert.deepEqual(await api.read(), { state: 'asleep' });
});
test('startup resumes only once, without polling or wake; logout revokes saved session', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const path = String(url); calls.push(path);
    if (path.endsWith('/session')) return Response.json({ authenticated: true });
    if (path.endsWith('/logout')) return Response.json({ authenticated: false });
    if (path.endsWith('/capabilities')) return Response.json({ commands: true });
    return Response.json({ response: { state: 'asleep' } });
  };
  try {
    const store = createMobileVehicleStore();
    assert.equal(await store.getState().restoreSession(), true);
    assert.equal(await store.getState().restoreSession(), false);
    assert.equal(store.getState().remembered, true);
    assert.equal(store.getState().commandsEnabled, true);
    assert.deepEqual(calls, ['/v1/vehicle/session', '/v1/vehicle/status', '/v1/vehicle/capabilities']);
    await store.getState().disconnect();
    assert.equal(calls.at(-1), '/v1/vehicle/session/logout');
    assert.equal(store.getState().remembered, false);
  } finally { globalThis.fetch = original; }
});
