/**
 * EMPIRICAL CHALLENGER TEST SUITE: FRONTEND AUDIO & STREAM ISOLATION
 * Exhaustively stress-tests:
 * 1. Spoken digit words & number combinations (Shield 0a)
 * 2. Caller objections and phone inquiry variations (Shield 0b)
 * 3. Genuine caller confirmations and booking affirmations (Shield 0c)
 * 4. 2-word subsets of assistant prompts (Shield 0d vs Prompt Tail Discrimination)
 * 5. Platform-calibrated decay matrix (Windows 450ms, iOS 250ms, Android 500ms)
 * 6. Dynamic acoustic decay timing simulation & hardware track gating
 */

import assert from "node:assert/strict";

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

let totalTests = 0;
let passedTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
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
console.log("CHALLENGER 2: EMPIRICAL FRONTEND AUDIO STRESS SUITE");
console.log("================================================================================\n");

// ============================================================================
// SUITE 1: Spoken Digit Words & Phone Number Input Stress
// ============================================================================
console.log("--- 1. Spoken Digit Words & Phone Number Input Stress ---");

await runTest("1.1 Spoken digits 'five five five one two three four' (7 digits) is preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("five five five one two three four"), false);
});

await runTest("1.2 Spoken digits 'eight hundred five five five zero one nine nine' (8 digits) is preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("eight hundred five five five zero one nine nine"), false);
  assert.equal(isEcho("Eight hundred, five five five, zero one nine nine."), false);
});

await runTest("1.3 Conversational prefixes with spoken digits are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("my phone number is five five five zero one nine nine"), false);
  assert.equal(isEcho("you can reach me at eight zero zero five five five zero one two three"), false);
  assert.equal(isEcho("best number is five five five eight eight eight eight"), false);
  assert.equal(isEcho("reach me on five five five one two one two"), false);
});

await runTest("1.4 Spoken 'oh' as zero in phone numbers is counted as digit", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  // 7 digits including 'oh'
  assert.equal(isEcho("five five five oh one two three"), false);
  // 10 digits with 'oh'
  assert.equal(isEcho("eight oh oh five five five oh one two three"), false);
});

await runTest("1.5 Mixed numeric digits and punctuation are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("555-123-4567"), false);
  assert.equal(isEcho("(555) 019-9999"), false);
  assert.equal(isEcho("5550199"), false);
  assert.equal(isEcho("call 555-234-5678"), false);
});

// ============================================================================
// SUITE 2: Caller Objections & Inquiries Stress (Shield 0b)
// ============================================================================
console.log("\n--- 2. Caller Objections & Inquiries Stress ---");

await runTest("2.1 Exact objection matches without punctuation are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  const objections = [
    "i don't have a phone number",
    "i dont have a phone number",
    "i don't have a number",
    "dont have a phone number",
    "don't have a phone number",
    "no phone number",
    "no number",
    "no phone",
    "don't have a number",
    "dont have a number",
    "i have no number",
    "do not have a number",
    "why do you need my number",
    "why do you need that",
    "why do you ask",
    "why are you asking",
    "i don't have a phone",
    "i dont have a phone",
    "dont have a phone",
    "don't have a phone",
  ];

  for (const obj of objections) {
    assert.equal(isEcho(obj), false, `Objection '${obj}' must NOT be echo`);
  }
});

await runTest("2.2 Objection variants with natural caller speech punctuation and filler words are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("I don't have a phone number!"), false);
  assert.equal(isEcho("Actually, I don't have a phone number right now."), false);
  assert.equal(isEcho("Sorry, no phone number available."), false);
  assert.equal(isEcho("Why do you need my number anyway?"), false);
  assert.equal(isEcho("No number, sorry."), false);
  assert.equal(isEcho("I don't have a phone to give you."), false);
  assert.equal(isEcho("Why are you asking for that?"), false);
});

// ============================================================================
// SUITE 3: Genuine Confirmations & Voice Affirmations (Shield 0c)
// ============================================================================
console.log("\n--- 3. Genuine Confirmations & Voice Affirmations Stress ---");

await runTest("3.1 Voice booking affirmations ('lock it in', 'sounds great') are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("I have you down for AC repair tomorrow at 10 AM. Would you like me to book it?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  const affirmations = [
    "lock it in",
    "lock that in",
    "lock it in please",
    "sounds great",
    "that sounds great",
    "that works for me",
    "sounds good",
    "that sounds good",
    "yes thank you",
    "yes thanks",
    "that works",
    "go ahead",
    "yes please",
    "yes go ahead",
    "yes please go ahead",
    "sure go ahead",
    "yes book it",
    "yes book that",
    "go ahead please",
    "please book it",
    "please book that",
    "correct",
    "perfect",
    "absolutely",
    "definitely",
    "please do",
    "confirm",
    "confirmed",
  ];

  for (const aff of affirmations) {
    assert.equal(isEcho(aff), false, `Affirmation '${aff}' must NOT be echo`);
  }
});

// ============================================================================
// SUITE 4: 2-Word Subsets of Assistant Prompts & Service Selections
// ============================================================================
console.log("\n--- 4. 2-Word Subsets of Assistant Prompts & Service Selections ---");

await runTest("4.1 Legitimate 2-word service choices are preserved even if spoken in assistant prompt", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("We handle AC repair, heating maintenance, or furnace tune up.");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("ac repair"), false, "'ac repair' must not be echo");
  assert.equal(isEcho("heating maintenance"), false, "'heating maintenance' must not be echo");
  assert.equal(isEcho("tune up"), false, "'tune up' must not be echo");
  assert.equal(isEcho("furnace maintenance"), false, "'furnace maintenance' must not be echo");
  assert.equal(isEcho("heat pump"), false, "'heat pump' must not be echo");
  assert.equal(isEcho("pipe leak"), false, "'pipe leak' must not be echo");
  assert.equal(isEcho("water leak"), false, "'water leak' must not be echo");
  assert.equal(isEcho("air conditioning"), false, "'air conditioning' must not be echo");
});

await runTest("4.2 Legitimate 2-word date/time selections are preserved", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("We have openings tomorrow morning or Friday afternoon.");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("tomorrow morning"), false, "'tomorrow morning' must not be echo");
  assert.equal(isEcho("tomorrow afternoon"), false, "'tomorrow afternoon' must not be echo");
  assert.equal(isEcho("friday afternoon"), false, "'friday afternoon' must not be echo");
  assert.equal(isEcho("tomorrow at 10"), false, "'tomorrow at 10' must not be echo");
  assert.equal(isEcho("monday morning"), false, "'monday morning' must not be echo");
});

await runTest("4.3 Assistant 2-word structural phrases that are NOT services or dates ARE suppressed", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("callback phone"), true, "'callback phone' is echo");
  assert.equal(isEcho("technician reach"), true, "'technician reach' is echo");
  assert.equal(isEcho("best callback"), true, "'best callback' is echo");
  assert.equal(isEcho("reach you"), true, "'reach you' suffix is echo");
});

await runTest("4.4 Full assistant signature echoes ARE strictly suppressed", () => {
  const speech = new BrowserSpeechRecognition();
  speech.registerAssistantSpeech("Thank you for calling Apex Air. My name is Sarah. What is the best callback phone number for our technician to reach you?");
  const isEcho = (text: string) => (speech as any).isAcousticEcho(text);

  assert.equal(isEcho("thank you for calling"), true);
  assert.equal(isEcho("thanks for calling"), true);
  assert.equal(isEcho("my name is sarah"), true);
  assert.equal(isEcho("this is sarah"), true);
  assert.equal(isEcho("what is the best callback phone number"), true);
  assert.equal(isEcho("tap confirm booking"), true);
  assert.equal(isEcho("confirm booking on your screen"), true);
  assert.equal(isEcho("our technician will see you then"), true);
});

// ============================================================================
// SUITE 5: Platform Decay Matrix Verification
// ============================================================================
console.log("\n--- 5. Platform Decay Matrix Verification ---");

await runTest("5.1 Windows Desktop Profile (Chrome/Edge/Firefox)", () => {
  const windowsUAs = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  ];

  for (const ua of windowsUAs) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
    const speech = new BrowserSpeechRecognition();
    const config = speech.getDynamicAcousticCooldownMs();

    assert.equal(config.minFloorMs, 450, "Windows minFloorMs must be 450ms");
    assert.equal(config.targetDb, -55, "Windows targetDb must be -55 dBFS");
    assert.equal(config.maxTimeoutMs, 700, "Windows maxTimeoutMs must be 700ms");
    assert.equal(speech.getAcousticCooldownMs(), 450, "Windows getAcousticCooldownMs must be 450ms");
  }
});

await runTest("5.2 iOS Mobile Profile (iPhone/iPad Safari & WebKit)", () => {
  const iosUAs = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.92 Mobile/15E148 Safari/604.1",
  ];

  for (const ua of iosUAs) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
    const speech = new BrowserSpeechRecognition();
    const config = speech.getDynamicAcousticCooldownMs();

    assert.equal(config.minFloorMs, 250, "iOS minFloorMs must be 250ms");
    assert.equal(config.targetDb, -50, "iOS targetDb must be -50 dBFS");
    assert.equal(config.maxTimeoutMs, 500, "iOS maxTimeoutMs must be 500ms");
    assert.equal(speech.getAcousticCooldownMs(), 250, "iOS getAcousticCooldownMs must be 250ms");
  }
});

await runTest("5.3 Android Mobile Profile (Samsung/Pixel Chrome & Samsung Internet)", () => {
  const androidUAs = [
    "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  ];

  for (const ua of androidUAs) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
    const speech = new BrowserSpeechRecognition();
    const config = speech.getDynamicAcousticCooldownMs();

    assert.equal(config.minFloorMs, 500, "Android minFloorMs must be 500ms");
    assert.equal(config.targetDb, -55, "Android targetDb must be -55 dBFS");
    assert.equal(config.maxTimeoutMs, 750, "Android maxTimeoutMs must be 750ms");
    assert.equal(speech.getAcousticCooldownMs(), 500, "Android getAcousticCooldownMs must be 500ms");
  }
});

// ============================================================================
// SUITE 6: Hardware Track Gating & Dynamic Cooldown Timing Simulation
// ============================================================================
console.log("\n--- 6. Hardware Track Gating & Dynamic Cooldown Timing Simulation ---");

await runTest("6.1 Assistant playback immediately mutes physical track and aborts recognition", async () => {
  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  await speech.start();
  assert.equal(mockTrack.enabled, true, "Track enabled initially");

  // Agent starts speaking
  speech.pauseForAgentPlayback(true);
  assert.equal(mockTrack.enabled, false, "Track physically muted on playback start");
  assert.equal((speech as any).isPausedForAgent, true, "isPausedForAgent is true");
  assert.equal((speech as any).recognition, null, "recognition instance nullified");

  speech.stop();
});

await runTest("6.2 Dynamic Cooldown respects minFloorMs before re-enabling track (Windows 450ms)", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0" },
    configurable: true,
    writable: true,
  });

  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  let mockAudioOutputActive = false;
  speech.setAudioOutputActiveCheck(() => mockAudioOutputActive);

  await speech.start();

  // Assistant begins turn
  speech.pauseForAgentPlayback(true);
  assert.equal(mockTrack.enabled, false, "Track muted during turn");

  // Assistant finishes speaking
  speech.pauseForAgentPlayback(false);

  // At 200ms (below Windows minFloor 450ms), track must STILL be muted
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(mockTrack.enabled, false, "Track still muted at 200ms (< 450ms floor)");

  // At 550ms (past Windows minFloor 450ms and silent), track must be re-enabled
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(mockTrack.enabled, true, "Track re-enabled after 450ms floor and silence");
  assert.equal((speech as any).isPausedForAgent, false, "isPausedForAgent restored to false");

  speech.stop();
});

await runTest("6.3 Loudspeaker reverberation delay: track stays muted while output is active until targetDb silence", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0" },
    configurable: true,
    writable: true,
  });

  const speech = new BrowserSpeechRecognition();
  const mockTrack = new MockMediaStreamTrack();
  (speech as any).mediaStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack],
  };

  let mockAudioOutputActive = true; // Simulating room reverb ringing above -55 dBFS
  speech.setAudioOutputActiveCheck(() => mockAudioOutputActive);

  await speech.start();
  speech.pauseForAgentPlayback(true);
  speech.pauseForAgentPlayback(false);

  // Wait 480ms (past 450ms min floor, but output still ringing)
  await new Promise((resolve) => setTimeout(resolve, 480));
  assert.equal(mockTrack.enabled, false, "Track stays muted because audio output is still active");

  // Room reverb finally drops below -55 dBFS
  mockAudioOutputActive = false;

  // Next check cycle (30-60ms) should re-enable
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(mockTrack.enabled, true, "Track re-enabled once room reverb decayed below -55 dBFS");

  speech.stop();
});

console.log("\n================================================================================");
console.log(`ALL EMPIRICAL FRONTEND AUDIO STRESS TESTS PASSED: ${passedTests} / ${totalTests} (100%)`);
console.log("================================================================================\n");
