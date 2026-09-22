/**
 * Turn-ownership regression suite for NeuralAudioPlayer.
 *
 * Reproduces two confirmed races:
 *   1. Stale resume: scheduleAudioBuffer awaited ctx.resume() and then checked
 *      only isTurnActive, so a buffer belonging to a stopped turn could be
 *      scheduled into its replacement turn.
 *   2. Worker clobber: stopAudioInternal reset isFetching while the old queue
 *      worker was still awaiting its fetch; the old worker's unconditional
 *      finally cleared the replacement worker's fetching flag, letting
 *      checkTurnCompletion finish the new turn before its audio was scheduled.
 */

import assert from "node:assert/strict";

let stopMarkerArmed = false;
let decodedStartsAfterStop = 0;
const decodedStarts = [];

class MockDecodedBuffer {
  constructor(duration = 1.0) {
    this.duration = duration;
    this.sampleRate = 24000;
    this.numberOfChannels = 1;
    this.length = Math.round(duration * this.sampleRate);
    this.isDecoded = true;
  }
}

class MockSourceNode {
  constructor() {
    this.buffer = null;
    this.onended = null;
    this.startedAt = null;
    this.stopped = false;
  }
  connect() {}
  disconnect() {}
  start(time) {
    this.startedAt = time;
    if (this.buffer?.isDecoded) {
      decodedStarts.push(this);
      if (stopMarkerArmed) decodedStartsAfterStop++;
    }
  }
  stop() {
    this.stopped = true;
  }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 10.0;
    this.state = "running";
    this.destination = {};
    this.pendingResumes = [];
  }
  createBuffer(channels, length, sampleRate) {
    return { duration: length / sampleRate, sampleRate, numberOfChannels: channels, length, isDecoded: false };
  }
  createBufferSource() {
    return new MockSourceNode();
  }
  createGain() {
    return {
      gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
      connect() {},
      disconnect() {},
    };
  }
  createAnalyser() {
    return { fftSize: 256, smoothingTimeConstant: 0.8, connect() {}, disconnect() {} };
  }
  async decodeAudioData() {
    return new MockDecodedBuffer();
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  async close() {
    this.state = "closed";
  }
}

class DeferredResumeAudioContext extends MockAudioContext {
  constructor() {
    super();
    this.state = "suspended";
  }
  resume() {
    return new Promise((resolve) => {
      this.pendingResumes.push(resolve);
    });
  }
}

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.AudioContext = MockAudioContext;
globalThis.speechSynthesis = {
  speaking: false, pending: false, paused: false,
  speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [],
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; }
};

let fetchCalls = 0;
let deferredFetches = [];
globalThis.fetch = (_url, options = {}) => {
  fetchCalls++;
  if (options.signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    deferredFetches.push({ resolve, reject });
  });
};

function resolveNextFetch() {
  const pending = deferredFetches.shift();
  assert.ok(pending, "expected a pending fetch to resolve");
  pending.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
}

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function testStaleResumeDoesNotScheduleIntoReplacementTurn() {
  globalThis.AudioContext = DeferredResumeAudioContext;
  fetchCalls = 0;
  deferredFetches = [];
  const { NeuralAudioPlayer } = await import("./neural-audio-player.ts");
  NeuralAudioPlayer.clearCache();
  decodedStarts.length = 0;
  decodedStartsAfterStop = 0;
  const player = new NeuralAudioPlayer();
  try {
    player.startTurn();
    player.speakSentence("stale resume probe one");
    await flush();
    assert.equal(fetchCalls, 1, "turn A sentence fetch dispatched");
    resolveNextFetch();
    await flush();

    const ctx = player.getAudioContext();
    assert.equal(ctx.state, "suspended", "context is suspended so the scheduler parks on resume");
    assert.ok(ctx.pendingResumes.length >= 1, "scheduler awaited AudioContext.resume()");

    stopMarkerArmed = true;
    player.stop(); // caller barge-in ends turn A
    player.startTurn(); // replacement turn B begins before the old resume settles

    for (const resolve of ctx.pendingResumes.splice(0)) resolve();
    await flush();

    assert.equal(
      decodedStartsAfterStop, 0,
      "a buffer from the stopped turn must never be scheduled into the replacement turn",
    );
    console.log("PASS: stale resume cannot schedule old-turn audio into the new turn");
  } finally {
    stopMarkerArmed = false;
    player.close();
  }
}

async function testReplacementWorkerSurvivesOldWorkerCompletion() {
  globalThis.AudioContext = MockAudioContext;
  const { NeuralAudioPlayer } = await import("./neural-audio-player.ts");
  NeuralAudioPlayer.clearCache();
  decodedStarts.length = 0;
  decodedStartsAfterStop = 0;
  fetchCalls = 0;
  deferredFetches = [];
  const player = new NeuralAudioPlayer();
  const turnEnds = [];
  player.setTurnStateCallback((active) => {
    if (!active) turnEnds.push("ended");
  });
  try {
    player.startTurn(); // turn A
    player.speakSentence("worker generation probe two");
    assert.equal(fetchCalls, 1, "turn A fetch dispatched");

    player.stop(); // barge-in resets fetching state while turn A fetch is pending
    player.startTurn(); // turn B
    turnEnds.length = 0; // Exclude the intentional end of turn A.
    player.speakSentence("worker generation probe three");
    await flush();
    assert.equal(fetchCalls, 2, "turn B fetched its own sentence");

    resolveNextFetch(); // settle the OLD turn's fetch first
    await flush();

    player.endTurnQueue(); // turn B's stream is complete while its fetch is in flight
    await flush();
    assert.equal(
      turnEnds.length, 0,
      "turn B must not finish while its own fetch is still in flight",
    );

    resolveNextFetch(); // now settle turn B's fetch
    await flush();
    assert.equal(
      decodedStarts.length, 1,
      "turn B audio must be scheduled exactly once after its fetch resolves",
    );
    console.log("PASS: replacement worker survives old worker completion");
  } finally {
    player.close();
  }
}

let failures = 0;
for (const test of [
  testStaleResumeDoesNotScheduleIntoReplacementTurn,
  testReplacementWorkerSurvivesOldWorkerCompletion,
]) {
  try {
    await test();
  } catch (error) {
    failures++;
    console.error(`FAIL: ${test.name}`, error);
  }
}
console.log(`Audio turn ownership: ${2 - failures} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
