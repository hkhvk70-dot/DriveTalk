import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceUiState } from '../src/services/voice/voice_ui_state.ts';

const idle = { enabled: true, supported: true, listening: false, speaking: false, sending: false };
test('voice screen states distinguish permission readiness, capture, playback and idle', () => {
  assert.match(voiceUiState(idle).label, /开始说话/);
  assert.match(voiceUiState({...idle, enabled:false}).label, /尚未就绪/);
  assert.match(voiceUiState({...idle, supported:false}).label, /输入法/);
  assert.match(voiceUiState({...idle, listening:true}).hint, /确认后再发送/);
  assert.match(voiceUiState({...idle, sending:true}).label, /正在回复/);
  assert.match(voiceUiState({...idle, sending:true, speaking:true}).hint, /麦克风已停止/);
});
test('dedicated voice tab routes to shared safety pipeline, not a second recognizer or dispatcher', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../src/App.tsx'), /path="voice" element={<VoicePage/);
  assert.match(read('../src/components/layout/BottomNav.tsx'), /to: '\/voice', label: '语音'/);
  assert.match(read('../src/components/layout/BottomNav.tsx'), /grid-cols-5/);
  assert.match(read('../src/pages/VoicePage.tsx'), /<GrokPage voiceFirst/);
  const shared = read('../src/pages/GrokPage.tsx');
  assert.match(shared, /\[allow, setAllow\] = useState\(false\)/);
  assert.match(shared, /speech\.current\?\.start\(\)/);
  assert.match(shared, /if \(document.hidden\)/);
  assert.match(shared, /setReadAloud\(ready\)/);
});
