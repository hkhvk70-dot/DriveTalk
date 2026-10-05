export interface SentenceChunk {
  sequence: number;
  text: string;
  reason: 'punctuation' | 'limit' | 'end';
}

/** 输入必须是新增文本 delta，不能反复传入累计全文。 */
export class SentenceSplitter {
  private pending = '';
  private length = 0;
  private sequence = 0;
  private ended = false;
  private readonly maxCharacters: number;
  private readonly firstCharacters: number;

  constructor(maxCharacters = 100, firstCharacters = maxCharacters) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 8 || maxCharacters > 300) {
      throw new RangeError('maxCharacters 必须为 8–300');
    }
    this.maxCharacters = maxCharacters;
    if (!Number.isInteger(firstCharacters) || firstCharacters < 8 || firstCharacters > maxCharacters) {
      throw new RangeError('首段长度必须为 8–maxCharacters');
    }
    this.firstCharacters = firstCharacters;
  }

  push(delta: string): SentenceChunk[] {
    if (this.ended) throw new Error('当前文本流已结束，请创建新的分句器');
    if (delta.length > 64_000) throw new RangeError('单个文本增量过大');
    const chunks: SentenceChunk[] = [];
    // for…of 按 Unicode 字符处理，避免截断 emoji 的代理对。
    for (const character of delta) {
      if (!this.pending && /[\s。！？!?，,；;：:]/u.test(character)) continue;
      this.pending += character;
      this.length++;
      // 不把英文小数点作为句末，例如 26.5°C。
      if (/[。！？!?，,；;：:\n]/u.test(character)) {
        this.emit(chunks, 'punctuation');
      } else if (this.length >= (this.sequence === 0 ? this.firstCharacters : this.maxCharacters)) {
        this.emit(chunks, 'limit'); // 无标点长句也能开始合成。
      }
    }
    return chunks;
  }

  finish(): SentenceChunk[] {
    if (this.ended) return [];
    this.ended = true;
    const chunks: SentenceChunk[] = [];
    this.emit(chunks, 'end');
    return chunks;
  }

  private emit(chunks: SentenceChunk[], reason: SentenceChunk['reason']): void {
    const text = this.pending.trim();
    this.pending = '';
    this.length = 0;
    if (text) chunks.push({ sequence: this.sequence++, text, reason });
  }
}
