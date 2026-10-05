package org.drivetalk.app;

/** 纯本地时间策略；识别器分段不代表整条用户消息结束。可脱离 Android 测试。 */
final class SpeechCapturePolicy {
    static final long SILENCE_MS = 2000;
    static final long INITIAL_SILENCE_MS = 15000;
    static final long LIMIT_MS = 120000;
    private final long start;
    private long lastVoice;
    private boolean heard;
    private int voicedFrames;

    SpeechCapturePolicy(long start) { this.start = start; this.lastVoice = start; }

    String update(long now, double rms, boolean textChanged) {
        // 连续约300ms的能量或识别文字变化作为活动依据，不把单个噪声尖峰当人声。
        voicedFrames = rms >= 350 ? voicedFrames + 1 : 0;
        if (voicedFrames >= 3 || textChanged) { heard = true; lastVoice = now; }
        if (now - start >= LIMIT_MS) return "timeout";
        if (heard && now - lastVoice >= SILENCE_MS) return "complete";
        if (!heard && now - start >= INITIAL_SILENCE_MS) return "no-speech";
        return null;
    }
}
