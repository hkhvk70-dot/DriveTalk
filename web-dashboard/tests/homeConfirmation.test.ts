import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatGrok, type GrokEvent } from '../src/services/grokApi.ts';

test('home accepted-but-unconfirmed SSE is preserved, not treated as success or resent', async () => {
  let calls = 0; const events: GrokEvent[] = [];
  await chatGrok('打开智能插座', false, new AbortController().signal, e => events.push(e),
    (async () => {
      calls++;
      return new Response('event: result\ndata: {"status":"accepted","target":"home","commandSent":true,"message":"已受理，状态暂未确认"}\n\nevent: done\ndata: {}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch, { allowHomeControl: true, conversationId: crypto.randomUUID() });
  assert.equal(calls, 1);
  const result = events.find(e => e.type === 'result');
  assert.equal(result?.type, 'result');
  if (result?.type === 'result') {
    assert.equal(result.status, 'accepted'); assert.equal(result.target, 'home');
    assert.equal(result.commandSent, true);
  }
});

test('home pending pauses hands-free and clears clarification; vehicle interim acceptance does not', () => {
  const page = readFileSync(new URL('../src/pages/GrokPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /event.target === 'home' && event.status === 'accepted'/);
  assert.match(page, /clearHomeConversation\(\); stopHandsFree\(\)/);
  assert.match(page, /家居命令已受理，状态暂未确认/);
  assert.match(page, /\['unknown', 'not_sent', 'accepted'\].includes\(turn.status\)/);
});
