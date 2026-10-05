import type { GrokEvent } from '../grokApi.ts';
import { AudioQueue } from './audio_queue.ts';
import { SentenceSplitter } from './sentence_splitter.ts';
import { FishAudioWs, type FishAudioOptions } from './fish_audio_ws.ts';

/** 一轮文本生成、TTS 合成和播放并行。仅消费文本与执行器结果，不具备控车动作。 */
export class VoicePipeline {
  private queue: AudioQueue;
  private session: FishAudioWs | undefined;
  private splitter = new SentenceSplitter();
  private generation = 0;
  private cancelled = true;
  private finished = false;
  private sawText = false;

  private readonly onError: (error: Error) => void;
  private readonly onSynthesis: (active: boolean) => void;
  constructor(queue: AudioQueue, onError: (error: Error) => void = () => {}, onSynthesis: (active: boolean) => void = () => {}) { this.queue = queue; this.onError = onError; this.onSynthesis = onSynthesis; }
  prepareAudio(): Promise<void> { return this.queue.unlock(); }

  async start(options: Omit<FishAudioOptions, 'onAudio' | 'signal' | 'turnId'> = {}): Promise<void> {
    this.interrupt();
    const generation = this.generation;
    await this.queue.unlock();
    if (generation !== this.generation) throw new DOMException('已打断', 'AbortError');
    const turn = this.queue.beginTurn();
    this.cancelled = false; this.finished = this.sawText = false;
    this.onSynthesis(true);
    // 首段无标点时最多等待40字，后续保留100字以限制碎片合成数量。
    this.splitter = new SentenceSplitter(100, 40);
    let session: FishAudioWs;
    let decoded = Promise.resolve();
    let pendingBytes = 0;
    try {
      session = await FishAudioWs.connect({ ...options, turnId: crypto.randomUUID(), signal: turn.signal,
        onAudio: (bytes, sequence, sampleRate, format) => {
          if (format !== 'mp3') { this.queue.enqueuePcm16(turn.id, sequence, bytes, sampleRate); return; }
          pendingBytes += bytes.length;
          if (pendingBytes > 2_000_000) throw new Error('语音解码队列已满');
          decoded = decoded.then(async () => {
            try { await this.queue.enqueueMp3(turn.id, sequence, bytes); }
            finally { pendingBytes -= bytes.length; }
          });
          void decoded.catch((error: Error) => {
            if (generation !== this.generation) return;
            this.interrupt(); this.onError(error);
          });
        } });
    } catch (error) {
      if (generation === this.generation) this.interrupt();
      throw error;
    }
    // ready 到 await 恢复之间也可能发生打断，旧连接不能重新占据新回合。
    if (generation !== this.generation || turn.signal.aborted) {
      session.cancel(); throw new DOMException('已打断', 'AbortError');
    }
    this.session = session;
    // 真正的合成结束后才结束播放队列，文本生成结束时还有音频在路上。
    void session.completed.then(async () => {
      await decoded;
      if (generation === this.generation) {this.queue.finishTurn(turn.id); this.onSynthesis(false);}
    }).catch((error: Error) => {
      if (generation !== this.generation) return;
      this.interrupt();
      if (error.name !== 'AbortError') this.onError(error);
    });
  }

  accept(event: GrokEvent): void {
    if (this.cancelled || this.finished || !this.session) return;
    if (event.type === 'text_delta') {
      this.sawText = true;
      for (const chunk of this.splitter.push(event.message)) this.session.sendSentence(chunk.text);
    } else if (event.type === 'result' && event.status !== 'no_command') {
      // 受理/确认来自现有执行器，避免播报模型对命令成功的猜测。
      for (const chunk of this.splitter.push(event.message + '。')) this.session.sendSentence(chunk.text);
    } else if (event.type === 'text_done') {
      this.finish();
    } else if (event.type === 'text' && !this.sawText) {
      // 兼容旧后端，只在没有 text_delta 时使用整段文本。
      this.sawText = true;
      for (const chunk of this.splitter.push(event.message)) this.session.sendSentence(chunk.text);
    }
  }

  /** 兼容旧 SSE；调用者仅在文本流正常结束时调用，失败时应 interrupt。 */
  finish(): void {
    if (this.cancelled || this.finished || !this.session) return;
    for (const chunk of this.splitter.finish()) this.session.sendSentence(chunk.text);
    this.finished = true; this.session.finishText();
  }

  interrupt(): void {
    this.generation++; this.cancelled = true;
    this.session?.cancel(); this.session = undefined;
    this.queue.interrupt();
    this.onSynthesis(false);
  }
}
