import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceSplitter } from '../src/services/voice/sentence_splitter.ts';
import { AudioQueue } from '../src/services/voice/audio_queue.ts';

test('sentence deltas emit immediately at punctuation and flush final tail exactly once', () => {
  const splitter = new SentenceSplitter();
  assert.deepEqual(splitter.push('温度为26.'), []);
  assert.deepEqual(splitter.push('5度，已经'), [{ sequence: 0, text: '温度为26.5度，', reason: 'punctuation' }]);
  assert.deepEqual(splitter.push('关闭。！！\n'), [{ sequence: 1, text: '已经关闭。', reason: 'punctuation' }]);
  splitter.push('剩余文本');
  assert.deepEqual(splitter.finish(), [{ sequence: 2, text: '剩余文本', reason: 'end' }]);
  assert.deepEqual(splitter.finish(), []);
  assert.throws(() => splitter.push('迟到增量'));
});

test('unpunctuated output is bounded without splitting surrogate pairs', () => {
  const splitter = new SentenceSplitter(8);
  const chunks = splitter.push('😀'.repeat(17));
  assert.equal(chunks.length, 2);
  assert.equal(Array.from(chunks[0].text).length, 8);
  assert.equal(splitter.finish()[0].text, '😀');
});

class FakeSource {
  buffer: { duration: number; values: Float32Array } | null = null;
  onended: (() => void) | null = null;
  at = -1;
  stopped = false;
  connect() {}
  disconnect() {}
  start(at: number) { this.at = at; }
  stop() { this.stopped = true; }
  end() { this.onended?.(); }
}
class FakeContext {
  currentTime = 0;
  state = 'suspended';
  destination = {};
  nodes: FakeSource[] = [];
  decodedFrames = 800;
  async resume() { this.state = 'running'; }
  async decodeAudioData(_bytes: ArrayBuffer) {
    return { numberOfChannels: 1, duration: this.decodedFrames / 8000, length: this.decodedFrames, sampleRate: 8000,
      getChannelData: () => new Float32Array(this.decodedFrames).fill(0.25) };
  }
  createBuffer(_channels: number, frames: number, rate: number) {
    const values = new Float32Array(frames);
    return { duration: frames / rate, values, getChannelData: () => values };
  }
  createBufferSource() { const source = new FakeSource(); this.nodes.push(source); return source; }
}
function fixture(options: { maxBufferedSeconds?: number } = {}) {
  const context = new FakeContext();
  const active: boolean[] = [];
  let underruns = 0;
  const queue = new AudioQueue({ ...options, context: context as unknown as AudioContext,
    onSpeechActive: value => active.push(value), onUnderrun: () => underruns++ });
  return { queue, context, active, underruns: () => underruns };
}

test('PCM chunks are scheduled contiguously before preceding chunk ends; mic stays muted through finish', async () => {
  const { queue, context, active } = fixture();
  await queue.unlock();
  const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array(1600), 8000);
  queue.enqueuePcm16(turn.id, 1, new Uint8Array(1600), 8000);
  assert.equal(context.nodes[1].at, context.nodes[0].at + context.nodes[0].buffer!.duration);
  assert.deepEqual(active, [true]);
  queue.finishTurn(turn.id);
  context.nodes[0].end();
  assert.deepEqual(active, [true]);
  context.nodes[1].end();
  assert.deepEqual(active, [true, false]);
});

test('interrupt stops scheduled audio, aborts upstream and rejects late old-turn frames', async () => {
  const { queue, context, active } = fixture();
  await queue.unlock();
  const old = queue.beginTurn();
  queue.enqueuePcm16(old.id, 0, new Uint8Array(1600), 8000);
  const current = queue.beginTurn();
  assert.equal(old.signal.aborted, true);
  assert.equal(context.nodes[0].stopped, true);
  assert.equal(queue.enqueuePcm16(old.id, 1, new Uint8Array(1600), 8000), false);
  queue.finishTurn(old.id);
  queue.enqueuePcm16(current.id, 0, new Uint8Array(1600), 8000);
  assert.deepEqual(active, [true, false, true]);
  await queue.dispose();
  assert.equal(current.signal.aborted, true);
  assert.equal(queue.enqueuePcm16(current.id, 1, new Uint8Array(1600), 8000), false);
});

test('PCM sample can span two network frames without losing bytes', async () => {
  const { queue, context } = fixture();
  await queue.unlock();
  const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array([0]), 8000);
  assert.equal(context.nodes.length, 0);
  queue.enqueuePcm16(turn.id, 1, new Uint8Array([128, 255, 127]), 8000);
  assert.deepEqual(Array.from(context.nodes[0].buffer!.values), [-1, 32767 / 32768]);
  queue.finishTurn(turn.id);
});

test('buffer exhaustion, duplicate frames and malformed tail fail explicitly', async () => {
  const { queue, context, underruns, active } = fixture({ maxBufferedSeconds: 1 });
  await queue.unlock();
  const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array(8000), 8000);
  assert.throws(() => queue.enqueuePcm16(turn.id, 1, new Uint8Array(16000), 8000), /缓冲已满/);
  assert.throws(() => queue.enqueuePcm16(turn.id, 0, new Uint8Array(2), 8000), /乱序/);
  context.currentTime = 0.58;
  context.nodes[0].end();
  assert.equal(underruns(), 1);
  assert.deepEqual(active, [true]); // 尚未结束 TTS，空档不能开放 ASR。
  queue.enqueuePcm16(turn.id, 1, new Uint8Array([0]), 8000);
  assert.throws(() => queue.finishTurn(turn.id), /半个样本/);
  assert.equal(turn.signal.aborted, true);
  assert.deepEqual(active, [true, false]);
});

test('audio requires an explicit user gesture unlock', () => {
  const { queue } = fixture();
  const turn = queue.beginTurn();
  assert.throws(() => queue.enqueuePcm16(turn.id, 0, new Uint8Array(2), 8000), /尚未解锁/);
});

test('MP3 sentences decode and schedule contiguously while preserving microphone gating', async () => {
  const {queue, context, active} = fixture();
  await queue.unlock(); const turn = queue.beginTurn();
  await queue.enqueueMp3(turn.id, 0, new Uint8Array([1]));
  await queue.enqueueMp3(turn.id, 1, new Uint8Array([2]));
  assert.equal(context.nodes[1].at, context.nodes[0].at + context.nodes[0].buffer!.duration);
  queue.finishTurn(turn.id); assert.deepEqual(active, [true]);
  context.nodes[0].end(); context.nodes[1].end(); assert.deepEqual(active, [true, false]);
});

test('interrupt during MP3 decode discards the decoded old-turn buffer', async () => {
  const {queue, context} = fixture();
  await queue.unlock(); const turn = queue.beginTurn();
  const decoding = queue.enqueueMp3(turn.id, 0, new Uint8Array([1]));
  queue.interrupt();
  assert.equal(await decoding, false); assert.equal(context.nodes.length, 0);
});

test('MP3 waits for bounded playback capacity instead of failing when synthesis gets ahead', async () => {
  const { queue, context } = fixture({ maxBufferedSeconds: 1 });
  await queue.unlock(); const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array(14400), 8000);
  let completed = false;
  const pending = queue.enqueueMp3(turn.id, 0, new Uint8Array([1])).then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(completed, false); assert.equal(context.nodes.length, 1);
  context.currentTime = 0.2;
  assert.equal(await pending, true);
  assert.ok(queue.bufferedSeconds <= 1);
  assert.equal(context.nodes[1].at, context.nodes[0].at + context.nodes[0].buffer!.duration);
  queue.interrupt();
});

test('interrupt releases capacity wait immediately and no old audio enters a new turn', async () => {
  const { queue, context } = fixture({ maxBufferedSeconds: 1 });
  await queue.unlock(); const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array(14400), 8000);
  const pending = queue.enqueueMp3(turn.id, 0, new Uint8Array([1]));
  await new Promise(resolve => setTimeout(resolve, 10));
  queue.beginTurn();
  assert.equal(await pending, false); assert.equal(context.nodes.length, 1);
  queue.interrupt();
});

test('long MP3 sentence is locally chunked with continuous scheduling and bounded buffer', async () => {
  const { queue, context, active } = fixture({ maxBufferedSeconds: 1 });
  context.decodedFrames = 24000; // 3秒长句，超过1秒调度上限。
  await queue.unlock(); const turn = queue.beginTurn();
  const timer = setInterval(() => {
    assert.ok(queue.bufferedSeconds <= 1.00001);
    context.currentTime += 0.05;
    for (const node of context.nodes) if (node.at + node.buffer!.duration <= context.currentTime) node.end();
  }, 10);
  try {
    assert.equal(await queue.enqueueMp3(turn.id, 0, new Uint8Array([1])), true);
    assert.equal(context.nodes.length, 6);
    for (let i = 1; i < context.nodes.length; i++) assert.ok(Math.abs(context.nodes[i].at - context.nodes[i-1].at - 0.5) < 0.00001);
    assert.deepEqual(active, [true]);
    context.decodedFrames = 800;
    assert.equal(await queue.enqueueMp3(turn.id, 1, new Uint8Array([2])), true);
    await assert.rejects(queue.enqueueMp3(turn.id, 1, new Uint8Array([2])), /乱序/);
  } finally { clearInterval(timer); queue.interrupt(); }
});

test('paused playback fails explicitly rather than leaving a buffer waiter hanging', async () => {
  const { queue, context } = fixture({ maxBufferedSeconds: 1 });
  await queue.unlock(); const turn = queue.beginTurn();
  queue.enqueuePcm16(turn.id, 0, new Uint8Array(14400), 8000);
  const pending = queue.enqueueMp3(turn.id, 0, new Uint8Array([1]));
  await new Promise(resolve => setTimeout(resolve, 10)); context.state = 'suspended';
  await assert.rejects(pending, /已暂停/); queue.interrupt();
});
