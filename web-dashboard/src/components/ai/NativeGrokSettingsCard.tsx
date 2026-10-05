import { useEffect, useState } from 'react';
import { nativeGrokAvailable, nativeGrokConfig } from '../../services/nativeGrok';

export default function NativeGrokSettingsCard() {
  const [available,setAvailable] = useState(nativeGrokAvailable);
  const [key,setKey] = useState(''); const [model,setModel] = useState('');
  const [persona,setPersona] = useState(''); const [configured,setConfigured] = useState(false);
  const [enabled,setEnabled] = useState(false); const [busy,setBusy] = useState(false); const [notice,setNotice] = useState('');
  useEffect(() => {
    const ready = () => setAvailable(nativeGrokAvailable());
    window.addEventListener('drivetalk-native-grok-ready',ready);
    return () => window.removeEventListener('drivetalk-native-grok-ready',ready);
  },[]);
  useEffect(() => {
    let active = true;
    if (available) void nativeGrokConfig().then(c => {if(active){setConfigured(c.configured);setEnabled(c.enabled);setModel(c.model);setPersona(c.persona);}}).catch(e => {if(active)setNotice(e.message);});
    return () => {active=false;};
  },[available]);
  async function save(clear=false) {
    setBusy(true);setNotice(''); const apiKey=key;setKey('');
    try {
      const c=await nativeGrokConfig(clear ? {clear:true} : {apiKey,model,persona,enabled:true});
      setConfigured(c.configured);setEnabled(c.enabled);setModel(c.model);setPersona(c.persona);
      setNotice(clear ? '已删除手机保存的 Grok 配置。' : '已加密保存到本机；未调用付费模型。到语音页选择 Grok 即可聊天。');
    } catch(e) {setNotice(e instanceof Error ? e.message : '保存失败');} finally{setBusy(false);}
  }
  return <section className="mobile-card space-y-3 p-5">
    <h2 className="text-sm font-medium">Grok · 手机直连官方 API</h2>
    <p className="text-xs leading-6 text-neutral-400">{available ? enabled&&configured ? '本机已启用' : '本机未启用' : '需要安装支持直连的新版 APK；普通网页不可用。'} 手机代理须覆盖 DriveTalk。此通道仅聊天，控车继续用 DeepSeek；朗读仍经阿里云 Fish Audio。</p>
    <label className="block text-xs">xAI API Key<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={!available||busy} onChange={e=>setKey(e.target.value)} placeholder={configured?'已保存，留空保留原 Key':'xai-…'} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
    <label className="block text-xs">模型 ID（按 xAI 控制台填写）<input value={model} disabled={!available||busy} maxLength={80} onChange={e=>setModel(e.target.value)} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
    <label className="block text-xs">Grok 人设提示词<textarea value={persona} disabled={!available||busy} rows={3} maxLength={2000} onChange={e=>setPersona(e.target.value)} className="mt-2 w-full rounded-xl bg-white/5 p-3" /></label>
    <button disabled={!available||busy||!model.trim()||(!configured&&!key.trim())} onClick={()=>void save()} className="mobile-button w-full">保存并启用手机 Grok</button>
    <button disabled={!available||busy||!configured} onClick={()=>void save(true)} className="mobile-button w-full">删除本机 Grok Key</button>
    {notice&&<p role="status" className="text-xs leading-6 text-amber-200">{notice}</p>}
    <p className="text-xs leading-6 text-neutral-500">Key 用 Android Keystore 加密保存，不上传阿里云、不写网页存储。聊天内容会发送给 xAI；启用朗读时回复文本还会发送到 Fish Audio。</p>
    <p className="text-xs leading-6 text-neutral-500">2.0.4 APK 起，人设留空就不发送 system 提示词；填写后原样发送。App 不添加话题限制，模型本身的规则仍由 xAI 决定。</p>
  </section>;
}
