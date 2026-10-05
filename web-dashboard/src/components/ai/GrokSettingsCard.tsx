import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { grokConfig, type GrokConfig } from '../../services/grokApi';
import { useVehicleStore } from '../../stores/mobileVehicleStore';

export default function GrokSettingsCard() {
  const remembered = useVehicleStore(s => s.remembered);
  const source = useVehicleStore(s => s.source);
  const vehicleBusy = useVehicleStore(s => s.isLoading);
  const [config, setConfig] = useState<GrokConfig | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('deepseek-flash');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const available = source === 'live' && remembered;
  useEffect(() => {
    let active = true;
    if (available) void grokConfig().then(value => { if (active) { setConfig(value); setModel(value.model); setPersona(value.persona); } }).catch(() => { if (active) setNotice('AI 接口尚未就绪，需部署新版后端；不会影响手动控车。'); });
    else { setKey(''); setPersona(''); setConfig(null); }
    return () => { active = false; };
  }, [available]);
  async function save(clear = false, enabled = true) {
    const secret = key.trim(); setKey(''); setBusy(true); setNotice('');
    try {
      const result = await grokConfig(clear ? { clear: true } : { ...(secret ? { apiKey: secret } : {}), model: model.trim(), persona: persona.trim(), enabled });
      setConfig(result);
      setNotice(clear ? '服务器保存的 DeepSeek 密钥已清除。' : enabled ? '配置已加密保存到服务器。请到 DeepSeek 助手中发送消息验证；尚未测试连通或控车。' : 'DeepSeek 已停用，后端会阻断 AI 请求。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '配置保存未确认；未自动重试'); }
    finally { setBusy(false); }
  }
  return <section className="mobile-card space-y-4 p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">DeepSeek 私人 AI 助手</h2><span className="text-xs text-neutral-400">{config?.enabled ? '已启用' : '未启用'}</span></div>
    {!available && <p className="text-xs leading-6 text-amber-200">请先连接车辆并勾选“记住登录”，才能配置 AI。模拟模式不访问 DeepSeek。</p>}
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label className="block text-xs text-neutral-400">DeepSeek API Key<input type="password" aria-label="DeepSeek API Key" autoComplete="new-password" spellCheck={false} value={key} maxLength={260} disabled={!available || busy || vehicleBusy} onChange={e => setKey(e.target.value)} placeholder={config?.configured ? '已保存；留空保留现有密钥' : 'sk-…'} className="mt-2 w-full rounded-xl bg-white/5 p-3 text-sm" /></label>
      <label className="block text-xs text-neutral-400">模型名称<input aria-label="DeepSeek 模型名称" value={model} maxLength={80} autoComplete="off" disabled={!available || busy || vehicleBusy} onChange={e => setModel(e.target.value)} className="mt-2 w-full rounded-xl bg-white/5 p-3 text-sm" /></label>
      <label className="block text-xs text-neutral-400">AI 人设提示词<textarea aria-label="AI 人设提示词" rows={5} maxLength={2000} value={persona} disabled={!available || busy || vehicleBusy} onChange={e => setPersona(e.target.value)} placeholder="例如：你是温暖、机智的随车伙伴。用自然简洁的中文回应，适度表达关心，但不要装作知道未提供的信息。" className="mt-2 w-full resize-none rounded-xl bg-white/5 p-3 text-sm" /></label>
      <button type="submit" disabled={!available || busy || vehicleBusy || (!key.trim() && !config?.configured)} className="mobile-button w-full">{busy ? '正在保存…' : '保存并启用 DeepSeek'}</button>
    </form>
    <p className="text-xs leading-6 text-neutral-500">人设与密钥均只保存到自己的 HTTPS 后端；人设会随每次对话发送给 DeepSeek。它只能改变表达风格，不能解除控车权限、车辆在线/P档检查或一次一个动作限制。</p>
    {config?.configured && <div className="grid grid-cols-2 gap-2"><button disabled={busy || vehicleBusy} className="mobile-button text-xs" onClick={() => void save(false, false)}>停用 AI</button><button disabled={busy || vehicleBusy} className="mobile-button text-xs" onClick={() => { if (window.confirm('清除服务器保存的 DeepSeek API Key？此操作不影响 Tesla 授权。')) void save(true); }}>清除 DeepSeek 密钥</button></div>}
    <p role="status" className="break-words text-xs leading-6 text-neutral-400">{notice}</p>
    <p className="text-xs leading-6 text-neutral-500">此卡片仅配置阿里云 DeepSeek。手机直连 Grok 在下方独立设置，不会自动切换服务。</p>
    <Link to="/ai" className="mobile-button w-full">打开 DeepSeek 对话与控车 →</Link>
  </section>;
}
