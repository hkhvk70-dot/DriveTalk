import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic, Square, Volume2 } from 'lucide-react';
import { chatGrok, grokConfig } from '../services/grokApi';
import { chatNativeGrok, nativeGrokConfig, grokHistory, nativeGrokConversationAvailable } from '../services/nativeGrok';
import { useVehicleStore } from '../stores/mobileVehicleStore';
import { voiceConfig } from '../services/voice/voice_config';
import { AudioQueue } from '../services/voice/audio_queue';
import { VoicePipeline } from '../services/voice/voice_pipeline';
import { parallelReply } from '../services/voice/parallel_reply';
import { SpeechInput, speechFactory, speechTimingHint, beginSpeechSession, endSpeechSession, speechSessionActive } from '../services/voice/speech_input';
import { asrChoice, asrConfig, type AsrConfig } from '../services/voice/asr_config';
import { AliyunSpeechEngine, cloudCaptureSupported } from '../services/voice/aliyun_speech';
import { usePhoneSpeed } from '../services/voice/use_phone_speed';
import { canResumeCapture, speechRecovery, CaptureStartup } from '../services/voice/hands_free';
import { voiceUiState } from '../services/voice/voice_ui_state';
import { homeAccount } from '../services/smartHomeApi';

interface Turn { id: number; question: string; answer: string; result: string; status: string; provider: 'DeepSeek' | 'Grok' }

export default function GrokPage({ voiceFirst = false }: { voiceFirst?: boolean }) {
  const remembered = useVehicleStore(s => s.remembered);
  const source = useVehicleStore(s => s.source);
  const busy = useVehicleStore(s => s.isLoading);
  const [deepseekEnabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<'deepseek' | 'grok'>('deepseek');
  const [nativeEnabled, setNativeEnabled] = useState(false);
  const enabled = provider === 'grok' ? nativeEnabled : deepseekEnabled;
  const [message, setMessage] = useState('');
  // New public installations require explicit grants; no implicit device actions.
  const [allow, setAllow] = useState(false);
  const [allowHome, setAllowHome] = useState(false);
  const [homeReady, setHomeReady] = useState(false);
  // 只传不具备权限的随机会话标识，不上传客户端历史；待澄清动作由服务端短期保存。
  const homeConversation = useRef(crypto.randomUUID());
  const clearHomeConversation = () => {homeConversation.current = crypto.randomUUID();};
  const [sending, setSending] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState('');
  const [voiceReady, setVoiceReady] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<'loading' | 'ready' | 'finalizing' | 'idle'>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [preparingSpeech, setPreparingSpeech] = useState(false);
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const phoneSpeed = usePhoneSpeed(gpsEnabled);
  const automatic = useRef(false);
  const captureStartup = useRef(new CaptureStartup());
  const captureState = useRef({enabled,listening,sending,speaking,synthesizing,busy,hidden:false});
  captureState.current = {enabled,listening,sending,speaking,synthesizing,busy,hidden:document.hidden};
  const sendingNow = useRef(false);
  const failures = useRef(0);
  const nextListen = useRef(0);
  const autoSend = useRef<(text: string) => void>(() => {});
  const [speechSupported, setSpeechSupported] = useState(false);
  const [speechRevision, setSpeechRevision] = useState(0);
  const [asr, setAsr] = useState<AsrConfig | null>(null);
  const cloudAsr = asrChoice() === 'aliyun';
  const pipeline = useRef<VoicePipeline | null>(null);
  const speech = useRef<SpeechInput | null>(null);
  const controller = useRef<AbortController | null>(null);
  const available = source === 'live' && remembered;
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setHomeReady(false);
    clearHomeConversation();
    if (available) void homeAccount('status', undefined, abort.signal).then(value => {
      if (active) setHomeReady(value.controlConnected && value.controlGranted && value.devices.some(d => d.enabled));
    }).catch(() => {});
    return () => {active = false; abort.abort();};
  }, [available]);
  useEffect(() => {
    let active = true;
    const ready = () => {void nativeGrokConfig().then(c => {if(active)setNativeEnabled(c.configured&&c.enabled&&nativeGrokConversationAvailable());}).catch(()=>{if(active)setNativeEnabled(false);});};
    ready(); window.addEventListener('drivetalk-native-grok-ready',ready);
    return () => {active=false;window.removeEventListener('drivetalk-native-grok-ready',ready);};
  },[]);
  useEffect(() => {
    const ready = () => setSpeechRevision(value => value + 1);
    window.addEventListener('drivetalk-native-ready', ready);
    window.addEventListener('drivetalk-asr-change', ready);
    return () => {window.removeEventListener('drivetalk-native-ready', ready); window.removeEventListener('drivetalk-asr-change', ready);};
  }, []);
  useEffect(() => {
    let active = true; setAsr(null);
    if (available && cloudAsr) void asrConfig().then(value => {if (active) setAsr(value);}).catch(() => {});
    return () => {active = false;};
  }, [available, cloudAsr, speechRevision]);
  useEffect(() => {
    let active = true;
    const factory = cloudAsr ? available && asr?.enabled && asr.configured && cloudCaptureSupported()
      ? () => new AliyunSpeechEngine(speechSessionActive) : undefined : speechFactory();
    setSpeechSupported(!!factory);
    const input = factory ? new SpeechInput(factory, text => {if (active) {
      failures.current = 0;
      if (automatic.current) autoSend.current(text); else setMessage(text);
    }}, value => {captureState.current.listening = value; if (active) setListening(value);}, (text, code) => {if (active) {
      const recovery = speechRecovery(code, failures.current); failures.current = recovery.failures;
      if (automatic.current && recovery.retry) {nextListen.current = Date.now() + recovery.delay; if (code === 'no-speech') return;}
      else {stopHandsFree();}
      setNotice(text);
    }}, text => {if (active) setMessage(text);}, status => {if (active) setSpeechStatus(status);}) : null;
    speech.current = input;
    const audio = new AudioQueue({onSpeechActive: value => {
      if (value) input?.abort(); // 半双工：播音之前停止 ASR，不把 AI 声音录回去。
      captureState.current.speaking = value;
      if (active) setSpeaking(value);
    }});
    const voice = new VoicePipeline(audio, error => {if (active) {
      stopHandsFree();
      setNotice(`朗读已停止：${error.message}；文本回复仍可查看。`);
    }}, value => {captureState.current.synthesizing = value; if (active) setSynthesizing(value);});
    pipeline.current = voice;
    setVoiceReady(false); setReadAloud(false);
    if (available) void voiceConfig().then(v => {
      if (active) { const ready = v.configured && v.enabled; setVoiceReady(ready); setReadAloud(ready); }
    }).catch(() => {});
    const pause = () => {if (document.hidden) {clearHomeConversation(); stopHandsFree(); setGpsEnabled(false); controller.current?.abort(); voice.interrupt();}};
    const nativePause = () => {clearHomeConversation(); stopHandsFree(); setGpsEnabled(false); controller.current?.abort(); voice.interrupt();};
    document.addEventListener('visibilitychange', pause);
    window.addEventListener('drivetalk-native-pause', nativePause);
    return () => {
      active = false; document.removeEventListener('visibilitychange', pause);
      window.removeEventListener('drivetalk-native-pause', nativePause);
      automatic.current = false; captureStartup.current.cancel(); endSpeechSession();
      input?.abort(); controller.current?.abort(); voice.interrupt();
      void audio.dispose().catch(() => {}); speech.current = null; pipeline.current = null;
    };
  }, [available, speechRevision, voiceFirst, cloudAsr, asr?.enabled, asr?.configured]);
  useEffect(() => {
    let active = true;
    if (available) void grokConfig().then(value => { if (active) setEnabled(value.enabled && value.configured); }).catch(() => { if (active) setNotice('AI 后端尚未就绪，请在设置中配置或部署新版后端。'); });
    else { setEnabled(false); setTurns([]); }
    return () => { active = false; controller.current?.abort(); };
  }, [available]);
  async function send(recognized?: string) {
    const raw = (recognized ?? message).trim();
    if (!enabled || busy || sendingNow.current || !raw || (recognized === undefined && listening)) return;
    if (raw.length > 1850) {setMessage(raw); setNotice('消息超过1850字，已保留原文，请编辑后再发送；未自动发送。'); stopHandsFree(); return;}
    sendingNow.current = true;
    const gpsContext = gpsEnabled ? `【手机GPS参考：${phoneSpeed.kmh === null ? '速度未知/信号不可用' : phoneSpeed.kmh + ' km/h'}。不是车辆传感器数据，不用于替代控车安全检查。】\n` : '';
    const question = gpsContext + raw; setMessage(''); setSending(true); setNotice('');
    const id = Date.now(); const abort = new AbortController(); controller.current = abort;
    speech.current?.abort();
    const voice = readAloud && voiceReady ? pipeline.current : null;
    pipeline.current?.interrupt();
    const stopAudio = () => voice?.interrupt();
    abort.signal.addEventListener('abort', stopAudio, {once:true});
    setTurns(previous => [...previous.slice(-19), { id, question: raw, answer: '', result: provider === 'grok' ? '手机直连 Grok，聊天通道不执行控车' : '正在处理，尚未确认任何操作', status: 'pending', provider: provider === 'grok' ? 'Grok' : 'DeepSeek' }]);
    const update = (fields: Partial<Turn>) => setTurns(previous => previous.map(turn => turn.id === id ? { ...turn, ...fields } : turn));
    const task = async () => {
      let chatStarted = false;
      try {
        abort.signal.throwIfAborted();
        chatStarted = true;
        const history=grokHistory(turns);
        const chat: typeof chatGrok = provider === 'grok' ? (q,a,s,event)=>chatNativeGrok(q,a,s,event,history) : chatGrok;
        await parallelReply(voice, abort.signal, receive => chat(question, provider === 'deepseek' && allow, abort.signal, receive,
          undefined, { allowHomeControl: provider === 'deepseek' && allowHome && homeReady,
            ...(provider === 'deepseek' ? {conversationId: homeConversation.current} : {}) }), event => {
          if (event.type === 'snapshot') useVehicleStore.getState().receiveAssistantSnapshot(event.data, event.fresh);
          else if (event.type === 'text_delta') setTurns(previous => previous.map(turn => turn.id === id ? { ...turn, answer: turn.answer + event.message } : turn));
          else if (event.type === 'text') update({ answer: event.message });
          else if (event.type === 'result') {
            update({ result: event.message, status: event.status });
            if (['unknown', 'not_sent'].includes(event.status) || (event.target === 'home' && event.status === 'accepted')) {
              clearHomeConversation(); stopHandsFree();
              setNotice(event.target === 'home' && event.status === 'accepted'
                ? '家居命令已受理，状态暂未确认；已暂停连续会话。请查看设备实际状态，勿重复发送。'
                : `结果未确认，已暂停连续会话。请先确认${event.target === 'home' ? '家居设备' : '车辆'}状态，勿重复操作。`);
            }
          }
          else if (event.type === 'status' || event.type === 'tool_call') update({ result: event.message });
        }, error => {
          stopHandsFree(); setReadAloud(false);
          setNotice(`朗读已停止：${error.message}；文本请求继续处理，请勿重复发送。`);
        });
      } catch (error) {
        clearHomeConversation();
        stopHandsFree();
        voice?.interrupt();
        const text = !chatStarted ? `本次消息未发送：${error instanceof Error ? error.message : '语音未就绪'}` : provider === 'grok' && abort.signal.aborted ? 'Grok 回复已停止，未发送车辆动作。' : abort.signal.aborted ? '已停止读取回复；这不能撤回已发指令，请检查车辆，勿重复发送。' : error instanceof Error ? error.message : 'AI 连接未确认，请检查车辆，勿重复发送';
        update({ result: text, status: chatStarted ? 'unknown' : 'not_sent' });
      }
    };
    // 手机聊天不需要 Tesla 登录，也不取得车辆操作锁；DeepSeek 仍保持原控车串行保护。
    const started = provider === 'grok' ? (await task(), true) : await useVehicleStore.getState().runAssistant(task);
    if (!started) {stopHandsFree(); update({ result: '车辆服务正忙，本次消息未发送。', status: 'not_sent' });}
    abort.signal.removeEventListener('abort', stopAudio);
    controller.current = null; sendingNow.current = false; setSending(false);
  }
  autoSend.current = text => {
    if (busy || sendingNow.current || !enabled) {stopHandsFree(); setMessage(text); setNotice('服务暂时不可用，本句未发送；已暂停连续会话。'); return;}
    void send(text);
  };
  function stopHandsFree() {automatic.current = false; captureStartup.current.cancel(); setPreparingSpeech(false); setHandsFree(false); endSpeechSession(); speech.current?.abort();}
  function mayStartCapture() {
    return automatic.current && !sendingNow.current && !speech.current?.isActive &&
      canResumeCapture({...captureState.current, hidden:document.hidden, busy:useVehicleStore.getState().isLoading});
  }
  async function startHandsFree() {
    if (automatic.current || captureStartup.current.preparing || !enabled || busy || sending || speaking || synthesizing || !speechSupported) return;
    speech.current?.abort(); // 将手动收音明确结束后，再开启新的连续会话。
    if (!beginSpeechSession()) {setNotice('连续会话需要新版 APK，请先升级。'); return;}
    automatic.current = true; setHandsFree(true); failures.current = 0; nextListen.current = 0; setNotice('');
    setPreparingSpeech(true);
    try {await captureStartup.current.start(async () => {if (readAloud && voiceReady) await pipeline.current?.prepareAudio();},
      mayStartCapture, () => speech.current?.start());}
    catch {stopHandsFree(); setNotice('无法启用声音，请重新开启会话。'); return;}
    setPreparingSpeech(captureStartup.current.preparing);
  }
  useEffect(() => {
    if (!handsFree) return;
    const expiry = setTimeout(() => {stopHandsFree(); setNotice('会话已达15分钟，已停止收音；可重新开启。');}, 15 * 60 * 1000);
    return () => clearTimeout(expiry);
  }, [handsFree]);
  useEffect(() => {
    if (!handsFree || !canResumeCapture({enabled,listening,sending,speaking,synthesizing,busy,hidden:document.hidden,preparing:preparingSpeech}) || captureStartup.current.preparing) return;
    const timer = setTimeout(() => {
      // 超时触发时再次读最新状态，不能用安排定时器时的旧闭包。
      if (!captureStartup.current.preparing && mayStartCapture()) speech.current?.start();
    }, Math.max(700, nextListen.current - Date.now()));
    return () => clearTimeout(timer);
  }, [handsFree, listening, sending, speaking, synthesizing, busy, enabled, preparingSpeech]);
  function dictate() {
    if (!enabled || busy || sending || captureStartup.current.preparing) return;
    pipeline.current?.interrupt(); setNotice('');
    if (listening) speech.current?.stop();
    else speech.current?.start();
  }
  function interrupt() {
    clearHomeConversation();
    stopHandsFree();
    controller.current?.abort(); pipeline.current?.interrupt(); speech.current?.abort();
  }
  const voiceStatus = voiceUiState({enabled, supported: speechSupported, listening, speaking, sending});
  const conversation = <div aria-live="polite" className="space-y-3">{turns.map(turn => <article key={turn.id} className="mobile-card space-y-3 break-words p-4">
    <p className="text-sm text-neutral-200">你：{turn.question}</p>
    {turn.answer && <p className="whitespace-pre-wrap text-sm leading-6 text-neutral-400">{turn.provider}：{turn.answer}</p>}
    <p className={`rounded-xl p-3 text-xs leading-6 ${['unknown', 'not_sent', 'accepted'].includes(turn.status) ? 'bg-amber-400/10 text-amber-200' : turn.status === 'confirmed' ? 'bg-emerald-400/10 text-emerald-200' : 'bg-white/5 text-neutral-300'}`}>{turn.result}</p>
  </article>)}</div>;
  return <section className={voiceFirst ? 'flex flex-col gap-4' : 'space-y-5'}>
    <div className="mobile-card space-y-3 p-5">
      <div className="flex items-center justify-between"><h2 className="font-medium">{voiceFirst ? '说话、聊天与控车' : 'AI 对话'}</h2><Link to="/settings" className="min-h-11 inline-flex items-center text-xs text-sky-300">语音与密钥设置</Link></div>
      <label className="flex items-center justify-between gap-3 text-sm">当前通道<select aria-label="AI 通道" value={provider} disabled={sending||speaking||synthesizing||busy||handsFree} onChange={e=>{clearHomeConversation();stopHandsFree();pipeline.current?.interrupt();setProvider(e.target.value as 'deepseek'|'grok');setNotice('');}} className="rounded-xl bg-white/10 p-3"><option value="deepseek">DeepSeek · 聊天与控车 / 控家</option><option value="grok">Grok · 手机直连聊天</option></select></label>
      {provider==='grok'&&<><p className="text-xs leading-6 text-sky-300">通过手机网络直接连接 xAI，不经过阿里云。只使用你的人设，不加 App 固定聊天提示词。带入本页最近6轮成功聊天（最多12000字）；离页即清除。此通道没有控车工具。</p><button className="mobile-button w-full text-xs" disabled={sending||speaking||synthesizing||handsFree} onClick={()=>setTurns(previous=>previous.filter(t=>t.provider!=='Grok'))}>清除 Grok 对话上下文</button></>}
      {provider==='deepseek'&&<p className="text-xs leading-6 text-neutral-400">支持日常聊天；一般问题仍独立处理。家居指令可用自然称呼，有歧义会追问，可接着回答“我示例区域甲的那个”。待澄清请求只在本页短期保留（2分钟），切后台、取消或换话题失效；控车仍一次一个明确动作，不自动唤醒。</p>}
      {provider==='deepseek'&&<label className="flex items-start gap-3 rounded-xl bg-white/5 p-3 text-sm"><input type="checkbox" className="mt-1" checked={allow} disabled={!enabled || busy || handsFree} onChange={e => setAllow(e.target.checked)} /><span>允许本页发送的自然语言指令直接控车<span className="mt-1 block text-xs leading-5 text-neutral-500">默认关闭；请明确授权本页操作，离开后不保留此授权。只有主动发送或开启连续会话后才会执行，误识别可能导致动作。仍需在线并授权；仅备箱和充电口盖要求 P 档，不自动唤醒。</span></span></label>}
      {provider==='deepseek'&&<label className="flex items-start gap-3 rounded-xl bg-white/5 p-3 text-sm"><input type="checkbox" className="mt-1" checked={allowHome} disabled={!enabled || !homeReady || busy || sending || handsFree} onChange={e => {clearHomeConversation();setAllowHome(e.target.checked);}} /><span>允许本页语音 / 文字控制所选米家设备<span className="mt-1 block text-xs leading-5 text-neutral-500">{homeReady ? '可说“帮我打开智能插座”或“把智能空调3调到24度”。模型理解称呼，后端核对具体设备；名称或房间不清楚时先问你，不猜测执行。灯具、插座、空调各类每日最多20次，执行后回读。房间称呼需在米家同步后可用。' : '默认不授予家居控制；服务未就绪时不会发送家居指令。请先到设置完成米家登录；已适配的设备默认选中，明确关闭的设备不会重新开启。'}</span></span></label>}
      {provider==='deepseek'&&<button type="button" className="mobile-button w-full text-xs" onClick={()=>{interrupt();setNotice('已清除本页待澄清请求。之后请重新说完整指令；不能撤回已发送的动作。');}}>清除待澄清的家居请求</button>}
      {!enabled && <p className="text-xs text-amber-200">{provider==='grok' ? '请安装2.0.4或更新的 APK，并在设置中填写 xAI Key 和准确的模型 ID、启用手机 Grok。' : '请记住登录，并在设置中填写 API Key、启用 DeepSeek。'}</p>}
      {notice && <p role="alert" className="text-xs text-amber-200">{notice}</p>}
    </div>
    {voiceFirst && <div className="mobile-card flex flex-col items-center px-5 py-7 text-center">
      <p className="text-[10px] tracking-[0.2em] text-neutral-500">DRIVETALK VOICE</p>
      <button type="button" className="mobile-button mt-4 w-full" disabled={!handsFree && (!enabled || busy || sending || speaking || synthesizing || !speechSupported)} onClick={() => {if (handsFree) stopHandsFree(); else void startHandsFree();}}>{handsFree ? '结束连续会话' : '开启连续会话（识别后自动发送）'}</button>
      <p className="mt-2 text-xs leading-6 text-neutral-400">前台最长15分钟。开启后无需逐句点击；朗读时暂停收音，结束后继续。暂不支持朗读中语音插话；切后台或离页即停止。系统识别可能使用网络和耗电，消息会消耗模型/语音额度。</p>
      <button type="button" className="mobile-button mt-3 w-full" onClick={() => setGpsEnabled(value => !value)}>{gpsEnabled ? '停止手机 GPS 测速' : '开启手机 GPS 测速'}</button>
      <p role="status" className="mt-2 text-sm">手机 GPS：{phoneSpeed.kmh === null ? '—' : phoneSpeed.kmh} km/h {gpsEnabled ? phoneSpeed.error || (phoneSpeed.kmh === null ? '等待有效速度（不会使用 Fleet 车速）' : `精度约 ${Math.round(phoneSpeed.accuracy ?? 0)} 米`) : '未启用'}</p>
      <button type="button" aria-label={listening ? '停止收音' : speaking || sending ? '打断回复与朗读' : '开始语音识别'}
        aria-pressed={listening} disabled={!enabled || (!listening && !speaking && !sending && (busy || !speechSupported))}
        onClick={() => { if (handsFree || speaking || sending) interrupt(); else dictate(); }}
        className={`my-6 flex h-28 w-28 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300 disabled:opacity-35 ${listening ? 'bg-sky-300 text-[#171a20]' : 'bg-white/10 text-white'}`}>
        {listening || sending ? <Square size={32} aria-hidden="true" /> : speaking ? <Volume2 size={38} aria-hidden="true" /> : <Mic size={38} strokeWidth={1.6} aria-hidden="true" />}
      </button>
      <h2 role="status" className="text-xl font-medium">{preparingSpeech ? '正在准备连续会话…' : handsFree && !speaking && !sending ? '连续会话 · 等你说话' : voiceStatus.label}</h2>
      <p className="mt-2 max-w-xs text-xs leading-6 text-neutral-400">{handsFree ? speaking || synthesizing ? '朗读期间关闭麦克风，结束后自动续听。' : sending ? '正在处理这一句，不会重复发送。' : '完整识别后自动发送；超时或异常只保留草稿。说话前请确认正在收音。' : voiceStatus.hint}</p>
      <span className={`mt-4 rounded-full px-3 py-1.5 text-xs ${provider === 'deepseek' && (allow || allowHome) ? 'bg-amber-400/10 text-amber-200' : 'bg-white/5 text-neutral-400'}`}>{provider === 'deepseek' && allow ? '本页已允许控车 · 备箱/充电口盖需 P 档' : '不发送车辆动作'}{provider === 'deepseek' && allowHome && homeReady ? ' · 已允许所选设备控家' : ' · 不控家'}</span>
    </div>}
    {!voiceFirst && conversation}
    <form className="mobile-card space-y-3 p-4" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={readAloud} disabled={!voiceReady || sending || busy} onChange={e => {setReadAloud(e.target.checked); if (!e.target.checked) pipeline.current?.interrupt();}} />流式朗读回复（Fish Audio）</label>
      {!voiceReady && <p className="text-xs text-neutral-500">朗读未就绪，请在设置中配置 Fish 音色并启用语音；可继续文字对话。</p>}
      {!voiceFirst && (speechSupported ? <button type="button" disabled={!enabled || busy || sending} onClick={dictate} className="mobile-button w-full">{listening ? '停止收音' : '说话输入（确认后再发送）'}</button> : <p className="text-xs text-neutral-500">{cloudAsr ? '阿里云识别暂未就绪，请查看下方原因或到设置检查。' : '本地/系统识别不可用，请使用输入法语音输入。'}</p>)}
      <p className="text-xs leading-6 text-neutral-500">{cloudAsr ? !cloudCaptureSupported() ? '阿里云主引擎需要支持 PCM 桥接的新版 APK，普通浏览器需要麦克风权限。' : !asr?.enabled ? '阿里云主引擎尚未就绪，请在设置中保存北京区 Key 和 Workspace ID；不自动降级。' : '阿里云流式识别；停说约2秒结束，最长2分钟，故障保留草稿、不重发。' : speechTimingHint()}</p>
      <p role="status" className="text-xs text-neutral-400">{preparingSpeech ? '正在准备音频；尚未启动收音，可点击结束连续会话。' : listening && speechStatus === 'finalizing' ? '收音已停止，正在等待阿里云完整识别结果；未发送消息。' : listening && speechStatus === 'loading' ? cloudAsr ? '正在授权麦克风/连接阿里云识别；尚未上传音频，可点击停止。' : '正在加载手机离线识别模型，尚未收音；首次可能较慢，可点击停止。' : listening ? `正在收音，识别文字会显示在下方；${handsFree ? '完整结果自动发送，异常草稿不自动发送。' : '确认后再发送。'}${cloudAsr ? '本次录音发往阿里云，不在本应用保存；可能产生费用。' : speechStatus === 'ready' ? '当前本地识别不保存或上传录音。' : '录音可能由手机系统或浏览器识别服务处理。'}` : speaking || synthesizing ? '正在合成/朗读 · 麦克风已停止' : handsFree ? '连续会话开启 · 自动续听' : '点击收音；不会后台监听或自动发送。'}</p>
      <label className="block text-xs text-neutral-400">消息或明确车辆指令<textarea aria-label="DeepSeek 消息" rows={3} value={message} disabled={!enabled || busy || listening} onChange={e => setMessage(e.target.value)} placeholder={allow ? '可以聊天；控车例如：关闭空调（一次一个动作）' : '例如：写一段约50字的旅行介绍，测试朗读'} className="mt-2 w-full resize-none rounded-xl bg-white/5 p-3 text-sm" /></label>
      {message.length > 1850 && <p role="status" className="text-xs text-amber-200">已保留全部识别文字（{message.length}字），请缩短至1850字后发送。</p>}
      <button type="submit" disabled={!enabled || busy || listening || message.length > 1850 || !message.trim()} className="mobile-button w-full">{sending ? '正在处理…' : allow || allowHome ? '发送并执行（按独立授权）' : '发送（仅聊天/读快照）'}</button>
      {(sending || speaking || readAloud) && <button type="button" onClick={interrupt} className="mobile-button w-full text-xs">打断回复与朗读（不撤回已发指令）</button>}
    </form>
    {voiceFirst && conversation}
    <p className="text-xs leading-6 text-neutral-500">服务器结果卡是执行依据，不以模型聊天文字认定动作完成。结果未知时先在官方 App 或现场确认，不要重复操作。密钥不要粘贴到对话里；消息会发送给 {provider==='grok'?'xAI（手机直连）':'DeepSeek'}。</p>
  </section>;
}
