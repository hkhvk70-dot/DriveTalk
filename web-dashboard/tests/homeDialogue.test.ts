import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatGrok, type GrokEvent } from '../src/services/grokApi.ts';

const frame = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
function stream(text: string): Response {
  return new Response(text, {headers: {'Content-Type': 'text/event-stream'}});
}

test('clarification keeps one page ID but every message has a fresh request ID, no client history', async () => {
  const session = crypto.randomUUID(); const requests: Record<string, unknown>[] = [];
  const fetcher = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return stream(frame('text', {text: '哪个？示例区域甲还是示例区域乙？'}) +
      frame('result', {status: 'clarification', target: 'home', commandSent: false, message: '尚未发送'}) + frame('done', {}));
  }) as typeof fetch;
  const events: GrokEvent[] = [];
  for (const text of ['打开智能插座', '我示例区域甲的那个']) await chatGrok(text, false,
    new AbortController().signal, event => events.push(event), fetcher, {allowHomeControl: true, conversationId: session});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].conversationId, session); assert.equal(requests[1].conversationId, session);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.equal('history' in requests[1], false);
  assert.equal(requests[1].message, '我示例区域甲的那个');
  assert.equal(events.filter(e => e.type === 'result').length, 2);
});

test('invalid conversation ID never sends a request', async () => {
  await assert.rejects(chatGrok('打开智能插座', false, new AbortController().signal, () => {},
    (async () => assert.fail('no fetch')) as typeof fetch, {conversationId: 'bad'}), /会话标识/);
});

test('home clarification is page-scoped and cleared on cancel, background, channel or grant change', () => {
  const source = readFileSync(new URL('../src/pages/GrokPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /homeConversation = useRef\(crypto.randomUUID\(\)\)/);
  assert.match(source, /conversationId: homeConversation.current/);
  assert.match(source, /function interrupt\(\) \{\s*clearHomeConversation\(\)/);
  assert.match(source, /const pause = .*clearHomeConversation\(\)/);
  assert.match(source, /const nativePause = .*clearHomeConversation\(\)/);
  assert.match(source, /onChange=\{e=>\{clearHomeConversation\(\);stopHandsFree\(\)/);
  assert.match(source, /clearHomeConversation\(\);setAllowHome/);
  assert.match(source, /清除待澄清的家居请求/);
  assert.doesNotMatch(source, /localStorage.*homeConversation|sessionStorage.*homeConversation/);
});
