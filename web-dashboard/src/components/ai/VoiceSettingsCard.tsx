import { useEffect, useRef, useState } from 'react';
import { normalizeVoiceReference, voiceSaveBlockReason, voiceConfig, type VoiceConfig } from '../../services/voice/voice_config';
import { useVehicleStore } from '../../stores/mobileVehicleStore';

export default function VoiceSettingsCard() {
  const available = useVehicleStore(s => s.source === 'live' && s.remembered);
  const edited = useRef(false);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [key, setKey] = useState(''), [reference, setReference] = useState('');
  const [model, setModel] = useState('fishaudio-s21pro-flash');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    edited.current = false;
    setKey(''); setConfig(null); setReference(''); setNotice('');
    if (available) void voiceConfig().then(v => {
      if (active) {setConfig(v); if (!edited.current) {setReference(v.referenceId); setModel(v.model);}}
    }).catch(() => {if (active) setNotice('语音后端尚未就绪；文本对话仍可使用。');});
    return () => {active = false;};
  }, [available]);
  async function save(enabled: boolean, clear = false) {
    if (!available || busy) return;
    if (enabled) {
      const reason = voiceSaveBlockReason(available, busy, reference, !!key.trim(), !!config?.configured);
      if (reason) {setNotice(reason); return;}
    }
    const apiKey = key.trim(); setKey(''); setBusy(true); setNotice('');
    try {
      const value = await voiceConfig(clear ? {clear:true} : enabled ?
        {...(apiKey ? {apiKey} : {}), referenceId:normalizeVoiceReference(reference)!, model, enabled:true} : {enabled:false});
      setConfig(value); setReference(value.referenceId);
      setNotice(clear ? 'Fish 密钥与音色配置已清除。' : enabled ? '已加密保存；尚未验证真实合成。请到对话页勾选朗读。' : '语音已停用。');
    } catch (error) {setNotice(error instanceof Error ? error.message : '保存未确认');}
    finally {setBusy(false);}
  }
  const blocked = voiceSaveBlockReason(available, busy, reference, !!key.trim(), !!config?.configured);
  return <section className="mobile-card space-y-4 p-5">
    <h2 className="text-sm font-medium">FishAudio.org 流式语音 · {config?.enabled ? '已启用' : '未启用'}</h2>
    <p className="text-xs text-neutral-400">接入 fishaudio.org 的 Key 和音色，不是 fish.audio。已保存密钥无需重新填写。</p>
    {!available && <p className="text-xs text-amber-200">请先连接并记住登录。</p>}
    <form className="space-y-3" onSubmit={e => {e.preventDefault(); void save(true);}}>
      <label className="block text-xs text-neutral-400">Fish Audio API Key<input type="password" autoComplete="new-password" aria-label="Fish Audio API Key" spellCheck={false} maxLength={256} value={key} disabled={!available || busy} onChange={e => setKey(e.target.value)} placeholder={config?.configured ? '留空保留已保存密钥' : 'Fish 开发者密钥'} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
      <label className="block text-xs text-neutral-400">音色 ID（voiceId）<input aria-label="Fish 音色 ID" aria-describedby="voice-save-reason" autoComplete="off" spellCheck={false} value={reference} disabled={!available || busy} onChange={e => {edited.current = true; setReference(e.target.value);}} placeholder="32 位 ID 或带连字符的 UUID" className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
      <label className="flex items-center justify-between text-xs text-neutral-400">语音模型<select aria-label="Fish 模型" value={model} disabled={!available || busy} onChange={e => {edited.current = true; setModel(e.target.value);}} className="rounded-lg bg-neutral-800 p-2">{['fishaudio-s21pro-flash'].map(v => <option key={v}>{v}</option>)}</select></label>
      <button className="mobile-button w-full disabled:opacity-40" aria-describedby="voice-save-reason" disabled={!!blocked}>{busy ? '正在保存…' : '保存并启用语音'}</button>
      <p id="voice-save-reason" role="status" className="text-xs text-amber-200">{blocked || '格式检查通过，可以保存（尚未验证密钥和音色是否有效）。'}</p>
    </form>
    {config?.configured && <div className="grid grid-cols-2 gap-2"><button className="mobile-button text-xs" disabled={!available || busy} onClick={() => void save(false)}>停用朗读</button><button className="mobile-button text-xs" disabled={!available || busy} onClick={() => {if (window.confirm('清除服务器 Fish 密钥和音色配置？')) void save(false, true);}}>清除语音配置</button></div>}
    <p role="status" className="text-xs text-amber-200">{notice}</p>
    <p className="text-xs leading-6 text-neutral-500">密钥仅保存至加密后端，不在手机持久保存。请自行创建或选择有权使用的音色；这里不自动克隆声音。朗读文本会发送给 Fish Audio，可能产生费用。语音识别兼容性取决于设备，识别服务可能上传录音；不会自动发送识别出的控车指令。</p>
  </section>;
}
