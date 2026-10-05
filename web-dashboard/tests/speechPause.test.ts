import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpeechInput, NativeSpeechEngine, speechTimingHint, beginSpeechSession, endSpeechSession,
  SPEECH_CAPTURE_LIMIT_MS, SPEECH_TEXT_LIMIT, type SpeechEngine } from '../src/services/voice/speech_input.ts';
import { speechRecovery } from '../src/services/voice/hands_free.ts';

class Engine implements SpeechEngine {
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: SpeechEngine['onresult'] = null;
  onerror: SpeechEngine['onerror'] = null;
  onend: SpeechEngine['onend'] = null;
  aborts = 0; stops = 0;
  start() {}
  abort() {this.aborts++;}
  stop() {this.stops++;}
  result(text: string, isFinal: boolean) {
    this.onresult?.({resultIndex:0, results:[{isFinal,0:{transcript:text}}]});
  }
}
function setup(engine: SpeechEngine = new Engine()) {
  const texts: string[] = [], previews: string[] = [], errors: {text:string;code?:string}[] = [], active: boolean[] = [];
  const input = new SpeechInput(()=>engine, text=>texts.push(text), value=>active.push(value),
    (text,code)=>errors.push({text,code}), text=>previews.push(text));
  input.start();
  return {engine:engine as Engine, input, texts, previews, errors, active};
}

test('partial hypotheses replace the preview and never trigger automatic sending', () => {
  const s = setup();
  try {
    assert.equal(s.engine.interimResults,true);
    s.engine.result('先打开',false); s.engine.result('先不要打开后备箱',false);
    assert.equal(s.previews.at(-1),'先不要打开后备箱'); assert.deepEqual(s.texts,[]);
    s.engine.result('先不要打开后备箱。',true);
    assert.deepEqual(s.texts,['先不要打开后备箱。']);
  } finally {s.input.abort();}
});

test('twenty seconds no longer silently cancels a long utterance', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const s = setup(); s.engine.result('长句的第一部分',false);
  t.mock.timers.tick(20000);
  assert.equal(s.active.at(-1),true); assert.equal(s.engine.aborts,0);
  s.engine.result('长句的第一部分和第二部分。',true);
  assert.deepEqual(s.texts,['长句的第一部分和第二部分。']);
});

test('capture watchdog stops gracefully; timeout final result is draft only', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const s = setup(); s.engine.result('打开后',false);
  t.mock.timers.tick(SPEECH_CAPTURE_LIMIT_MS);
  assert.equal(s.engine.stops,1); assert.equal(s.engine.aborts,0);
  s.engine.result('打开后备箱',true);
  assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'打开后备箱');
  assert.equal(s.errors.at(-1)?.code,'draft'); assert.match(s.errors.at(-1)!.text,/未自动发送/);
});

test('manual stop waits for final text and preserves it without automatically executing it', () => {
  const s = setup(); s.engine.result('部分文字',false);
  s.input.stop(); s.input.stop();
  assert.equal(s.engine.stops,1); assert.equal(s.engine.aborts,0);
  s.engine.result('部分文字加上结尾',true);
  assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'部分文字加上结尾');
  assert.equal(s.active.at(-1),false);
});

test('final-result grace timeout retains preview and ignores late callbacks', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const s = setup(); s.engine.result('未完成草稿',false);
  const late = s.engine.onresult!;
  s.input.stop(); t.mock.timers.tick(6000);
  late({resultIndex:0,results:[{isFinal:true,0:{transcript:'迟到的控车指令'}}]});
  assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'未完成草稿');
  assert.equal(s.errors.length,1);
});

test('network errors or end-without-result retain draft and stop hands-free recovery', () => {
  for (const event of ['network','end']) {
    const s = setup(); s.engine.result('尚未说完',false);
    if (event==='end') s.engine.onend?.(); else s.engine.onerror?.({error:event});
    assert.equal(s.previews.at(-1),'尚未说完'); assert.deepEqual(s.texts,[]);
    assert.equal(s.errors.at(-1)?.code,'draft');
    assert.equal(speechRecovery(s.errors.at(-1)?.code,0).retry,false);
  }
});

test('a long recognized reply is retained; oversized recognition preserves last safe preview', () => {
  const s = setup(), long = '字'.repeat(2100);
  s.engine.result(long,true); assert.deepEqual(s.texts,[long]);
  const tooLong = setup(); tooLong.engine.result('已有草稿',false);
  tooLong.engine.result('字'.repeat(SPEECH_TEXT_LIMIT+1),true);
  assert.deepEqual(tooLong.texts,[]); assert.equal(tooLong.previews.at(-1),'已有草稿');
  assert.match(tooLong.errors.at(-1)!.text,/过长/);
});

test('native v3 partial/draft events keep text but never send timeout drafts or stale results', () => {
  const events = new EventTarget(), calls: {action:string;id:string}[] = [];
  const bridge = {version:3,available:true,request:(action:string,id:string)=>{calls.push({action,id});return true;}};
  const engine = new NativeSpeechEngine(bridge,events), s = setup(engine), id = calls[0].id;
  const emit = (detail:object) => events.dispatchEvent(Object.assign(new Event('drivetalk-native-speech'),{detail}));
  emit({id:'wrong',type:'partial',text:'不能显示'}); assert.deepEqual(s.previews,[]);
  emit({id,type:'partial',text:'说到一半'});
  emit({id,type:'draft',text:'说到一半更完整',reason:'timeout'});
  emit({id,type:'result',text:'迟到指令'});
  assert.deepEqual(s.texts,[]); assert.equal(s.previews.at(-1),'说到一半更完整');
  assert.equal(s.errors.at(-1)?.code,'draft'); assert.equal(calls.at(-1)?.action,'cancel');
});

test('native v3 session uses continue, supports graceful stop and revokes on end', () => {
  const calls:string[] = [], bridge = {version:3,available:true,request:(action:string)=>{calls.push(action);return true;}};
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__DriveTalkNativeSpeech:bridge}});
  try {
    assert.equal(beginSpeechSession(),true);
    const engine = new NativeSpeechEngine(bridge,new EventTarget());
    engine.start(); engine.stop(); engine.abort(); endSpeechSession();
    assert.deepEqual(calls,['begin','continue','stop','cancel','end']);
  } finally {if(previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window');}
});

test('timing hint distinguishes requested native policy from old APK and browser behavior', () => {
  const bridge = {version:3,available:true,request:()=>true};
  assert.match(speechTimingHint({__DriveTalkNativeSpeech:bridge}),/2\.5秒/);
  assert.match(speechTimingHint({__DriveTalkNativeSpeech:{...bridge,silenceMs:2000}}),/后2秒/);
  assert.match(speechTimingHint({__DriveTalkNativeSpeech:{...bridge,version:2}}),/20秒/);
  assert.match(speechTimingHint({}),/浏览器决定/);
});

test('Android source requests both silence intervals at 2000 ms and waits for final results', () => {
  // 配置回归，不是手机ASR效果测试：厂商可以忽略这两个Intent参数。
  const source = readFileSync(new URL('../../mobile/src/main/java/org/drivetalk/app/NativeSpeech.java',import.meta.url),'utf8');
  assert.match(source,/SILENCE_MILLIS = 2000/);
  assert.match(source,/silenceMs:/);
  assert.match(source,/EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MILLIS/);
  assert.match(source,/EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MILLIS/);
  assert.match(source,/EXTRA_PARTIAL_RESULTS, true/);
  assert.match(source,/CAPTURE_LIMIT_MILLIS = 120000/);
  assert.match(source,/recognizer\.stopListening\(\)/);
  assert.match(source,/navigator.userActivation/);
  assert.match(source,/Lifecycle.State.RESUMED/);
});

test('repeated start does not cancel microphone or discard partial text', () => {
  let creations=0;
  const engine=new Engine(), previews:string[]=[], texts:string[]=[];
  const input=new SpeechInput(()=>{creations++;return engine;},text=>texts.push(text),()=>{},()=>{},text=>previews.push(text));
  try {
    input.start(); engine.result('尚未说完',false); input.start(); input.start();
    assert.equal(creations,1); assert.equal(engine.aborts,0); assert.ok(input.isActive);
    engine.result('尚未说完的完整句。',true);
    assert.deepEqual(texts,['尚未说完的完整句。']); assert.equal(input.isActive,false);
  } finally {input.abort();}
});
test('native repeated start issues exactly one request and keeps the active request ID',()=>{
  const events=new EventTarget(), calls:{action:string;id:string}[]=[];
  const engine=new NativeSpeechEngine({version:3,available:true,request:(action,id)=>{calls.push({action,id});return true;}},events);
  const texts:string[]=[]; engine.onresult=event=>texts.push(event.results[0][0].transcript);
  try {
    engine.start();engine.start(); assert.equal(calls.length,1);
    events.dispatchEvent(Object.assign(new Event('drivetalk-native-speech'),{detail:{id:calls[0].id,type:'partial',text:'同一会话'}}));
    assert.deepEqual(texts,['同一会话']);
  } finally {engine.abort();}
});
test('no-text network failure leaves no capture timer, stops auto recovery and ignores stale result',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const s=setup(), late=s.engine.onresult!;
  s.engine.onerror?.({error:'network'});
  assert.equal(s.input.isActive,false); assert.equal(speechRecovery(s.errors[0].code,0).retry,false);
  assert.match(s.errors[0].text,/不再自动重启/);
  t.mock.timers.tick(SPEECH_CAPTURE_LIMIT_MS+10000);
  late({resultIndex:0,results:[{isFinal:true,0:{transcript:'不能执行'}}]});
  assert.equal(s.errors.length,1); assert.deepEqual(s.texts,[]); assert.equal(s.engine.stops,0);
});
test('page guards audio preparation and rechecks live capture state when resume timer fires',()=>{
  const source=readFileSync(new URL('../src/pages/GrokPage.tsx',import.meta.url),'utf8');
  assert.match(source,/captureStartup.current.start/);
  assert.match(source,/captureStartup.current.cancel\(\)/);
  assert.match(source,/!captureStartup.current.preparing && mayStartCapture\(\)/);
  assert.match(source,/speech.current\?\.isActive/);
  assert.match(source,/captureState.current.speaking = value/);
  assert.match(source,/preparing:preparingSpeech/);
});

test('page preview is display-only, retains overlength speech and blocks sending during capture', () => {
  const source = readFileSync(new URL('../src/pages/GrokPage.tsx',import.meta.url),'utf8');
  assert.match(source,/text => \{if \(active\) setMessage\(text\);\}/);
  assert.match(source,/raw.length > 1850\) \{setMessage\(raw\)/);
  assert.match(source,/recognized === undefined && listening/);
  assert.match(source,/busy \|\| listening \|\| message.length > 1850/);
  assert.match(source,/if \(listening\) speech.current\?\.stop\(\)/);
});
