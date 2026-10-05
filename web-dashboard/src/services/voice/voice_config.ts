export interface VoiceConfig { configured: boolean; enabled: boolean; model: string; referenceId: string }
export interface VoiceUpdate { apiKey?: string; referenceId?: string; model?: string; enabled?: boolean; clear?: boolean }
// 仅规范化音色标识，不访问用户提供的地址，也不持久保存密钥。
export function normalizeVoiceReference(input: string): string | null {
  const value = input.trim();
  const hex = /^[a-f0-9]{32}$/i.test(value) ? value : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.replaceAll('-', '') : null;
  if (hex) return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`.toLowerCase();
  return null;
}
export function voiceSaveBlockReason(available: boolean, busy: boolean, reference: string, keyPresent: boolean, configured: boolean): string {
  if (!available) return '请先连接车辆后端并记住登录，再保存语音配置。';
  if (busy) return '正在保存语音配置，请稍候。';
  if (!reference.trim()) return '请填写音色 ID，不是音色名称或模型名称。';
  if (!normalizeVoiceReference(reference)) return '音色 ID 应为 32 位十六进制字符（也支持带连字符的 UUID）；请勿填写网页链接。';
  if (!keyPresent && !configured) return '请填写 Fish Audio API Key。';
  return '';
}
export async function voiceConfig(update?: VoiceUpdate, fetcher: typeof fetch = fetch): Promise<VoiceConfig> {
  const response = await fetcher('/v1/vehicle/ai/voice/config', {
    method: update ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: {Accept:'application/json', ...(update ? {'Content-Type':'application/json'} : {})},
    signal: AbortSignal.timeout(12000), ...(update ? {body:JSON.stringify(update)} : {}),
  });
  if (!response.ok) throw new Error(`语音配置返回 HTTP ${response.status}；未自动重试`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音配置响应无效');
  const v = value as Record<string, unknown>;
  if ('apiKey' in v || typeof v.configured !== 'boolean' || typeof v.enabled !== 'boolean' ||
      typeof v.model !== 'string' || typeof v.referenceId !== 'string') throw new Error('语音配置响应无效');
  return {configured:v.configured,enabled:v.enabled,model:v.model,referenceId:v.referenceId};
}
