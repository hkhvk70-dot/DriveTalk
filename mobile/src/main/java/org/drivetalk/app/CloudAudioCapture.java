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
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/** 仅收集有界 PCM，由可信网页转发到同源识别代理；不落盘、不持有 API Key。 */
final class CloudAudioCapture {
    interface Listener {
        void ready();
        void frame(byte[] bytes, Runnable consumed);
        void ended(String reason);
    }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Ticket current;
    private boolean destroyed;
    private static final class Ticket {
        volatile boolean cancelled, textChanged;
        volatile String stop;
        volatile AudioRecord recorder;
    }
    CloudAudioCapture(Context context) { this.context = context.getApplicationContext(); }
    void start(Listener listener) {
        if (destroyed) return;
        cancel(); Ticket ticket = new Ticket(); current = ticket;
        worker.execute(() -> capture(ticket, listener));
    }
    void heard() { Ticket t = current; if (t != null) t.textChanged = true; }
    void stop(String reason) { Ticket t = current; if (t != null && t.stop == null) t.stop = reason; }
    void cancel() {
        Ticket t = current; current = null;
        if (t == null) return;
        t.cancelled = true;
        if (t.recorder != null) try { t.recorder.stop(); } catch (IllegalStateException ignored) { }
    }
    void destroy() { destroyed = true; cancel(); worker.shutdown(); }
    private void publish(Ticket t, Runnable callback) {
        main.post(() -> { if (current == t && !t.cancelled) callback.run(); });
    }
    @SuppressLint("MissingPermission") // NativeSpeech 前台/权限/可信页面门禁。
    private void capture(Ticket t, Listener listener) {
        AudioRecord record = null;
        String reason = "audio-capture";
        try {
            int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("Unsupported microphone");
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 6400));
            if (record.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) { record.setPreferredDevice(device); break; }
            }
            t.recorder = record;
            if (t.cancelled) return;
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone stopped");
            publish(t, listener::ready);
            SpeechCapturePolicy policy = new SpeechCapturePolicy(SystemClock.elapsedRealtime());
            short[] samples = new short[1600];
            while (!t.cancelled) {
                if (t.stop != null) { reason = t.stop; break; }
                int count = record.read(samples, 0, samples.length);
                if (t.cancelled) return;
                if (count <= 0) throw new IOException("Read failed");
                byte[] pcm = new byte[count * 2]; double power = 0;
                for (int i = 0; i < count; i++) {
                    pcm[i * 2] = (byte) samples[i]; pcm[i * 2 + 1] = (byte) (samples[i] >> 8);
                    power += (double) samples[i] * samples[i];
                }
                // 最多一个 JS 回调待消费；WebView/网络拥塞时停止，不堆积或丢弃中间语音。
                Semaphore consumed = new Semaphore(0);
                publish(t, () -> listener.frame(pcm, consumed::release));
                if (!consumed.tryAcquire(1, TimeUnit.SECONDS)) { reason = "asr-backpressure"; break; }
                boolean changed = t.textChanged; t.textChanged = false;
                String outcome = policy.update(SystemClock.elapsedRealtime(), Math.sqrt(power / count), changed);
                if (outcome != null) { reason = outcome; break; }
            }
        } catch (SecurityException ignored) { reason = "not-allowed"; }
        catch (IOException | RuntimeException ignored) { reason = "audio-capture"; }
        catch (InterruptedException ignored) { Thread.currentThread().interrupt(); reason = "audio-capture"; }
        finally {
            t.recorder = null;
            if (record != null) {
                try { record.stop(); } catch (IllegalStateException ignored) { }
                record.release();
            }
        }
        String outcome = reason; publish(t, () -> listener.ended(outcome));
    }
}
