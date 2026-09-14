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
  out = out.replace(
    /(?:\+1[\s.-]*)?(?:\(([2-9]\d{2})\)|([2-9]\d{2}))[\s.-]*(\d{3})[\s.-]*(\d{4})\b/g,
    (match) => formatSpokenPhoneNumber(match)
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

  // HVAC -> H-V-A-C
  out = out.replace(/\bHVAC\b/gi, "H-V-A-C");

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

  // 12. Contraction expansions: "I'm" -> "I am", "can't" -> "cannot"
  out = out.replace(/\b([a-zA-Z]+'[a-zA-Z]+)\b/g, (match) => {
    const lower = match.toLowerCase();
    const expanded = CONTRACTIONS[lower];
    if (expanded) {
      if (match[0] === match[0].toUpperCase()) {
        return expanded.charAt(0).toUpperCase() + expanded.slice(1);
      }
      return expanded;
    }
    return match;
  });

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
