import { useEffect, useState } from 'react';
import { asrChoice, chooseAsr, asrConfig, type AsrConfig, type AsrChoice } from '../../services/voice/asr_config';
import { cloudCaptureSupported } from '../../services/voice/aliyun_speech';
import { useVehicleStore } from '../../stores/mobileVehicleStore';

export default function AsrSettingsCard() {
  const available = useVehicleStore(s => s.source === 'live' && s.remembered);
  const [config, setConfig] = useState<AsrConfig | null>(null);
  const [key, setKey] = useState(''), [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [engine, setEngine] = useState<AsrChoice>(asrChoice());
  useEffect(() => {
    let active = true;
    setKey(''); setConfig(null); setWorkspace('');
    if (available) void asrConfig().then(value => {
      if (active) {setConfig(value); setWorkspace(value.workspaceId);}
    }).catch(() => {if (active) setNotice('阿里云识别后端尚未部署或登录失效。');});
    return () => {active = false;};
  }, [available]);
  async function save(enabled: boolean, clear = false) {
    if (!available || busy) return;
    const apiKey = key.trim(); setKey(''); setBusy(true); setNotice('');
    try {
      const value = await asrConfig(clear ? {clear:true} : enabled ?
        {...(apiKey ? {apiKey} : {}),workspaceId:workspace.trim(),enabled:true} : {enabled:false});
      setConfig(value); setWorkspace(value.workspaceId);
      chooseAsr(engine);
      setNotice(clear ? '识别密钥已清除。' : enabled ? '已加密保存；尚未进行真实识别验证，实际收音会产生阿里云费用。' : '已停用云端识别，不自动降级。');
    } catch (error) {setNotice(error instanceof Error ? error.message : '保存未确认；未自动重试');}
    finally {setBusy(false);}
  }
  const blocked = !available || busy || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(workspace.trim()) || (!key.trim() && !config?.configured);
  return <section className="mobile-card space-y-4 p-5">
    <h2 className="text-sm font-medium">语音识别 · 阿里云主引擎</h2>
    <label className="flex items-center justify-between gap-3 text-xs text-neutral-400">当前识别引擎<select aria-label="识别引擎" value={engine} onChange={e => {const value = e.target.value as AsrChoice; setEngine(value); chooseAsr(value);}} className="rounded-lg bg-neutral-800 p-2"><option value="aliyun">阿里云流式识别（默认）</option><option value="local">本地 / 系统识别（手动备用）</option></select></label>
    <p className="text-xs leading-6 text-neutral-400">Fun-ASR，北京地域。边说边显示文字，停说约2秒提交整句；单段最长2分钟。不会因网络失败自动切换引擎。本次选择不持久保存，重开 App 默认阿里云。</p>
    {!cloudCaptureSupported() && <p className="text-xs text-amber-200">此 APK 尚不支持云端 PCM 收音，请安装2.0.8或更新版本；不会静默使用旧系统识别。</p>}
    <form className="space-y-3" onSubmit={e => {e.preventDefault(); void save(true);}}>
      <label className="block text-xs text-neutral-400">百炼北京区 API Key<input type="password" aria-label="阿里云识别 API Key" autoComplete="new-password" spellCheck={false} maxLength={256} disabled={!available || busy} value={key} onChange={e => setKey(e.target.value)} placeholder={config?.configured ? '留空保留已保存密钥' : '不是 Tesla / DeepSeek / Fish Key'} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
      <label className="block text-xs text-neutral-400">Workspace ID<input aria-label="阿里云 Workspace ID" autoComplete="off" spellCheck={false} maxLength={63} disabled={!available || busy} value={workspace} onChange={e => setWorkspace(e.target.value)} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
      <button disabled={blocked} className="mobile-button w-full disabled:opacity-40">{busy ? '正在保存…' : '保存并启用阿里云识别'}</button>
    </form>
    {config?.configured && <div className="grid grid-cols-2 gap-2"><button disabled={!available || busy} className="mobile-button text-xs" onClick={() => void save(false)}>停用云端识别</button><button disabled={!available || busy} className="mobile-button text-xs" onClick={() => {if (window.confirm('清除服务器阿里云识别密钥？')) void save(false,true);}}>清除识别配置</button></div>}
    <p role="status" className="text-xs text-amber-200">{notice || (!available ? '请先连接后端并记住登录。' : config?.enabled ? '配置已启用（不代表实际识别已验证）。' : '云端识别未启用。')}</p>
    <p className="text-xs leading-6 text-neutral-500">启用后本次收音会经 DriveTalk 发往阿里云识别，不在本应用保存录音；阿里云的数据处理政策以其说明为准。Key仅保存在加密后端。本应用每天最多1小时上传音频、300次收音；故障保留文字草稿，不自动重发。朗读继续使用 Fish，聊天继续使用已选模型。</p>
  </section>;
}
