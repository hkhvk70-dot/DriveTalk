import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSpeechEngine, SpeechInput, beginSpeechSession, endSpeechSession } from '../src/services/voice/speech_input.ts';

function fixture() {
  const events = new EventTarget(), calls: {action:string;id:string}[] = [];
  const engine = new NativeSpeechEngine({version:1,available:true,request:(action,id)=>{calls.push({action,id});return true;}},events);
  const texts:string[] = [], errors:string[] = [];
  const input = new SpeechInput(()=>engine,text=>texts.push(text),()=>{},error=>errors.push(error));
  const emit = (detail:object) => {const event = new Event('drivetalk-native-speech');Object.assign(event,{detail});events.dispatchEvent(event);};
  return {input,calls,texts,errors,emit};
}

test('native final text fills input once, cancels capture, never sends a command',()=>{
  const f=fixture(); f.input.start(); const id=f.calls[0].id;
  f.emit({id:'other',type:'result',text:'ignored'});assert.deepEqual(f.texts,[]);
  f.emit({id,type:'result',text:' 你好 '});
  f.emit({id,type:'result',text:'late'});
  assert.deepEqual(f.texts,['你好']);assert.equal(f.calls.at(-1)?.action,'cancel');
});
test('interruption ignores native results; permission errors give specific advice',()=>{
  const f=fixture();f.input.start();const old=f.calls[0].id;f.input.abort();
  f.emit({id:old,type:'result',text:'late'});assert.deepEqual(f.texts,[]);
  f.input.start();f.emit({id:f.calls.at(-1)!.id,type:'error',error:'not-allowed'});
  assert.match(f.errors[0],/麦克风权限/);assert.equal(f.calls.at(-1)?.action,'cancel');
});
test('native v2 explicitly begins a session, continues with fresh ids, and ends permission on stop',()=>{
  const calls:string[] = [];
  const bridge = {version:2,available:true,request:(action:string,_id:string)=>{calls.push(action);return true;}};
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__DriveTalkNativeSpeech:bridge}});
  try {
    assert.equal(beginSpeechSession(),true);
    const engine = new NativeSpeechEngine(bridge,new EventTarget());
    engine.start(); engine.abort(); engine.start(); engine.abort(); endSpeechSession();
    engine.start(); engine.abort();
    assert.deepEqual(calls,['begin','continue','cancel','continue','cancel','end','start','cancel']);
  } finally {if(previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window');}
});
test('old APK cannot silently opt into continuous listening',()=>{
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__DriveTalkNativeSpeech:{version:1,available:true}}});
  try {assert.equal(beginSpeechSession(),false);}
  finally {if(previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window');}
});
