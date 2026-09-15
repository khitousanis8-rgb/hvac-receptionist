/**
 * Test Suite for Spoken-Text Normalizer.
 *
 * Covers 20 realistic HVAC caller and receptionist sentences containing:
 * - Contractions and apostrophes ("I'm", "can't", "furnace's")
 * - Phone numbers in diverse formats
 * - HVAC abbreviations and shorthand ("A/C", "HVAC", "BTU", "CO", "tech")
 * - Times and dates ("10:00 AM", "2:30 p.m.", "October 1st")
 * - Measurements and temperatures ("72°F", "3 ton", "$120")
 * - Symbols, markdown, URLs, and punctuation
 */

import { normalizeSpokenText, findClauseSplit } from "./text-normalization.ts";

export interface TestCase {
  id: number;
  input: string;
  assertions: (normalized: string) => void;
  description: string;
}

export const HVAC_TEST_CASES: TestCase[] = [
  {
    id: 1,
    description: "Contractions expansion: I'm, don't, can't",
    input: "I'm calling because my heater won't turn on and I don't know what to do.",
    assertions: (res) => {
      if (!res.includes("I am")) throw new Error(`Expected 'I am' in: ${res}`);
      if (!res.includes("will not")) throw new Error(`Expected 'will not' in: ${res}`);
      if (!res.includes("do not")) throw new Error(`Expected 'do not' in: ${res}`);
    },
  },
  {
    id: 2,
    description: "A/C shorthand expansion",
    input: "Our central A/C stopped blowing cold air this afternoon.",
    assertions: (res) => {
      if (!res.includes("air conditioning")) throw new Error(`Expected 'air conditioning' in: ${res}`);
      if (res.includes("A/C")) throw new Error(`Did not expect 'A/C' in: ${res}`);
    },
  },
  {
    id: 3,
    description: "HVAC abbreviation expansion to H-V-A-C",
    input: "Apex HVAC offers 24/7 heating and emergency support.",
    assertions: (res) => {
      if (!res.includes("H-V-A-C")) throw new Error(`Expected 'H-V-A-C' in: ${res}`);
    },
  },
  {
    id: 4,
    description: "10-digit phone number spaced digits formatting",
    input: "My callback number is 555-123-4567, please call when you arrive.",
    assertions: (res) => {
      if (!res.includes("5 5 5, 1 2 3, 4 5 6 7")) throw new Error(`Expected spaced digits in: ${res}`);
    },
  },
  {
    id: 5,
    description: "Parenthesized phone number with +1 country code",
    input: "Reach me at +1 (212) 555-0199 if anything changes.",
    assertions: (res) => {
      if (!res.includes("1, 2 1 2, 5 5 5, 0 1 9 9")) throw new Error(`Expected formatted phone in: ${res}`);
    },
  },
  {
    id: 6,
    description: "Time normalization for top of hour (10:00 AM -> 10 AM)",
    input: "Can the technician come tomorrow at 10:00 AM?",
    assertions: (res) => {
      if (!res.includes("10 AM")) throw new Error(`Expected '10 AM' in: ${res}`);
      if (res.includes("10:00 AM")) throw new Error(`Did not expect '10:00 AM' in: ${res}`);
    },
  },
  {
    id: 7,
    description: "Time normalization for half hour with lowercase (2:30 p.m. -> 2:30 PM)",
    input: "We have an open slot at 2:30 p.m. this Thursday.",
    assertions: (res) => {
      if (!res.includes("2:30 PM")) throw new Error(`Expected '2:30 PM' in: ${res}`);
    },
  },
  {
    id: 8,
    description: "Temperature in Fahrenheit (72°F -> 72 degrees Fahrenheit)",
    input: "The thermostat is set to 72°F, but the house is freezing.",
    assertions: (res) => {
      if (!res.includes("72 degrees Fahrenheit")) throw new Error(`Expected '72 degrees Fahrenheit' in: ${res}`);
      if (res.includes("°F")) throw new Error(`Did not expect '°F' in: ${res}`);
    },
  },
  {
    id: 9,
    description: "Temperature degrees symbol (85° -> 85 degrees)",
    input: "It is currently 85° inside my living room.",
    assertions: (res) => {
      if (!res.includes("85 degrees")) throw new Error(`Expected '85 degrees' in: ${res}`);
    },
  },
  {
    id: 10,
    description: "Currency formatting ($89.50 -> 89 dollars and 50 cents)",
    input: "Our diagnostic service fee is $89.50 for standard visits.",
    assertions: (res) => {
      if (!res.includes("89 dollars and 50 cents")) throw new Error(`Expected currency words in: ${res}`);
      if (res.includes("$")) throw new Error(`Did not expect '$' in: ${res}`);
    },
  },
  {
    id: 11,
    description: "Whole dollar currency ($150 -> 150 dollars)",
    input: "The tune-up special is only $150 this season.",
    assertions: (res) => {
      if (!res.includes("150 dollars")) throw new Error(`Expected '150 dollars' in: ${res}`);
    },
  },
  {
    id: 12,
    description: "Ordinal date normalization (October 1st -> October first)",
    input: "Could we schedule the inspection for October 1st?",
    assertions: (res) => {
      if (!res.includes("October first")) throw new Error(`Expected 'October first' in: ${res}`);
    },
  },
  {
    id: 13,
    description: "Ordinal date 22nd -> twenty-second",
    input: "Our next available appointment is Friday, August 22nd.",
    assertions: (res) => {
      if (!res.includes("twenty-second")) throw new Error(`Expected 'twenty-second' in: ${res}`);
    },
  },
  {
    id: 14,
    description: "Safety carbon monoxide abbreviation (CO -> carbon monoxide)",
    input: "Emergency: our CO detector is sounding an alarm in the hallway.",
    assertions: (res) => {
      if (!res.includes("carbon monoxide")) throw new Error(`Expected 'carbon monoxide' in: ${res}`);
    },
  },
  {
    id: 15,
    description: "BTU cooling capacity (18000 BTU -> 18000 B-T-U)",
    input: "I have an 18000 BTU mini split unit that is leaking water.",
    assertions: (res) => {
      if (!res.includes("B-T-U")) throw new Error(`Expected 'B-T-U' in: ${res}`);
    },
  },
  {
    id: 16,
    description: "Markdown formatting removal (bold, asterisks, headers)",
    input: "**Important**: #1 priority is safety! Visit *www.example.com* for details.",
    assertions: (res) => {
      if (res.includes("**") || res.includes("*") || res.includes("#")) {
        throw new Error(`Did not expect markdown in: ${res}`);
      }
      if (res.includes("www.example.com")) {
        throw new Error(`Did not expect URL in: ${res}`);
      }
    },
  },
  {
    id: 17,
    description: "Brackets, parentheses, and technical symbols cleanup",
    input: "Our [certified] tech (Sarah's team) will assist you @ your home & check 100% of vents.",
    assertions: (res) => {
      if (res.includes("[") || res.includes("]") || res.includes("(") || res.includes(")")) {
        throw new Error(`Did not expect brackets or parens in: ${res}`);
      }
      if (!res.includes("technician")) throw new Error(`Expected 'technician' in: ${res}`);
      if (!res.includes(" and ")) throw new Error(`Expected '&' replaced with 'and' in: ${res}`);
      if (!res.includes("100 percent")) throw new Error(`Expected '100 percent' in: ${res}`);
    },
  },
  {
    id: 18,
    description: "Multiple punctuation collapse (... -> .)",
    input: "Let me check our schedule... Okay, we have an opening tomorrow.",
    assertions: (res) => {
      if (res.includes("...")) throw new Error(`Did not expect ellipsis in: ${res}`);
      if (!res.includes(".")) throw new Error(`Expected period in: ${res}`);
    },
  },
  {
    id: 19,
    description: "Noon time normalization (12:00 PM -> 12 PM)",
    input: "Is 12:00 PM on Monday convenient for you?",
    assertions: (res) => {
      if (!res.includes("12 PM")) throw new Error(`Expected '12 PM' in: ${res}`);
    },
  },
  {
    id: 20,
    description: "Complex combined conversational receptionist sentence",
    input: "You're all set! We've scheduled your A/C tune-up on September 3rd at 9:00 AM. Our tech will call 555-987-6543 beforehand.",
    assertions: (res) => {
      if (!res.includes("You are all set!")) throw new Error(`Expected 'You are all set!' in: ${res}`);
      if (!res.includes("We have scheduled")) throw new Error(`Expected 'We have scheduled' in: ${res}`);
      if (!res.includes("air conditioning")) throw new Error(`Expected 'air conditioning' in: ${res}`);
      if (!res.includes("September third")) throw new Error(`Expected 'September third' in: ${res}`);
      if (!res.includes("9 AM")) throw new Error(`Expected '9 AM' in: ${res}`);
      if (!res.includes("technician")) throw new Error(`Expected 'technician' in: ${res}`);
      if (!res.includes("5 5 5, 9 8 7, 6 5 4 3")) throw new Error(`Expected formatted phone in: ${res}`);
    },
  },
];

export const CLAUSE_SPLIT_TEST_CASES = [
  {
    name: "Time protection: 10:30 AM is never split at the colon",
    input: "We can schedule your AC maintenance for tomorrow at 10:30 AM, does that work for you?",
    test: () => {
      const split = findClauseSplit(
        "We can schedule your AC maintenance for tomorrow at 10:30 AM, does that work for you?",
        false
      );
      if (!split) throw new Error("Expected a split at the comma");
      if (split.sentence.endsWith("10:") || split.sentence.endsWith("10")) {
        throw new Error(`Split fragmented time expression: '${split.sentence}'`);
      }
      if (!split.sentence.includes("10:30 AM")) {
        throw new Error(`Expected '10:30 AM' intact in: '${split.sentence}'`);
      }
    },
  },
  {
    name: "Number protection: $1,500 is never split at the comma",
    input: "The total estimate for replacing the evaporator coil is $1,500, including parts and labor.",
    test: () => {
      const split = findClauseSplit(
        "The total estimate for replacing the evaporator coil is $1,500, including parts and labor.",
        false
      );
      if (!split) throw new Error("Expected a split at the comma");
      if (split.sentence.endsWith("$1") || split.sentence.endsWith("1")) {
        throw new Error(`Split fragmented formatted number: '${split.sentence}'`);
      }
      if (!split.sentence.includes("$1,500")) {
        throw new Error(`Expected '$1,500' intact in: '${split.sentence}'`);
      }
    },
  },
  {
    name: "Phone number protection: 555-123-4567 is not fragmented",
    input: "Our technician will call you at 555-123-4567 before heading over.",
    test: () => {
      const split = findClauseSplit(
        "Our technician will call you at 555-123-4567 before heading over.",
        false
      );
      if (!split) throw new Error("Expected a split at the period");
      if (!split.sentence.includes("555-123-4567")) {
        throw new Error(`Expected phone number intact in: '${split.sentence}'`);
      }
    },
  },
  {
    name: "Abbreviation protection: Dr. and p.m. do not cause premature splits",
    input: "Dr. Smith confirmed an appointment for 3:00 p.m. today.",
    test: () => {
      const split = findClauseSplit(
        "Dr. Smith confirmed an appointment for 3:00 p.m. today.",
        false
      );
      if (!split) throw new Error("Expected a split at terminal period");
      if (split.sentence === "Dr.") {
        throw new Error(`Premature split at abbreviation 'Dr.': '${split.sentence}'`);
      }
      if (split.sentence.includes("3:") && !split.sentence.includes("3:00")) {
        throw new Error(`Split inside time: '${split.sentence}'`);
      }
    },
  },
  {
    name: "Terminal prosody: question mark retains prosody mark",
    input: "Thanks for calling Apex Air! How can I help you today?",
    test: () => {
      const split = findClauseSplit(
        "Thanks for calling Apex Air! How can I help you today?",
        true
      );
      if (!split) throw new Error("Expected a split at exclamation mark");
      if (split.sentence !== "Thanks for calling Apex Air!") {
        throw new Error(`Expected 'Thanks for calling Apex Air!' but got '${split.sentence}'`);
      }
    },
  },
];

export function runAllTests(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  for (const tc of HVAC_TEST_CASES) {
    const result = normalizeSpokenText(tc.input);
    try {
      tc.assertions(result);
      passed++;
    } catch (err: any) {
      console.error(`FAILED Test #${tc.id} [${tc.description}]:`, err.message, "Output:", result);
      failed++;
    }
  }

  for (const tc of CLAUSE_SPLIT_TEST_CASES) {
    try {
      tc.test();
      passed++;
    } catch (err: any) {
      console.error(`FAILED Clause Split Test [${tc.name}]:`, err.message);
      failed++;
    }
  }

  return { passed, failed };
}
