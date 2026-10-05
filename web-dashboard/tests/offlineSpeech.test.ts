import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NativeSpeechEngine, SpeechInput, speechTimingHint} from '../src/services/voice/speech_input.ts';

test('offline bridge keeps loading distinct from microphone readiness and ignores stale status',()=>{
  const events=new EventTarget(), calls:{action:string;id:string}[]=[], statuses:string[]=[], texts:string[]=[], errors:string[]=[];
  const bridge={version:3,available:true,engine:'offline-vosk',request:(action:string,id:string)=>{calls.push({action,id});return true;}};
  const engine=new NativeSpeechEngine(bridge,events);
  const input=new SpeechInput(()=>engine,text=>texts.push(text),()=>{},error=>errors.push(error),()=>{},status=>statuses.push(status));
  const emit=(detail:object)=>events.dispatchEvent(Object.assign(new Event('drivetalk-native-speech'),{detail}));
  input.start(); const id=calls[0].id;
  emit({id:'stale',type:'status',text:'ready'}); assert.deepEqual(statuses,[]);
  emit({id,type:'status',text:'loading'}); emit({id,type:'status',text:'ready'});
  assert.deepEqual(statuses,['loading','ready']);
  emit({id,type:'partial',text:'先不要打开后备箱'}); assert.deepEqual(texts,[]);
  emit({id,type:'draft',text:'先不要打开后备箱',reason:'audio-capture'});
  assert.deepEqual(texts,[]); assert.match(errors[0],/麦克风读取失败/); assert.match(errors[0],/未自动发送/);
  assert.equal(statuses.at(-1),'idle');
  emit({id,type:'result',text:'迟到的指令'}); assert.deepEqual(texts,[]);
});
test('offline hint does not claim a system ASR or guaranteed transcription accuracy',()=>{
  const bridge={version:3,available:true,engine:'offline-vosk',request:()=>true};
  assert.match(speechTimingHint({__DriveTalkNativeSpeech:bridge}),/本地离线/);
  assert.match(speechTimingHint({__DriveTalkNativeSpeech:bridge}),/可能误识别/);
});
test('offline recorder is serial and transient, without recording files, requests or transcript logs',()=>{
  const source=readFileSync(new URL('../../mobile/src/main/java/org/drivetalk/app/OfflineSpeech.java',import.meta.url),'utf8');
  assert.match(source,/newSingleThreadExecutor/);
  assert.match(source,/TYPE_BUILTIN_MIC/);
  assert.match(source,/getPartialResult/); assert.match(source,/getFinalResult/);
  assert.match(source,/ticket\.cancelled/); assert.match(source,/recorder\.release\(\)/);
  assert.doesNotMatch(source,/HttpClient|urlopen|URLConnection|Socket|Log\.[diwe]\(|out\.write\(pcm/);
  assert.match(source,/if \(ticket.stop != null\)/);
});
