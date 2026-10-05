package org.drivetalk.app;

import org.junit.Test;
import static org.junit.Assert.*;

public final class SpeechCapturePolicyTest {
    @Test public void initialSilenceDoesNotFailAtFiveSeconds() {
        SpeechCapturePolicy policy = new SpeechCapturePolicy(0);
        assertNull(policy.update(5000, 0, false));
        assertNull(policy.update(14999, 0, false));
        assertEquals("no-speech", policy.update(15000, 0, false));
    }
    @Test public void shortHalfSecondPauseDoesNotEndUtterance() {
        SpeechCapturePolicy policy = new SpeechCapturePolicy(0);
        policy.update(100, 800, false); policy.update(200, 800, false); policy.update(300, 800, false);
        assertNull(policy.update(800, 0, false));
        assertNull(policy.update(1000, 0, true));
        assertNull(policy.update(2999, 0, false));
        assertEquals("complete", policy.update(3000, 0, false));
    }
    @Test public void uninterruptedLongSpeechDoesNotStopAtFiveOrTwentySeconds() {
        SpeechCapturePolicy policy = new SpeechCapturePolicy(0);
        for (long now = 100; now < 120000; now += 100) assertNull(policy.update(now, 800, false));
        assertEquals("timeout", policy.update(120000, 800, false));
    }
    @Test public void textChangesSupportQuietButRecognizableSpeech() {
        SpeechCapturePolicy policy = new SpeechCapturePolicy(0);
        assertNull(policy.update(8000, 50, true));
        assertNull(policy.update(9500, 20, false));
        assertEquals("complete", policy.update(10000, 20, false));
    }
    @Test public void oneNoiseSpikeIsNotEnoughToEndInitialListening() {
        SpeechCapturePolicy policy = new SpeechCapturePolicy(0);
        policy.update(100, 5000, false); policy.update(200, 0, false);
        assertNull(policy.update(5000, 0, false));
        assertEquals("no-speech", policy.update(15000, 0, false));
    }
}
