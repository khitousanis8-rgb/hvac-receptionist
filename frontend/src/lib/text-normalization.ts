/**
 * Pure Spoken-Text Normalizer for Voice Receptionist TTS.
 *
 * Normalizes symbols, shorthand, numbers, times, dates, measurements, and phone numbers
 * into clean, natural spoken English without destroying caller/business names or sentence flow.
 */

const CONTRACTIONS: Record<string, string> = {
  "won't": "will not",
  "can't": "cannot",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  "wouldn't": "would not",
  "couldn't": "could not",
  "shouldn't": "should not",
  "it's": "it is",
  "that's": "that is",
  "what's": "what is",
  "there's": "there is",
  "here's": "here is",
  "who's": "who is",
  "how's": "how is",
  "i'm": "I am",
  "you're": "you are",
  "we're": "we are",
  "they're": "they are",
  "i've": "I have",
  "you've": "you have",
  "we've": "we have",
  "they've": "they have",
  "i'll": "I will",
  "you'll": "you will",
  "he'll": "he will",
  "she'll": "she will",
  "we'll": "we will",
  "they'll": "they will",
  "i'd": "I would",
  "you'd": "you would",
  "he'd": "he would",
  "she'd": "she would",
  "we'd": "we would",
  "they'd": "they would",
  "let's": "let us",
};

const ORDINALS: Record<string, string> = {
  "1st": "first",
  "2nd": "second",
  "3rd": "third",
  "4th": "fourth",
  "5th": "fifth",
  "6th": "sixth",
  "7th": "seventh",
  "8th": "eighth",
  "9th": "ninth",
  "10th": "tenth",
  "11th": "eleventh",
  "12th": "twelfth",
  "13th": "thirteenth",
  "14th": "fourteenth",
  "15th": "fifteenth",
  "16th": "sixteenth",
  "17th": "seventeenth",
  "18th": "eighteenth",
  "19th": "nineteenth",
  "20th": "twentieth",
  "21st": "twenty-first",
  "22nd": "twenty-second",
  "23rd": "twenty-third",
  "24th": "twenty-fourth",
  "25th": "twenty-fifth",
  "26th": "twenty-sixth",
  "27th": "twenty-seventh",
  "28th": "twenty-eighth",
  "29th": "twenty-ninth",
  "30th": "thirtieth",
  "31st": "thirty-first",
};

const CARDINALS: Record<string, string> = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  "10": "ten",
  "11": "eleven",
  "12": "twelve",
  "13": "thirteen",
  "14": "fourteen",
  "15": "fifteen",
  "16": "sixteen",
  "17": "seventeen",
  "18": "eighteen",
  "19": "nineteen",
  "20": "twenty",
};

/**
 * Format raw 7-digit, 10-digit, or 11-digit phone numbers into spaced digits
 * with natural pauses (e.g. "5 5 5, 1 2 3, 4 5 6 7") so speech engines speak them cleanly.
 */
function formatSpokenPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    const area = digits.slice(1, 4).split("").join(" ");
    const pre = digits.slice(4, 7).split("").join(" ");
    const line = digits.slice(7, 11).split("").join(" ");
    return `1, ${area}, ${pre}, ${line}`;
  }
  if (digits.length === 10) {
    const area = digits.slice(0, 3).split("").join(" ");
    const pre = digits.slice(3, 6).split("").join(" ");
    const line = digits.slice(6, 10).split("").join(" ");
    return `${area}, ${pre}, ${line}`;
  }
  if (digits.length === 7) {
    const pre = digits.slice(0, 3).split("").join(" ");
    const line = digits.slice(3, 7).split("").join(" ");
    return `${pre}, ${line}`;
  }
  return raw;
}

/**
 * Normalizes text for speech synthesis (TTS).
 * Converts shorthand, symbols, numbers, currencies, times, dates, and phone numbers
 * into spoken-safe plain English.
 */
export function normalizeSpokenText(text: string): string {
  if (!text || typeof text !== "string") return "";

  let out = text;

  // 1. Normalize smart quotes, curly apostrophes, and em/en dashes
  out = out
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, ", ");

  // 2. Strip HTML tags, markdown links, code blocks, URLs
  out = out
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) -> text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ");

  // 3. Currency: $89.50 -> 89 dollars and 50 cents, $150 -> 150 dollars
  out = out.replace(/\$(\d+)\.(\d{2})\b/g, "$1 dollars and $2 cents");
  out = out.replace(/\$(\d+)\b/g, "$1 dollars");

  // 4. Time formats (BEFORE colon stripping): "10:00 AM" -> "10 AM", "2:30 p.m." -> "2:30 PM"
  out = out.replace(/(\d{1,2}):00\s*(?:a\.m\.|am)(?=[^\w]|$)/gi, "$1 AM");
  out = out.replace(/(\d{1,2}):00\s*(?:p\.m\.|pm)(?=[^\w]|$)/gi, "$1 PM");
  out = out.replace(/(\d{1,2}):(\d{2})\s*(?:a\.m\.|am)(?=[^\w]|$)/gi, "$1:$2 AM");
  out = out.replace(/(\d{1,2}):(\d{2})\s*(?:p\.m\.|pm)(?=[^\w]|$)/gi, "$1:$2 PM");
  out = out.replace(/\b12:00\s*(?:p\.m\.|pm)(?=[^\w]|$)/gi, "12 PM");
  out = out.replace(/\b12:00\s*(?:a\.m\.|am)(?=[^\w]|$)/gi, "12 midnight");

  // 5. Phone numbers (BEFORE parens, dashes, or plus stripping):
  // Matches e.g. +1 (555) 123-4567, (555) 123-4567, 555-123-4567, +15551234567
  const phoneTokens: string[] = [];
  out = out.replace(
    /(?:\+1[\s.-]*)?(?:\(([2-9]\d{2})\)|([2-9]\d{2}))[\s.-]*(\d{3})[\s.-]*(\d{4})\b/g,
    (match) => {
      const token = `XYZPHONETOKEN${phoneTokens.length}XYZ`;
      phoneTokens.push(formatSpokenPhoneNumber(match));
      return token;
    }
  );

  // 6. Percentages: 95% -> 95 percent
  out = out.replace(/(\d+)\s*%/g, "$1 percent");

  // 7. Temperature and measurements: 72°F -> 72 degrees Fahrenheit
  out = out.replace(/(\d+)\s*°\s*F\b/gi, "$1 degrees Fahrenheit");
  out = out.replace(/(\d+)\s*°\s*C\b/gi, "$1 degrees Celsius");
  out = out.replace(/(\d+)\s*°/g, "$1 degrees");

  // 8. Common HVAC abbreviations and domain terms
  // AC / A/C
  out = out.replace(/\bA\/C\b/gi, "air conditioning");
  out = out.replace(/\bAC\b/g, "air conditioning");

  // HVAC / H.V.A.C. -> H-V-A-C
  out = out.replace(/\bH[.-]?V[.-]?A[.-]?C(?:\.|\b)/gi, "H-V-A-C");

  // BTU / BTUs -> B-T-Us
  out = out.replace(/\bBTUs\b/g, "B-T-Us");
  out = out.replace(/\bBTU\b/g, "B-T-U");
  out = out.replace(/\bCFM\b/g, "C-F-M");

  // Carbon monoxide / dioxide
  out = out.replace(/\bCO2\b/g, "carbon dioxide");
  out = out.replace(/\bCO\b/g, "carbon monoxide");

  // Appt / Tech
  out = out.replace(/\bappts\b/gi, "appointments");
  out = out.replace(/\bappt\b/gi, "appointment");
  out = out.replace(/\btechs\b/gi, "technicians");
  out = out.replace(/\btech\b/gi, "technician");

  // Latin abbreviations
  out = out.replace(/\be\.g\.,?\b/gi, "for example,");
  out = out.replace(/\bi\.e\.,?\b/gi, "that is,");
  out = out.replace(/\betc\.\b/gi, "and so on.");
  out = out.replace(/\betc\b/gi, "and so on");
  out = out.replace(/\bvs\.?\b/gi, "versus");

  // 9. Ordinal numbers: 1st -> first, 2nd -> second, etc.
  out = out.replace(/\b(\d{1,2}(?:st|nd|rd|th))\b/gi, (match) => {
    const lower = match.toLowerCase();
    return ORDINALS[lower] || match;
  });

  // 10. Markdown syntax, brackets, and code marks
  out = out.replace(/[*_~`#|<>]/g, " ");
  out = out.replace(/[\[\]\(\)\{\}]/g, " ");

  // 11. Symbol replacements
  out = out.replace(/&/g, " and ");
  out = out.replace(/@/g, " at ");
  out = out.replace(/\+/g, " plus ");
  out = out.replace(/=/g, " equals ");

  // 12. Cardinal numbers: convert standalone digits 0-20 to natural spoken words (e.g. "six" not "6")
  // Keeps natural contractions untouched for warm human conversation.
  out = out.replace(/\b([0-9]|1[0-9]|20)\b(?!\s*(?:AM|PM|am|pm|:|\.))/g, (match) => {
    return CARDINALS[match] || match;
  });

  // Restore protected phone numbers
  out = out.replace(/XYZPHONETOKEN(\d+)XYZ/g, (_, idx) => phoneTokens[Number(idx)]);

  // 13. Punctuation cleanup: keep only speech-safe punctuation (. ? ! , : ')
  out = out
    .replace(/[^\w\s.,?!':-]/g, " ")
    .replace(/--+/g, ", ")
    .replace(/\.{2,}/g, ".")
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/,{2,}/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s+\?/g, "?")
    .replace(/\s+!/g, "!")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

export interface ClauseSplit {
  sentence: string;
  rest: string;
}

/**
 * Splits streaming conversational text into clean, speakable sentence or clause chunks.
 *
 * Tokenizes and protects spoken expressions before sentence splitting:
 * - Colons between digits: "10:30", "5:05" (never split mid-time)
 * - Commas between digits: "1,500", "10,000" (never split mid-number)
 * - Phone digits / hyphens: "555-123-4567"
 * - Decimals and periods in numbers: "3.5", "$89.50"
 * - Abbreviations: "Mr.", "Mrs.", "Ms.", "Dr.", "St.", "vs.", "etc.", "No.", "a.m.", "p.m.", month abbreviations
 * - Meridiems: clauses ending immediately before "am", "pm", "a.m.", "p.m." (meridiem stays attached)
 * - Contractions and apostrophes: "don't", "can't", "it's"
 */
export function findClauseSplit(
  buffer: string,
  isFirstPhrase: boolean
): ClauseSplit | null {
  const re = /[.?!,:;\n]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const punct = m[0];
    const candidate = buffer.slice(0, m.index);
    const charBefore = buffer[m.index - 1] || "";
    const charAfter = buffer[m.index + 1] || "";

    // 1. Colon protection: never split times like "10:30" or "5:05"
    if (punct === ":" && /\d/.test(charBefore) && /\d/.test(charAfter)) {
      continue;
    }

    // 2. Comma protection: never split formatted numbers like "1,500" or "$10,000"
    if (punct === "," && /\d/.test(charBefore) && /\d/.test(charAfter)) {
      continue;
    }

    // 3. Period protection: skip abbreviations, initials, decimals, and domain names
    if (punct === ".") {
      const lastWord = (candidate.split(/\s+/).pop() || "").toLowerCase();
      if (
        /^[a-z](\.[a-z])*$/i.test(lastWord) ||
        /^(mr|mrs|ms|dr|st|vs|etc|no|am|pm|a\.m|p\.m|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)$/.test(lastWord)
      ) {
        continue;
      }
      if (/\d/.test(charBefore) && (/\d/.test(charAfter) || charAfter === "")) {
        continue;
      }
    }

    // 4. Meridiem protection: if punctuation is immediately followed by AM/PM, do not split
    const restAfterPunct = buffer.slice(m.index + 1).trimStart();
    if (/^(?:am|pm|a\.m\.|p\.m\.)\b/i.test(restAfterPunct)) {
      continue;
    }

    const trimmed = candidate.trim();
    if (!trimmed) continue;

    if (punct === "." || punct === "?" || punct === "!") {
      // Complete sentence terminal: dispatch immediately
      if (isFirstPhrase && trimmed.length < 8) continue;
      return { sentence: trimmed + punct, rest: buffer.slice(m.index + 1) };
    }

    // Breath group / clause boundaries (comma, colon, semicolon, newline)
    if (isFirstPhrase ? trimmed.length >= 8 : trimmed.length >= 25 || buffer.length > 80) {
      return { sentence: trimmed, rest: buffer.slice(m.index + 1) };
    }
  }
  return null;
}
