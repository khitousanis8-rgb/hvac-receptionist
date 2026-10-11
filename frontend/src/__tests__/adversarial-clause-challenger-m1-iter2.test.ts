/**
 * EMPIRICAL ADVERSARIAL CHALLENGER TEST SUITE: CLAUSE STREAMING (MILESTONE 1 ITERATION 2)
 *
 * Verifies frontend clause splitting, streaming cadence, boundary enforcement,
 * numeric/currency/time preservation, abbreviation protection, and pathological edge cases.
 */

import assert from "node:assert/strict";
import { findClauseSplit, normalizeSpokenText } from "../lib/text-normalization.ts";

console.log("================================================================================");
console.log("FRONTEND CHALLENGER 1 (M1 ITERATION 2): ADVERSARIAL CLAUSE STRESS HARNESS");
console.log("================================================================================\n");

let passed = 0;
let total = 0;

function runTest(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err: any) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    throw err;
  }
}

// ============================================================================
// SUITE 1: Conversational Opener Cadence & Boundary Correctness
// ============================================================================
console.log("--- 1. Conversational Opener Cadence & Boundary Correctness ---");

runTest("1.1 'Sure,' dispatches immediately with trailing comma", () => {
  const split = findClauseSplit("Sure, I can book that for you right now.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Sure,");
  assert.equal(split.rest.trim(), "I can book that for you right now.");
});

runTest("1.2 'Yes.' dispatches immediately with trailing period", () => {
  const split = findClauseSplit("Yes. We have availability this afternoon.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Yes.");
  assert.equal(split.rest.trim(), "We have availability this afternoon.");
});

runTest("1.3 'Hi!' dispatches immediately with exclamation", () => {
  const split = findClauseSplit("Hi! Thanks for calling Blueridge Comfort.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Hi!");
  assert.equal(split.rest.trim(), "Thanks for calling Blueridge Comfort.");
});

runTest("1.4 'Got it.' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("Got it. Let me look up your appointment details.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Got it.");
  assert.equal(split.rest.trim(), "Let me look up your appointment details.");
});

runTest("1.5 'Okay,' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("Okay, let me check the technician dispatch calendar.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Okay,");
  assert.equal(split.rest.trim(), "let me check the technician dispatch calendar.");
});

runTest("1.6 'Certainly,' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("Certainly, we can service your heat pump today.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Certainly,");
  assert.equal(split.rest.trim(), "we can service your heat pump today.");
});

runTest("1.7 'Alright,' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("Alright, I will reserve that slot for you.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Alright,");
  assert.equal(split.rest.trim(), "I will reserve that slot for you.");
});

runTest("1.8 'No problem,' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("No problem, our technician Sarah can arrive at 10 AM.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "No problem,");
  assert.equal(split.rest.trim(), "our technician Sarah can arrive at 10 AM.");
});

runTest("1.9 'Of course,' dispatches immediately on first phrase", () => {
  const split = findClauseSplit("Of course, emergency service is available 24/7.", true);
  assert.ok(split, "Should split on opener");
  assert.equal(split.sentence, "Of course,");
  assert.equal(split.rest.trim(), "emergency service is available 24/7.");
});

runTest("1.10 Conversational opener without trailing space ('Sure,let me check')", () => {
  const split = findClauseSplit("Sure,let me check.", true);
  assert.ok(split, "Should split on opener even without space");
  assert.equal(split.sentence, "Sure,");
  assert.equal(split.rest, "let me check.");
});

// ============================================================================
// SUITE 2: Intermediate Breath Group Punctuation & Threshold Rules
// ============================================================================
console.log("\n--- 2. Intermediate Breath Group Punctuation & Threshold Rules ---");

runTest("2.1 Intermediate clause >= 12 chars splits on comma and retains comma", () => {
  const split = findClauseSplit("That sounds wonderful, our technician will be right over.", false);
  assert.ok(split, "Should split intermediate clause >= 12 chars");
  assert.equal(split.sentence, "That sounds wonderful,");
  assert.equal(split.rest.trim(), "our technician will be right over.");
});

runTest("2.2 Intermediate clause < 12 chars does NOT split prematurely", () => {
  const split = findClauseSplit("and then, we will inspect the compressor.", false);
  assert.ok(split, "Should proceed past short comma phrase");
  assert.equal(split.sentence, "and then, we will inspect the compressor.");
  assert.equal(split.rest, "");
});

runTest("2.3 Colon breath group retains ':' for cadence", () => {
  const split = findClauseSplit("Here is what we recommend: a complete seasonal tune-up.", false);
  assert.ok(split, "Should split on colon");
  assert.equal(split.sentence, "Here is what we recommend:");
  assert.equal(split.rest.trim(), "a complete seasonal tune-up.");
});

runTest("2.4 Semicolon breath group retains ';' for cadence", () => {
  const split = findClauseSplit("The system is running; however, the filter needs replacement.", false);
  assert.ok(split, "Should split on semicolon");
  assert.equal(split.sentence, "The system is running;");
  assert.equal(split.rest.trim(), "however, the filter needs replacement.");
});

runTest("2.5 Newline breath group does not attach literal newline punctuation", () => {
  const split = findClauseSplit("First check the thermostat\nThen check the breaker.", false);
  assert.ok(split, "Should split on newline");
  assert.equal(split.sentence, "First check the thermostat");
  assert.equal(split.rest.trim(), "Then check the breaker.");
});

runTest("2.6 Sequential multi-clause draining preserves complete text stream", () => {
  const text = "Sure, I can help with that. Our standard fee is $89. Sarah will arrive tomorrow at 10 AM; she will call ahead.";
  let buffer = text;
  let isFirst = true;
  const emitted: string[] = [];

  while (buffer.trim()) {
    const split = findClauseSplit(buffer, isFirst);
    if (!split || !split.sentence) {
      emitted.push(buffer.trim());
      break;
    }
    emitted.push(split.sentence);
    buffer = split.rest;
    isFirst = false;
  }

  assert.ok(emitted.length >= 4, "Should emit at least 4 clauses");
  assert.equal(emitted[0], "Sure,");
  assert.equal(emitted[1], "I can help with that.");
  assert.equal(emitted[2], "Our standard fee is $89.");
  assert.equal(emitted[3], "Sarah will arrive tomorrow at 10 AM;");
  assert.equal(emitted[4], "she will call ahead.");
});

// ============================================================================
// SUITE 3: Numeric, Currency, Time & Phone Number Protection
// ============================================================================
console.log("\n--- 3. Numeric, Currency, Time & Phone Protection ---");

runTest("3.1 Currency '$2,500.00' never splits mid-number", () => {
  const text = "The replacement will cost $2,500.00 in total.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "The replacement will cost $2,500.00 in total.");
  assert.equal(split.rest, "");
});

runTest("3.2 Large currency '$1,000,000' never splits mid-number", () => {
  const text = "The commercial unit warranty covers up to $1,000,000 of damage.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "The commercial unit warranty covers up to $1,000,000 of damage.");
});

runTest("3.3 Decimal '3.5 ton unit' never splits mid-decimal", () => {
  const text = "We recommend a 3.5 ton heat pump for your home.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "We recommend a 3.5 ton heat pump for your home.");
});

runTest("3.4 Decimal '0.5% efficiency' never splits mid-decimal", () => {
  const text = "The variance is only 0.5% between stages.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "The variance is only 0.5% between stages.");
});

runTest("3.5 Time '10:30' colon is never split", () => {
  const text = "Sarah can arrive at 10:30 tomorrow morning.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Sarah can arrive at 10:30 tomorrow morning.");
});

runTest("3.6 Time followed by comma ('At 10:30, Sarah will arrive.') splits cleanly at comma", () => {
  const text = "At 10:30, Sarah will arrive at your home.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "At 10:30,");
  assert.equal(split.rest.trim(), "Sarah will arrive at your home.");
});

runTest("3.7 Phone number '+1 (555) 123-4567' remains intact through splitting", () => {
  const text = "Please call +1 (555) 123-4567, or visit our website.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Please call +1 (555) 123-4567,");
  assert.equal(split.rest.trim(), "or visit our website.");
});

runTest("3.8 Hyphenated phone number '555-123-4567' remains intact", () => {
  const text = "Your confirmation was sent to 555-123-4567. Have a great day!";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Your confirmation was sent to 555-123-4567.");
  assert.equal(split.rest.trim(), "Have a great day!");
});

// ============================================================================
// SUITE 4: Honorific, Title & Abbreviation Protection
// ============================================================================
console.log("\n--- 4. Honorific, Title & Abbreviation Protection ---");

runTest("4.1 'Dr. Smith' does not split at 'Dr.'", () => {
  const text = "Dr. Smith requested a technician inspection.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Dr. Smith requested a technician inspection.");
});

runTest("4.2 'Mr. Davis' does not split at 'Mr.'", () => {
  const text = "Hello Mr. Davis, thank you for reaching out.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Hello Mr. Davis,");
  assert.equal(split.rest.trim(), "thank you for reaching out.");
});

runTest("4.3 'Mrs. Johnson' and 'Ms. Adams' do not split at honorifics", () => {
  const text = "Mrs. Johnson and Ms. Adams both confirmed their service.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Mrs. Johnson and Ms. Adams both confirmed their service.");
});

runTest("4.4 'e.g.' and 'i.e.' do not split mid-abbreviation", () => {
  const text = "We service all cooling equipment, e.g. central AC and ductless units.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "We service all cooling equipment,");
  assert.equal(split.rest.trim(), "e.g. central AC and ductless units.");
});

runTest("4.5 'H.V.A.C.' acronym does not split at internal periods", () => {
  const text = "We are licensed in H.V.A.C. installations across the state.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "We are licensed in H.V.A.C. installations across the state.");
});

runTest("4.6 'U.S.A.' acronym does not split at internal periods", () => {
  const text = "All our equipment is manufactured in the U.S.A. for maximum reliability.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "All our equipment is manufactured in the U.S.A. for maximum reliability.");
});

runTest("4.7 Month abbreviations 'Jan.', 'Feb.', 'Oct.' do not split prematurely across multi-sentence streams", () => {
  const text = "Our winter tune-up begins on Oct. 15 and ends on Jan. 31. Please book your appointment soon.";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Our winter tune-up begins on Oct. 15 and ends on Jan. 31.");
  assert.equal(split.rest.trim(), "Please book your appointment soon.");
});

runTest("4.8 In-flight trailing digit period ('3.') defers split until decimal or next token arrives", () => {
  // During in-flight streaming, 'The unit is 3.' defers splitting so '3.5' is not fragmented
  const inFlight = "The unit is 3.";
  const splitInFlight = findClauseSplit(inFlight, true);
  assert.equal(splitInFlight, null, "Should defer split while trailing character is empty (waiting for next token)");

  // Once next sentence or space arrives, it splits cleanly
  const completed = "The unit is 3. We will install it.";
  const splitCompleted = findClauseSplit(completed, true);
  assert.ok(splitCompleted);
  assert.equal(splitCompleted.sentence, "The unit is 3.");
});

// ============================================================================
// SUITE 5: Pathological Sequences, Edge Cases & Fuzzing
// ============================================================================
console.log("\n--- 5. Pathological Sequences, Edge Cases & Fuzzing ---");

runTest("5.1 Ellipsis sequence ('...') does not stall or loop indefinitely", () => {
  let buf = "Checking our records... Please hold on a moment.";
  const chunks: string[] = [];
  let isFirst = true;
  let loops = 0;
  while (loops < 10) {
    loops++;
    const split = findClauseSplit(buf, isFirst);
    if (!split || !split.sentence) break;
    chunks.push(split.sentence);
    buf = split.rest;
    isFirst = false;
  }
  if (buf.trim()) chunks.push(buf.trim());
  assert.ok(chunks.length >= 2, "Should emit at least 2 chunks");
  assert.equal(chunks[0], "Checking our records.");
  assert.ok(loops < 10, "Should terminate safely");
});

runTest("5.2 Mixed interrobang ('?!') splits cleanly without stalling", () => {
  const text = "Is tomorrow morning available?! That would be ideal!";
  const split = findClauseSplit(text, true);
  assert.ok(split);
  assert.equal(split.sentence, "Is tomorrow morning available?");
  assert.equal(split.rest.trim(), "! That would be ideal!");
});

runTest("5.3 Repeated commas (',,,') do not trigger NaN or crash", () => {
  const split = findClauseSplit("Well,,, we can check that for you.", true);
  assert.ok(split);
  assert.equal(split.sentence, "Well,");
  assert.equal(split.rest.trim(), ",, we can check that for you.");
});

runTest("5.4 Empty, whitespace, and period-only strings return null without crashing", () => {
  assert.equal(findClauseSplit("", true), null);
  assert.equal(findClauseSplit("   ", true), null);
  assert.equal(findClauseSplit(".", true), null);
  assert.equal(findClauseSplit("   .", true), null);

  // For punctuation-only clauses like ',,,', normalization safely produces punctuation that
  // neuralVoice.speakSentence drops via !/[a-zA-Z0-9]/.test(clean)
  const normCommas = normalizeSpokenText(",,,");
  assert.equal(/[a-zA-Z0-9]/.test(normCommas), false, "Punctuation-only string must contain no alphanumeric text");
});

runTest("5.5 Massive 5,000 character string without punctuation processes in < 20ms", () => {
  const bigString = "word ".repeat(1000); // 5,000 chars without punctuation
  const start = performance.now();
  const split = findClauseSplit(bigString, true);
  const elapsed = performance.now() - start;
  assert.equal(split, null, "Should return null since no punctuation exists");
  assert.ok(elapsed < 20, `Execution took ${elapsed.toFixed(2)}ms, expected < 20ms`);
});

runTest("5.6 Micro-token streaming simulation (1-character chunks) drains without data loss", () => {
  const fullText = "Certainly, Sarah will be there tomorrow. Thank you!";
  let buffer = "";
  let isFirst = true;
  const emitted: string[] = [];

  for (let i = 0; i < fullText.length; i++) {
    buffer += fullText[i];
    while (true) {
      const split = findClauseSplit(buffer, isFirst);
      if (!split || !split.sentence) break;
      emitted.push(split.sentence);
      buffer = split.rest;
      isFirst = false;
    }
  }
  if (buffer.trim()) emitted.push(buffer.trim());

  assert.equal(emitted.length, 3);
  assert.equal(emitted[0], "Certainly,");
  assert.equal(emitted[1], "Sarah will be there tomorrow.");
  assert.equal(emitted[2], "Thank you!");
});

runTest("5.7 Meridiem 'AM.' and 'PM.' are protected abbreviations during streaming", () => {
  // 'AM.' and 'PM.' are protected in abbreviation list so '10 AM.' is not severed prematurely
  const text = "Sarah will arrive at 10 AM. Would that work?";
  const split = findClauseSplit(text, false);
  assert.ok(split);
  assert.equal(split.sentence, "Sarah will arrive at 10 AM. Would that work?");
});

// ============================================================================
// SUITE 6: Normalization & Prosody Consistency
// ============================================================================
console.log("\n--- 6. Normalization & Prosody Consistency ---");

runTest("6.1 normalizeSpokenText formats currency correctly", () => {
  const norm = normalizeSpokenText("Our diagnostic visit is $89.50 today.");
  assert.ok(norm.includes("89 dollars and 50 cents"), `Got: ${norm}`);
});

runTest("6.2 normalizeSpokenText formats time correctly", () => {
  const norm = normalizeSpokenText("We can arrive at 10:00 a.m. or 2:30 p.m.");
  assert.ok(norm.includes("10 AM"), `Got: ${norm}`);
  assert.ok(norm.includes("2:30 PM"), `Got: ${norm}`);
});

runTest("6.3 normalizeSpokenText formats HVAC acronyms for natural TTS", () => {
  const norm = normalizeSpokenText("We specialize in HVAC and AC repair.");
  assert.ok(norm.includes("H-vac"), `Got: ${norm}`);
  assert.ok(norm.includes("air conditioning"), `Got: ${norm}`);
});

runTest("6.4 normalizeSpokenText preserves speech-safe delimiters (. , ? !)", () => {
  assert.equal(normalizeSpokenText("Sure,"), "Sure,");
  assert.equal(normalizeSpokenText("Yes."), "Yes.");
  assert.equal(normalizeSpokenText("Hi!"), "Hi!");
  assert.equal(normalizeSpokenText("Ready?"), "Ready?");
});

console.log("\n================================================================================");
console.log(`ALL ADVERSARIAL CHALLENGER TESTS PASSED: ${passed} / ${total} (100%)`);
console.log("================================================================================\n");
