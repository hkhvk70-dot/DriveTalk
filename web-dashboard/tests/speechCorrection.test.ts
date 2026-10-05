import test from 'node:test';
import assert from 'node:assert/strict';
import { correctSpeechTemperature } from '../src/services/voice/speech_correction.ts';
import { SpeechInput, NativeSpeechEngine, type SpeechEngine } from '../src/services/voice/speech_input.ts';
import { speechRecovery } from '../src/services/voice/hands_free.ts';

test('explicit Chinese temperatures normalize without guessing or extra requests', () => {
  const examples = new Map([
    ['空调调至二十一度','空调调至21度'],
    ['请把空调的温度调整到二十一点五摄氏度。','请把空调调至21.5度。'],
    ['帮我将车内空调设置为两十六度','帮我将车内空调调至26度'],
    ['空调调到二 一度','空调调至21度'],
    ['汽车空调调至二十八度','汽车空调调至28度'],
    ['空调调至21°C','空调调至21度'],
    ['空调调至十五点零五度','空调调至15.05度'],
  ]);
  for (const [original,text] of examples) assert.deepEqual(correctSpeechTemperature(original),{original,text,needsReview:false});
});

test('the reported homophone error is a review-only candidate, never an automatic command', () => {
  const original='空调跳至二是一度';
  assert.deepEqual(correctSpeechTemperature(original),{original,text:'空调调至21度',needsReview:true});
  for (const original of ['空调跳到21度','空调调制二十一度','空调调至二时五度']) {
    assert.equal(correctSpeechTemperature(original).needsReview,true);
  }
});

test('unparseable and out-of-range temperature numbers are not silently clamped', () => {
  for (const original of ['空调调至二二一度','空调调至二是一一度','空调调至二十二十一度',
    '空调调至十四度','空调调至三十度','空调调至二十点度','空调调至二十点点五度']) {
    assert.deepEqual(correctSpeechTemperature(original),{original,text:original,needsReview:true});
  }
});

test('chat, quoted/negated/question/multiple actions and named home devices stay verbatim', () => {
  for (const original of ['不要把空调调至二十一度','空调调至二十一度吗','空调调至二十一度？',
    '你刚才说空调跳至二是一度','“空调调至二十一度”这句话什么意思',
    '空调调至二十一度然后打开后备箱','空调调至二十一度，不要开后备箱',
    '示例区域乙智能空调3调至二十一度','空调跳至二是一度这句话识别错了','我今天二十一岁',
    '锁车','解锁','不要解锁','打开后备箱','关闭后备箱']) {
    assert.deepEqual(correctSpeechTemperature(original),{original,text:original,needsReview:false});
  }
});

class Engine implements SpeechEngine {
  lang=''; continuous=false; interimResults=false; maxAlternatives=1;
  onresult:SpeechEngine['onresult']=null; onerror:SpeechEngine['onerror']=null; onend:SpeechEngine['onend']=null;
  start() {} abort() {}
}
function setup(engine:SpeechEngine=new Engine()) {
  const sent:string[]=[], preview:string[]=[], errors:{text:string;code?:string}[]=[];
  const input=new SpeechInput(()=>engine,text=>sent.push(text),()=>{},(text,code)=>errors.push({text,code}),text=>preview.push(text));
  input.start(); return {engine,input,sent,preview,errors};
}
function result(engine:SpeechEngine,text:string,isFinal=true) {
  engine.onresult?.({resultIndex:0,results:[{isFinal,0:{transcript:text}}]});
}

test('partial hypotheses and stopped/error drafts stay raw and never auto-send a correction', () => {
  const s=setup();
  try {
    result(s.engine,'空调跳至二是一度',false);
    assert.deepEqual(s.preview,['空调跳至二是一度']); assert.deepEqual(s.sent,[]);
    s.engine.onerror?.({error:'network'});
    assert.deepEqual(s.sent,[]); assert.equal(s.preview.at(-1),'空调跳至二是一度');
    assert.equal(s.errors[0].code,'draft');
  } finally {s.input.abort();}
});

test('ambiguous final text pauses hands-free, preserves original/suggestion and ignores late callbacks', () => {
  const s=setup(), late=s.engine.onresult!;
  result(s.engine,'空调跳至二是一度');
  assert.deepEqual(s.sent,[]); assert.equal(s.preview.at(-1),'空调调至21度');
  assert.match(s.errors[0].text,/原文：“空调跳至二是一度”/);
  assert.match(s.errors[0].text,/本句未自动发送/);
  assert.equal(speechRecovery(s.errors[0].code,0).retry,false); assert.equal(s.input.isActive,false);
  late({resultIndex:0,results:[{isFinal:true,0:{transcript:'空调调至22度'}}]});
  assert.deepEqual(s.sent,[]); assert.equal(s.errors.length,1);
});

test('equivalent formatting reaches existing final-text callback exactly once', () => {
  const s=setup(); result(s.engine,'空调调至二十一度');
  assert.deepEqual(s.sent,['空调调至21度']); assert.deepEqual(s.errors,[]); assert.equal(s.input.isActive,false);
});

test('Android offline bridge uses the same review gate as browser speech', () => {
  const events=new EventTarget(); let requestId='';
  const engine=new NativeSpeechEngine({version:3,available:true,request:(_action,id)=>{requestId=id;return true;}},events);
  const s=setup(engine), id=requestId;
  events.dispatchEvent(Object.assign(new Event('drivetalk-native-speech'),{detail:{id,type:'result',text:'空调跳至二是一度'}}));
  assert.deepEqual(s.sent,[]); assert.equal(s.preview.at(-1),'空调调至21度');
  assert.equal(s.errors[0].code,'recognition-review');
});
