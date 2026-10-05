import test from 'node:test';
import assert from 'node:assert/strict';
import type { GrokEvent } from '../src/services/grokApi.ts';
import { parallelReply } from '../src/services/voice/parallel_reply.ts';
import { SentenceSplitter } from '../src/services/voice/sentence_splitter.ts';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function fixture() {
  const connection = deferred();
  const accepted: GrokEvent[] = [];
  const errors: Error[] = [];
  let starts = 0, interrupts = 0, finishes = 0;
  const voice = {
    start: () => {starts++; return connection.promise;},
    accept: (event: GrokEvent) => {accepted.push(event);},
    finish: () => {finishes++;},
    interrupt: () => {interrupts++;},
  };
  return {voice, connection, accepted, errors, report: (e: Error) => errors.push(e),
    counts: () => ({starts, interrupts, finishes})};
}
const delta = (message = '第一句。', sequence = 0): GrokEvent => ({type:'text_delta',turnId:'mock',sequence,message});
const done: GrokEvent = {type:'text_done',turnId:'mock'};

test('model starts before delayed TTS ready; text displays immediately and is later spoken in order', async () => {
  const f = fixture(), displayed: GrokEvent[] = [];
  let modelCalls = 0;
  const reply = parallelReply(f.voice, new AbortController().signal, async receive => {
    modelCalls++; receive(delta()); receive(delta('第二句。',1)); receive(done);
  }, e => displayed.push(e), f.report);
  assert.equal(modelCalls, 1);
  assert.equal(displayed.length, 3);
  assert.equal(f.accepted.length, 0);
  f.connection.resolve(); await reply;
  assert.deepEqual(f.accepted, displayed);
  assert.deepEqual(f.counts(), {starts:1, interrupts:0, finishes:1});
});

test('ready-first response forwards live chunks before the model finishes', async () => {
  const f = fixture(), model = deferred();
  let receive!: (e: GrokEvent) => void;
  const reply = parallelReply(f.voice, new AbortController().signal, async callback => {
    receive = callback; await model.promise;
  }, () => {}, f.report);
  f.connection.resolve(); await Promise.resolve(); await Promise.resolve();
  receive(delta()); assert.equal(f.accepted.length, 1);
  receive(done); model.resolve(); await reply;
  assert.equal(f.counts().finishes, 1);
});

test('TTS failure never prevents or retries the model; text is retained', async () => {
  const f = fixture(), text: GrokEvent[] = [], model = deferred();
  let modelCalls = 0, receive!: (e: GrokEvent) => void;
  const reply = parallelReply(f.voice, new AbortController().signal, async callback => {
    modelCalls++; receive = callback; await model.promise;
  }, e => text.push(e), f.report);
  f.connection.reject(new Error('mock TTS failure')); await Promise.resolve();
  receive(delta()); receive(done); model.resolve(); await reply;
  assert.equal(modelCalls, 1); assert.equal(text.length, 2);
  assert.equal(f.errors.length, 1); assert.equal(f.counts().interrupts, 1);
  assert.equal(f.counts().finishes, 0);
});

test('model failure discards queued speech and rejects; late TTS ready cannot play it', async () => {
  const f = fixture();
  await assert.rejects(parallelReply(f.voice, new AbortController().signal, async receive => {
    receive(delta()); throw new Error('mock model failure');
  }, () => {}, f.report), /model failure/);
  f.connection.resolve(); await Promise.resolve();
  assert.equal(f.accepted.length, 0); assert.equal(f.counts().interrupts, 1);
});

test('abort releases ready wait immediately and rejects late audio/text without retries', async () => {
  const f = fixture(), abort = new AbortController();
  const reply = parallelReply(f.voice, abort.signal, async receive => {receive(delta());}, () => {}, f.report);
  abort.abort(); await assert.rejects(reply, {name:'AbortError'});
  f.connection.resolve(); await Promise.resolve();
  assert.equal(f.accepted.length, 0); assert.equal(f.errors.length, 0);
});

test('aborted turn does not start TTS or model', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(parallelReply(f.voice, abort.signal, async () => {throw new Error('must not run');}, () => {}, f.report), {name:'AbortError'});
  assert.equal(f.counts().starts, 0);
});

test('bounded wait queue drops only speech, not text, and never retries', async () => {
  const f = fixture(); let received = 0;
  await parallelReply(f.voice, new AbortController().signal, async receive => {
    receive(delta('字'.repeat(6001))); receive(done);
    f.connection.resolve();
  }, () => {received++;}, f.report);
  assert.equal(received, 2); assert.equal(f.errors.length, 1);
  assert.equal(f.accepted.length, 0);
});

test('speech send errors do not propagate into model stream or repeat device results', async () => {
  const f = fixture(), model = deferred();
  f.voice.accept = () => {throw new Error('mock send failure');};
  let receive!: (e: GrokEvent) => void, received = 0;
  const reply = parallelReply(f.voice, new AbortController().signal, async callback => {receive = callback; await model.promise;}, () => {received++;}, f.report);
  f.connection.resolve(); await Promise.resolve(); await Promise.resolve();
  receive({type:'result', status:'confirmed', message:'已确认', commandSent:true});
  receive(done); model.resolve(); await reply;
  assert.equal(received, 2); assert.equal(f.errors.length, 1);
  assert.equal(f.counts().interrupts, 1);
});

test('text-only path needs no audio connection', async () => {
  let received = 0;
  await parallelReply(null, new AbortController().signal, async receive => {receive(delta()); receive(done);}, () => {received++;}, () => {throw Error('unexpected');});
  assert.equal(received, 2);
});

test('first unpunctuated chunk is 40 unicode characters, later chunks retain 100', () => {
  const split = new SentenceSplitter(100,40);
  assert.equal(split.push('字'.repeat(39)).length, 0);
  assert.equal(split.push('😀')[0].text, '字'.repeat(39)+'😀');
  assert.equal(split.push('字'.repeat(99)).length, 0);
  assert.equal(split.push('字')[0].text.length, 100);
});

test('punctuation still emits immediately and first limit configuration is validated', () => {
  const split = new SentenceSplitter(100,40);
  assert.equal(split.push('你好，')[0].text, '你好，');
  assert.equal(split.push('字'.repeat(40)).length, 0);
  assert.equal(split.finish()[0].text.length, 40);
  assert.throws(() => new SentenceSplitter(100,101), RangeError);
  assert.throws(() => new SentenceSplitter(100,7), RangeError);
});
