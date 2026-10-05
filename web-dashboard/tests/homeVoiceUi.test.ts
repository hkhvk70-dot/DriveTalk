import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('control grants default off, home readiness is required, native chat stays isolated', () => {
  const source = readFileSync(new URL('../src/pages/GrokPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\[allow, setAllow\] = useState\(false\)/);
  assert.match(source, /\[allowHome, setAllowHome\] = useState\(false\)/);
  assert.match(source, /allowHomeControl: provider === 'deepseek' && allowHome && homeReady/);
  assert.match(source, /value.controlConnected && value.controlGranted/);
  assert.match(source, /await parallelReply\(voice, abort.signal, receive => chat\(question, provider === 'deepseek' && allow/);
  assert.match(source, /checked=\{allowHome\} disabled=\{!enabled \|\| !homeReady \|\| busy \|\| sending \|\| handsFree\}/);
});

test('settings defaults come from server, opt-outs are explicitly saved without duplicate grant dialog', () => {
  const source = readFileSync(new URL('../src/components/smarthome/SmartHomeSettingsCard.tsx', import.meta.url), 'utf8');
  assert.match(source, /setSelected\(value.devices.filter\(d => d.enabled\)/);
  assert.doesNotMatch(source, /action === 'select'.*window.confirm/);
  assert.match(source, /action === 'select' && account\?\.controlConnected === true/);
  assert.match(source, /value.controlGranted/);
});

test('default grants do not start microphone, GPS, paid synthesis or automatic send', () => {
  const source = readFileSync(new URL('../src/pages/GrokPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\[handsFree, setHandsFree\] = useState\(false\)/);
  assert.match(source, /\[gpsEnabled, setGpsEnabled\] = useState\(false\)/);
  assert.match(source, /const pause = .*stopHandsFree\(\).*voice.interrupt\(\)/);
  assert.match(source, /const nativePause = .*stopHandsFree\(\).*voice.interrupt\(\)/);
  assert.match(source, /function stopHandsFree\(\).*automatic.current = false.*captureStartup.current.cancel\(\).*setHandsFree\(false\).*endSpeechSession\(\).*speech.current\?\.abort\(\)/);
  assert.match(source, /setVoiceReady\(ready\); setReadAloud\(ready\)/);
});
