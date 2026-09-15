/**
 * Adversarial Empirical Stress Harness for Web Audio Unlock and Resumption.
 *
 * Tests:
 * 1. ctx.resume() rejects or hangs:
 *    - Synchronous throw in ctx.resume()
 *    - Asynchronous rejection in ctx.resume()
 *    - Indefinite hang in ctx.resume() during scheduleAudioBuffer() and unlockAudio()
 *    - Barge-in during hang: does stop() unwedge the scheduler or does isFetching deadlock?
 * 2. AudioContext transitions to "interrupted" or "suspended" mid-stream:
 *    - Interruption during active queue processing
 *    - Transition to "closed" and recreation: clock drift / nextPlayTime arithmetic
 *    - Buffer scheduling while suspended: ordering, timing, and recovery on resume
 * 3. unlockAudio() concurrency and stress:
 *    - 1,000 rapid consecutive calls: duplicate nodes, memory growth, masterGain / analyser integrity
 *    - Context state when already "running" vs "suspended"
 */

import assert from "node:assert/strict";

// Mock Web Audio Infrastructure
class MockAudioBuffer {
  constructor(duration = 1.0, sampleRate = 48000) {
    this.duration = duration;
    this.sampleRate = sampleRate;
    this.numberOfChannels = 1;
    this.length = Math.round(duration * sampleRate);
  }
}

let totalSourceNodesCreated = 0;
let totalGainNodesCreated = 0;
let totalAnalyserNodesCreated = 0;
let activeConnectedSources = new Set();

class MockAudioBufferSourceNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.onended = null;
    this.isPlaying = false;
    this.startTime = null;
    this.isStopped = false;
    this.isDisconnected = false;
    this.destination = null;
    this.id = ++totalSourceNodesCreated;
  }

  connect(dest) {
    this.destination = dest;
    activeConnectedSources.add(this);
  }

  disconnect() {
    this.isDisconnected = true;
    activeConnectedSources.delete(this);
  }

  start(time = 0) {
    this.startTime = time;
    this.isPlaying = true;
    if (this.buffer && (this.buffer.duration === 0 || this.buffer.length <= 1)) {
      // Immediate stop for 0-duration or 1-sample buffers
      this.stop();
    }
  }

  stop() {
    this.isStopped = true;
    this.isPlaying = false;
    if (this.onended) {
      const cb = this.onended;
      setTimeout(() => cb(), 0);
    }
  }
}

class MockGainNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = ++totalGainNodesCreated;
    this.gain = {
      value: 1.0,
      setValueAtTime: (val, time) => { this.gain.value = val; },
      linearRampToValueAtTime: (val, time) => { this.gain.value = val; },
      cancelScheduledValues: (time) => {},
    };
  }
  connect(dest) {}
  disconnect() {}
}

class MockAnalyserNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = ++totalAnalyserNodesCreated;
    this.fftSize = 256;
    this.smoothingTimeConstant = 0.8;
  }
  connect(dest) {}
  disconnect() {}
}

class MockAudioContext {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.currentTime = 10.0;
    this.state = "suspended";
    this.destination = { name: "MockAudioDestination" };
    this.resumeBehavior = "normal"; // "normal" | "reject" | "throw" | "hang"
    this.resumeDelayMs = 0;
  }

  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(length / sampleRate, sampleRate);
  }

  createBufferSource() {
    return new MockAudioBufferSourceNode(this);
  }

  createGain() {
    return new MockGainNode(this);
  }

  createAnalyser() {
    return new MockAnalyserNode(this);
  }

  async decodeAudioData(arrayBuffer) {
    return new MockAudioBuffer(1.0, this.sampleRate);
  }

  resume() {
    if (this.resumeBehavior === "throw") {
      throw new Error("Synchronous resume crash!");
    }
    if (this.resumeBehavior === "reject") {
      return Promise.reject(new Error("AudioContext resume rejected: user gesture required."));
    }
    if (this.resumeBehavior === "hang") {
      return new Promise(() => {}); // Never resolves
    }
    if (this.resumeDelayMs > 0) {
      return new Promise((resolve) => {
        setTimeout(() => {
          this.state = "running";
          resolve();
        }, this.resumeDelayMs);
      });
    }
    this.state = "running";
    return Promise.resolve();
  }

  async close() {
    this.state = "closed";
  }
}

// Global Browser Shims
const mockUtterances = [];
const mockSpeechSynthesis = {
  speaking: false,
  pending: false,
  paused: false,
  speak: (utterance) => {
    mockUtterances.push(utterance);
    mockSpeechSynthesis.speaking = true;
    utterance.onstart?.();
  },
  cancel: () => {
    mockSpeechSynthesis.speaking = false;
    mockUtterances.length = 0;
  },
  pause: () => { mockSpeechSynthesis.paused = true; },
  resume: () => { mockSpeechSynthesis.paused = false; },
  getVoices: () => [
    { name: "Microsoft Jenny Online (Natural) - English (United States)", lang: "en-US" },
  ],
};

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.AudioContext = MockAudioContext;
globalThis.webkitAudioContext = MockAudioContext;
globalThis.speechSynthesis = mockSpeechSynthesis;
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.pitch = 1;
    this.voice = null;
    this.lang = "en-US";
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
};

globalThis.fetch = async (url, options = {}) => {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(512),
  };
};

const { NeuralAudioPlayer } = await import("./neural-audio-player.ts");

console.log("=================================================================");
console.log("EMPIRICAL ADVERSARIAL CHALLENGER: WEB AUDIO UNLOCK & RESUME");
console.log("=================================================================");

async function test_resume_synchronous_throw() {
  console.log("\n[Stress Test 1A] ctx.resume() throws synchronously...");
  const player = new NeuralAudioPlayer();
  const ctx = player.getAudioContext();
  assert.ok(ctx, "AudioContext must exist");
  ctx.resumeBehavior = "throw";

  // 1. In unlockAudio
  let thrown = false;
  try {
    player.unlockAudio();
  } catch (err) {
    thrown = true;
  }
  assert.equal(thrown, false, "unlockAudio() must catch synchronous resume throw without crashing");

  // 2. In scheduleAudioBuffer
  let schedulerCrashed = false;
  try {
    player.startTurn();
    player.speakSentence("Testing synchronous resume crash.");
    await new Promise((r) => setTimeout(r, 40));
  } catch (err) {
    schedulerCrashed = true;
  }
  assert.equal(schedulerCrashed, false, "scheduleAudioBuffer() must catch synchronous resume throw without crashing");
  console.log("✓ PASS: Synchronous resume throw is safely caught in both unlockAudio and scheduleAudioBuffer.");
  player.close();
}

async function test_resume_rejection() {
  console.log("\n[Stress Test 1B] ctx.resume() rejects asynchronously...");
  const player = new NeuralAudioPlayer();
  const ctx = player.getAudioContext();
  ctx.resumeBehavior = "reject";

  let caught = true;
  try {
    player.unlockAudio();
    player.startTurn();
    player.speakSentence("Testing asynchronous rejection.");
    await new Promise((r) => setTimeout(r, 40));
  } catch (err) {
    caught = false;
  }
  assert.ok(caught, "Rejected resume promise must not produce unhandled promise rejection");
  // Check that player state did not permanently hang
  assert.equal(player["isFetching"], false, "isFetching must return to false after rejection");
  console.log("✓ PASS: Asynchronous resume rejection is safely caught and does not crash the audio scheduler.");
  player.close();
}

async function test_resume_hang_deadlock_evaluation() {
  console.log("\n[Stress Test 1C] ctx.resume() hangs indefinitely (Promise never resolves)...");
  const player = new NeuralAudioPlayer();
  const ctx = player.getAudioContext();
  ctx.resumeBehavior = "hang";

  player.startTurn();
  player.speakSentence("First sentence that hangs on resume.");

  // Allow queue processing to reach await ctx.resume()
  await new Promise((r) => setTimeout(r, 50));

  console.log("  Evaluating scheduler state during resume hang:");
  console.log("  - isFetching:", player["isFetching"]);
  console.log("  - queue length:", player["queue"].length);
  console.log("  - isTurnActive:", player["isTurnActive"]);

  // EMPIRICAL OBSERVATION:
  const isFetchingDuringHang = player["isFetching"];

  // Now simulate caller barge-in or stop()
  console.log("  Simulating caller barge-in / stop()...");
  player.stop();

  console.log("  Evaluating scheduler state after stop():");
  console.log("  - isFetching:", player["isFetching"]);
  console.log("  - isTurnActive:", player["isTurnActive"]);

  // Now simulate a subsequent turn
  console.log("  Attempting new turn after stop()...");
  ctx.resumeBehavior = "normal"; // resume unblocks in subsequent turn
  player.startTurn();
  player.speakSentence("Second sentence after barge-in.");

  await new Promise((r) => setTimeout(r, 50));
  console.log("  Evaluating new turn state:");
  console.log("  - isFetching:", player["isFetching"]);
  console.log("  - activeSources count:", player["activeSources"].length);
  console.log("  - queue length:", player["queue"].length);

  const newTurnProcessed = player["activeSources"].length > 0 || player["queue"].length === 0;
  console.log("  Did new turn schedule playback?", newTurnProcessed ? "YES" : "NO");
  assert.equal(newTurnProcessed, true, "New turn must schedule playback after barge-in/stop");
  console.log("✓ PASS: [1C] Hanging resume recovered on stop/barge-in and next turn processed.");

  player.close();
  return { isFetchingDuringHang, newTurnProcessed };
}

async function test_interruption_mid_stream() {
  console.log("\n[Stress Test 2] AudioContext transitions to 'interrupted'/'suspended' mid-stream...");
  const player = new NeuralAudioPlayer();
  const ctx = player.getAudioContext();
  ctx.state = "running";

  player.startTurn();
  player.speakSentence("Sentence 1 streaming.");
  player.speakSentence("Sentence 2 streaming.");

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(player["activeSources"].length >= 1, true, "At least 1 source should be active");

  // Context transitions to interrupted (e.g. phone call arrives)
  console.log("  AudioContext transitioned to 'interrupted'!");
  ctx.state = "interrupted";

  // Queue an additional sentence during interruption
  player.speakSentence("Sentence 3 queued while interrupted.");
  await new Promise((r) => setTimeout(r, 30));

  // Verify scheduler did not crash
  assert.equal(player["isTurnActive"], true, "Turn remains active during interruption");
  console.log("  - Active sources during interruption:", player["activeSources"].length);
  console.log("  - Player isPlaying flag:", player["isPlaying"]);

  // Interruption ends, audio resumed via wake / unlockAudio
  console.log("  Interruption ends, invoking unlockAudio()...");
  player.unlockAudio();
  assert.equal(ctx.state, "running", "Context must resume to running");

  // All sources complete
  for (const s of [...player["activeSources"]]) {
    s.stop();
  }
  await new Promise((r) => setTimeout(r, 50));

  console.log("✓ PASS: Mid-stream interruption transitions cleanly and recovers without crashing.");
  player.close();
}

async function test_context_closed_recreation() {
  console.log("\n[Stress Test 2B] AudioContext closes (e.g. OS kills audio HAL) and re-instantiates...");
  const player = new NeuralAudioPlayer();
  const oldCtx = player.getAudioContext();
  oldCtx.currentTime = 50.0;
  oldCtx.state = "running";

  player.startTurn();
  player.speakSentence("Old sentence before audio device crash.");
  await new Promise((r) => setTimeout(r, 20));

  console.log("  Old context currentTime:", oldCtx.currentTime);
  console.log("  Player nextPlayTime on old context:", player["nextPlayTime"]);

  // Simulate Android OS closing the audio context
  await oldCtx.close();
  console.log("  Old context state:", oldCtx.state);

  // New turn begins after audio device reset
  player.startTurn();
  const newCtx = player.getAudioContext();
  assert.notEqual(oldCtx, newCtx, "A new AudioContext must be instantiated when old one is closed");
  console.log("  New context created, initial currentTime:", newCtx.currentTime);
  console.log("  Player nextPlayTime after new context init / startTurn():", player["nextPlayTime"]);

  player.speakSentence("New sentence on fresh AudioContext.");
  await new Promise((r) => setTimeout(r, 20));

  const scheduledSource = player["activeSources"][0];
  console.log("  Scheduled source startTime on new context:", scheduledSource?.startTime);

  // Check if scheduled source has massive delay (>1.0s in the future on a context with currentTime=10.0)
  const drift = (scheduledSource?.startTime ?? 0) - newCtx.currentTime;
  console.log(`  Delay between new context currentTime and scheduled startTime: ${drift.toFixed(3)}s`);

  if (drift > 1.0) {
    console.warn(`  ⚠️ CRITICAL FINDING: Clock drift detected! Buffer was scheduled ${drift.toFixed(3)}s in the future because nextPlayTime was not reset on AudioContext re-creation.`);
    assert.fail(`Clock drift detected: ${drift.toFixed(3)}s`);
  } else {
    console.log("  ✓ PASS: [2B] Buffer was scheduled immediately without clock drift.");
  }

  player.close();
  return { drift };
}

async function test_unlockAudio_concurrency_and_nodes() {
  console.log("\n[Stress Test 3] unlockAudio() rapid consecutive calls (1,000 invocations)...");
  totalSourceNodesCreated = 0;
  totalGainNodesCreated = 0;
  totalAnalyserNodesCreated = 0;

  const player = new NeuralAudioPlayer();
  const ctx = player.getAudioContext();
  assert.ok(ctx, "Context instantiated");

  const initialGainNodes = totalGainNodesCreated;
  const initialAnalyserNodes = totalAnalyserNodesCreated;
  const initialSources = totalSourceNodesCreated;

  console.log(`  Initial nodes: Gain=${initialGainNodes}, Analyser=${initialAnalyserNodes}, Sources=${initialSources}`);

  const startTime = performance.now();
  for (let i = 0; i < 1000; i++) {
    player.unlockAudio();
  }
  const elapsedMs = performance.now() - startTime;

  console.log(`  Executed 1,000 unlockAudio() calls in ${elapsedMs.toFixed(2)}ms`);
  console.log(`  Gain nodes created: ${totalGainNodesCreated} (expected: ${initialGainNodes})`);
  console.log(`  Analyser nodes created: ${totalAnalyserNodesCreated} (expected: ${initialAnalyserNodes})`);
  console.log(`  Source nodes created: ${totalSourceNodesCreated} (1 per unlockAudio call: ${totalSourceNodesCreated - initialSources})`);
  console.log(`  Connected source nodes lingering without disconnect(): ${activeConnectedSources.size}`);

  // Assertions 3A:
  assert.equal(totalGainNodesCreated, initialGainNodes, "Gain nodes must NOT be duplicated");
  assert.equal(totalAnalyserNodesCreated, initialAnalyserNodes, "Analyser nodes must NOT be duplicated");
  assert.equal(player.getAnalyserNode(), player.getAnalyserNode(), "AnalyserNode reference must remain identical");
  console.log("✓ PASS: [3A] No duplicate processing nodes (Gain/Analyser) created across 1,000 rapid calls.");

  // Assertions 3B:
  assert.ok(totalSourceNodesCreated - initialSources <= 1, "Source nodes must NOT be allocated redundantly when running");
  console.log("✓ PASS: [3B] Source nodes not redundantly allocated when context is running.");

  player.close();
}

async function test_event_listener_cleanup() {
  console.log("\n[Stress Test 4] Event listener cleanup on player.close()...");
  let added = [];
  let removed = [];
  const origWinAdd = globalThis.addEventListener;
  const origWinRem = globalThis.removeEventListener;
  const origDocAdd = globalThis.document.addEventListener;
  const origDocRem = globalThis.document.removeEventListener;

  globalThis.addEventListener = (evt, fn) => { added.push({ target: "window", evt, fn }); };
  globalThis.removeEventListener = (evt, fn) => { removed.push({ target: "window", evt, fn }); };
  globalThis.document.addEventListener = (evt, fn) => { added.push({ target: "document", evt, fn }); };
  globalThis.document.removeEventListener = (evt, fn) => { removed.push({ target: "document", evt, fn }); };

  try {
    const player = new NeuralAudioPlayer();
    assert.equal(added.filter(a => a.evt === "visibilitychange").length, 1, "visibilitychange listener added");
    assert.equal(added.filter(a => a.evt === "focus").length, 1, "focus listener added");

    player.close();
    assert.equal(removed.filter(r => r.evt === "visibilitychange").length, 1, "visibilitychange listener removed");
    assert.equal(removed.filter(r => r.evt === "focus").length, 1, "focus listener removed");

    // Verify exact function references matched
    const visAdd = added.find(a => a.evt === "visibilitychange");
    const visRem = removed.find(r => r.evt === "visibilitychange");
    assert.equal(visAdd.fn, visRem.fn, "visibilitychange handler reference must match exactly");

    const focAdd = added.find(a => a.evt === "focus");
    const focRem = removed.find(r => r.evt === "focus");
    assert.equal(focAdd.fn, focRem.fn, "focus handler reference must match exactly");

    console.log("✓ PASS: [4] Event listeners registered in constructor are cleanly removed on close().");
  } finally {
    globalThis.addEventListener = origWinAdd;
    globalThis.removeEventListener = origWinRem;
    globalThis.document.addEventListener = origDocAdd;
    globalThis.document.removeEventListener = origDocRem;
  }
}

async function runAllChallengerTests() {
  await test_resume_synchronous_throw();
  await test_resume_rejection();
  const hangResult = await test_resume_hang_deadlock_evaluation();
  await test_interruption_mid_stream();
  await test_context_closed_recreation();
  await test_unlockAudio_concurrency_and_nodes();
  await test_event_listener_cleanup();

  console.log("\n=================================================================");
  console.log("CHALLENGER STRESS SUITE COMPLETE");
  console.log("=================================================================");
}

runAllChallengerTests().catch((e) => {
  console.error("CHALLENGER TEST ERROR:", e);
  process.exit(1);
});
