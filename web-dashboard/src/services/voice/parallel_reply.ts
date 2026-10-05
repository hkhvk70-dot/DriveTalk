import type { GrokEvent } from '../grokApi.ts';

interface ReplyVoice {
  start(): Promise<void>;
  accept(event: GrokEvent): void;
  finish(): void;
  interrupt(): void;
}

/** 只在用户已经发送消息后并行建连；不预合成、不重试模型或设备命令。 */
export async function parallelReply(
  voice: ReplyVoice | null,
  signal: AbortSignal,
  chat: (receive: (event: GrokEvent) => void) => Promise<void>,
  onEvent: (event: GrokEvent) => void,
  onVoiceError: (error: Error) => void,
): Promise<void> {
  signal.throwIfAborted();
  let ready = false, enabled = !!voice;
  let characters = 0;
  const pending: GrokEvent[] = [];
  const discardVoice = (error?: unknown) => {
    if (!enabled) return;
    enabled = false; pending.length = 0;
    voice?.interrupt();
    if (error && !signal.aborted) onVoiceError(error instanceof Error ? error : new Error('朗读中断'));
  };
  const cancel = () => discardVoice();
  signal.addEventListener('abort', cancel, {once: true});
  // ready 之前的文本保存在有上限的内存队列；先到的文本不丢弃、不颠倒。
  const accept = (event: GrokEvent) => {
    if (!enabled || signal.aborted) return;
    if (!['text_delta', 'text', 'text_done', 'result'].includes(event.type)) return;
    try {
      if (ready) voice!.accept(event);
      else {
        characters += 'message' in event ? event.message.length : 0;
        if (characters > 6000 || pending.length >= 512) throw new Error('语音连接等待队列已满；本轮仅保留文本');
        pending.push(event);
      }
    } catch (error) { discardVoice(error); }
  };
  // start 的失败仅停朗读，不能拦住已经授权的一次文本请求，也不能重发它。
  const connection = (async () => {
    if (!voice) return;
    try {
      await voice.start();
      if (!enabled || signal.aborted) return;
      ready = true;
      for (const event of pending) voice.accept(event);
      pending.length = 0;
    } catch (error) { discardVoice(error); }
  })();
  let aborted!: () => void;
  const cancellation = new Promise<void>(resolve => {
    aborted = resolve;
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) resolve();
  });
  try {
    await chat(event => {
      if (signal.aborted) return;
      onEvent(event); accept(event);
    });
    // 文本已完成但连接未就绪时仍保留本轮互斥；打断则立即释放等待。
    await Promise.race([connection, cancellation]);
    signal.throwIfAborted();
    if (enabled) try { voice!.finish(); } catch (error) { discardVoice(error); }
  } catch (error) {
    discardVoice();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', aborted);
  }
}
