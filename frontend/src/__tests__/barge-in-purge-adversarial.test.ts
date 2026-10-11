/**
 * EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 3
 * Frontend Barge-In Detection, Acoustic Echo Discrimination,
 * and Audio Purge Latency (<10ms) with Zero Zombie Sounds.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

// --- MOCK BROWSER ENVIRONMENT ---

class MockMediaStreamTrack {
  enabled = true;
  kind = "audio";
  readyState = "live";
  stop() {
    this.readyState = "ended";
  }
}

class MockAudioBuffer {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;

  constructor(duration = 1.0, sampleRate = 24000) {
    this.duration = duration;
    this.sampleRate = sampleRate;
    this.numberOfChannels = 1;
    this.length = duration * sampleRate;
  }
}

class MockAudioBufferSourceNode {
  ctx: any;
  buffer: any = null;
  onended: any = null;
  isPlaying = false;
  isStopped = false;
  isDisconnected = false;
  stopCalls = 0;
  disconnectCalls = 0;

  constructor(ctx: any) {
    this.ctx = ctx;
  }

  connect(dest: any) {
    this.ctx.connectedDestination = dest;
  }

  disconnect() {
    this.isDisconnected = true;
    this.disconnectCalls++;
  }

  start(time?: number) {
    this.isPlaying = true;
  }

  stop() {
    this.isStopped = true;
    this.isPlaying = false;
    this.stopCalls++;
    if (this.onended) {
      const cb = this.onended;
      setTimeout(() => cb(), 0);
    }
  }
}

class MockGainNode {
  ctx: any;
  gain: {
    value: number;
    setValueAtTime: (val: number, time: number) => void;
    linearRampToValueAtTime: (val: number, time: number) => void;
    cancelScheduledValues: (time: number) => void;
  };
  scheduledRamps: Array<{ val: number; time: number }> = [];

  constructor(ctx: any) {
    this.ctx = ctx;
    this.gain = {
      value: 1.0,
      setValueAtTime: (val: number, time: number) => {
        this.gain.value = val;
      },
      linearRampToValueAtTime: (val: number, time: number) => {
        this.scheduledRamps.push({ val, time });
        this.gain.value = val;
      },
      cancelScheduledValues: (time: number) => {},
    };
  }
  connect(dest: any) {}
  disconnect() {}
}

class MockAnalyserNode {
  ctx: any;
  fftSize = 1024;
  smoothingTimeConstant = 0.8;
  mockData: Float32Array = new Float32Array(1024);

  constructor(ctx: any) {
    this.ctx = ctx;
  }
  connect(dest: any) {}
  disconnect() {}
  getFloatTimeDomainData(arr: Float32Array) {
    arr.set(this.mockData);
  }
  getByteTimeDomainData(arr: Uint8Array) {
    for (let i = 0; i < arr.length; i++) {
      const s = Math.max(-1, Math.min(1, this.mockData[i] || 0));
      arr[i] = Math.round((s + 1) * 127.5);
    }
  }
}

class MockAudioContext {
  sampleRate = 24000;
  currentTime = 100.0;
  state = "running";
  destination = {};
  createdSources: MockAudioBufferSourceNode[] = [];
  createdGainNodes: MockGainNode[] = [];

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(length / sampleRate, sampleRate);
  }

  createBufferSource() {
    const src = new MockAudioBufferSourceNode(this);
    this.createdSources.push(src);
    return src;
  }

  createGain() {
    const gain = new MockGainNode(this);
    this.createdGainNodes.push(gain);
    return gain;
  }

  createAnalyser() {
    return new MockAnalyserNode(this);
  }

  async decodeAudioData(ab: ArrayBuffer) {
    return new MockAudioBuffer(1.0, this.sampleRate);
  }

  async resume() {
    this.state = "running";
  }

  async close() {
    this.state = "closed";
  }
}

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

// Global browser polyfills
(globalThis as any).window = globalThis;
(globalThis as any).AudioContext = MockAudioContext;
(globalThis as any).webkitAudioContext = MockAudioContext;
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

// SpeechSynthesis mock
const mockUtterances: any[] = [];
const mockSpeechSynthesis = {
  speaking: false,
  pending: false,
  paused: false,
  speak: (u: any) => {
    mockUtterances.push(u);
    mockSpeechSynthesis.speaking = true;
  },
  cancel: () => {
    mockSpeechSynthesis.speaking = false;
    mockUtterances.length = 0;
  },
  pause: () => {
    mockSpeechSynthesis.paused = true;
  },
  resume: () => {
    mockSpeechSynthesis.paused = false;
  },
  getVoices: () => [{ name: "Sarah Voice", lang: "en-US" }],
};
(globalThis as any).speechSynthesis = mockSpeechSynthesis;

import { BrowserSpeechRecognition } from "../lib/speech-recognition.ts";
import { NeuralAudioPlayer } from "../lib/neural-audio-player.ts";

let testsPassed = 0;
let testsFailed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
    }
    testsPassed++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err: any) {
    testsFailed++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split("\n").slice(0, 4).join("\n"));
    }
  }
}

console.log("================================================================================");
console.log("EMPIRICAL ADVERSARIAL CHALLENGER: FRONTEND BARGE-IN & AUDIO PURGE");
console.log("================================================================================\n");

// ==============================================================================
// SUITE 1: ACOUSTIC ECHO SUPPRESSION VS GENUINE CALLER SPEECH
// ==============================================================================
console.log("--- Suite 1: Acoustic Echo Suppression vs Genuine Caller Speech ---");

await test("1.1 Echo candidate during playback NEVER triggers onBargeIn", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  speech.registerAssistantSpeech(
    "Thank you for calling Apex Air. What is the best callback phone number for our technician to reach you?"
  );

  let bargeInCount = 0;
  speech.setCallbacks({
    onBargeIn: () => {
      bargeInCount++;
    },
  });

  await speech.start();
  speech.enterAssistantTurn(10);

  const echoPhrases = [
    "thank you for calling apex air",
    "what is the best callback phone number",
    "for our technician to reach you",
    "best callback phone number",
    "technician to reach you",
    "apex air what is the best callback",
  ];

  const rec = (speech as any).recognition;
  for (const echo of echoPhrases) {
    rec.onresult({
      resultIndex: 0,
      results: [[{ transcript: echo, isFinal: true }]],
    });
  }

  assert.equal(bargeInCount, 0, `Expected 0 barge-in triggers for echo phrases, got ${bargeInCount}`);
  speech.stop();
});

await test("1.2 Genuine caller interruption phrases IMMEDIATELY trigger onBargeIn", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  speech.registerAssistantSpeech(
    "We have an opening tomorrow morning at 10 AM or tomorrow afternoon at 2 PM. Would you like me to book one of those for you?"
  );

  const genuinePhrases = [
    "wait",
    "stop",
    "hold on a second",
    "excuse me",
    "actually wait",
    "tomorrow at 10 AM",
    "ac repair",
    "furnace tune up",
    "yes please",
    "lock it in",
    "five five five zero one two three",
    "i don't have a phone number",
    "can you do afternoon instead",
  ];

  for (const phrase of genuinePhrases) {
    let bargeInFired = 0;
    speech.setCallbacks({
      onBargeIn: () => {
        bargeInFired++;
      },
    });

    await speech.start();
    speech.enterAssistantTurn(20);
    (speech as any).sessionStartTime = Date.now() - 1000;

    const rec = (speech as any).recognition;
    rec.onresult({
      resultIndex: 0,
      results: [[{ transcript: phrase, isFinal: true }]],
    });

    assert.equal(
      bargeInFired,
      1,
      `Genuine caller phrase "${phrase}" must trigger onBargeIn immediately (got ${bargeInFired})`
    );
    speech.stop();
  }
});

await test("1.3 Non-speech/noise/empty input during playback does NOT trigger onBargeIn", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  let bargeInCount = 0;
  speech.setCallbacks({
    onBargeIn: () => {
      bargeInCount++;
    },
  });

  await speech.start();
  speech.enterAssistantTurn(30);

  const noiseCandidates = ["", "   ", "...", "?!", "---", "   \n\t  "];
  const rec = (speech as any).recognition;

  for (const noise of noiseCandidates) {
    rec.onresult({
      resultIndex: 0,
      results: [[{ transcript: noise, isFinal: false }]],
    });
  }

  assert.equal(bargeInCount, 0, `Non-speech noise must not trigger onBargeIn (got ${bargeInCount})`);
  speech.stop();
});

await test("1.4 Half-duplex fallback strictly maintained when onBargeIn is omitted", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  // Explicitly omit onBargeIn
  speech.setCallbacks({
    onTranscript: () => {},
  });

  await speech.start();
  assert.equal(mockTrack.enabled, true, "Mic track initially enabled");
  assert.notEqual((speech as any).recognition, null, "Recognition initialized");

  speech.enterAssistantTurn(40);

  assert.equal((speech as any).isPausedForAgent, true, "isPausedForAgent true");
  assert.equal(mockTrack.enabled, false, "Microphone track must be HARDWARE-GATED (disabled)");
  assert.equal((speech as any).recognition, null, "Recognition instance must be nullified in half-duplex mode");
  assert.equal((speech as any).isListening, false, "isListening must be false");

  speech.stop();
});

// ==============================================================================
// SUITE 2: AUDIO PURGE SPEED & ZERO ZOMBIE SOUNDS IN NEURALVOICE.STOP()
// ==============================================================================
console.log("\n--- Suite 2: Audio Purge Speed & Zero Zombie Sounds ---");

await test("2.1 neuralVoice.stop() executes in <10ms and purges active AudioBufferSourceNodes", async () => {
  const player = new NeuralAudioPlayer();
  (player as any).audioContext = new MockAudioContext();
  (player as any).masterGain = (player as any).audioContext.createGain();

  // Populate multiple active sources simulating multi-sentence audio playback
  const sources: MockAudioBufferSourceNode[] = [];
  for (let i = 0; i < 8; i++) {
    const src = (player as any).audioContext.createBufferSource();
    src.start();
    (player as any).activeSources.push(src);
    sources.push(src);
  }

  // Populate in-flight fetch controllers and queue
  for (let i = 0; i < 5; i++) {
    const ac = new AbortController();
    (player as any).inFlightControllers.add(ac);
    (player as any).queue.push({
      turnId: 1,
      text: `Pending clause ${i}`,
      abortController: ac,
    });
  }

  (player as any).isTurnActive = true;
  (player as any).isPlaying = true;

  // Measure purge latency
  const t0 = performance.now();
  player.stop();
  const durationMs = performance.now() - t0;

  assert(
    durationMs < 10,
    `neuralVoice.stop() purge latency MUST be < 10ms (measured: ${durationMs.toFixed(3)}ms)`
  );

  // Verify all sources were stopped and disconnected
  for (let i = 0; i < sources.length; i++) {
    assert.equal(sources[i].isStopped, true, `Source ${i} must be stopped`);
    assert.equal(sources[i].isDisconnected, true, `Source ${i} must be disconnected`);
    assert.equal(sources[i].onended, null, `Source ${i} onended must be nullified to prevent callbacks`);
  }

  assert.equal((player as any).activeSources.length, 0, "activeSources array must be purged to length 0");
  assert.equal((player as any).isTurnActive, false, "isTurnActive must be false");
  assert.equal((player as any).isPlaying, false, "isPlaying must be false");
  assert.equal((player as any).queue.length, 0, "Queue must be empty");
  assert.equal((player as any).inFlightControllers.size, 0, "inFlightControllers must be cleared");
});

await test("2.2 In-flight fetch controllers are all aborted immediately on stop()", async () => {
  const player = new NeuralAudioPlayer();
  const controllers: AbortController[] = [];

  for (let i = 0; i < 10; i++) {
    const ac = new AbortController();
    controllers.push(ac);
    (player as any).inFlightControllers.add(ac);
  }

  player.stop();

  for (let i = 0; i < controllers.length; i++) {
    assert.equal(controllers[i].signal.aborted, true, `AbortController ${i} must have aborted signal`);
  }
  assert.equal((player as any).inFlightControllers.size, 0, "In-flight controllers set must be empty");
});

await test("2.3 Anti-pop 8ms master gain linear ramp is scheduled", async () => {
  const player = new NeuralAudioPlayer();
  const ctx = new MockAudioContext();
  (player as any).audioContext = ctx;
  const gain = ctx.createGain();
  (player as any).masterGain = gain;

  player.stop();

  assert(
    gain.scheduledRamps.length >= 1,
    "Expected linearRampToValueAtTime to be called on masterGain during stop()"
  );
  const lastRamp = gain.scheduledRamps[gain.scheduledRamps.length - 1];
  assert.equal(lastRamp.val, 0.0001, "Target gain must ramp down to near zero (0.0001)");
  assert.equal(
    lastRamp.time,
    ctx.currentTime + 0.008,
    "Ramp time must be exactly currentTime + 0.008s (8ms anti-pop window)"
  );
});

await test("2.4 Zero Zombie Sounds: Async fetches completing AFTER stop() are strictly discarded", async () => {
  const player = new NeuralAudioPlayer();
  const ctx = new MockAudioContext();
  (player as any).audioContext = ctx;
  (player as any).masterGain = ctx.createGain();

  player.startTurn(1);

  // Simulate a delayed fetch promise that was launched during turn 1
  let resolveDelayedFetch: any;
  const delayedPromise = new Promise<{ buffer: any; error: any }>((resolve) => {
    resolveDelayedFetch = resolve;
  });

  const abortController = new AbortController();
  const item = {
    turnId: (player as any).currentTurnId,
    text: "Delayed clause from turn 1",
    abortController,
    fetchPromise: delayedPromise,
  };
  (player as any).queue.push(item);

  // Caller barges in before fetch resolves
  player.stop();

  assert.equal(abortController.signal.aborted, true, "Item controller aborted on stop");

  // Now the delayed network packet arrives
  const mockBuffer = ctx.createBuffer(1, 24000, 24000);
  resolveDelayedFetch({ buffer: mockBuffer, error: null });
  await delayedPromise;

  // Let microtasks run
  await new Promise((r) => setTimeout(r, 10));

  // Assert that zero new sources were scheduled or played
  assert.equal(
    (player as any).activeSources.length,
    0,
    "Zero sources should be active after delayed fetch arrived"
  );
  assert.equal(
    ctx.createdSources.filter((s) => s.isPlaying).length,
    0,
    "No audio buffer sources should be playing from discarded turn"
  );
});

await test("2.5 Rapid barge-in stress: 100 consecutive stop-start cycles without memory leaks or race conditions", async () => {
  const player = new NeuralAudioPlayer();
  const ctx = new MockAudioContext();
  (player as any).audioContext = ctx;
  (player as any).masterGain = ctx.createGain();

  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    player.startTurn(i);
    // Add mock sources
    const s = ctx.createBufferSource();
    s.start();
    (player as any).activeSources.push(s);

    const ac = new AbortController();
    (player as any).inFlightControllers.add(ac);

    player.stop();

    assert.equal((player as any).activeSources.length, 0);
    assert.equal((player as any).inFlightControllers.size, 0);
    assert.equal((player as any).isTurnActive, false);
    assert.equal(ac.signal.aborted, true);
  }
  const totalDuration = performance.now() - t0;
  console.log(`    (100 stop-start cycles executed in ${totalDuration.toFixed(2)}ms, avg: ${(totalDuration / 100).toFixed(3)}ms/cycle)`);
  assert(totalDuration < 100, "100 cycles must complete in under 100ms total");
});

// ==============================================================================
// SUMMARY
// ==============================================================================
console.log("\n================================================================================");
console.log(`EMPIRICAL CHALLENGER VERDICT: ${testsPassed} passed, ${testsFailed} failed`);
console.log("================================================================================\n");

if (testsFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
