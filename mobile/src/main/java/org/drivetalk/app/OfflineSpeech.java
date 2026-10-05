package org.drivetalk.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 手机端 Vosk：不保存录音、不联网，PCM 仅留在短时内存中。 */
final class OfflineSpeech {
    interface Listener {
        void status(String value);
        void partial(String text);
        void ended(String text, String reason);
    }
    private static final String ASSET = "vosk-model-small-cn-0.22";
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    // 解包、模型加载、录音读取、推理、释放全部串行；主线程绝不等待 join。
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Model model;
    private volatile Ticket current;
    private boolean destroyed;
    private static final class Ticket {
        volatile boolean cancelled;
        volatile String stop;
        volatile AudioRecord recorder;
    }
    OfflineSpeech(Context context) { this.context = context.getApplicationContext(); }

    void start(Listener listener) {
        if (destroyed) return;
        cancel();
        Ticket ticket = new Ticket(); current = ticket;
        listener.status("loading");
        worker.execute(() -> capture(ticket, listener));
    }
    void stop(String reason) {
        Ticket ticket = current;
        if (ticket != null && ticket.stop == null) ticket.stop = reason;
    }
    void cancel() {
        Ticket ticket = current; current = null;
        if (ticket == null) return;
        ticket.cancelled = true;
        AudioRecord recorder = ticket.recorder;
        if (recorder != null) try { recorder.stop(); } catch (IllegalStateException ignored) { }
    }
    void destroy() {
        if (destroyed) return;
        destroyed = true; cancel();
        worker.execute(() -> { if (model != null) { model.close(); model = null; } });
        worker.shutdown();
    }
    private void publish(Ticket ticket, Runnable event) {
        main.post(() -> { if (current == ticket && !ticket.cancelled) event.run(); });
    }

    @SuppressLint("MissingPermission") // NativeSpeech 的权限/前台门禁后才进入。
    private void capture(Ticket ticket, Listener listener) {
        AudioRecord recorder = null;
        StringBuilder committed = new StringBuilder();
        String preview = "", reason = "offline-unavailable";
        try {
            if (model == null) {
                LibVosk.setLogLevel(LogLevel.WARNINGS); // 不启用识别调试日志。
                model = new Model(prepareModel().getAbsolutePath());
            }
            if (ticket.cancelled) return;
            if (ticket.stop != null) {
                String stop = ticket.stop; publish(ticket, () -> listener.ended("", stop)); return;
            }
            int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("Unsupported microphone format");
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 6400));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            // USB调试/外设不应把录音路由到无麦克风设备；使用手机内置麦克风。
            AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) { recorder.setPreferredDevice(device); break; }
            }
            ticket.recorder = recorder;
            if (ticket.cancelled) return;
            try (Recognizer recognizer = new Recognizer(model, 16000f)) {
                recorder.startRecording();
                if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone stopped");
                publish(ticket, () -> listener.status("ready"));
                SpeechCapturePolicy policy = new SpeechCapturePolicy(SystemClock.elapsedRealtime());
                short[] pcm = new short[1600]; // 100ms，本地推理后覆盖，不落盘。
                while (!ticket.cancelled) {
                    if (ticket.stop != null) { reason = ticket.stop; break; }
                    int count = recorder.read(pcm, 0, pcm.length);
                    if (ticket.cancelled) return;
                    if (count <= 0) { reason = "audio-capture"; break; }
                    double power = 0;
                    for (int i = 0; i < count; i++) power += (double) pcm[i] * pcm[i];
                    boolean segment = recognizer.acceptWaveForm(pcm, count);
                    String hypothesis;
                    if (segment) {
                        append(committed, parse(recognizer.getResult(), "text"));
                        hypothesis = committed.toString();
                    } else hypothesis = join(committed.toString(), parse(recognizer.getPartialResult(), "partial"));
                    boolean changed = !hypothesis.isEmpty() && !hypothesis.equals(preview);
                    if (changed) { preview = hypothesis; String text = preview; publish(ticket, () -> listener.partial(text)); }
                    if (preview.length() > 12000) { reason = "too-long"; break; }
                    String outcome = policy.update(SystemClock.elapsedRealtime(), Math.sqrt(power / count), changed);
                    if (outcome != null) { reason = outcome; break; }
                }
                if (ticket.cancelled) return;
                append(committed, parse(recognizer.getFinalResult(), "text"));
                if (committed.length() > 0) preview = committed.toString();
                if (preview.length() > 12000) { preview = preview.substring(0, 12000); reason = "too-long"; }
            }
        } catch (SecurityException ignored) { reason = "not-allowed"; }
        catch (IOException | RuntimeException | LinkageError ignored) { reason = "offline-unavailable"; }
        finally {
            // 只有工作线程 release，取消在主线程仅 stop；不会释放正在 native 推理的模型。
            ticket.recorder = null;
            if (recorder != null) {
                try { recorder.stop(); } catch (IllegalStateException ignored) { }
                recorder.release();
            }
        }
        String text = preview, outcome = reason;
        publish(ticket, () -> listener.ended(text, outcome));
    }
    private static String parse(String json, String key) throws IOException {
        try { return new JSONObject(json).optString(key, "").trim()
            .replaceAll("(?<=\\p{IsHan})\\s+(?=\\p{IsHan})", ""); }
        catch (org.json.JSONException error) { throw new IOException("Invalid local result"); }
    }
    private static String join(String left, String right) {
        return left.isEmpty() ? right : right.isEmpty() ? left : left + " " + right;
    }
    private static void append(StringBuilder target, String text) {
        if (!text.isEmpty()) { if (target.length() > 0) target.append(' '); target.append(text); }
    }
    private File prepareModel() throws IOException {
        File root = new File(context.getNoBackupFilesDir(), ASSET);
        File marker = new File(root, "ready-v1");
        if (!marker.exists()) {
            copyAsset(ASSET, root);
            if (!new File(root, "am/final.mdl").isFile() || !new File(root, "conf/model.conf").isFile())
                throw new IOException("Bundled model missing");
            try (FileOutputStream out = new FileOutputStream(marker)) { out.write(1); }
        }
        return root;
    }
    private void copyAsset(String asset, File destination) throws IOException {
        String[] children = context.getAssets().list(asset);
        if (children != null && children.length > 0) {
            if (!destination.isDirectory() && !destination.mkdirs()) throw new IOException("Model directory unavailable");
            for (String child : children) copyAsset(asset + "/" + child, new File(destination, child));
        } else {
            try (InputStream input = context.getAssets().open(asset); FileOutputStream out = new FileOutputStream(destination)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) out.write(buffer, 0, count);
            }
        }
    }
}
