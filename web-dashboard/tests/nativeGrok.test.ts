import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeGrokRequest, grokHistory } from '../src/services/nativeGrok.ts';

function fake() {
  const target = new EventTarget() as EventTarget & {__DriveTalkNativeGrok: {version:number;request:(p:Record<string,unknown>)=>boolean}};
  const requests: Record<string,unknown>[]=[];
  target.__DriveTalkNativeGrok={version:2,request:p=>{requests.push(p);return true;}};
  const emit=(data:Record<string,unknown>)=>target.dispatchEvent(new CustomEvent('drivetalk-native-grok',{detail:data}));
  return {target:target as unknown as Window,requests,emit};
}
test('native config returns metadata only and never exposes a saved Key',async()=>{
  const f=fake();const p=nativeGrokRequest({action:'config'},undefined,undefined,f.target);
  f.emit({id:f.requests[0].id,type:'config',configured:true,enabled:true,model:'mock-model',persona:'简洁'});
  assert.deepEqual(await p,{configured:true,enabled:true,model:'mock-model',persona:'简洁'});
  const bad=nativeGrokRequest({action:'config'},undefined,undefined,f.target);
  f.emit({id:f.requests[1].id,type:'config',apiKey:'mock',configured:true,enabled:true,model:'mock',persona:''});
  await assert.rejects(bad,/响应无效/);assert.equal(f.requests.at(-1)?.action,'cancel');
});
test('Grok context includes successful pairs only, in order, without DeepSeek or partial replies',()=>{
  const base={provider:'Grok',status:'no_command',question:'第一句',answer:'回复一'};
  assert.deepEqual(grokHistory([base,{...base,provider:'DeepSeek',question:'锁车'}, {...base,status:'unknown'}, {...base,question:'第二句',answer:'回复二'}]),[
    {role:'user',content:'第一句'},{role:'assistant',content:'回复一'},
    {role:'user',content:'第二句'},{role:'assistant',content:'回复二'},
  ]);
  const bounded=grokHistory(Array.from({length:20},(_,i)=>({...base,question:String(i)})));
  assert.equal(bounded.length,12);assert.equal(bounded[0].content,'14');
  assert.deepEqual(grokHistory([{...base,answer:'x'.repeat(12001)}]),[]);
  assert.deepEqual(grokHistory([]),[]);
});
test('old APK fails explicitly before a paid chat request, but config remains readable',async()=>{
  const f=fake();(f.target as unknown as {__DriveTalkNativeGrok:{version:number}}).__DriveTalkNativeGrok.version=1;
  await assert.rejects(nativeGrokRequest({action:'chat',message:'test'},undefined,undefined,f.target),/2.0.4/);
  assert.equal(f.requests.length,0);
  const config=nativeGrokRequest({action:'config'},undefined,undefined,f.target);
  f.emit({id:f.requests[0].id,type:'config',configured:true,enabled:true,model:'mock',persona:''});await config;
});
test('no fixed identity or rejection prompt is added; blank persona omits system role',()=>{
  const native=readFileSync(new URL('../../mobile/src/main/java/org/drivetalk/app/NativeGrok.java',import.meta.url),'utf8');
  assert.doesNotMatch(native,/你是 DriveTalk 聊天助手|以下为用户风格偏好|不能执行或声称执行/);
  assert.match(native,/if \(!persona.trim\(\).isEmpty\(\)\) messages.put/);
  assert.match(native,/put\("content", persona\)/);
  assert.match(native,/historyLength > 12000/);
});
test('phone streamed text reaches the voice event contract in order; no tool actions',async()=>{
  const f=fake();const events: unknown[]=[];
  const p=nativeGrokRequest({action:'chat',message:'mock'},undefined,e=>events.push(e),f.target);
  const id=f.requests[0].id;
  f.emit({id:'unrelated',type:'text_delta',sequence:0,message:'ignored'});
  f.emit({id,type:'text_delta',sequence:0,message:'你好。'});
  f.emit({id,type:'text_delta',sequence:1,message:'世界！'});
  f.emit({id,type:'text_done'});f.emit({id,type:'result'});f.emit({id,type:'done'});
  await p;
  assert.deepEqual((events as {type:string}[]).map(e=>e.type),['text_delta','text_delta','text_done','result']);
  assert.equal((events[3] as {commandSent:boolean}).commandSent,false);
  assert.equal(f.requests.length,1);
});
test('abort cancels once, drops late audio/text, and never resends',async()=>{
  const f=fake(),abort=new AbortController();let events=0;
  const p=nativeGrokRequest({action:'chat',message:'mock'},abort.signal,()=>events++,f.target);
  abort.abort(); await assert.rejects(p,/停止/);
  f.emit({id:f.requests[0].id,type:'text_delta',sequence:0,message:'late'});
  assert.equal(events,0);assert.equal(f.requests.length,2);assert.equal(f.requests[1].action,'cancel');
});
test('invalid order and upstream failure reject without a second paid request',async()=>{
  const f=fake();const p=nativeGrokRequest({action:'chat'},undefined,undefined,f.target);
  f.emit({id:f.requests[0].id,type:'text_delta',sequence:2,message:'bad'});
  await assert.rejects(p,/顺序异常/);
  assert.equal(f.requests.filter(r=>r.action==='chat').length,1);
  const failure=nativeGrokRequest({action:'chat'},undefined,undefined,f.target);
  f.emit({id:f.requests[2].id,type:'error',message:'Grok HTTP 403'});
  await assert.rejects(failure,/403/);assert.equal(f.requests.filter(r=>r.action==='chat').length,2);
});
test('native transport keeps fixed TLS endpoint, encryption, redirects off and no vehicle tools',()=>{
  const native=readFileSync(new URL('../../mobile/src/main/java/org/drivetalk/app/NativeGrok.java',import.meta.url),'utf8');
  const activity=readFileSync(new URL('../../mobile/src/main/java/org/drivetalk/app/MainActivity.java',import.meta.url),'utf8');
  assert.match(native,/https:\/\/api\.x\.ai\/v1\/chat\/completions/);
  assert.match(native,/AndroidKeyStore/);assert.match(native,/AES\/GCM\/NoPadding/);
  assert.match(native,/setInstanceFollowRedirects\(false\)/);
  assert.match(native,/newSingleThreadExecutor/);assert.match(native,/"stream", true/);
  assert.match(native,/tools-disabled/);assert.match(native,/Lifecycle\.State\.RESUMED/);
  assert.doesNotMatch(native,/\/v1\/vehicle|setHostnameVerifier|setSSLSocketFactory|System\.out|Log\./);
  assert.match(activity,/trusted\(Uri\.parse\(url\)\) && grok\.request/);
  assert.match(activity,/grok\.destroy\(\)/);
});
