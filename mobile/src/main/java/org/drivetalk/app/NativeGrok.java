package org.drivetalk.app;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.lifecycle.Lifecycle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONObject;
import org.json.JSONArray;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.security.KeyStore;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/** 只连接官方聊天 API；没有车辆工具、任意 URL 或凭证读取接口。 */
final class NativeGrok {
    static final String PROMPT = "DRIVETALK_NATIVE_GROK_V1";
    private static final String ALIAS = "drivetalk-grok-v1";
    private final ComponentActivity activity;
    private final WebView web;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String activeId;
    private volatile HttpsURLConnection connection;
    private volatile boolean destroyed;
    private long cooldownUntil;
    private int epoch;
    NativeGrok(ComponentActivity activity, WebView web) { this.activity = activity; this.web = web; }

    private boolean trusted() {
        return !destroyed && web.getUrl() != null && MainActivity.trusted(Uri.parse(web.getUrl()))
            && activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }
    void publishAvailability() {
        if (!trusted()) return;
        web.evaluateJavascript("window.__DriveTalkNativeGrok=Object.freeze({version:2,request:(p)=>{if(p.action==='save'&&!navigator.userActivation.isActive)return false;return window.prompt('" + PROMPT + "',JSON.stringify(p))==='accepted';}});window.dispatchEvent(new Event('drivetalk-native-grok-ready'));", null);
    }
    boolean request(String value) {
        if (!trusted() || value == null || value.length() > 90000) return false;
        try {
            JSONObject request = new JSONObject(value);
            String id = request.getString("id"), action = request.getString("action");
            if (!id.matches("[a-zA-Z0-9-]{16,64}")) return false;
            if (action.equals("cancel")) { if (id.equals(activeId)) cancel(); return true; }
            if (!action.equals("config") && !action.equals("save") && !action.equals("chat")) return false;
            if (activeId != null) return false; // 禁止重复请求及并发付费合成。
            activeId = id;
            int generation = epoch;
            worker.execute(() -> {
                try {
                    if (!id.equals(activeId)) return;
                    if (action.equals("chat")) chat(id, request, generation);
                    else {
                        JSONObject config = action.equals("save") && request.optBoolean("clear") ? new JSONObject() : readConfig();
                        if (action.equals("save")) {
                            if (request.optBoolean("clear")) config = new JSONObject();
                            else {
                                String key = request.optString("apiKey").trim();
                                if (!key.isEmpty()) {
                                    if (!key.matches("xai-[A-Za-z0-9_.-]{16,256}")) throw new Exception("invalid");
                                    config.put("apiKey", key);
                                }
                                String model = request.optString("model").trim(), persona = request.optString("persona");
                                if (!model.matches("[A-Za-z0-9_.:-]{1,80}") || persona.length() > 2000) throw new Exception("invalid");
                                config.put("model", model).put("persona", persona).put("enabled", request.optBoolean("enabled"));
                                if (config.optBoolean("enabled") && config.optString("apiKey").isEmpty()) throw new Exception("invalid");
                            }
                            writeConfig(config);
                        }
                        emit(id, "config", metadata(config), generation);
                    }
                } catch (Exception ignored) {
                    try { emit(id, "error", new JSONObject().put("message", "Grok 请求失败：请检查本机配置、网络与 API 账户；未自动重试。"), generation); } catch (Exception impossible) { }
                }
                finally { if (id.equals(activeId)) activeId = null; }
            });
            return true;
        } catch (Exception ignored) { return false; }
    }
    private JSONObject metadata(JSONObject config) throws Exception {
        return new JSONObject().put("configured", !config.optString("apiKey").isEmpty())
            .put("enabled", config.optBoolean("enabled")).put("model", config.optString("model"))
            .put("persona", config.optString("persona"));
    }
    // Keystore 和加解密只在工作线程中执行，不阻塞 UI；配置不备份、不回传网页 Key。
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private JSONObject readConfig() throws Exception {
        String saved = activity.getSharedPreferences(ALIAS, 0).getString("ciphertext", "");
        if (saved.isEmpty()) return new JSONObject();
        String[] parts = saved.split(":");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    private void writeConfig(JSONObject config) throws Exception {
        if (config.length() == 0) {
            if (!activity.getSharedPreferences(ALIAS, 0).edit().clear().commit()) throw new Exception("storage");
            return;
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
            + Base64.encodeToString(cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!activity.getSharedPreferences(ALIAS, 0).edit().putString("ciphertext", encrypted).commit()) throw new Exception("storage");
    }
    private void chat(String id, JSONObject request, int generation) throws Exception {
        if (System.currentTimeMillis() < cooldownUntil) throw new Exception("cooldown");
        JSONObject config = readConfig();
        String message = request.optString("message");
        if (!config.optBoolean("enabled") || config.optString("apiKey").isEmpty() || message.trim().isEmpty() || message.length() > 2000) throw new Exception("config");
        JSONArray messages = new JSONArray();
        // 不添加 App 身份、话题、语气或拒答指令；仅原样传入用户保存的人设。
        String persona = config.optString("persona");
        if (!persona.trim().isEmpty()) messages.put(new JSONObject().put("role", "system").put("content", persona));
        JSONArray history = request.optJSONArray("history");
        int historyLength = 0;
        if (history != null) {
            if (history.length() > 12 || history.length() % 2 != 0) throw new Exception("history");
            for (int i = 0; i < history.length(); i++) {
                JSONObject item = history.getJSONObject(i);
                String role = item.getString("role"), content = item.getString("content");
                historyLength += content.length();
                if (!role.equals(i % 2 == 0 ? "user" : "assistant") || content.trim().isEmpty() || historyLength > 12000) throw new Exception("history");
                messages.put(new JSONObject().put("role", role).put("content", content));
            }
        }
        messages.put(new JSONObject().put("role", "user").put("content", message));
        byte[] body = new JSONObject().put("model", config.getString("model")).put("messages", messages)
            .put("stream", true).put("max_tokens", 2048).toString().getBytes(StandardCharsets.UTF_8);
        HttpsURLConnection conn = (HttpsURLConnection) new URL("https://api.x.ai/v1/chat/completions").openConnection();
        connection = conn;
        try {
            if (!id.equals(activeId)) return;
            conn.setConnectTimeout(15000); conn.setReadTimeout(30000); conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST"); conn.setDoOutput(true); conn.setFixedLengthStreamingMode(body.length);
            conn.setRequestProperty("Content-Type", "application/json"); conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Authorization", "Bearer " + config.getString("apiKey"));
            try (java.io.OutputStream out = conn.getOutputStream()) { out.write(body); }
            int code = conn.getResponseCode();
            if (code != 200) {
                if (code == 429) cooldownUntil = System.currentTimeMillis() + 60000;
                emit(id, "error", new JSONObject().put("message", "Grok HTTP " + code + "；请检查模型、余额或手机代理，未自动重试。"), generation); return;
            }
            int sequence = 0, total = 0; boolean done = false;
            long deadline = System.currentTimeMillis() + 120000;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder line = new StringBuilder(); int ch;
                while ((ch = reader.read()) != -1) {
                    if (!id.equals(activeId)) return;
                    if (++total > 500000 || System.currentTimeMillis() > deadline) throw new Exception("limit");
                    if (ch != '\n') { if (line.length() > 65536) throw new Exception("frame"); line.append((char)ch); continue; }
                    String text = line.toString().trim(); line.setLength(0);
                    if (!text.startsWith("data:")) continue;
                    String data = text.substring(5).trim();
                    if (data.equals("[DONE]")) { done = true; break; }
                    JSONObject frame = new JSONObject(data);
                    if (frame.has("error")) throw new Exception("upstream");
                    JSONArray choices = frame.optJSONArray("choices");
                    if (choices == null || choices.length() == 0) continue;
                    JSONObject delta = choices.getJSONObject(0).optJSONObject("delta");
                    if (delta != null && delta.has("tool_calls")) throw new Exception("tools-disabled");
                    String content = delta == null ? "" : delta.optString("content", "");
                    if (!content.isEmpty()) emit(id, "text_delta", new JSONObject().put("message", content).put("sequence", sequence++), generation);
                }
            }
            if (!done) throw new Exception("incomplete");
            emit(id, "text_done", new JSONObject(), generation);
            emit(id, "result", new JSONObject().put("status", "no_command").put("message", "手机直连 Grok；未发送车辆动作。"), generation);
            emit(id, "done", new JSONObject(), generation);
        } finally { conn.disconnect(); if (connection == conn) connection = null; }
    }
    private void emit(String id, String type, JSONObject payload, int generation) {
        try {
            payload.put("id", id).put("type", type);
            String script = "window.dispatchEvent(new CustomEvent('drivetalk-native-grok',{detail:" + payload + "}));";
            activity.runOnUiThread(() -> { if (generation == epoch && trusted()) web.evaluateJavascript(script, null); });
        } catch (Exception ignored) { }
    }
    void cancel() {
        activeId = null; epoch++;
        HttpsURLConnection conn = connection;
        if (conn != null) new Thread(conn::disconnect, "grok-cancel").start();
    }
    void destroy() { destroyed = true; cancel(); worker.shutdownNow(); }
}
