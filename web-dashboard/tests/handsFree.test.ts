import test from 'node:test';
import assert from 'node:assert/strict';
import { canResumeCapture, speechRecovery, CaptureStartup } from '../src/services/voice/hands_free.ts';
const idle = {enabled:true,listening:false,sending:false,speaking:false,synthesizing:false,busy:false,hidden:false};
test('capture never resumes during synthesis, playback, requests, busy work or background',()=>{
  assert.ok(canResumeCapture(idle));
  assert.equal(canResumeCapture({...idle,enabled:false}),false);
  for(const name of ['listening','sending','speaking','synthesizing','busy','hidden','preparing']) assert.equal(canResumeCapture({...idle,[name]:true}),false);
});
test('network failure stops immediately; only quiet periods and bounded busy errors resume',()=>{
  for(const code of ['network','not-allowed','unavailable',undefined,'bad-input']) assert.equal(speechRecovery(code,0).retry,false);
  assert.equal(speechRecovery('no-speech',0).delay,1500);
  assert.equal(speechRecovery('busy',0).delay,3000);
  assert.equal(speechRecovery('busy',1).delay,6000);
  assert.equal(speechRecovery('busy',2).retry,false);
});

function deferred() {let resolve!:()=>void; let reject!:(error:Error)=>void;
  const promise = new Promise<void>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject};}
test('slow audio preparation cannot start a competing capture or duplicate button request',async()=>{
  const gate=new CaptureStartup(), audio=deferred(); let captures=0;
  const first=gate.start(()=>audio.promise,()=>true,()=>captures++);
  assert.ok(gate.preparing);
  assert.equal(canResumeCapture({...idle,preparing:gate.preparing}),false);
  assert.equal(await gate.start(async()=>{},()=>true,()=>captures++),false);
  assert.equal(captures,0);
  audio.resolve(); assert.equal(await first,true); assert.equal(captures,1); assert.equal(gate.preparing,false);
});
test('stop/background cancellation invalidates pending capture even after a new session starts',async()=>{
  const gate=new CaptureStartup(), old=deferred(), latest=deferred(); let captures=0;
  const first=gate.start(()=>old.promise,()=>true,()=>captures++); gate.cancel();
  const second=gate.start(()=>latest.promise,()=>true,()=>captures++);
  old.resolve(); assert.equal(await first,false); assert.ok(gate.preparing); assert.equal(captures,0);
  latest.resolve(); assert.equal(await second,true); assert.equal(captures,1);
});
test('delayed preparation rechecks current playback/request/visibility state before capture',async()=>{
  for(const field of ['hidden','speaking','sending','busy','synthesizing','listening']) {
    const gate=new CaptureStartup(), audio=deferred(), state={...idle}; let captures=0;
    const attempt=gate.start(()=>audio.promise,()=>canResumeCapture(state),()=>captures++);
    Object.assign(state,{[field]:true}); audio.resolve();
    assert.equal(await attempt,false); assert.equal(captures,0); assert.equal(gate.preparing,false);
  }
});
test('stale audio preparation rejection does not stop a newer session',async()=>{
  const gate=new CaptureStartup(), old=deferred(), latest=deferred();
  const first=gate.start(()=>old.promise,()=>true,()=>{}); gate.cancel();
  const second=gate.start(()=>latest.promise,()=>true,()=>{});
  old.reject(new Error('old audio failure')); assert.equal(await first,false); assert.ok(gate.preparing);
  latest.resolve(); assert.equal(await second,true);
});
test('current audio preparation failure releases its single-flight guard',async()=>{
  const gate=new CaptureStartup(); let captures=0;
  await assert.rejects(gate.start(async()=>{throw new Error('audio');},()=>true,()=>captures++),/audio/);
  assert.equal(gate.preparing,false); assert.equal(captures,0);
});
