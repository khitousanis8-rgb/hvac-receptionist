/**
 * Adversarial Verification Test Suite for AEC Hardware Gating, Monotonic Epoch Tracking,
 * AnalyserNode Decay Calibration (< -60 dBFS), and Inter-Sentence Prefetch.
 */

import assert from "node:assert/strict";

// Setup browser mocks for Node environment
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
  connect() {}
  disconnect() {}
}

(globalThis as any).window = globalThis;
(globalThis as any).SpeechRecognition = MockSpeechRecognition;
(globalThis as any).webkitSpeechRecognition = MockSpeechRecognition;

if (!(globalThis as any).document) {
  (globalThis as any).document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
}
if (!(globalThis as any).addEventListener) {
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
}

import { BrowserSpeechRecognition } from "../lib/speech-recognition.ts";
import { NeuralAudioPlayer } from "../lib/neural-audio-player.ts";

console.log("=== Running AEC Half-Duplex, Epoch Tracking & Decay Calibration Tests ===");

// 1. Physical Half-Duplex Stream Disconnection (enterAssistantTurn)
{
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
  };
  await speech.start();
  const mockRec = (speech as any).recognition as MockSpeechRecognition;

  assert.equal(mockRec.startCalls, 1, "Initial start calls start()");
  assert.equal((speech as any).isListening, true, "isListening is true initially");
  assert.equal(mockTrack.enabled, true, "Physical MediaStreamTrack is enabled initially");

  // Enter assistant turn with epoch 15
  const returnedEpoch = speech.enterAssistantTurn(15);

  assert.equal(returnedEpoch, 15, "enterAssistantTurn returns new epoch (15)");
  assert.equal(speech.getCurrentSpeechEpoch(), 15, "getCurrentSpeechEpoch is 15");
  assert.equal((speech as any).recognition, null, "recognition instance is nullified on enterAssistantTurn");
  assert.ok(mockRec.abortCalls >= 1, "abort() called on recognition instance");
  assert.equal(mockRec.onresult, null, "onresult event listener nullified");
  assert.equal(mockRec.onerror, null, "onerror event listener nullified");
  assert.equal(mockRec.onend, null, "onend event listener nullified");
  assert.equal((speech as any).restartTimer, null, "restartTimer is null");
  assert.equal((speech as any).cooldownTimer, null, "cooldownTimer is null");
  assert.equal((speech as any).debounceTimer, null, "debounceTimer is null");
  assert.equal(mockTrack.enabled, false, "Physical MediaStreamTrack is hardware gated (enabled = false)");
  assert.equal((speech as any).isListening, false, "isListening is false");
  assert.equal((speech as any).isPausedForAgent, true, "isPausedForAgent is true");
  console.log("  ✓ PASS: 1. Physical Half-Duplex Stream Disconnection");
}

// 2. Monotonic Speech Epoch Tracking & Ghost Audio Frame Invalidation
{
  const speech = new BrowserSpeechRecognition();
  let transcriptCount = 0;
  speech.setCallbacks({
    onTranscript: () => {
      transcriptCount++;
    },
  });
  await speech.start();

  // Advance assistant turn to epoch 2
  speech.enterAssistantTurn(2);

  // Scenario A: Ghost frame arriving with stale epoch (activeListeningEpoch 1 vs currentSpeechEpoch 2)
  (speech as any).initNativeRecognition(MockSpeechRecognition);
  const activeMock = (speech as any).recognition as MockSpeechRecognition;
  (speech as any).activeListeningEpoch = 1;
  (speech as any).currentSpeechEpoch = 2;
  (speech as any).sessionStartTime = Date.now() - 500;

  activeMock.onresult({
    resultIndex: 0,
    results: [[{ transcript: "stale audio from previous turn", isFinal: true }]],
  });
  assert.equal(transcriptCount, 0, "Stale epoch frame (epoch 1 vs 2) is discarded");

  // Scenario B: Frame arriving within 350ms warm-up window
  (speech as any).activeListeningEpoch = 2;
  (speech as any).currentSpeechEpoch = 2;
  (speech as any).sessionStartTime = Date.now() - 100; // 100ms since start (< 350ms)

  activeMock.onresult({
    resultIndex: 0,
    results: [[{ transcript: "warmup click noise", isFinal: true }]],
  });
  assert.equal(transcriptCount, 0, "Frame arriving within 350ms of session start is discarded as warm-up noise");

  // Scenario C: Legitimate frame arriving after 350ms with matching epoch
  speech.resumeAfterAcousticDecay(2);
  const legitimateMock = (speech as any).recognition as MockSpeechRecognition;
  (speech as any).sessionStartTime = Date.now() - 400; // 400ms since start (>= 350ms)
  legitimateMock.onresult({
    resultIndex: 0,
    results: [[{ transcript: "my furnace is making noise", isFinal: true }]],
  });
  assert.equal(transcriptCount, 1, "Legitimate frame with matching epoch and >350ms elapsed is accepted");

  speech.stop();
  console.log("  ✓ PASS: 2. Monotonic Speech Epoch Tracking & Invalidation");
}

// 3. Platform-Calibrated Dynamic Reverb Decay Configuration
{
  const speech = new BrowserSpeechRecognition();

  // 3a: Android Mobile
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    },
    configurable: true,
    writable: true,
  });
  const androidConfig = speech.getDynamicAcousticCooldownMs();
  assert.equal(androidConfig.minFloorMs, 500, "Android minFloorMs is 500ms");
  assert.equal(androidConfig.targetDb, -55, "Android targetDb is -55 dBFS");
  assert.equal(androidConfig.maxTimeoutMs, 750, "Android maxTimeoutMs is 750ms");

  // 3b: Windows Desktop
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
    configurable: true,
    writable: true,
  });
  const windowsConfig = speech.getDynamicAcousticCooldownMs();
  assert.equal(windowsConfig.minFloorMs, 450, "Windows minFloorMs is 450ms");
  assert.equal(windowsConfig.targetDb, -55, "Windows targetDb is -55 dBFS");
  assert.equal(windowsConfig.maxTimeoutMs, 700, "Windows maxTimeoutMs is 700ms");

  // 3c: iOS / macOS (Apple WebKit)
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
    configurable: true,
    writable: true,
  });
  const iosConfig = speech.getDynamicAcousticCooldownMs();
  assert.equal(iosConfig.minFloorMs, 250, "iOS minFloorMs is 250ms");
  assert.equal(iosConfig.targetDb, -50, "iOS targetDb is -50 dBFS");
  assert.equal(iosConfig.maxTimeoutMs, 500, "iOS maxTimeoutMs is 500ms");
  console.log("  ✓ PASS: 3. Platform-Calibrated Dynamic Reverb Decay Configuration");
}

// 4. 32-bit Float32Array AnalyserNode Decay Monitoring Down to < -60 dBFS
{
  const player = new NeuralAudioPlayer();
  const mockAnalyser = new MockAnalyserNode();
  (player as any).analyserNode = mockAnalyser;
  (player as any).audioContext = { state: "running", currentTime: 0 };

  // 4a: Absolute digital silence (all zeros)
  mockAnalyser.mockData.fill(0);
  const silenceResult = player.getOutputDecibelLevel();
  assert.ok(silenceResult.peakDb <= -100, "Absolute silence yields <= -100 peakDb");
  assert.equal(silenceResult.isTrueSilence, true, "Absolute silence satisfies isTrueSilence (< -60 dBFS)");

  // 4b: True silence below -60 dBFS (amplitude 0.0005 -> ~ -66.02 dBFS)
  mockAnalyser.mockData.fill(0.0005);
  const sub60Result = player.getOutputDecibelLevel();
  assert.ok(sub60Result.peakDb < -60, "Amplitude 0.0005 peakDb is below -60 dBFS");
  assert.equal(sub60Result.isTrueSilence, true, "Amplitude 0.0005 is recognized as true silence (< 0.0010)");

  // 4c: Active audible signal (amplitude 0.05 -> ~ -26.02 dBFS)
  mockAnalyser.mockData.fill(0.05);
  const activeResult = player.getOutputDecibelLevel();
  assert.ok(activeResult.peakDb > -60, "Amplitude 0.05 peakDb is well above -60 dBFS (~ -26 dBFS)");
  assert.equal(activeResult.isTrueSilence, false, "Amplitude 0.05 is recognized as active audio (isTrueSilence = false)");

  // 4d: Exact boundary precision (0.0010 vs 0.00099)
  mockAnalyser.mockData.fill(0.0010);
  const boundary60Result = player.getOutputDecibelLevel();
  assert.equal(boundary60Result.isTrueSilence, false, "Exact 0.0010 linear amplitude (-60.00 dBFS) is not silence");

  mockAnalyser.mockData.fill(0.00099);
  const boundarySub60Result = player.getOutputDecibelLevel();
  assert.equal(boundarySub60Result.isTrueSilence, true, "Amplitude 0.00099 (< 0.0010 linear) is recognized as true silence");
  console.log("  ✓ PASS: 4. 32-bit Float32Array AnalyserNode Decay Monitoring");
}

// 5. Consecutive Silent Frames (~80ms / 4 frames) Turn Completion Gating
{
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

  let turnFinished = false;
  player.setTurnStateCallback((active) => {
    if (!active) turnFinished = true;
  });

  // Frame 1: silent
  mockAnalyser.mockData.fill(0.0005); // below -60 dBFS
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 1, "Frame 1 silent increments counter to 1");
  assert.equal(turnFinished, false, "Turn not finished after 1 silent frame");

  // Frame 2: silent
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 2, "Frame 2 silent increments counter to 2");
  assert.equal(turnFinished, false, "Turn not finished after 2 silent frames");

  // Frame 3: non-silent noise burst (0.02 amplitude)
  mockAnalyser.mockData.fill(0.02);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 0, "Non-silent burst resets counter back to 0");
  assert.equal(turnFinished, false, "Turn not finished after noise burst");

  // Frames 4-7: 4 consecutive silent frames
  mockAnalyser.mockData.fill(0.0002);
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 1, "Frame 4 silent: counter 1");
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 2, "Frame 5 silent: counter 2");
  (player as any).checkTurnCompletion();
  assert.equal((player as any).consecutiveSilentFrames, 3, "Frame 6 silent: counter 3");
  assert.equal(turnFinished, false, "Turn not finished after 3 silent frames");

  (player as any).checkTurnCompletion();
  assert.equal(turnFinished, true, "4 consecutive silent frames triggers turn completion");
  assert.equal((player as any).isTurnActive, false, "isTurnActive is set to false");
  console.log("  ✓ PASS: 5. Consecutive Silent Frames Gating");
}

// 6. Inter-Sentence Parallel Pre-Fetching in Queue Processing
{
  const player = new NeuralAudioPlayer();
  const fetchedSentences: string[] = [];
  (player as any).fetchAudioBuffer = (text: string) => {
    fetchedSentences.push(text);
    return Promise.resolve({
      duration: 1.0,
      length: 24000,
      sampleRate: 24000,
      numberOfChannels: 1,
    });
  };
  (player as any).scheduleAudioBuffer = () => Promise.resolve();

  player.startTurn(1);
  // Queue sentence 1
  player.speakSentence("First sentence of response.");
  // Queue sentence 2 and 3 immediately as SSE deltas arrive
  player.speakSentence("Second sentence prefetching in background.");
  player.speakSentence("Third sentence also prebuffering.");

  assert.equal(fetchedSentences.length, 3, "All 3 sentences triggered network prefetch in parallel without starvation");
  assert.equal(fetchedSentences[0], "First sentence of response.", "Sentence 1 prefetch initiated");
  assert.equal(fetchedSentences[1], "Second sentence prefetching in background.", "Sentence 2 prefetch initiated");
  assert.equal(fetchedSentences[2], "Third sentence also prebuffering.", "Sentence 3 prefetch initiated");

  player.stop();
  console.log("  ✓ PASS: 6. Inter-Sentence Parallel Pre-Fetching");
}

console.log("\nALL AEC, EPOCH, DECAY & PREFETCH TESTS PASSED SUCCESSFULLY (100%)\n");
