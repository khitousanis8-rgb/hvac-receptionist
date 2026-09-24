/**
 * EMPIRICAL ADVERSARIAL STRESS TEST SUITE
 * Challenger: Frontend Audio Gating, Monotonic Epoch Invalidation,
 * Boundary Decibel Decays, Barge-In Stress, and Platform Cooldown Matrix.
 */

import assert from "node:assert/strict";

// Global mocks for Node test environment
class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  maxAlternatives = 1;
  onresult: any = null;
  onerror: any = null;
  onend: any = null;

  startCalls = 0;
  abortCalls = 0;
  stopCalls = 0;
  isActive = false;

  start() {
    this.startCalls++;
    this.isActive = true;
  }
  abort() {
    this.abortCalls++;
    this.isActive = false;
    if (this.onend) {
      setTimeout(() => {
        if (this.onend) this.onend();
      }, 0);
    }
  }
  stop() {
    this.stopCalls++;
    this.isActive = false;
    if (this.onend) {
      setTimeout(() => {
        if (this.onend) this.onend();
      }, 0);
    }
  }
}

class MockMediaStreamTrack {
  enabled = true;
  kind = "audio";
  stop() {}
}

class MockAnalyserNode {
  fftSize = 1024;
  smoothingTimeConstant = 0.0;
  mockData: Float32Array = new Float32Array(1024);
  getFloatTimeDomainData(array: Float32Array) {
    array.set(this.mockData);
  }
  getByteTimeDomainData(array: Uint8Array) {
    for (let i = 0; i < array.length; i++) {
      const sample = Math.max(-1, Math.min(1, this.mockData[i] || 0));
      array[i] = Math.round((sample + 1) * 127.5);
    }
  }
  connect() {}
  disconnect() {}
}

(globalThis as any).window = globalThis;
(globalThis as any).SpeechRecognition = MockSpeechRecognition;
(globalThis as any).webkitSpeechRecognition = MockSpeechRecognition;

if (!(globalThis as any).document) {
  (globalThis as any).document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
}
if (!(globalThis as any).addEventListener) {
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
}

import { BrowserSpeechRecognition } from "../lib/speech-recognition.ts";
import { NeuralAudioPlayer } from "../lib/neural-audio-player.ts";

let totalTests = 0;
let passedTests = 0;

function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(
        () => {
          passedTests++;
          console.log(`  ✓ PASS: ${name}`);
        },
        (err) => {
          console.error(`  ✗ FAIL: ${name}`);
          console.error(err);
          throw err;
        }
      );
    }
    passedTests++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    throw err;
  }
}

console.log("================================================================================");
console.log("CHALLENGER FRONTEND: ADVERSARIAL AUDIO STRESS & BOUNDARY TESTS");
console.log("================================================================================\n");

// ============================================================================
// CHALLENGE 1: Epoch Desynchronization & Out-of-Order Frame Rejection
// ============================================================================
console.log("--- 1. Epoch Desynchronization & Out-of-Order Frame Rejection ---");

await runTest("1.1 Stale epoch frames (past epochs 0..9 vs current 10) are strictly dropped", async () => {
  const speech = new BrowserSpeechRecognition();
  const transcripts: string[] = [];
  speech.setCallbacks({
    onTranscript: (t, isFinal) => {
      transcripts.push(`${t}:${isFinal}`);
    },
  });
  await speech.start();

  // Advance speech epoch to 10
  speech.enterAssistantTurn(10);
  (speech as any).initNativeRecognition(MockSpeechRecognition);
  const rec = (speech as any).recognition as MockSpeechRecognition;

  // Simulate in-flight frames arriving from older epochs (0 through 9)
  for (let pastEpoch = 0; pastEpoch < 10; pastEpoch++) {
    (speech as any).activeListeningEpoch = pastEpoch;
    (speech as any).currentSpeechEpoch = 10;
    (speech as any).sessionStartTime = Date.now() - 1000; // Well past warm-up

    rec.onresult({
      resultIndex: 0,
      results: [[{ transcript: `ghost frame from epoch ${pastEpoch}`, isFinal: true }]],
    });
  }

  assert.equal(transcripts.length, 0, "No transcripts emitted for stale past epochs");
  speech.stop();
});

await runTest("1.2 Future desynchronized epoch frames (epoch 11 vs current 10) are strictly dropped", async () => {
  const speech = new BrowserSpeechRecognition();
  const transcripts: string[] = [];
  speech.setCallbacks({
    onTranscript: (t) => transcripts.push(t),
  });
  await speech.start();

  speech.enterAssistantTurn(10);
  (speech as any).initNativeRecognition(MockSpeechRecognition);
  const rec = (speech as any).recognition as MockSpeechRecognition;

  (speech as any).activeListeningEpoch = 11;
  (speech as any).currentSpeechEpoch = 10;
  (speech as any).sessionStartTime = Date.now() - 1000;

  rec.onresult({
    resultIndex: 0,
    results: [[{ transcript: "future desynced frame", isFinal: true }]],
  });

  assert.equal(transcripts.length, 0, "Future desynchronized epoch frame is dropped");
  speech.stop();
});

await runTest("1.3 Minimum Speech Latency Guard boundary stress (0ms, 150ms, 349ms vs 351ms)", async () => {
  const speech = new BrowserSpeechRecognition();
  const transcripts: string[] = [];
  speech.setCallbacks({
    onTranscript: (t) => transcripts.push(t),
  });
  await speech.start();

  speech.enterAssistantTurn(5);
  speech.resumeAfterAcousticDecay(5);
  const rec = (speech as any).recognition as MockSpeechRecognition;

  const now = Date.now();

  // Test at 0ms elapsed
  (speech as any).sessionStartTime = now;
  rec.onresult({
    resultIndex: 0,
    results: [[{ transcript: "transient at 0ms", isFinal: false }]],
  });
  assert.equal(transcripts.length, 0, "Dropped at 0ms");

  // Test at 150ms elapsed
  (speech as any).sessionStartTime = now - 150;
  rec.onresult({
    resultIndex: 0,
    results: [[{ transcript: "transient at 150ms", isFinal: false }]],
  });
  assert.equal(transcripts.length, 0, "Dropped at 150ms");

  // Test at 349ms elapsed (just below 350ms threshold)
  (speech as any).sessionStartTime = now - 349;
  rec.onresult({
    resultIndex: 0,
    results: [[{ transcript: "transient at 349ms", isFinal: false }]],
  });
  assert.equal(transcripts.length, 0, "Dropped at 349ms");

  // Test at 351ms elapsed (just above 350ms threshold) -> legitimate speech accepted!
  (speech as any).sessionStartTime = now - 351;
  rec.onresult({
    resultIndex: 0,
    results: [[{ transcript: "hello my AC is broken", isFinal: false }]],
  });
  assert.equal(transcripts.length, 1, "Accepted at 351ms");
  assert.equal(transcripts[0], "hello my AC is broken");

  speech.stop();
});

await runTest("1.4 Rapid turn switching nullifies onresult handlers and drops delayed events across epochs", async () => {
  const speech = new BrowserSpeechRecognition();
  const transcripts: string[] = [];
  speech.setCallbacks({
    onTranscript: (t) => transcripts.push(t),
  });
  await speech.start();

  // Rapidly toggle assistant turns 1, 2, 3, 4, 5
  for (let epoch = 1; epoch <= 5; epoch++) {
    (speech as any).initNativeRecognition(MockSpeechRecognition);
    const oldRec = (speech as any).recognition as MockSpeechRecognition;
    assert.ok(typeof oldRec.onresult === "function", "Listener attached initially");

    // Enter assistant turn
    speech.enterAssistantTurn(epoch);

    // 1. Assert old instance handler was completely nullified
    assert.equal(oldRec.onresult, null, `onresult on old recognition was nullified by enterAssistantTurn(${epoch})`);
    assert.equal((speech as any).recognition, null, "speech.recognition instance is nullified");

    // 2. If a rogue in-flight callback from epoch - 1 somehow bypassed nullification:
    (speech as any).initNativeRecognition(MockSpeechRecognition);
    const newRec = (speech as any).recognition as MockSpeechRecognition;
    (speech as any).activeListeningEpoch = epoch - 1;
    (speech as any).sessionStartTime = Date.now() - 500;
    newRec.onresult({
      resultIndex: 0,
      results: [[{ transcript: `delayed bleed from epoch ${epoch - 1}`, isFinal: true }]],
    });
  }

  assert.equal(transcripts.length, 0, "Zero delayed bleed packets leaked through across rapid epoch transitions");
  speech.stop();
});

// ============================================================================
// CHALLENGE 2: -59.5 dBFS vs -65 dBFS Decay Threshold Boundaries & 4-Frame Persistence Reset
// ============================================================================
console.log("\n--- 2. -59.5 dBFS vs -65 dBFS Boundaries & 4-Frame Persistence Reset ---");

await runTest("2.1 -59.5 dBFS waveform (linear ~0.001059) must NOT finish turn and isTrueSilence is false", () => {
  const player = new NeuralAudioPlayer();
  const mockAnalyser = new MockAnalyserNode();
  (player as any).analyserNode = mockAnalyser;
  (player as any).audioContext = { state: "running", currentTime: 0 };
  (player as any).isTurnActive = true;
  (player as any).endTurnSignaled = true;
  (player as any).queue = [];
  (player as any).activeSources = [];
  (player as any).isPlaying = true;
  (player as any).isFetching = false;
  (player as any).consecutiveSilentFrames = 0;

  let turnEnded = false;
  player.setTurnStateCallback((active) => {
    if (!active) turnEnded = true;
  });

  // -59.5 dBFS amplitude: 10^(-59.5/20) = 0.00105925
  const amp595 = Math.pow(10, -59.5 / 20);
  assert.ok(amp595 > 0.0010, "-59.5 dBFS linear amplitude is strictly greater than 0.0010");

  mockAnalyser.mockData.fill(amp595);
  const decibel = player.getOutputDecibelLevel();

  assert.ok(decibel.peakDb > -60.0 && decibel.peakDb < -59.0, `peakDb is approx -59.5 (got ${decibel.peakDb})`);
  assert.equal(decibel.isTrueSilence, false, "-59.5 dBFS is NOT true silence");

  // Call checkTurnCompletion 10 times with -59.5 dBFS
  for (let i = 0; i < 10; i++) {
    (player as any).checkTurnCompletion();
    assert.equal((player as any).consecutiveSilentFrames, 0, `Frame ${i + 1}: consecutiveSilentFrames remains 0`);
    assert.equal(turnEnded, false, `Frame ${i + 1}: turn must not end`);
    assert.equal((player as any).isTurnActive, true, `Frame ${i + 1}: isTurnActive remains true`);
  }
});

await runTest("2.2 -65 dBFS waveform (linear ~0.000562) is recognized as true silence", () => {
  const player = new NeuralAudioPlayer();
  const mockAnalyser = new MockAnalyserNode();
  (player as any).analyserNode = mockAnalyser;
  (player as any).audioContext = { state: "running", currentTime: 0 };

  const amp65 = Math.pow(10, -65 / 20);
  assert.ok(amp65 < 0.0010, "-65 dBFS linear amplitude is strictly below 0.0010");

  mockAnalyser.mockData.fill(amp65);
  const decibel = player.getOutputDecibelLevel();

  assert.ok(decibel.peakDb < -64.0 && decibel.peakDb > -66.0, `peakDb is approx -65.0 (got ${decibel.peakDb})`);
  assert.equal(decibel.isTrueSilence, true, "-65 dBFS satisfies isTrueSilence");
  assert.equal(player.isAudioOutputActive(-60), false, "isAudioOutputActive(-60) is false for -65 dBFS");
});

await runTest("2.3 Transient noise spikes after 1, 2, or 3 silent frames MUST reset consecutive silent frames counter", () => {
  const player = new NeuralAudioPlayer();
  const mockAnalyser = new MockAnalyserNode();
  (player as any).analyserNode = mockAnalyser;
  (player as any).audioContext = { state: "running", currentTime: 0 };
  (player as any).isTurnActive = true;
  (player as any).endTurnSignaled = true;
  (player as any).queue = [];
  (player as any).activeSources = [];
  (player as any).isPlaying = true;
  (player as any).isFetching = false;

  let turnEnded = false;
  player.setTurnStateCallback((active) => {
    if (!active) turnEnded = true;
  });

  const silentAmp = Math.pow(10, -65 / 20); // -65 dBFS
  const noiseAmp = Math.pow(10, -40 / 20);  // -40 dBFS noise burst

  // Pattern A: 1 silent frame -> Spike -> Reset to 0
  (player as any).consecutiveSilentFrames = 0;
  mockAnalyser.mockData.fill(silentAmp);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 1, "1 silent frame -> counter 1");

  mockAnalyser.mockData.fill(noiseAmp);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 0, "Spike after 1 frame -> counter reset to 0");
  assert.equal(turnEnded, false, "Turn still active");

  // Pattern B: 2 silent frames -> Spike -> Reset to 0
  mockAnalyser.mockData.fill(silentAmp);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 1, "Silent frame -> counter 1");
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 2, "Silent frame -> counter 2");

  mockAnalyser.mockData.fill(noiseAmp);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 0, "Spike after 2 frames -> counter reset to 0");
  assert.equal(turnEnded, false, "Turn still active");

  // Pattern C: 3 silent frames -> Spike (at -59.5 dBFS) -> Reset to 0
  const thresholdSpike = Math.pow(10, -59.5 / 20); // -59.5 dBFS boundary spike
  mockAnalyser.mockData.fill(silentAmp);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 1, "Silent frame -> counter 1");
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 2, "Silent frame -> counter 2");
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 3, "Silent frame -> counter 3");

  mockAnalyser.mockData.fill(thresholdSpike);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 0, "-59.5 dBFS spike after 3 frames -> counter reset to 0");
  assert.equal(turnEnded, false, "Turn still active, not finished after 3 frames + spike");
});

await runTest("2.4 Exactly 4 consecutive silent frames at -65 dBFS finishes turn cleanly", () => {
  const player = new NeuralAudioPlayer();
  const mockAnalyser = new MockAnalyserNode();
  (player as any).analyserNode = mockAnalyser;
  (player as any).audioContext = { state: "running", currentTime: 0 };
  (player as any).isTurnActive = true;
  (player as any).endTurnSignaled = true;
  (player as any).queue = [];
  (player as any).activeSources = [];
  (player as any).isPlaying = true;
  (player as any).isFetching = false;
  (player as any).consecutiveSilentFrames = 0;

  let turnEnded = false;
  player.setTurnStateCallback((active) => {
    if (!active) turnEnded = true;
  });

  const silentAmp = Math.pow(10, -65 / 20);
  mockAnalyser.mockData.fill(silentAmp);

  // Frames 1..3: not finished
  for (let i = 1; i <= 3; i++) {
    (player as any).checkTurnCompletion();
    assert.equal((player as any).consecutiveSilentFrames, i, `Frame ${i}: counter is ${i}`);
    assert.equal(turnEnded, false, `Frame ${i}: turn not ended`);
  }

  // Frame 4: FINISHED!
  (player as any).checkTurnCompletion();
  assert.equal(turnEnded, true, "Frame 4 triggers clean turn finalization");
  assert.equal((player as any).isTurnActive, false, "isTurnActive is false");
  assert.equal((player as any).isPlaying, false, "isPlaying is false");
});

// ============================================================================
// CHALLENGE 3: Rapid Interruption & Barge-In Cycling During Active Playback
// ============================================================================
console.log("\n--- 3. Rapid Interruption & Barge-In Cycling During Active Playback ---");

await runTest("3.1 50 rapid consecutive barge-in calls: no unhandled errors, monotonic epoch advancement", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };
  await speech.start();

  const startEpoch = speech.getCurrentSpeechEpoch();

  // Hammer resumeImmediatelyForInterrupt 50 times in rapid succession
  for (let i = 1; i <= 50; i++) {
    speech.resumeImmediatelyForInterrupt(startEpoch + i);
    assert.equal(speech.getCurrentSpeechEpoch(), startEpoch + i, `Epoch bumped to ${startEpoch + i}`);
    assert.equal(mockTrack.enabled, false, "Hardware track remains gated during tail-drain window");
    assert.equal((speech as any).isPausedForAgent, true, "isPausedForAgent is true during tail-drain");
  }

  // Wait 250ms for the final tail-drain timer to fire
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(mockTrack.enabled, true, "Physical track unmuted after final tail-drain");
  assert.equal((speech as any).isPausedForAgent, false, "isPausedForAgent restored to false");
  assert.equal((speech as any).activeListeningEpoch, startEpoch + 50, "Active listening epoch matches final epoch");

  speech.stop();
});

await runTest("3.2 Interrupt during active audio player playback cancels sources and resets queues", () => {
  const player = new NeuralAudioPlayer();
  (player as any).audioContext = {
    state: "running",
    currentTime: 10,
  };
  (player as any).isTurnActive = true;
  (player as any).isPlaying = true;

  let stoppedSource1 = false;
  let stoppedSource2 = false;
  const mockSource1 = {
    stop: () => { stoppedSource1 = true; },
    disconnect: () => {},
  };
  const mockSource2 = {
    stop: () => { stoppedSource2 = true; },
    disconnect: () => {},
  };

  (player as any).activeSources = [mockSource1, mockSource2];
  (player as any).queue = [
    { text: "sentence 1", buffer: null, isFetching: false, isDecoded: false },
    { text: "sentence 2", buffer: null, isFetching: false, isDecoded: false },
  ];

  // User barges in
  player.stop();

  assert.equal(stoppedSource1, true, "Active source 1 stopped");
  assert.equal(stoppedSource2, true, "Active source 2 stopped");
  assert.equal((player as any).activeSources.length, 0, "Active sources cleared");
  assert.equal((player as any).queue.length, 0, "Queue drained");
  assert.equal((player as any).isTurnActive, false, "isTurnActive reset to false");
  assert.equal((player as any).isPlaying, false, "isPlaying reset to false");
});

await runTest("3.3 Stale interrupt timers from superseded barge-in events do NOT override newest epoch", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };
  await speech.start();

  // Interrupt 1 targeting epoch 100
  speech.resumeImmediatelyForInterrupt(100);
  assert.equal(speech.getCurrentSpeechEpoch(), 100);

  // 50ms later, new interrupt 2 targeting epoch 101 supersedes interrupt 1
  await new Promise((resolve) => setTimeout(resolve, 50));
  speech.resumeImmediatelyForInterrupt(101);
  assert.equal(speech.getCurrentSpeechEpoch(), 101);

  // Wait 170ms (total 220ms from interrupt 1, but only 170ms from interrupt 2)
  await new Promise((resolve) => setTimeout(resolve, 170));
  // Interrupt 1 timer (200ms) would have expired, but its targetEpoch (100) !== currentSpeechEpoch (101)
  // Track must still be muted waiting for interrupt 2's full 200ms
  assert.equal(mockTrack.enabled, false, "Track remains muted because interrupt 1 did not activate stale epoch 100");

  // Wait additional 60ms (reaching 230ms for interrupt 2)
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(mockTrack.enabled, true, "Track now unmuted for current epoch 101");
  assert.equal((speech as any).activeListeningEpoch, 101, "Active epoch is 101, not 100");

  speech.stop();
});

// ============================================================================
// CHALLENGE 4: Platform-Calibrated Cooldown Matrix for Android, Windows, and iOS
// ============================================================================
console.log("\n--- 4. Platform-Calibrated Cooldown Matrix ---");

const matrixTestCases = [
  {
    name: "4.1 Android Mobile (Chrome on Samsung S24)",
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36",
    expected: { minFloorMs: 500, targetDb: -60, maxTimeoutMs: 1200 },
  },
  {
    name: "4.2 Android Mobile (Samsung Internet Browser)",
    ua: "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    expected: { minFloorMs: 500, targetDb: -60, maxTimeoutMs: 1200 },
  },
  {
    name: "4.3 Android Mobile (Pixel 8 Pro Chrome)",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
    expected: { minFloorMs: 500, targetDb: -60, maxTimeoutMs: 1200 },
  },
  {
    name: "4.4 Android Tablet (Linux Android UA)",
    ua: "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    expected: { minFloorMs: 500, targetDb: -60, maxTimeoutMs: 1200 },
  },
  {
    name: "4.5 Windows Desktop (Windows 11 Chrome x64)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    expected: { minFloorMs: 600, targetDb: -60, maxTimeoutMs: 1400 },
  },
  {
    name: "4.6 Windows Desktop (Windows 11 Edge x64)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    expected: { minFloorMs: 600, targetDb: -60, maxTimeoutMs: 1400 },
  },
  {
    name: "4.7 Windows Desktop (Firefox x64)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
    expected: { minFloorMs: 600, targetDb: -60, maxTimeoutMs: 1400 },
  },
  {
    name: "4.8 iOS Mobile (iPhone 15 Pro Safari)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    expected: { minFloorMs: 250, targetDb: -50, maxTimeoutMs: 500 },
  },
  {
    name: "4.9 iOS Mobile (iPad Safari)",
    ua: "Mozilla/5.0 (iPad; CPU OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    expected: { minFloorMs: 250, targetDb: -50, maxTimeoutMs: 500 },
  },
  {
    name: "4.10 macOS Desktop (Mac Safari)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    expected: { minFloorMs: 250, targetDb: -50, maxTimeoutMs: 500 },
  },
  {
    name: "4.11 iOS Mobile (Chrome CriOS on iPhone)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.92 Mobile/15E148 Safari/604.1",
    expected: { minFloorMs: 250, targetDb: -50, maxTimeoutMs: 500 },
  },
  {
    name: "4.12 Desktop Fallback (Linux x86_64 Chrome)",
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    expected: { minFloorMs: 600, targetDb: -60, maxTimeoutMs: 1400 },
  },
];

for (const tc of matrixTestCases) {
  runTest(tc.name, () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: tc.ua },
      configurable: true,
      writable: true,
    });
    const speech = new BrowserSpeechRecognition();
    const config = speech.getDynamicAcousticCooldownMs();

    assert.equal(config.minFloorMs, tc.expected.minFloorMs, `${tc.name} minFloorMs mismatch`);
    assert.equal(config.targetDb, tc.expected.targetDb, `${tc.name} targetDb mismatch`);
    assert.equal(config.maxTimeoutMs, tc.expected.maxTimeoutMs, `${tc.name} maxTimeoutMs mismatch`);
  });
}

console.log("\n================================================================================");
console.log(`ALL ADVERSARIAL STRESS CHALLENGES PASSED: ${passedTests} / ${totalTests} (100%)`);
console.log("================================================================================\n");
