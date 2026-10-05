import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AliyunSpeechEngine } from '../src/services/voice/aliyun_speech.ts';
import { SpeechInput } from '../src/services/voice/speech_input.ts';
import { asrConfig } from '../src/services/voice/asr_config.ts';

class Socket {
  onopen?: () => void; onmessage?: (e:{data:string}) => void; onerror?: () => void; onclose?: () => void;
  readyState=1; bufferedAmount=0; sent: unknown[]=[]; closed=false;
  send(v:unknown) {this.sent.push(v);}
  close() {this.closed=true;}
  event(v:unknown) {this.onmessage?.({data:JSON.stringify(v)});}
}
async function setup(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{protocol:'https:',host:'unit.example'}}});
  t.after(()=>{if (previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window');});
  const socket = new Socket(); let callbacks: any; let captureStarted=0, aborts=0;
  const engine = new AliyunSpeechEngine(()=>false, url=>{assert.equal(url,'wss://unit.example/v1/vehicle/ai/asr/live'); return socket as unknown as WebSocket;}, (_id,cb)=>{
    callbacks=cb; return {prepare:()=>Promise.resolve(),start:()=>{captureStarted++; cb.ready();},stop:()=>cb.ended('stopped'),abort:()=>{aborts++;},heard:()=>{}};
  });
  const texts:string[]=[], previews:string[]=[], errors:string[]=[], statuses:string[]=[];
  const input = new SpeechInput(()=>engine,text=>texts.push(text),()=>{},(_message,code)=>errors.push(code ?? ''),text=>previews.push(text),status=>statuses.push(status));
  input.start(); await Promise.resolve(); socket.onopen?.();
  const id=JSON.parse(socket.sent[0] as string).turnId;
  return {socket,input,texts,previews,errors,statuses,id,callbacks,started:()=>captureStarted,aborts:()=>aborts};
}

test('cloud ASR waits for task-started before capture; sentences never auto-send before stop', async t=>{
  const s=await setup(t);
  try {
    assert.equal(s.started(),0); s.socket.event({event:'ready',turnId:s.id}); assert.equal(s.started(),1);
    s.callbacks.pcm(new Uint8Array(3200)); assert.ok(s.socket.sent[1] instanceof Uint8Array);
    s.socket.event({event:'partial',turnId:s.id,text:'打开'}); s.socket.event({event:'partial',turnId:s.id,text:'不要打开后备箱。'});
    assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'不要打开后备箱。');
    s.callbacks.ended('complete'); s.socket.event({event:'finish',turnId:s.id,text:'不要打开后备箱。',reason:'complete'});
    assert.deepEqual(s.texts,['不要打开后备箱。']); assert.ok(s.socket.closed);
  } finally {s.input.abort();}
});
test('disconnect retains partial draft and does not reconnect or send', async t=>{
  const s=await setup(t);
  s.socket.event({event:'ready',turnId:s.id}); s.socket.event({event:'partial',turnId:s.id,text:'打开后'});
  s.socket.onclose?.(); assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'打开后'); assert.deepEqual(s.errors,['draft']);
  assert.ok(s.aborts()>0);
});
test('manual stop only returns a draft even when server has final text', async t=>{
  const s=await setup(t);
  s.socket.event({event:'ready',turnId:s.id}); s.input.stop();
  s.socket.event({event:'finish',turnId:s.id,text:'打开后备箱',reason:'stopped'});
  assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'打开后备箱'); assert.deepEqual(s.errors,['draft']);
});
test('unsolicited finish or wrong turn cannot send text', async t=>{
  const s=await setup(t); s.socket.event({event:'ready',turnId:s.id});
  s.socket.event({event:'finish',turnId:s.id,text:'开锁',reason:'complete'});
  assert.deepEqual(s.texts,[]); assert.deepEqual(s.errors,['asr-protocol']);
});
test('upload congestion fails closed rather than dropping audio or re-sending', async t=>{
  const s=await setup(t); s.socket.event({event:'ready',turnId:s.id});
  s.socket.bufferedAmount=64001; s.callbacks.pcm(new Uint8Array(3200));
  assert.deepEqual(s.errors,['asr-backpressure']); assert.equal(s.socket.sent.length,1);
});
test('failed provider exposes safe error code and never automatic fallback', async t=>{
  const s=await setup(t); s.socket.event({event:'error',code:'asr-provider'});
  assert.deepEqual(s.errors,['asr-provider']); assert.equal(s.started(),0);
});
test('final text is not accepted until capture ended normally', async t=>{
  const s=await setup(t); s.socket.event({event:'ready',turnId:s.id}); s.callbacks.ended('timeout');
  s.socket.event({event:'finish',turnId:s.id,text:'空调调到21度',reason:'timeout'});
  assert.deepEqual(s.texts,[]); assert.deepEqual(s.errors,['draft']);
});
test('recognition config never returns or stores a provider secret', async()=>{
  const calls:RequestInit[]=[];
  const fetcher=(async(_url, init)=>{calls.push(init!); return new Response(JSON.stringify({configured:true,enabled:true,workspaceId:'123',model:'fun-asr-realtime',region:'cn-beijing'}));}) as typeof fetch;
  const config=await asrConfig({apiKey:'test-only-not-real',workspaceId:'123',enabled:true},fetcher);
  assert.equal(config.enabled,true); assert.equal(calls[0].method,'POST'); assert.equal(calls[0].credentials,'same-origin');
  assert.ok(!('apiKey' in config)); assert.equal(calls.length,1);
  await assert.rejects(asrConfig(undefined,(async()=>new Response(JSON.stringify({...config,apiKey:'should-not-echo'}))) as typeof fetch));
});
test('connection watchdog stops without capturing or retrying', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const s=await setup(t); t.mock.timers.tick(18000);
  assert.deepEqual(s.errors,['asr-timeout']); assert.equal(s.started(),0); assert.ok(s.socket.closed);
});
test('late final callback after interruption cannot send a command', async t=>{
  const s=await setup(t); s.socket.event({event:'ready',turnId:s.id});
  const late=s.socket.onmessage!; s.input.abort();
  late({data:JSON.stringify({event:'finish',turnId:s.id,text:'打开后备箱',reason:'complete'})});
  assert.deepEqual(s.texts,[]); assert.deepEqual(s.errors,[]);
});
test('native v4 streams bounded PCM only after upstream ready, then releases capture', async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const surface=new EventTarget() as EventTarget & {location:object;__DriveTalkNativeSpeech:object};
  const calls:string[]=[]; let id='';
  surface.location={protocol:'https:',host:'unit.example'};
  surface.__DriveTalkNativeSpeech={version:4,cloudPcm:true,available:true,request:(action:string,value:string)=>{calls.push(action); id=value; return true;}};
  Object.defineProperty(globalThis,'window',{configurable:true,value:surface});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window');});
  const socket=new Socket(); const engine=new AliyunSpeechEngine(()=>true,()=>socket as unknown as WebSocket);
  const events=(type:string,text='',reason?:string)=>surface.dispatchEvent(new CustomEvent('drivetalk-native-speech',{detail:{id,type,text,reason}}));
  engine.start(); assert.deepEqual(calls,['cloud-continue']); assert.equal(socket.sent.length,0);
  events('prepared'); await Promise.resolve(); socket.onopen?.();
  socket.event({event:'ready',turnId:id}); assert.ok(calls.includes('cloud-record'));
  events('pcm',btoa('\0\0'.repeat(1600))); assert.ok(socket.sent[1] instanceof Uint8Array);
  events('capture-end','','complete'); assert.equal(JSON.parse(socket.sent[2] as string).reason,'complete');
  engine.abort(); assert.equal(calls.at(-1),'cancel'); assert.ok(socket.closed);
});
