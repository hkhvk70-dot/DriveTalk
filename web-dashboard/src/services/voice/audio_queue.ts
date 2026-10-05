export interface AudioTurn { id: number; signal: AbortSignal }
export interface AudioQueueOptions {
  context?: AudioContext;
  leadInSeconds?: number;
  maxBufferedSeconds?: number;
  /** true 时暂停 ASR/关闭麦克风轨道；false 时由上层决定是否重新收音。 */
  onSpeechActive?: (active: boolean) => void;
  onUnderrun?: () => void;
}

/** 接收单声道 signed PCM16 little-endian；不要传 MP3、WAV 头或 MessagePack 帧。 */
export class AudioQueue {
  private context: AudioContext | undefined;
  private readonly ownsContext: boolean;
  private readonly leadIn: number;
  private readonly maxBuffered: number;
  private generation = 0;
  private controller = new AbortController();
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private nextSequence = 0;
  private nextEncodedSequence = 0;
  private sampleRate = 0;
  private carry: number | undefined;
  private accepting = false;
  private speechActive = false;
  private disposed = false;
  private readonly options: AudioQueueOptions;

  constructor(options: AudioQueueOptions = {}) {
    this.options = options;
    this.context = options.context;
    this.ownsContext = !options.context;
    this.leadIn = options.leadInSeconds ?? 0.08;
    this.maxBuffered = options.maxBufferedSeconds ?? 12;
    if (!Number.isFinite(this.leadIn) || this.leadIn < 0 || this.leadIn > 1 ||
        !Number.isFinite(this.maxBuffered) || this.maxBuffered < 1 || this.maxBuffered > 60) {
      throw new RangeError('无效音频缓冲参数');
    }
  }

  /** 必须从用户点击“开始对话”等手势调用，解除手机自动播放限制。 */
  async unlock(): Promise<void> {
    if (this.disposed) throw new Error('音频队列已释放');
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.disposed || this.context.state !== 'running') throw new Error('请点击页面启用声音');
  }

  beginTurn(): AudioTurn {
    if (this.disposed) throw new Error('音频队列已释放');
    this.interrupt();
    this.controller = new AbortController();
    this.accepting = true;
    return { id: this.generation, signal: this.controller.signal };
  }

  get bufferedSeconds(): number {
    return Math.max(0, this.nextTime - (this.context?.currentTime ?? 0));
  }

  /** 完整短句 MP3 由手机 Web Audio 解码；调用者串行 await，禁止解码顺序颠倒。 */
  async enqueueMp3(turnId: number, sequence: number, bytes: Uint8Array): Promise<boolean> {
    if (turnId !== this.generation || this.controller.signal.aborted || this.disposed) return false;
    if (!this.context || !bytes.length || bytes.length > 1_000_000) throw new Error('压缩音频无效');
    if (sequence !== this.nextEncodedSequence) throw new Error('压缩音频缺失、重复或乱序');
    const decoded = await this.context.decodeAudioData(bytes.slice().buffer);
    // 插话后仍在解码的旧音频不能重新播放。
    if (turnId !== this.generation || this.controller.signal.aborted || this.disposed) return false;
    if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 ||
        !Number.isFinite(decoded.duration) || decoded.duration > 60 || !decoded.length ||
        decoded.length * decoded.numberOfChannels * 4 > 24_000_000 ||
        !Number.isInteger(decoded.sampleRate) || decoded.sampleRate < 8000 || decoded.sampleRate > 96000) {
      throw new Error('解码音频超出限制');
    }
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    // 长句仅在本地分成半秒播放块，不增加合成请求。缓冲满时等待，而非停止朗读。
    const chunkFrames = Math.floor(decoded.sampleRate * 0.5);
    for (let offset = 0; offset < decoded.length; offset += chunkFrames) {
      const frames = Math.min(chunkFrames, decoded.length - offset);
      if (!await this.waitForCapacity(turnId, frames / decoded.sampleRate)) return false;
      const pcm = new Uint8Array(frames * 2);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < frames; i++) {
        const sample = channels.reduce((sum, channel) => sum + channel[offset + i], 0) / channels.length;
        if (!Number.isFinite(sample)) throw new Error('无效音频样本');
        view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
      }
      if (!this.enqueuePcm16(turnId, this.nextSequence, pcm, decoded.sampleRate)) return false;
    }
    this.nextEncodedSequence++;
    return true;
  }

  private async waitForCapacity(turnId: number, duration: number): Promise<boolean> {
    const signal = this.controller.signal;
    let lastProgress = Date.now();
    let lastTime = this.context?.currentTime ?? 0;
    while (turnId === this.generation && !signal.aborted && !this.disposed) {
      const context = this.context;
      if (!this.accepting || !context || context.state !== 'running') throw new Error('音频播放已暂停，请重新开始朗读');
      const start = Math.max(this.nextTime, context.currentTime + (this.sources.size ? 0 : this.leadIn));
      if (start + duration - context.currentTime <= this.maxBuffered && this.sources.size < 2048) return true;
      if (context.currentTime > lastTime) { lastTime = context.currentTime; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > 15_000) throw new Error('音频播放没有进展，请重新开始朗读');
      // 打断立即唤醒等待者；不留下定时器或旧回合音频。
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 50);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
    return false;
  }

  /** sequence 是整个回合的音频帧序号，从 0 开始，不是短句序号。 */
  enqueuePcm16(turnId: number, sequence: number, bytes: Uint8Array, sampleRate: number): boolean {
    if (turnId !== this.generation || this.disposed || this.controller.signal.aborted) return false;
    if (!this.accepting) throw new Error('音频流已结束');
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('音频尚未解锁或已暂停');
    if (sequence !== this.nextSequence) throw new Error('音频帧缺失、重复或乱序');
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000 ||
        (this.sampleRate !== 0 && this.sampleRate !== sampleRate)) throw new Error('PCM 采样率无效或改变');
    if (!bytes.byteLength || bytes.byteLength > 1_000_000) throw new Error('音频帧大小无效');

    const carrySize = this.carry === undefined ? 0 : 1;
    const frames = Math.floor((bytes.length + carrySize) / 2);
    const duration = frames / sampleRate;
    const start = Math.max(this.nextTime, context.currentTime + (this.sources.size ? 0 : this.leadIn));
    if (start + duration - context.currentTime > this.maxBuffered || this.sources.size >= 2048) {
      throw new Error('音频缓冲已满，请暂停上游合成');
    }
    // WS 消息可能在一个 16-bit 样本中间断开，保留未配对字节。
    const joined = new Uint8Array(bytes.length + carrySize);
    if (carrySize) joined[0] = this.carry!;
    joined.set(bytes, carrySize);
    let source: AudioBufferSourceNode | undefined;
    if (frames) {
      const buffer = context.createBuffer(1, frames, sampleRate);
      const output = buffer.getChannelData(0);
      const view = new DataView(joined.buffer);
      for (let i = 0; i < frames; i++) output[i] = view.getInt16(i * 2, true) / 32768;
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        source!.disconnect();
        if (turnId !== this.generation || !this.sources.delete(source!)) return;
        if (!this.sources.size) {
          if (this.accepting) this.options.onUnderrun?.();
          else this.setSpeechActive(false);
        }
      };
      this.sources.add(source);
      // 在播放前通知上层静音麦克风，含缓冲空档均保持静音。
      this.setSpeechActive(true);
      try { source.start(start); }
      catch (error) {
        this.sources.delete(source); source.disconnect();
        this.interrupt(); throw error;
      }
      this.nextTime = start + duration;
    }
    this.carry = joined.length % 2 ? joined[joined.length - 1] : undefined;
    this.sampleRate = sampleRate;
    this.nextSequence++;
    return true;
  }

  finishTurn(turnId: number): void {
    if (turnId !== this.generation || this.disposed || this.controller.signal.aborted) return;
    if (this.carry !== undefined) {
      this.interrupt(); throw new Error('PCM 流以半个样本结束');
    }
    this.accepting = false;
    if (!this.sources.size) this.setSpeechActive(false);
  }

  /** 上层监听 signal，同时关闭 TTS WS 和终止文本流；不会撤回已发出的控车动作。 */
  interrupt(): void {
    this.generation++; // 先废弃回合，迟到的数据和 onended 不能影响新回合。
    this.controller.abort();
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* 已停止。 */ }
      source.disconnect();
    }
    this.sources.clear();
    this.accepting = false;
    this.nextTime = this.context?.currentTime ?? 0;
    this.nextSequence = this.sampleRate = 0;
    this.nextEncodedSequence = 0;
    this.carry = undefined;
    this.setSpeechActive(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.interrupt();
    this.disposed = true;
    if (this.ownsContext && this.context && this.context.state !== 'closed') await this.context.close();
  }

  private setSpeechActive(active: boolean): void {
    if (this.speechActive === active) return;
    this.speechActive = active;
    this.options.onSpeechActive?.(active);
  }
}
