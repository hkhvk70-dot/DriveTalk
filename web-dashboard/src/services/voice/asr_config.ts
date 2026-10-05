export interface AsrConfig { configured: boolean; enabled: boolean; workspaceId: string; model: string; region: string }
export type AsrChoice = 'aliyun' | 'local';
let choice: AsrChoice = 'aliyun'; // 主引擎固定默认阿里云；不会因错误偷偷降级。
export function asrChoice(): AsrChoice { return choice; }
export function chooseAsr(value: AsrChoice): void {
  choice = value;
  window.dispatchEvent(new Event('drivetalk-asr-change'));
}
export async function asrConfig(update?: {apiKey?: string; workspaceId?: string; enabled?: boolean; clear?: boolean}, fetcher: typeof fetch = fetch): Promise<AsrConfig> {
  const response = await fetcher('/v1/vehicle/ai/asr/config', {
    method: update ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: {Accept:'application/json', ...(update ? {'Content-Type':'application/json'} : {})},
    signal: AbortSignal.timeout(12000), ...(update ? {body:JSON.stringify(update)} : {}),
  });
  if (!response.ok) throw new Error(`阿里云识别配置返回 HTTP ${response.status}；未自动重试`);
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'apiKey' in value ||
      typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean' ||
      typeof value.workspaceId !== 'string' || value.model !== 'fun-asr-realtime' || value.region !== 'cn-beijing') throw new Error('识别配置响应无效');
  return {configured:value.configured, enabled:value.enabled, workspaceId:value.workspaceId, model:value.model, region:value.region};
}
