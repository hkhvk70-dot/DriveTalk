/** 展示状态，不启动收音、合成或车辆操作。 */
export function voiceUiState(state: {
  enabled: boolean; supported: boolean; listening: boolean; speaking: boolean; sending: boolean;
}): { label: string; hint: string } {
  if (!state.enabled) return { label: '助手尚未就绪', hint: '请在设置中登录并启用 DeepSeek。' };
  if (state.listening) return { label: '正在聆听', hint: '说完会回填文字，确认后再发送。最长收音 20 秒。' };
  if (state.speaking) return { label: '正在朗读', hint: '麦克风已停止，可以点击打断。' };
  if (state.sending) return { label: '正在回复', hint: '正在等待助手，不会重复发送。' };
  if (!state.supported) return { label: '使用输入法语音', hint: '系统识别不可用，请在下方输入框使用输入法麦克风。' };
  return { label: '点击开始说话', hint: '不会后台监听；识别后可修改文字。' };
}
