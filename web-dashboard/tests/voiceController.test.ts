import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePipeline } from '../src/services/voice/voice_pipeline.ts';
import type { AudioQueue } from '../src/services/voice/audio_queue.ts';

class Queue {
  controller = new AbortController(); frames: number[] = []; finished = false;
  async unlock() {}
  beginTurn() {this.controller = new AbortController(); return {id:1,signal:this.controller.signal};}
  interrupt() {this.controller.abort();}
  enqueuePcm16(_id: number, sequence: number) {this.frames.push(sequence); return true;}
  async enqueueMp3(_id: number, sequence: number) {this.frames.push(sequence); return true;}
  finishTurn() {this.finished = true;}
}
class Socket {
  readyState = 1; bufferedAmount = 0; closed = false; binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event:{data:unknown}) => void) | null = null;
  onerror = null; onclose = null;
  sent: Record<string,unknown>[] = [];
  send(raw: string) {this.sent.push(JSON.parse(raw));}
  close() {this.closed = true;}
  ready() {
    this.onopen?.();
    this.onmessage?.({data:JSON.stringify({event:'ready',turnId:this.sent[0].turnId,format:'pcm_s16le',sampleRate:24000})});
  }
}
async function prepare() {
  const queue = new Queue(), socket = new Socket();
  const pipeline = new VoicePipeline(queue as unknown as AudioQueue);
  const pending = pipeline.start({location:{href:'https://console.example.invalid/dashboard/'},socketFactory:()=>socket as unknown as WebSocket});
  await Promise.resolve(); return {queue,socket,pipeline,pending};
}
test('punctuated delta sends TTS before text_done and PCM arrives before input ends', async () => {
  const s = await prepare(); s.socket.ready(); await s.pending;
  s.pipeline.accept({type:'text_delta',turnId:'t',sequence:0,message:'你好。还有'});
  assert.deepEqual(s.socket.sent.map(v=>v.event),['start','text']);
  s.socket.onmessage?.({data:new Uint8Array([0,0]).buffer}); assert.deepEqual(s.queue.frames,[0]);
  s.pipeline.accept({type:'text_done',turnId:'t'});
  assert.deepEqual(s.socket.sent.map(v=>v.event),['start','text','text','stop']);
  assert.equal(s.queue.finished,false);
  s.socket.onmessage?.({data:JSON.stringify({event:'finish',turnId:s.socket.sent[0].turnId,reason:'stop'})});
  await Promise.resolve(); await Promise.resolve(); assert.equal(s.queue.finished,true);
  s.pipeline.interrupt();
});
test('interrupt just after ready cannot resurrect the old session', async () => {
  const s = await prepare(); s.socket.ready(); s.pipeline.interrupt();
  await assert.rejects(s.pending,{name:'AbortError'});
  s.pipeline.accept({type:'text',message:'迟到文本。'});
  assert.equal(s.socket.sent.length,1); assert.ok(s.socket.closed);
});
test('socket creation failure cleans up the audio turn', async () => {
  const queue = new Queue(), pipeline = new VoicePipeline(queue as unknown as AudioQueue);
  await assert.rejects(pipeline.start({location:{href:'https://console.example.invalid/'},socketFactory:()=>{throw new Error('mock failure');}}));
  assert.ok(queue.controller.signal.aborted);
});

test('MP3 decoding is ordered and finish waits for pending decode', async () => {
  const s = await prepare();
  s.socket.onopen?.();
  s.socket.onmessage?.({data:JSON.stringify({event:'ready',turnId:s.socket.sent[0].turnId,format:'mp3'})});
  await s.pending;
  s.pipeline.accept({type:'text_delta',turnId:'t',sequence:0,message:'你好。'});
  s.socket.onmessage?.({data:new Uint8Array([1]).buffer});
  s.socket.onmessage?.({data:new Uint8Array([2]).buffer});
  s.pipeline.finish();
  s.socket.onmessage?.({data:JSON.stringify({event:'finish',turnId:s.socket.sent[0].turnId,reason:'stop'})});
  assert.equal(s.queue.finished,false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.queue.frames,[0,1]); assert.equal(s.queue.finished,true);
  s.pipeline.interrupt();
});
test('continuous coordinator remains gated while waiting for synthesis, before first audio arrives', async () => {
  const queue = new Queue(), socket = new Socket(), state:boolean[] = [];
  const pipeline = new VoicePipeline(queue as unknown as AudioQueue,()=>{},active=>state.push(active));
  await pipeline.prepareAudio(); assert.deepEqual(state,[]); // 解锁不创建付费合成请求。
  const pending = pipeline.start({location:{href:'https://console.example.invalid/dashboard/'},socketFactory:()=>socket as unknown as WebSocket});
  await Promise.resolve(); assert.equal(state.at(-1),true);
  socket.ready(); await pending;
  pipeline.accept({type:'text_delta',turnId:'t',sequence:0,message:'你好。'});
  pipeline.finish(); assert.equal(state.at(-1),true);
  socket.onmessage?.({data:JSON.stringify({event:'finish',turnId:socket.sent[0].turnId,reason:'stop'})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.at(-1),false); assert.ok(queue.finished);
  pipeline.interrupt();
});
