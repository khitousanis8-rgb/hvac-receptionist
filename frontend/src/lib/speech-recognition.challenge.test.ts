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

import { BrowserSpeechRecognition } from "./speech-recognition.ts";

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

  // Echo of closing phrases
  speech.registerAssistantSpeech("You are all set. Our technician will see you then. Is there anything else I can help with?");
  assert(isEcho("you are all set") === true, "2.2 'you are all set' IS suppressed");
  assert(isEcho("our technician will see you then") === true, "2.2 'our technician will see you then' IS suppressed");
  assert(isEcho("is there anything else i can help with") === true, "2.2 'is there anything else i can help with' IS suppressed");

  // 2.3 Genuine Caller Inquiries (Must NOT be suppressed)
  console.log("\n  --- 2.3 Genuine Caller Inquiries ---");
  assert(isEcho("hello i need help with my ac") === false, "2.3 'hello i need help with my ac' is NOT suppressed");
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
}

async function main() {
  console.log("================================================================================");
  console.log("STARTING EMPIRICAL ADVERSARIAL VERIFICATION HARNESS");
  console.log("================================================================================");

  try {
    await runBackoffWindowStressTests();
    await runEchoSuppressionWhitelistTests();
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
