package org.drivetalk.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import org.json.JSONObject;
import java.util.ArrayList;

/** 仅语音输入桥；不暴露令牌、网络请求或车辆能力。所有调用都在主线程。 */
final class NativeSpeech {
    static final String PROMPT = "DRIVETALK_NATIVE_SPEECH_V1";
    private final ComponentActivity activity;
    private final WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ActivityResultLauncher<String> permission;
    private SpeechRecognizer recognizer;
    private final OfflineSpeech offline;
    private final CloudAudioCapture cloud;
    private boolean cloudMode, cloudRecording;
    private String currentId;
    private boolean permissionPending;
    private boolean destroyed;
    private long sessionUntil;
    static final int SILENCE_MILLIS = 2000;
    static final int CAPTURE_LIMIT_MILLIS = 120000;
    private static final int FINAL_WAIT_MILLIS = 5000;
    private static final int TEXT_LIMIT = 12000;
    private String stoppingReason;
    private final Runnable timeout = () -> stopCapture("timeout");
    private final Runnable finalTimeout = () -> finish("error", stoppingReason == null ? "timeout" : stoppingReason);

    NativeSpeech(ComponentActivity activity, WebView web) {
        this.activity = activity; this.web = web;
        offline = new OfflineSpeech(activity);
        cloud = new CloudAudioCapture(activity);
        permission = activity.registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            permissionPending = false;
            if (destroyed || currentId == null) return;
            if (granted) { if (cloudMode) emit(currentId, "prepared", "", null); else listen(); }
            else finish("error", "not-allowed");
        });
    }

    boolean trustedPage() {
        return !destroyed && web.getUrl() != null && MainActivity.trusted(android.net.Uri.parse(web.getUrl()));
    }

    void publishAvailability() {
        if (!trustedPage()) return;
        boolean available = BuildConfig.OFFLINE_ASR || SpeechRecognizer.isRecognitionAvailable(activity);
        // prompt 桥由 WebChromeClient 核对来源；不使用对所有 iframe 暴露的 addJavascriptInterface。
        String script = "(()=>{if(window.__DriveTalkNativeSpeech)return;"
            + "window.__DriveTalkNativeSpeech=Object.freeze({version:4,cloudPcm:true,engine:'" + (BuildConfig.OFFLINE_ASR ? "offline-vosk" : "system") + "',silenceMs:" + SILENCE_MILLIS + ",available:" + available + ",request:(action,id)=>{"
            + "if((action==='begin'||action==='start'||action==='cloud-prepare')&&(!navigator.userActivation||!navigator.userActivation.isActive))throw Error('需要点击开启收音');"
            + "return window.prompt('" + PROMPT + "',JSON.stringify({action,id}))==='accepted';}});"
            + "window.dispatchEvent(new Event('drivetalk-native-ready'));})()";
        web.evaluateJavascript(script, null);
    }

    boolean request(String json) {
        if (!trustedPage() || !activity.getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) || json == null || json.length() > 256) return false;
        try {
            JSONObject value = new JSONObject(json);
            if (value.length() != 2) return false;
            String id = value.getString("id"), action = value.getString("action");
            if (!id.matches("[a-fA-F0-9-]{36}")) return false;
            if ("begin".equals(action)) {
                sessionUntil = android.os.SystemClock.elapsedRealtime() + 15 * 60 * 1000;
                return true;
            }
            if ("end".equals(action)) { endSession(); return true; }
            if ("cloud-heard".equals(action)) {
                if (!id.equals(currentId) || !cloudMode || !cloudRecording) return false;
                cloud.heard(); return true;
            }
            if ("cloud-record".equals(action)) {
                if (!id.equals(currentId) || !cloudMode || cloudRecording || permissionPending) return false;
                cloudRecording = true;
                cloud.start(new CloudAudioCapture.Listener() {
                    @Override public void ready() { if (id.equals(currentId)) emit(id, "status", "ready", null); }
                    @Override public void frame(byte[] bytes, Runnable consumed) {
                        if (!id.equals(currentId) || !trustedPage()) { consumed.run(); return; }
                        String detail = "{id:" + JSONObject.quote(id) + ",type:'pcm',text:"
                            + JSONObject.quote(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)) + "}";
                        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('drivetalk-native-speech',{detail:" + detail + "}));", result -> consumed.run());
                    }
                    @Override public void ended(String reason) {
                        if (!id.equals(currentId)) return;
                        cancel(); emit(id, "capture-end", "", reason);
                    }
                });
                return true;
            }
            if ("cloud-continue".equals(action)) {
                if (android.os.SystemClock.elapsedRealtime() >= sessionUntil) return false;
                action = "cloud-prepare";
            }
            if ("cloud-prepare".equals(action)) {
                if (currentId != null || permissionPending) return false;
                currentId = id; cloudMode = true;
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                    emit(id, "prepared", "", null);
                else { permissionPending = true; permission.launch(Manifest.permission.RECORD_AUDIO); }
                return true;
            }
            if ("continue".equals(action)) {
                if (android.os.SystemClock.elapsedRealtime() >= sessionUntil) return false;
                action = "start";
            }
            if ("cancel".equals(action)) {
                if (id.equals(currentId)) cancel();
                return true;
            }
            if ("stop".equals(action)) {
                if (id.equals(currentId) && cloudMode) { cloud.stop("stopped"); return true; }
                if (!id.equals(currentId) || (!BuildConfig.OFFLINE_ASR && recognizer == null)) return false;
                stopCapture("stopped"); return true;
            }
            if (!"start".equals(action) || currentId != null || permissionPending || (!BuildConfig.OFFLINE_ASR && !SpeechRecognizer.isRecognitionAvailable(activity))) return false;
            currentId = id;
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) listen();
            else { permissionPending = true; permission.launch(Manifest.permission.RECORD_AUDIO); }
            return true;
        } catch (Exception ignored) {
            finish("error", "unavailable"); return false;
        }
    }

    private void listen() {
        if (!trustedPage() || currentId == null) { cancel(); return; }
        final String id = currentId;
        if (BuildConfig.OFFLINE_ASR) {
            offline.start(new OfflineSpeech.Listener() {
                private boolean active() { return id.equals(currentId); }
                @Override public void status(String value) { if (active()) emit(id, "status", value, null); }
                @Override public void partial(String text) { if (active()) emit(id, "partial", text, null); }
                @Override public void ended(String text, String reason) {
                    if (!active()) return;
                    if ("complete".equals(reason) && stoppingReason == null && !text.isEmpty()) finish("result", text);
                    else if (!text.isEmpty()) { cancel(); emit(id, "draft", text, reason); }
                    else finish("error", "complete".equals(reason) ? "no-speech" : reason);
                }
            });
            return;
        }
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
            recognizer.setRecognitionListener(new RecognitionListener() {
                private boolean active() { return id.equals(currentId); }
                @Override public void onReadyForSpeech(Bundle params) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { } // 不保存、传输或记录录音。
                @Override public void onEndOfSpeech() { }
                @Override public void onPartialResults(Bundle partial) {
                    if (!active()) return;
                    String text = textFrom(partial);
                    if (text.length() > TEXT_LIMIT) { stopCapture("too-long"); return; }
                    if (!text.isEmpty()) emit(id, "partial", text, null);
                }
                @Override public void onEvent(int eventType, Bundle params) { }
                @Override public void onResults(Bundle results) {
                    if (!active()) return;
                    String text = textFrom(results);
                    if (text.length() > TEXT_LIMIT) finish("error", "too-long");
                    else if (text.isEmpty()) finish("error", "no-speech");
                    else if (stoppingReason != null) {
                        // 强制结束得到的文字只能作为草稿，绝不冒充完整指令自动发送。
                        String reason = stoppingReason;
                        cancel(); emit(id, "draft", text, reason);
                    } else finish("result", text);
                }
                @Override public void onError(int error) {
                    if (!active()) return;
                    if (stoppingReason != null) { finish("error", stoppingReason); return; }
                    String reason = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed"
                        : error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "network"
                        : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "no-speech"
                        : error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? "busy" : "unavailable";
                    finish("error", reason);
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            // 请求静音连续2秒才结束；是否遵守取决于手机系统识别服务，不是网页延迟发送。
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MILLIS);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MILLIS);
            handler.postDelayed(timeout, CAPTURE_LIMIT_MILLIS);
            recognizer.startListening(intent);
        } catch (Exception ignored) { finish("error", "unavailable"); }
    }

    private void finish(String type, String value) {
        String id = currentId;
        cancel();
        emit(id, type, value, null);
    }

    private static String textFrom(Bundle results) {
        ArrayList<String> matches = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches == null || matches.isEmpty() || matches.get(0) == null ? "" : matches.get(0).trim();
    }

    private void stopCapture(String reason) {
        if (BuildConfig.OFFLINE_ASR) {
            if (currentId == null || stoppingReason != null) return;
            stoppingReason = reason; offline.stop(reason); return;
        }
        if (currentId == null || recognizer == null || stoppingReason != null) return;
        stoppingReason = reason; handler.removeCallbacks(timeout);
        // stopListening 等待最终识别回调，不能直接 cancel 丢弃用户已经说的话。
        handler.postDelayed(finalTimeout, FINAL_WAIT_MILLIS);
        try { recognizer.stopListening(); }
        catch (Exception ignored) { finish("error", reason); }
    }

    private void emit(String id, String type, String value, String reason) {
        if (id == null || !trustedPage()) return;
        // JSON 转义识别文本，避免把语音内容当作脚本执行。
        String detail = "{id:" + JSONObject.quote(id) + ",type:" + JSONObject.quote(type)
            + ("error".equals(type) ? ",error:" : ",text:") + JSONObject.quote(value)
            + (reason == null ? "" : ",reason:" + JSONObject.quote(reason)) + "}";
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('drivetalk-native-speech',{detail:" + detail + "}));", null);
    }

    void cancel() {
        offline.cancel();
        cloud.cancel(); cloudMode = false; cloudRecording = false;
        currentId = null; stoppingReason = null;
        handler.removeCallbacks(timeout); handler.removeCallbacks(finalTimeout);
        if (recognizer != null) {
            SpeechRecognizer previous = recognizer; recognizer = null;
            previous.cancel(); previous.destroy();
        }
    }
    void endSession() { sessionUntil = 0; cancel(); }
    boolean awaitingPermission() { return permissionPending; }
    void pause() { if (!permissionPending) endSession(); }
    void destroy() { endSession(); destroyed = true; offline.destroy(); cloud.destroy(); permission.unregister(); }
}
