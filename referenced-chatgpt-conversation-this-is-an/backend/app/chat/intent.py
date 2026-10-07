"""Pure intent and safety detectors extracted verbatim from app.chat_api.

These helpers classify caller text and format configured business hours. They
perform no database, provider, or request-handling work: dependencies are the
standard library and application settings only.

`_is_echo_of_assistant` is deliberately left in `app.chat_api` because it
consults persisted CallTurn rows.
"""

from __future__ import annotations

import re
from typing import Any

from app.config import Settings

__all__ = [
    "format_opening_hours_speech",
    "_is_assistant_echo",
    "_is_booking_flow_active",
    "_is_closing_or_polite_remark",
    "_is_farewell",
    "_is_general_question",
    "_is_hours_query",
    "_is_lookup_query",
    "_is_safety_emergency",
]


def _is_assistant_echo(text: str, company_name: str | None = None) -> bool:
    """Detect if caller input is an echo of assistant speech picked up by mic.

    Flags true if the message mirrors the opening greeting pattern (including when
    the intro phrase is clipped and only the greeting question was transcribed)
    and does NOT contain genuine caller booking/problem intent.
    """
    clean = text.lower().strip()
    has_intro = (
        "thank you for calling" in clean
        or "thanks for calling" in clean
        or "my name is sarah" in clean
        or "this is sarah" in clean
    )
    has_prompt = (
        "how can i assist" in clean
        or "how can i help" in clean
        or "heating or cooling today" in clean
    )
    # Catch opening greeting question even when mic starts late and misses the intro phrase
    has_greeting_question = (
        ("how can i help" in clean or "how can i assist" in clean)
        and ("heating or cooling" in clean or "heating today" in clean or "cooling today" in clean)
    ) or (
        "how can i help with your heating or cooling today" in clean
        or "how can i assist with your heating or cooling today" in clean
        or "how can i help with your heating or cooling" in clean
    )

    if not (has_intro and has_prompt) and not has_greeting_question:
        return False

    stripped = clean
    phrases = [
        "thank you for calling",
        "thanks for calling",
        "example hvac",
        "apex hvac",
        "blueridge comfort",
        "blueridge comfort systems",
        "my name is sarah",
        "this is sarah",
        "how can i help with your heating or cooling today",
        "how can i assist you with your heating or cooling today",
        "how can i assist with your heating or cooling today",
        "how can i help with your heating or cooling",
        "how can i assist with your heating or cooling",
        "how can i help with heating or cooling today",
        "how can i assist with heating or cooling today",
        "how can i help with heating or cooling",
        "how can i assist with heating or cooling",
        "with your heating or cooling today",
        "with your heating or cooling",
        "heating or cooling today",
        "heating or cooling",
        "how can i help with",
        "how can i assist you with",
        "how can i assist with",
        "how can i help you",
        "how can i assist you",
        "how can i help",
        "how can i assist",
    ]
    if company_name and company_name.strip():
        phrases.append(company_name.strip().lower())
    for phrase in sorted(phrases, key=len, reverse=True):
        stripped = stripped.replace(phrase, " ")

    stripped = re.sub(r"[^a-z0-9]", " ", stripped).strip()
    remaining_words = [w for w in stripped.split() if len(w) > 2]
    return len(remaining_words) <= 2


def _is_safety_emergency(text: str) -> bool:
    """Detect safety emergency keywords to give immediate life-safety guidance."""
    lower = text.lower().replace("fireplace", " ")
    emergency_kws = [
        "gas smell", "smell gas", "smelling gas", "smoke", "sparking",
        "sparks", "carbon monoxide", "dizzy", "burning smell", "gas leak",
    ]
    if any(kw in lower for kw in emergency_kws):
        return True
    if re.search(r"\bfire\b", lower):
        return True
    return False


def _is_lookup_query(text: str) -> bool:
    """Detect anonymous appointment lookup queries to enforce neutral privacy refusal."""
    lowered = text.lower()
    if any(
        phrase in lowered
        for phrase in (
            "existing appointment",
            "my appointment",
            "prior appointment",
            "past appointment",
            "check my appointment",
            "look up my appointment",
            "find my appointment",
            "status of my appointment",
            "when is my appointment",
            "what time is my appointment",
            "do i have an appointment",
            "existing booking",
            "my booking",
            "prior booking",
            "past booking",
            "check my booking",
            "look up my booking",
            "find my booking",
            "status of my booking",
            "when is my booking",
            "what time is my booking",
            "do i have a booking",
        )
    ):
        return True

    if re.search(
        r"\b(when is|what time is|status of|check|look\s*up|lookup|find|verify)\b"
        r".*\b(the|an|my)?\s*(existing\s+)?(appointment|booking)\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(appointment|booking)\b.*\b(check|look\s*up|lookup|status|(?:for|under|with)\s+\+?1?\d{3})\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(?:is there|do i have|can you (?:see|check)|any)\b"
        r".*\b(?:an?|my)?\s*(?:existing\s+)?(?:appointment|booking)\b",
        lowered,
    ):
        return True
    return False


def _is_hours_query(text: str) -> bool:
    """Detect if caller is asking about business or operating hours."""
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in (
            "what are your hours",
            "what hours",
            "business hours",
            "opening hours",
            "when are you open",
            "are you open",
            "what time do you open",
            "what time do you close",
            "operating hours",
            "your hours",
        )
    )


def format_opening_hours_speech(settings: Settings) -> str:
    """Format opening hours into natural spoken English for voice synthesis."""
    hours = settings.business_opening_hours
    if not hours:
        return (
            f"At {settings.business_company_name}, we are open Monday through Friday from 8:00 AM "
            "to 6:00 PM, and Saturday from 8:00 AM to 6:00 PM. We are closed on Sunday."
        )

    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if len(hours) == 7 and len(set(hours.values())) == 1:
        val = list(hours.values())[0]
        if val.lower() != "closed":
            return f"At {settings.business_company_name}, we are open seven days a week from {val}."

    mon_fri = ["monday", "tuesday", "wednesday", "thursday", "friday"]
    if all(d in hours for d in mon_fri) and len(set(hours[d] for d in mon_fri)) == 1:
        mf_val = hours["monday"]
        sat_val = hours.get("saturday", "closed")
        sun_val = hours.get("sunday", "closed")
        summary = f"Monday through Friday from {mf_val}"
        if sat_val == sun_val:
            if sat_val.lower() == "closed":
                summary += ", and closed on weekends"
            else:
                summary += f", and weekends from {sat_val}"
        else:
            if sat_val.lower() != "closed":
                summary += f", Saturday from {sat_val}"
            else:
                summary += ", closed Saturday"
            if sun_val.lower() != "closed":
                summary += f", and Sunday from {sun_val}"
            else:
                summary += ", and closed Sunday"
        return f"At {settings.business_company_name}, we are open {summary}."

    parts: list[str] = []
    for d in day_names:
        if d in hours:
            v = hours[d]
            if v.lower() == "closed":
                parts.append(f"closed on {d.title()}")
            else:
                parts.append(f"{d.title()} from {v}")
    return f"At {settings.business_company_name}, our hours are {', '.join(parts)}."


def _is_general_question(text: str) -> bool:
    """Detect if caller is asking a general question or objection rather than booking."""
    lower = text.lower().strip()

    # Scheduling and dispatch requests phrased politely as questions ("can someone come out", "could you schedule")
    # are booking requests, NOT general inquiries.
    booking_actions = (
        "come out", "come by", "come over", "come to", "come", "send someone",
        "send a technician", "book", "schedule", "appointment", "take a look",
        "check my", "fix my", "service my", "repair my", "look at my",
    )
    if any(ba in lower for ba in booking_actions):
        info_keywords = (
            "how much", "cost", "price", "pricing", "rate", "rates",
            "what hours", "when are you open", "what brand", "licensed", "insured",
        )
        if not any(ik in lower for ik in info_keywords):
            return False

    if "?" in lower:
        return True
    question_starters = (
        "how much", "what are your", "do you", "can you", "where are", "who are",
        "what hours", "what brands", "what is", "whats", "how does", "pricing",
        "cost", "rates", "why", "why are", "why do", "why would", "what for",
        "who", "how", "explain", "tell me", "what is the reason", "why you",
        "i have no", "i don't have", "i dont have", "no number", "no phone",
        "i want to know", "can someone", "could you", "would you",
        "is it possible", "i'm wondering", "im wondering",
    )
    return any(lower.startswith(q) or f" {q}" in lower for q in question_starters)


def _is_booking_flow_active(slots: dict[str, Any], text: str) -> bool:
    """Determine if the caller is in an active booking dialogue."""
    if slots.get("service") or slots.get("phone") or slots.get("date") or slots.get("time"):
        return True
    lower = text.lower()
    booking_intents = (
        "book", "schedule", "appointment", "technician", "come out",
        "repair", "service", "tune up", "tune-up",
    )
    return any(kw in lower for kw in booking_intents)


def _is_closing_or_polite_remark(text: str) -> bool:
    """Check if caller is merely expressing gratitude or saying goodbye."""
    cleaned = "".join(c for c in text.lower() if c.isalnum() or c.isspace()).strip()
    polite_exact = {
        "thank you", "thanks", "thank you so much", "thanks so much",
        "thank you very much", "thanks a lot", "many thanks",
        "bye", "goodbye", "bye bye", "have a good day", "have a great day",
        "have a good one", "take care",
        "no", "no that is all", "no thats all", "no thank you", "no thanks",
        "that is all", "thats all", "that is it", "thats it", "nope",
        "nothing else", "i am good", "im good", "all good",
        "perfect thank you", "great thank you", "ok thank you", "okay thank you",
        "ok thanks", "okay thanks",
        "sounds good thank you", "sounds great thank you",
    }
    if cleaned in polite_exact:
        return True
    if len(cleaned) < 35 and (
        cleaned.startswith("thank")
        or cleaned.startswith("bye")
        or cleaned.startswith("goodbye")
        or cleaned.startswith("have a")
        or cleaned.startswith("no thank")
        or cleaned.startswith("no that")
        or cleaned.startswith("thats all")
        or cleaned.startswith("that is all")
        or cleaned.startswith("take care")
    ):
        return True
    return False


# Unambiguous terminal sign-offs that may end a call.
#
# Deliberately NARROWER than `_is_closing_or_polite_remark`: bare "no", "thanks",
# "okay" and mid-conversation filler are conversational acknowledgements, not
# farewells, and must never terminate a call. Only explicit goodbyes and clear
# closures appear here.
_FAREWELL_PHRASES = frozenset(
    {
        "bye",
        "bye bye",
        "byebye",
        "bye now",
        "goodbye",
        "good bye",
        "goodnight",
        "good night",
        "see ya",
        "see you",
        "see you later",
        "see you then",
        "talk to you later",
        "talk soon",
        "speak soon",
        "have a good day",
        "have a great day",
        "have a good one",
        "have a great one",
        "take care",
        "take care now",
        "thanks bye",
        "thank you bye",
        "ok bye",
        "okay bye",
        "alright bye",
        "thats all",
        "that is all",
        "thats it",
        "that is it",
        "nothing else",
        "no thats all",
        "no that is all",
        "no thats it",
        "no that is it",
        "im good",
        "i am good",
        "we re good",
        "were good",
        "we are good",
        "im all set",
        "i am all set",
        "we re all set",
        "were all set",
        "we are all set",
    }
)

# Bare acknowledgements and negations: conversational, never terminal.
# Without this guard a lone "no" would be stripped to nothing and mistaken
# for a sign-off.
_NON_FAREWELL_UTTERANCES = frozenset(
    {
        "no",
        "nope",
        "yes",
        "yeah",
        "yep",
        "ok",
        "okay",
        "alright",
        "sure",
        "correct",
        "right",
        "got it",
        "thanks",
        "thank you",
        "please",
    }
)

# Low-information words removed before deciding whether anything substantive
# is left in the utterance.
_FAREWELL_FILLER = frozenset(
    {
        "ok",
        "okay",
        "alright",
        "well",
        "so",
        "and",
        "then",
        "yes",
        "yeah",
        "yep",
        "please",
        "now",
        "thank",
        "thanks",
        "you",
        "your",
        "yours",
        "im",
        "i",
        "am",
        "we",
        "re",
        "are",
        "is",
        "the",
        "a",
        "an",
        "for",
        "to",
        "of",
        "all",
        "set",
        "good",
        "great",
        "too",
    }
)

# If any of these appear, the caller is still mid-thought: never end the call.
_FAREWELL_BLOCKERS = (
    "wait",
    "hold on",
    "hang on",
    "one more",
    "one sec",
    "actually",
    "not yet",
    "dont hang",
    "don t hang",
    "before you go",
    "quick question",
    "i have a question",
    "another thing",
)


def _is_farewell(text: str) -> bool:
    """Detect an unambiguous terminal sign-off that should end the call.

    Returns True only when the utterance is a goodbye ("bye", "talk to you
    later", "take care") or a clear closure ("that's all", "nothing else",
    "we're good") with no substantive content left over.

    This is deliberately narrower than `_is_closing_or_polite_remark`, which
    also treats bare "no"/"thanks" as closings. Conservative by design: failing
    to end a call is far safer than hanging up on a caller mid-thought, so
    questions, hold-on markers ("wait", "one more thing", "before you go"), and
    utterances that add a new request ("bye, I also need a tune up") never match.
    """
    if "?" in text:
        return False
    cleaned = "".join(c for c in text.lower() if c.isalnum() or c.isspace())
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        return False
    if cleaned in _NON_FAREWELL_UTTERANCES:
        return False

    for blocker in _FAREWELL_BLOCKERS:
        if blocker in cleaned:
            return False

    # Remove every farewell phrase, longest first, then inspect what remains.
    matched_farewell = False
    stripped = f" {cleaned} "
    for phrase in sorted(_FAREWELL_PHRASES, key=len, reverse=True):
        target = f" {phrase} "
        if target in stripped:
            matched_farewell = True
            stripped = stripped.replace(target, " ")
    if not matched_farewell:
        return False
    stripped = " ".join(stripped.split())

    remaining = [
        word
        for word in stripped.split()
        if len(word) > 2 and word not in _FAREWELL_FILLER
    ]
    return not remaining
