import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGrok, grokConfig, type GrokEvent } from '../src/services/grokApi.ts';

function stream(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  // Split inside UTF-8 characters, JSON, CRLF and SSE separators.
  let position = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (position === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(position, ++position));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const frame = (event: string, value: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

test('key configuration is same-origin POST and never returned to UI', async () => {
  const requests: [string, RequestInit | undefined][] = [];
  const fetcher = (async (url, init) => {
    requests.push([String(url), init]);
    return Response.json({ configured: true, enabled: true, model: 'deepseek-flash', persona: '温柔简洁' });
  }) as typeof fetch;
  const config = await grokConfig({ apiKey: 'sk-test-only', persona: '温柔简洁', enabled: true }, fetcher);
  assert.equal(requests[0][0], '/v1/vehicle/ai/deepseek/config');
  assert.equal(requests[0][1]?.method, 'POST');
  assert.equal(requests[0][1]?.credentials, 'same-origin');
  assert.equal(requests[0][1]?.cache, 'no-store');
  assert.equal('apiKey' in config, false);
  assert.equal(config.persona, '温柔简洁');
  await assert.rejects(grokConfig(undefined, (async () => Response.json({ ...config, apiKey: 'unexpected' })) as typeof fetch), /响应无效/);
});

test('fragmented UTF-8 SSE updates snapshots with no secondary fetch or retry', async () => {
  const events: GrokEvent[] = [];
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++;
    assert.equal(url, '/v1/vehicle/ai/deepseek/chat');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.allowControl, true);
    assert.equal(body.message, '锁车');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    return stream(frame('text', { text: '中文回复' }) + frame('snapshot', { response: { state: 'online', charge_state: { battery_level: 71 } }, fresh: false })
       + frame('result', { status: 'accepted', message: '已受理', commandSent: true }) + frame('done', {}));
  }) as typeof fetch;
  await chatGrok('锁车', true, new AbortController().signal, event => events.push(event), fetcher);
  assert.equal(calls, 1);
  assert.equal(events[0].type, 'text');
  assert.equal((events[0] as { message: string }).message, '中文回复');
  assert.equal(events[1].type, 'snapshot');
  assert.equal((events[1] as { fresh: boolean }).fresh, false);
});

test('truncated stream is uncertain and never resent', async () => {
  let calls = 0;
  await assert.rejects(chatGrok('锁车', true, new AbortController().signal, () => {}, (async () => {
    calls++; return stream(frame('result', { status: 'accepted', message: '已受理' }));
  }) as typeof fetch), /连接中断/);
  assert.equal(calls, 1);
});

test('invalid snapshot and non-stream response fail closed', async () => {
  for (const response of [stream(frame('snapshot', { response: { charge_state: { battery_level: '71' } }, fresh: true }) + frame('done', {})), Response.json({ text: 'not SSE' })]) {
    await assert.rejects(chatGrok('查询电量', false, new AbortController().signal, () => assert.fail('no valid event'), (async () => response) as typeof fetch));
  }
});

test('aborted request never calls provider', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chatGrok('锁车', true, controller.signal, () => {}, (async () => assert.fail('must not fetch')) as typeof fetch));
});

test('home grant is independent of vehicle permission and home result remains authoritative', async () => {
  const events: GrokEvent[] = [];
  let calls = 0;
  await chatGrok('打开灯泡', false, new AbortController().signal, event => events.push(event), async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(body.allowControl, false); assert.equal(body.allowHomeControl, true);
    return stream(frame('result', {status: 'confirmed', target: 'home', commandSent: true, message: '回读已确认'}) + frame('done', {}));
  }, {allowHomeControl: true});
  assert.equal(calls, 1);
  assert.equal((events[0] as {target?: string}).target, 'home');
});

test('429 respects cooldown and does not automatically retry', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ message: '限流' }, { status: 429, headers: { 'Retry-After': '5' } }); }) as typeof fetch;
  await assert.rejects(chatGrok('锁车', true, new AbortController().signal, () => {}, fetcher), /限流/);
  await assert.rejects(chatGrok('锁车', true, new AbortController().signal, () => {}, fetcher), /冷却/);
  assert.equal(calls, 1);
});
