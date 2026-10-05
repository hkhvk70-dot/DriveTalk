import test from 'node:test';
import assert from 'node:assert/strict';
import { FishAudioWs } from '../src/services/voice/fish_audio_ws.ts';

const turnId = '11111111-1111-4111-8111-111111111111';
class Socket {
  readyState = 1; bufferedAmount = 0; binaryType = ''; closed = false;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: unknown}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  message(value: unknown) { this.onmessage?.({data: value instanceof ArrayBuffer ? value : JSON.stringify(value)}); }
}
function setup() {
  const socket = new Socket(), abort = new AbortController();
  const audio: number[] = []; let url = '', calls = 0;
  const pending = FishAudioWs.connect({turnId, signal: abort.signal,
    location: {href: 'https://console.example.invalid/dashboard/'},
    onAudio: (bytes, seq, rate) => { assert.equal(rate, 24000); audio.push(seq, bytes.length); },
    socketFactory: value => { url = value; calls++; return socket as unknown as WebSocket; }});
  socket.onopen?.();
  return {socket, abort, audio, pending, url, calls};
}
test('PCM arrives before text ends; one authenticated same-origin relay connection', async () => {
  const s = setup();
  assert.equal(s.url, 'wss://console.example.invalid/v1/vehicle/ai/voice/live');
  assert.equal(s.socket.binaryType, 'arraybuffer');
  s.socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:24000});
  const client = await s.pending;
  client.sendSentence('你好。');
  s.socket.message(new Uint8Array([0,0,1,0]).buffer);
  assert.deepEqual(s.audio, [0,4]);
  client.sendSentence('第二句。'); client.finishText();
  assert.deepEqual(s.socket.sent.map(v => v.event), ['start','text','text','stop']);
  assert.equal(s.socket.sent[3].sequences, 2);
  s.socket.message({event:'finish',turnId,reason:'stop'});
  await client.completed; assert.equal(s.socket.closed, true); assert.equal(s.calls, 1);
});
test('abort closes connection and discards late PCM', async () => {
  const s = setup();
  s.socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:24000});
  const client = await s.pending;
  s.abort.abort(); await assert.rejects(client.completed, {name:'AbortError'});
  s.socket.message(new Uint8Array([0,0]).buffer);
  assert.deepEqual(s.audio, []); assert.ok(s.socket.closed);
});
test('unexpected finish rejects rather than pretending synthesis succeeded', async () => {
  const s = setup();
  s.socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:24000});
  const client = await s.pending;
  s.socket.message({event:'finish',turnId,reason:'stop'});
  await assert.rejects(client.completed); assert.ok(s.socket.closed);
});
test('bounded send buffer fails without reconnect or resend', async () => {
  const s = setup();
  s.socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:24000});
  const client = await s.pending; s.socket.bufferedAmount = 40000;
  assert.throws(() => client.sendSentence('你好。'));
  await assert.rejects(client.completed); assert.equal(s.calls,1);
  assert.equal(s.socket.sent.length,1);
});
test('plain HTTP is rejected before opening a socket', async () => {
  await assert.rejects(FishAudioWs.connect({turnId,signal:new AbortController().signal,
    location:{href:'http://console.example.invalid/'},onAudio:()=>{},socketFactory:()=>{throw new Error('must not open');}}), /HTTPS/);
});

test('actual server PCM sample rate is passed to the queue', async () => {
  const socket = new Socket(); let rate = 0;
  const pending = FishAudioWs.connect({turnId,signal:new AbortController().signal,
    location:{href:'https://console.example.invalid/'},socketFactory:()=>socket as unknown as WebSocket,
    onAudio:(_bytes,_seq,sampleRate)=>{rate=sampleRate;}});
  socket.onopen?.();
  socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:44100});
  const client = await pending;
  socket.message(new Uint8Array([0,0]).buffer);
  assert.equal(rate,44100); client.cancel();
  await assert.rejects(client.completed,{name:'AbortError'});
});
test('unsupported PCM sample rate fails before any audio playback', async () => {
  const s = setup();
  s.socket.message({event:'ready',turnId,format:'pcm_s16le',sampleRate:0});
  await assert.rejects(s.pending);
  assert.deepEqual(s.audio,[]);
});
