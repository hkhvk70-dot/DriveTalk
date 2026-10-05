import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechInput, speechFactory, type SpeechEngine } from '../src/services/voice/speech_input.ts';
import { normalizeVoiceReference, voiceSaveBlockReason, voiceConfig } from '../src/services/voice/voice_config.ts';

test('voice ID normalization supports full hex and UUID without truncation', () => {
  assert.equal(normalizeVoiceReference(' A'.trim() + 'A'.repeat(31)), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(normalizeVoiceReference(' AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA '), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  for (const v of ['voice name', 'https://fish.audio/model/' + 'a'.repeat(32), 'a'.repeat(31), 'g'.repeat(32)]) assert.equal(normalizeVoiceReference(v), null);
});
test('save button exposes every blocking reason and permits retaining saved key', () => {
  const id = 'a'.repeat(32);
  assert.match(voiceSaveBlockReason(false,false,id,true,false), /登录/);
  assert.match(voiceSaveBlockReason(true,true,id,true,false), /保存/);
  assert.match(voiceSaveBlockReason(true,false,'',true,false), /填写音色/);
  assert.match(voiceSaveBlockReason(true,false,'invalid',true,false), /32/);
  assert.match(voiceSaveBlockReason(true,false,id,false,false), /API Key/);
  assert.equal(voiceSaveBlockReason(true,false,id,false,true), '');
  assert.equal(voiceSaveBlockReason(true,false,id,true,false), '');
});

class Engine implements SpeechEngine {
  lang = ''; continuous = true; interimResults = true; maxAlternatives = 2;
  onresult: SpeechEngine['onresult'] = null;
  onerror: SpeechEngine['onerror'] = null;
  onend: SpeechEngine['onend'] = null;
  starts = 0; aborts = 0;
  start() {this.starts++;} abort() {this.aborts++;}
}
function setup() {
  const engine = new Engine(), texts: string[] = [], active: boolean[] = [], errors: string[] = [];
  const speech = new SpeechInput(() => engine, v => texts.push(v), v => active.push(v), v => errors.push(v));
  return {engine,texts,active,errors,speech};
}
test('final recognized phrase stops capture and fills text only once', () => {
  const s = setup(); s.speech.start(); const callback = s.engine.onresult!;
  assert.equal(s.engine.lang,'zh-CN'); assert.equal(s.engine.continuous,false);
  callback({resultIndex:0,results:[{isFinal:true,0:{transcript:' 锁车 '}}]});
  callback({resultIndex:0,results:[{isFinal:true,0:{transcript:'重复'}}]});
  assert.deepEqual(s.texts,['锁车']); assert.equal(s.engine.aborts,1);
  assert.equal(s.active.at(-1),false);
});
test('playback abort discards stale recognition events', () => {
  const s = setup(); s.speech.start(); const callback = s.engine.onresult!;
  s.speech.abort(); callback({resultIndex:0,results:[{isFinal:true,0:{transcript:'AI 的声音'}}]});
  assert.deepEqual(s.texts,[]); assert.equal(s.engine.onresult,null);
});
test('interim recognition is not sent; permission error clears capture', () => {
  const s = setup(); s.speech.start();
  s.engine.onresult!({resultIndex:0,results:[{isFinal:false,0:{transcript:'未完成'}}]});
  assert.deepEqual(s.texts,[]); s.engine.onerror!({error:'not-allowed'});
  assert.equal(s.errors.length,1); assert.equal(s.engine.aborts,1);
});
test('unsupported browsers are explicitly detectable', () => {
  assert.equal(speechFactory({}),undefined);
  assert.ok(speechFactory({webkitSpeechRecognition:Engine})?.() instanceof Engine);
});
test('configuration uses same-origin owner POST with no cached key', async () => {
  const fake: typeof fetch = async (url, options) => {
    assert.equal(url,'/v1/vehicle/ai/voice/config'); assert.equal(options?.method,'POST');
    assert.equal(options?.credentials,'same-origin'); assert.equal(options?.cache,'no-store');
    assert.equal(JSON.parse(options?.body as string).apiKey,'test-only-key');
    return Response.json({configured:true,enabled:true,model:'s2.1-pro',referenceId:'a'.repeat(32)});
  };
  const value = await voiceConfig({apiKey:'test-only-key'},fake);
  assert.equal('apiKey' in value,false);
});
test('configuration rejects server key echo', async () => {
  await assert.rejects(voiceConfig(undefined,async () => Response.json({configured:true,enabled:true,model:'s1',referenceId:'a'.repeat(32),apiKey:'must-not-echo'})));
});
test('failed POST configuration is never automatically retried', async () => {
  let calls = 0;
  await assert.rejects(voiceConfig({enabled:true},async () => {calls++; return new Response('',{status:429});}), /429/);
  assert.equal(calls,1);
});
