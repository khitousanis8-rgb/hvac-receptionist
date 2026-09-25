/**
 * Empirical Adversarial Test Suite for Speech Recognition
 * Challenges:
 * 1. 150ms onend backoff window, race conditions, abort, and ghost listener prevention.
 * 2. Echo suppression whitelist with greetings vs genuine echo repeats and edge cases.
 */

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
  throwOnStart: Error | null = null;
  isActive = false;

  start() {
    this.startCalls++;
    if (this.throwOnStart) {
      throw this.throwOnStart;
    }
    this.isActive = true;
  }
  abort() {
    this.abortCalls++;
    this.isActive = false;
    if (this.onend) {
      // In browser, abort triggers onend asynchronously
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

// Polyfill window & Web Speech
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

import { BrowserSpeechRecognition } from "./speech-recognition.ts";
import { NeuralAudioPlayer } from "./neural-audio-player.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ FAIL: ${testName} ${detail ? " - " + detail : ""}`);
  }
}

async function runBackoffWindowStressTests() {
  console.log("\n=== TEST SUITE 1: 150ms onend Backoff Window & Ghost Listener Prevention ===");

  // 1.1 Baseline restart after 150ms backoff
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();
    assert(mockRec.startCalls === 1, "1.1 Normal start calls start() once");
    assert((speech as any).isListening === true, "1.1 isListening is true");

    // Simulate onend
    mockRec.onend();
    assert((speech as any).isListening === false, "1.1 isListening immediately set to false on onend");
    assert(mockRec.startCalls === 1, "1.1 start() not called synchronously on onend (backoff active)");
    assert((speech as any).restartTimer !== null, "1.1 restartTimer is set");

    // Wait 160ms (past the 150ms backoff)
    await sleep(180);
    assert(mockRec.startCalls === 2, "1.1 start() called after 150ms backoff expires");
    assert((speech as any).isListening === true, "1.1 isListening restored to true");
    assert((speech as any).restartTimer === null, "1.1 restartTimer reset to null");

    speech.stop();
    await sleep(20);
  }

  // 1.2 User calls setMuted(true) during 150ms backoff window
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();
    assert(mockRec.startCalls === 1, "1.2 Started");

    // Trigger onend -> starts 150ms timer
    mockRec.onend();
    assert((speech as any).restartTimer !== null, "1.2 restartTimer scheduled");

    // Mute at 50ms (during the 150ms window)
    await sleep(50);
    speech.setMuted(true);

    assert((speech as any).isMuted === true, "1.2 isMuted is true");
    assert((speech as any).restartTimer === null, "1.2 restartTimer cancelled by setMuted(true)");
    assert((speech as any).isListening === false, "1.2 isListening is false");

    // Wait beyond the original 150ms window
    await sleep(150);
    assert(mockRec.startCalls === 1, "1.2 start() NOT called while muted (no ghost listener)");
    assert((speech as any).isListening === false, "1.2 isListening remains false");

    // Unmute should cleanly resume
    speech.setMuted(false);
    assert(mockRec.startCalls === 2, "1.2 Unmute cleanly restarts listening");

    speech.stop();
    await sleep(20);
  }

  // 1.3 User calls stop() during 150ms backoff window
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();
    assert(mockRec.startCalls === 1, "1.3 Started");

    // Trigger onend
    mockRec.onend();
    assert((speech as any).restartTimer !== null, "1.3 restartTimer scheduled");

    // Stop at 50ms
    await sleep(50);
    speech.stop();

    assert((speech as any).shouldBeListening === false, "1.3 shouldBeListening is false");
    assert((speech as any).restartTimer === null, "1.3 restartTimer cleared by stop()");
    assert((speech as any).isListening === false, "1.3 isListening is false");

    // Wait past 150ms
    await sleep(150);
    assert(mockRec.startCalls === 1, "1.3 start() NOT called after stop() (no ghost listener)");
    assert((speech as any).isListening === false, "1.3 isListening remains false");
    await sleep(20);
  }

  // 1.4 User hangs up (unmount -> stop) during 150ms backoff window
  {
    let stateChanges: boolean[] = [];
    const speech = new BrowserSpeechRecognition();
    speech.setCallbacks({
      onStateChange: (state) => stateChanges.push(state),
    });
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();

    // Trigger onend
    mockRec.onend();
    assert(stateChanges[stateChanges.length - 1] === true, "1.4 Started state recorded");

    // Hangup at 60ms
    await sleep(60);
    speech.stop();

    // Wait past 150ms
    await sleep(160);
    assert(mockRec.startCalls === 1, "1.4 Hangup completely prevents restart");
    assert((speech as any).isListening === false, "1.4 Listener inactive after hangup");
    assert(stateChanges[stateChanges.length - 1] === false, "1.4 Final state change is false");
    await sleep(20);
  }

  // 1.5 Agent speaks (pauseForAgentPlayback(true)) during 150ms backoff window
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();

    // Trigger onend
    mockRec.onend();
    assert((speech as any).restartTimer !== null, "1.5 restartTimer active");

    // Agent starts speaking at 40ms
    await sleep(40);
    speech.pauseForAgentPlayback(true);

    assert((speech as any).isPausedForAgent === true, "1.5 isPausedForAgent is true");
    assert((speech as any).restartTimer === null, "1.5 restartTimer cleared on agent speech");

    // Wait past 150ms
    await sleep(150);
    assert(mockRec.startCalls === 1, "1.5 No restart while agent is speaking");
    assert((speech as any).isListening === false, "1.5 isListening remains false while agent speaks");

    speech.stop();
    await sleep(20);
  }

  // 1.6 resumeImmediatelyForInterrupt() during 150ms backoff window
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();

    // Trigger onend
    mockRec.onend();
    assert((speech as any).restartTimer !== null, "1.6 restartTimer active");

    // Caller interrupts at 40ms
    await sleep(40);
    speech.resumeImmediatelyForInterrupt();

    assert((speech as any).restartTimer === null, "1.6 restartTimer cleared on interrupt");
    assert((speech as any).isPausedForAgent === true, "1.6 In 200ms interrupt tail drain");

    // After 200ms interrupt cooldown expires
    await sleep(220);
    assert(mockRec.startCalls === 2, "1.6 Clean restart after interrupt drain");
    assert((speech as any).isListening === true, "1.6 isListening restored");

    speech.stop();
    await sleep(20);
  }

  // 1.7 Multiple rapid onend() events within backoff window
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();

    // Fire 5 rapid onends
    mockRec.onend();
    await sleep(20);
    mockRec.onend();
    await sleep(20);
    mockRec.onend();
    await sleep(20);
    mockRec.onend();
    await sleep(20);
    mockRec.onend();

    // Wait 100ms (total from first is 180ms, but last was at 80ms, so 100ms after last is only 100ms)
    await sleep(100);
    assert(mockRec.startCalls === 1, "1.7 Timers were debounced/reset on each onend");

    // Wait remaining 80ms to complete 150ms from last onend
    await sleep(80);
    assert(mockRec.startCalls === 2, "1.7 Exactly one restart occurred despite multiple onend events");

    speech.stop();
    await sleep(20);
  }

  // 1.8 Catch block recovery when start() throws InvalidStateError during 150ms timer callback
  {
    const speech = new BrowserSpeechRecognition();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    await speech.start();

    // Make recognition.start() throw on next attempt
    const invalidStateErr = new Error("InvalidStateError");
    invalidStateErr.name = "InvalidStateError";
    mockRec.throwOnStart = invalidStateErr;

    // Trigger onend
    mockRec.onend();

    // Wait past 150ms
    await sleep(180);

    // Verify it cleanly transitioned without unhandled rejection
    assert((speech as any).isSupported === false, "1.8 Caught error demotes isSupported to false");
    assert((speech as any).recognition === null, "1.8 recognition instance cleaned up");
    assert(speech.getInputPath() === "media_recorder_transcription", "1.8 Input path transitioned to fallback");

    speech.stop();
    await sleep(20);
  }
}

async function runEchoSuppressionWhitelistTests() {
  console.log("\n=== TEST SUITE 2: Echo Suppression Whitelist & Precision ===");

  const speech = new BrowserSpeechRecognition();
  // Register typical assistant opening utterance
  const assistantOpening = "Hi there, thank you for calling Apex Air. My name is Sarah. How can I assist you with your heating or cooling today?";
  speech.registerAssistantSpeech(assistantOpening);

  // Helper to test isAcousticEcho
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  // 2.1 Greeting Whitelist False-Positive Prevention
  console.log("\n  --- 2.1 Greeting Whitelist False-Positive Prevention ---");
  const greetings = [
    "hello",
    "hi",
    "hey",
    "hi there",
    "hello there",
    "good morning",
    "good afternoon",
  ];

  for (const g of greetings) {
    assert(isEcho(g) === false, `2.1 Greeting '${g}' is NOT suppressed as echo`);
  }

  // Punctuation and case variations
  assert(isEcho("Hi there!") === false, "2.1 'Hi there!' (with exclamation) is NOT suppressed");
  assert(isEcho("Hello.") === false, "2.1 'Hello.' (with period) is NOT suppressed");
  assert(isEcho("GOOD MORNING") === false, "2.1 'GOOD MORNING' (uppercase) is NOT suppressed");
  assert(isEcho("  hello there  ") === false, "2.1 '  hello there  ' (padded whitespace) is NOT suppressed");

  // Booking confirmations
  const confirmations = ["yes", "yeah", "yep", "sure", "ok", "okay", "go ahead", "sounds good", "that works"];
  for (const c of confirmations) {
    assert(isEcho(c) === false, `2.1 Confirmation '${c}' is NOT suppressed`);
  }

  // 2.2 Genuine Echo Repeat Suppression
  console.log("\n  --- 2.2 Genuine Echo Repeats Suppression ---");
  
  // Full signature phrases from assistant greeting
  assert(isEcho("thank you for calling") === true, "2.2 'thank you for calling' IS suppressed");
  assert(isEcho("my name is sarah") === true, "2.2 'my name is sarah' IS suppressed");
  assert(isEcho("how can i assist") === true, "2.2 'how can i assist' IS suppressed");
  assert(isEcho("with your heating or cooling") === true, "2.2 'with your heating or cooling' IS suppressed");

  // Compound echo where greeting is repeated along with assistant signature phrase
  assert(isEcho("hi there thank you for calling") === true, "2.2 'hi there thank you for calling' IS suppressed (signature phrase match)");
  assert(isEcho("hi there thank you for calling apex air") === true, "2.2 'hi there thank you for calling apex air' IS suppressed (signature + prefix)");
  assert(isEcho("thank you for calling apex air my name is sarah") === true, "2.2 'thank you for calling apex air my name is sarah' IS suppressed");
  assert(isEcho("my name is sarah how can i assist") === true, "2.2 'my name is sarah how can i assist' IS suppressed");

  // Echo of middle assistant phrases
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  assert(isEcho("what is the best callback phone number") === true, "2.2 'what is the best callback phone number' IS suppressed");
  assert(isEcho("best callback phone number") === true, "2.2 'best callback phone number' IS suppressed");
  assert(isEcho("technician to reach you") === true, "2.2 'technician to reach you' IS suppressed");
  // 2-word distorted echo fragments typical on Windows & Android loudspeakers
  assert(isEcho("technician reach") === true, "2.2 'technician reach' 2-word echo IS suppressed");
  assert(isEcho("callback phone") === true, "2.2 'callback phone' 2-word echo IS suppressed");
  assert(isEcho("cooling today") === true, "2.2 'cooling today' 2-word echo IS suppressed");

  // Echo of closing phrases
  speech.registerAssistantSpeech("You are all set. Our technician will see you then. Is there anything else I can help with?");
  assert(isEcho("you are all set") === true, "2.2 'you are all set' IS suppressed");
  assert(isEcho("our technician will see you then") === true, "2.2 'our technician will see you then' IS suppressed");
  assert(isEcho("is there anything else i can help with") === true, "2.2 'is there anything else i can help with' IS suppressed");

  // 2.3 Genuine Caller Inquiries (Must NOT be suppressed)
  console.log("\n  --- 2.3 Genuine Caller Inquiries ---");
  assert(isEcho("hello i need help with my ac") === false, "2.3 'hello i need help with my ac' is NOT suppressed");
  assert(isEcho("ac repair") === false, "2.3 'ac repair' 2-word genuine service is NOT suppressed");
  assert(isEcho("heating repair") === false, "2.3 'heating repair' 2-word genuine service is NOT suppressed");
  assert(isEcho("tune up") === false, "2.3 'tune up' 2-word genuine service is NOT suppressed");
  assert(isEcho("hi there my furnace is making a strange noise") === false, "2.3 'hi there my furnace is making a strange noise' is NOT suppressed");
  assert(isEcho("good morning i would like to schedule maintenance") === false, "2.3 'good morning i would like to schedule maintenance' is NOT suppressed");
  assert(isEcho("hey sarah my air conditioner stopped cooling") === false, "2.3 'hey sarah my air conditioner stopped cooling' is NOT suppressed");
  assert(isEcho("i have a leaking pipe") === false, "2.3 'i have a leaking pipe' is NOT suppressed");
  assert(isEcho("tomorrow at 2 pm works great") === false, "2.3 'tomorrow at 2 pm works great' is NOT suppressed");

  // 2.4 Adversarial Edge Cases & Vulnerability Probing
  console.log("\n  --- 2.4 Adversarial Edge Cases & Vulnerability Probing ---");

  // Edge Case A: "Good evening"
  // Is "good evening" suppressed if assistant opened with "Good evening"?
  speech.registerAssistantSpeech("Good evening, thank you for calling Apex Air. My name is Sarah.");
  const goodEveningResult = isEcho("good evening");
  console.log(`  [Vulnerability Check] 'good evening' when assistant said 'Good evening...': isEcho = ${goodEveningResult}`);
  // In current code, "good evening" is NOT in GENUINE_CONFIRMATIONS!
  // It has rawWords.length === 2, and utterance.startsWith("good evening") is TRUE!
  // So it will return TRUE (suppressed)!
  if (goodEveningResult === true) {
    console.warn("  ⚠️ VULNERABILITY CONFIRMED: 'good evening' is FALSE-POSITIVE SUPPRESSED because it is missing from GENUINE_CONFIRMATIONS!");
  }

  // Edge Case B: Caller says "Hi there Sarah" when assistant said "Hi there... My name is Sarah"
  speech.registerAssistantSpeech("Hi there, thank you for calling Apex Air. My name is Sarah.");
  const hiThereSarahResult = isEcho("hi there sarah");
  console.log(`  [Edge Case Check] 'hi there sarah': isEcho = ${hiThereSarahResult}`);

  // Edge Case C: Single word greeting "morning" or "afternoon" without "good"
  speech.registerAssistantSpeech("Good morning, thank you for calling Apex Air.");
  const morningResult = isEcho("morning");
  console.log(`  [Edge Case Check] 'morning': isEcho = ${morningResult}`);
  assert(morningResult === false, "2.4 Single word 'morning' is NOT suppressed");

  // Edge Case D: Caller says "hi there yes"
  const hiThereYesResult = isEcho("hi there yes");
  console.log(`  [Edge Case Check] 'hi there yes': isEcho = ${hiThereYesResult}`);
  assert(hiThereYesResult === false, "2.4 'hi there yes' is NOT suppressed");

  // Edge Case E: Caller providing callback number with phone digits
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const callbackPhoneWithDigits = isEcho("my callback number is 555-234-5678");
  assert(callbackPhoneWithDigits === false, "2.4 'my callback number is 555-234-5678' is NOT suppressed");
  const callbackPhone2 = isEcho("the callback phone is 555-234-5678");
  assert(callbackPhone2 === false, "2.4 'the callback phone is 555-234-5678' is NOT suppressed");
}

async function runGatingAndLatencyStressTests() {
  console.log("\n=== TEST SUITE 3: Minimum Speech Latency Guard & Real-Time Audio Level Gating ===");

  // 3.1 350ms Minimum Speech Latency Guard
  {
    const speech = new BrowserSpeechRecognition();
    let transcriptReceived: boolean = false;
    speech.setCallbacks({
      onTranscript: () => {
        transcriptReceived = true;
      },
    });
    await speech.start();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;

    // Simulate in-flight transcript arriving at 50ms after session start
    (speech as any).sessionStartTime = Date.now();
    mockRec.onresult({
      resultIndex: 0,
      results: [[{ transcript: "hello there", isFinal: true }]],
    });
    assert(transcriptReceived === false, "3.1 In-flight transcript arriving within 350ms is DROPPED");

    // Simulate genuine speech arriving at 400ms after session start
    (speech as any).sessionStartTime = Date.now() - 400;
    mockRec.onresult({
      resultIndex: 0,
      results: [[{ transcript: "hello there", isFinal: true }]],
    });
    assert(Boolean(transcriptReceived) === true, "3.1 Genuine speech arriving after 350ms latency guard is ACCEPTED");

    speech.stop();
  }

  // 3.2 Continuous Audio Level Output Gating
  {
    const speech = new BrowserSpeechRecognition();
    let transcriptReceived: boolean = false;
    speech.setCallbacks({
      onTranscript: () => {
        transcriptReceived = true;
      },
    });
    await speech.start();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;
    (speech as any).sessionStartTime = Date.now() - 500;

    // Simulate physical audio output active (loudspeaker playing)
    speech.setAudioOutputActiveCheck(() => true);
    mockRec.onresult({
      resultIndex: 0,
      results: [[{ transcript: "hello there", isFinal: true }]],
    });
    assert(transcriptReceived === false, "3.2 Microphone input while audio output is active is DROPPED");

    // Simulate audio output silent
    speech.setAudioOutputActiveCheck(() => false);
    mockRec.onresult({
      resultIndex: 0,
      results: [[{ transcript: "hello there", isFinal: true }]],
    });
    assert(Boolean(transcriptReceived) === true, "3.2 Microphone input when audio output is silent is ACCEPTED");

    speech.stop();
  }

  // 3.3 Genuine Service & Date/Time Suffix/Substring Whitelist
  {
    const speech = new BrowserSpeechRecognition();
    const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

    // Case 1: Assistant prompt ending with "AC repair"
    speech.registerAssistantSpeech("Do you need heating or AC repair?");
    assert(isEcho("ac repair") === false, "3.3 'ac repair' choice when prompt ends with 'AC repair' is NOT echo");
    assert(isEcho("heating repair") === false, "3.3 'heating repair' choice is NOT echo");

    // Case 2: Assistant prompt ending with "tune up"
    speech.registerAssistantSpeech("Would you like a furnace tune up?");
    assert(isEcho("tune up") === false, "3.3 'tune up' choice when prompt ends with 'tune up' is NOT echo");
    assert(isEcho("furnace maintenance") === false, "3.3 'furnace maintenance' choice is NOT echo");

    // Case 3: Assistant prompt containing dates and times
    speech.registerAssistantSpeech("We have openings tomorrow at 10 AM or Friday at 2 PM for our technician to visit.");
    assert(isEcho("tomorrow at 10 AM") === false, "3.3 'tomorrow at 10 AM' appointment choice is NOT echo");
    assert(isEcho("tomorrow at 10") === false, "3.3 'tomorrow at 10' appointment choice is NOT echo");
    assert(isEcho("Friday at 2 PM") === false, "3.3 'Friday at 2 PM' appointment choice is NOT echo");

    // Case 4: Assistant prompt containing emergency service
    speech.registerAssistantSpeech("We provide emergency AC repair and maintenance throughout the valley.");
    assert(isEcho("emergency AC repair") === false, "3.3 'emergency AC repair' is NOT echo");

    // Negative Controls: Assistant echoes must still be 100% suppressed
    assert(isEcho("cooling today") === true, "3.3 'cooling today' assistant phrase IS suppressed");
    assert(isEcho("technician reach") === true, "3.3 'technician reach' assistant phrase IS suppressed");
    assert(isEcho("callback phone") === true, "3.3 'callback phone' assistant phrase IS suppressed");
    assert(isEcho("best callback phone number") === true, "3.3 'best callback phone number' IS suppressed");
  }

  // 3.4 Prompt-Tail Acoustic Echo Discrimination vs. Genuine Caller Selections
  {
    const speech = new BrowserSpeechRecognition();
    const isEcho = (text: string) => (speech as any).isAcousticEcho(text);
    speech.registerAssistantSpeech("Do you need heating or AC repair?");

    // Genuine caller choices are immediately accepted without artificial delay
    assert(isEcho("ac repair") === false, "3.4 'ac repair' is ACCEPTED as genuine caller choice");
    assert(isEcho("heating repair") === false, "3.4 'heating repair' is ACCEPTED as genuine caller choice");

    // Assistant prompt with dates and times
    speech.registerAssistantSpeech("We have openings tomorrow at 10 AM or Friday at 2 PM.");
    assert(isEcho("tomorrow at 10 AM") === false, "3.4 'tomorrow at 10 AM' is ACCEPTED as genuine caller choice");
    assert(isEcho("Friday at 2 PM") === false, "3.4 'Friday at 2 PM' is ACCEPTED as genuine caller choice");
  }

  // 3.5 Early Prompt-Tail Acoustic Bleed Discrimination (< 650ms) vs. Genuine Caller Response (>= 700ms)
  {
    const speech = new BrowserSpeechRecognition();
    const isEcho = (text: string) => (speech as any).isAcousticEcho(text);
    speech.registerAssistantSpeech("Do you need heating or cooling today, or AC repair?");

    // Scenario A: Early acoustic bleed arriving within 200ms of session start (< 650ms)
    (speech as any).sessionStartTime = Date.now() - 200;
    (speech as any).lastAgentSpeechEndTime = Date.now() - 250;
    assert(isEcho("ac repair") === true, "3.5 Early 'ac repair' bleed arriving within 200ms is SUPPRESSED as echo");
    assert(isEcho("heating repair") === true, "3.5 Early 'heating repair' bleed within 200ms is SUPPRESSED as echo");
    assert(isEcho("cooling") === true, "3.5 Early 'cooling' bleed within 200ms is SUPPRESSED as echo");
    assert(isEcho("heating") === true, "3.5 Early 'heating' bleed within 200ms is SUPPRESSED as echo");

    // Scenario B: Genuine caller speaking after human cognitive reaction time (850ms > 650ms)
    (speech as any).sessionStartTime = Date.now() - 850;
    (speech as any).lastAgentSpeechEndTime = Date.now() - 900;
    assert(isEcho("ac repair") === false, "3.5 Caller 'ac repair' after human reaction time is ACCEPTED");
    assert(isEcho("heating repair") === false, "3.5 Caller 'heating repair' after human reaction time is ACCEPTED");
    assert(isEcho("cooling") === false, "3.5 Caller 'cooling' after human reaction time is ACCEPTED");
  }
}

async function runAecHalfDuplexEpochCalibrationTests() {
  console.log("\n=== TEST SUITE 4: AEC Half-Duplex, Monotonic Epoch & AnalyserNode Decay Calibration ===");

  // 4.1 Physical Half-Duplex Stream Disconnection (enterAssistantTurn)
  {
    const speech = new BrowserSpeechRecognition();
    const mockTrack = new MockMediaStreamTrack();
    (speech as any).mediaStream = {
      getAudioTracks: () => [mockTrack],
    };
    await speech.start();
    const mockRec = (speech as any).recognition as MockSpeechRecognition;

    assert(mockRec.startCalls === 1, "4.1 Initial start calls start()");
    assert((speech as any).isListening === true, "4.1 isListening is true initially");
    assert(mockTrack.enabled === true, "4.1 Physical MediaStreamTrack is enabled initially");

    // Enter assistant turn with epoch 10
    const returnedEpoch = speech.enterAssistantTurn(10);

    assert(returnedEpoch === 10, "4.1 enterAssistantTurn returns new epoch (10)");
    assert(speech.getCurrentSpeechEpoch() === 10, "4.1 getCurrentSpeechEpoch is 10");
    assert((speech as any).recognition === null, "4.1 recognition instance is nullified on enterAssistantTurn");
    assert(mockRec.abortCalls >= 1, "4.1 abort() called on recognition instance");
    assert(mockRec.onresult === null, "4.1 onresult event listener nullified");
    assert(mockRec.onerror === null, "4.1 onerror event listener nullified");
    assert(mockRec.onend === null, "4.1 onend event listener nullified");
    assert((speech as any).restartTimer === null, "4.1 restartTimer is null");
    assert((speech as any).cooldownTimer === null, "4.1 cooldownTimer is null");
    assert((speech as any).debounceTimer === null, "4.1 debounceTimer is null");
    assert(mockTrack.enabled === false, "4.1 Physical MediaStreamTrack is hardware gated (enabled = false)");
    assert((speech as any).isListening === false, "4.1 isListening is false");
    assert((speech as any).isPausedForAgent === true, "4.1 isPausedForAgent is true");
  }

  // 4.2 Monotonic Speech Epoch Tracking & Ghost Audio Frame Invalidation
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
    assert(transcriptCount === 0, "4.2 Stale epoch frame (epoch 1 vs 2) is discarded");

    // Scenario B: Frame arriving within 350ms warm-up window
    (speech as any).activeListeningEpoch = 2;
    (speech as any).currentSpeechEpoch = 2;
    (speech as any).sessionStartTime = Date.now() - 100; // Only 100ms since start (< 350ms)

    activeMock.onresult({
      resultIndex: 0,
      results: [[{ transcript: "warmup click noise", isFinal: true }]],
    });
    assert(transcriptCount === 0, "4.2 Frame arriving within 350ms of session start is discarded as warm-up noise");

    // Scenario C: Legitimate frame arriving after 350ms with matching epoch
    speech.resumeAfterAcousticDecay(2);
    const legitimateMock = (speech as any).recognition as MockSpeechRecognition;
    (speech as any).sessionStartTime = Date.now() - 400; // 400ms since start (>= 350ms)
    legitimateMock.onresult({
      resultIndex: 0,
      results: [[{ transcript: "my furnace is making noise", isFinal: true }]],
    });
    assert(transcriptCount === 1, "4.2 Legitimate frame with matching epoch and >350ms elapsed is accepted");

    speech.stop();
  }

  // 4.3 Platform-Calibrated Dynamic Reverb Decay Configuration
  {
    const speech = new BrowserSpeechRecognition();

    // 4.3a: Android Mobile
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
      },
      configurable: true,
      writable: true,
    });
    const androidConfig = speech.getDynamicAcousticCooldownMs();
    assert(androidConfig.minFloorMs === 500, "4.3a Android minFloorMs is 500ms");
    assert(androidConfig.targetDb === -55, "4.3a Android targetDb is -55 dBFS");
    assert(androidConfig.maxTimeoutMs === 750, "4.3a Android maxTimeoutMs is 750ms");

    // 4.3b: Windows Desktop
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      configurable: true,
      writable: true,
    });
    const windowsConfig = speech.getDynamicAcousticCooldownMs();
    assert(windowsConfig.minFloorMs === 450, "4.3b Windows minFloorMs is 450ms");
    assert(windowsConfig.targetDb === -55, "4.3b Windows targetDb is -55 dBFS");
    assert(windowsConfig.maxTimeoutMs === 700, "4.3b Windows maxTimeoutMs is 700ms");

    // 4.3c: iOS / macOS (Apple WebKit)
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      configurable: true,
      writable: true,
    });
    const iosConfig = speech.getDynamicAcousticCooldownMs();
    assert(iosConfig.minFloorMs === 250, "4.3c iOS minFloorMs is 250ms");
    assert(iosConfig.targetDb === -50, "4.3c iOS targetDb is -50 dBFS");
    assert(iosConfig.maxTimeoutMs === 500, "4.3c iOS maxTimeoutMs is 500ms");
  }

  // 4.4 32-bit Float32Array AnalyserNode Decay Monitoring Down to < -60 dBFS
  {
    const player = new NeuralAudioPlayer();
    const mockAnalyser = new MockAnalyserNode();
    (player as any).analyserNode = mockAnalyser;
    (player as any).audioContext = { state: "running", currentTime: 0 };

    // 4.4a: Absolute digital silence (all zeros)
    mockAnalyser.mockData.fill(0);
    const silenceResult = player.getOutputDecibelLevel();
    assert(silenceResult.peakDb <= -100, "4.4a Absolute silence yields <= -100 peakDb");
    assert(silenceResult.isTrueSilence === true, "4.4a Absolute silence satisfies isTrueSilence (< -60 dBFS)");

    // 4.4b: True silence below -60 dBFS (amplitude 0.0005 -> ~ -66.02 dBFS)
    mockAnalyser.mockData.fill(0.0005);
    const sub60Result = player.getOutputDecibelLevel();
    assert(sub60Result.peakDb < -60, "4.4b Amplitude 0.0005 peakDb is below -60 dBFS");
    assert(sub60Result.isTrueSilence === true, "4.4b Amplitude 0.0005 is recognized as true silence (< 0.0010)");

    // 4.4c: Active audible signal (amplitude 0.05 -> ~ -26.02 dBFS)
    mockAnalyser.mockData.fill(0.05);
    const activeResult = player.getOutputDecibelLevel();
    assert(activeResult.peakDb > -60, "4.4c Amplitude 0.05 peakDb is well above -60 dBFS (~ -26 dBFS)");
    assert(activeResult.isTrueSilence === false, "4.4c Amplitude 0.05 is recognized as active audio (isTrueSilence = false)");

    // 4.4d: Exact boundary precision (0.0010 vs 0.00099)
    mockAnalyser.mockData.fill(0.0010);
    const boundary60Result = player.getOutputDecibelLevel();
    assert(boundary60Result.isTrueSilence === false, "4.4d Exact 0.0010 linear amplitude (-60.00 dBFS) is not silence");

    mockAnalyser.mockData.fill(0.00099);
    const boundarySub60Result = player.getOutputDecibelLevel();
    assert(boundarySub60Result.isTrueSilence === true, "4.4d Amplitude 0.00099 (< 0.0010 linear) is recognized as true silence");
  }

  // 4.5 Consecutive Silent Frames (~80ms / 4 frames) Turn Completion Gating
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

    let turnFinished: boolean = false;
    player.setTurnStateCallback((active) => {
      if (!active) turnFinished = true;
    });

    // Frame 1: silent
    mockAnalyser.mockData.fill(0.0005); // below -60 dBFS
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 1, "4.5 Frame 1 silent increments counter to 1");
    assert(turnFinished === false, "4.5 Turn not finished after 1 silent frame");

    // Frame 2: silent
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 2, "4.5 Frame 2 silent increments counter to 2");
    assert(turnFinished === false, "4.5 Turn not finished after 2 silent frames");

    // Frame 3: non-silent noise burst (0.02 amplitude)
    mockAnalyser.mockData.fill(0.02);
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 0, "4.5 Non-silent burst resets counter back to 0");
    assert(turnFinished === false, "4.5 Turn not finished after noise burst");

    // Frames 4-7: 4 consecutive silent frames
    mockAnalyser.mockData.fill(0.0002);
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 1, "4.5 Frame 4 silent: counter 1");
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 2, "4.5 Frame 5 silent: counter 2");
    (player as any).checkTurnCompletion();
    assert((player as any).consecutiveSilentFrames === 3, "4.5 Frame 6 silent: counter 3");
    assert(turnFinished === false, "4.5 Turn not finished after 3 silent frames");

    (player as any).checkTurnCompletion();
    assert(Boolean(turnFinished) === true, "4.5 4 consecutive silent frames triggers turn completion");
    assert((player as any).isTurnActive === false, "4.5 isTurnActive is set to false");
  }

  // 4.6 Inter-Sentence Parallel Pre-Fetching in Queue Processing
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

    // Verify all 3 sentences had fetch initiated immediately without blocking on prior sentence playback
    assert(fetchedSentences.length === 3, "4.6 All 3 sentences triggered network prefetch in parallel without starvation");
    assert(fetchedSentences[0] === "First sentence of response.", "4.6 Sentence 1 prefetch initiated");
    assert(fetchedSentences[1] === "Second sentence prefetching in background.", "4.6 Sentence 2 prefetch initiated");
    assert(fetchedSentences[2] === "Third sentence also prebuffering.", "4.6 Sentence 3 prefetch initiated");

    player.stop();
  }
}

async function main() {
  console.log("================================================================================");
  console.log("STARTING EMPIRICAL ADVERSARIAL VERIFICATION HARNESS");
  console.log("================================================================================");

  try {
    await runBackoffWindowStressTests();
    await runEchoSuppressionWhitelistTests();
    await runGatingAndLatencyStressTests();
    await runAecHalfDuplexEpochCalibrationTests();
  } catch (err) {
    console.error("Fatal test execution error:", err);
    process.exit(1);
  }

  console.log("\n================================================================================");
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("================================================================================");

  if (failedTests > 0) {
    process.exit(1);
  }
}

main();
