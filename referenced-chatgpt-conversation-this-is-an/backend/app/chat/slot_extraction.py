"""Durable booking-slot extraction moved verbatim from app.chat_api.

Converts caller text into candidate and verified slot updates with negation
detection and AM/PM ambiguity clarification. Pure: depends only on the
intent detectors and phone normalization.
"""

from __future__ import annotations

import re
from typing import Any

from app.chat.intent import _is_assistant_echo
from app.scheduling import normalize_nanp_phone


def _extract_slots_from_text(text: str, current_slots: dict[str, Any]) -> dict[str, Any]:
    """Extract and separate candidate extractions from verified facts.

    Maintains candidates and verified slot models, strictly detects negated services,
    and flags ambiguous time expressions for AM/PM clarification without guessing.
    """
    updates: dict[str, Any] = {}
    lower = text.lower().strip()

    # Reject acoustic mic echoes of assistant greeting and system phrases
    if _is_assistant_echo(text):
        return updates

    # Initialize candidate, verified, and negation state
    existing_candidates = current_slots.get("candidates")
    candidates: dict[str, Any] = (
        dict(existing_candidates) if isinstance(existing_candidates, dict) else {}
    )
    existing_verified = current_slots.get("verified")
    verified: dict[str, Any] = (
        dict(existing_verified) if isinstance(existing_verified, dict) else {}
    )
    existing_negated = current_slots.get("negated_services")
    negated_services: list[str] = (
        list(existing_negated) if isinstance(existing_negated, list) else []
    )
    clarification_needed: str | None = current_slots.get("clarification_needed")

    # Seed from top-level slots if candidates/verified were empty
    for field in ("name", "phone", "service", "date", "time"):
        if field not in candidates and current_slots.get(field):
            candidates[field] = current_slots.get(field)
        if field not in verified and current_slots.get(field):
            verified[field] = current_slots.get(field)

    # 1. Name extraction
    name_patterns = [
        r"(?:my name is|i am|i'm|this is|call me|name's|name is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)",
        r"^([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+here",
    ]
    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            first_word = candidate.lower().split()[0]
            if first_word not in {
                "sarah", "calling", "good", "okay", "yes", "no", "looking",
                "interested", "repair", "service", "ac", "heating", "cooling",
                "this", "here", "just", "how",
            } and candidate.lower() not in {"sarah how", "sarah here"}:
                candidates["name"] = candidate
                verified["name"] = candidate
                updates["name"] = candidate
                break

    # 2. Phone extraction (handles spoken digit words: 'plus 1 2 3 0 ...' or '555-123-4567')
    digit_map = {
        "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4",
        "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
        "plus": "+",
    }
    normalized_for_phone = lower
    for word, digit in digit_map.items():
        normalized_for_phone = re.sub(rf"\b{word}\b", digit, normalized_for_phone)
    normalized_for_phone = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", normalized_for_phone)

    phone_match = re.search(r"(\+?\s*[\d\s\-\.\(\)]{6,}\d)", normalized_for_phone)
    if phone_match:
        matched_str = phone_match.group(1)
        raw_digits = re.sub(r"[^\d]", "", matched_str)
        candidates["phone"] = matched_str.strip()
        # Strict 10-digit NANP validation via normalize_nanp_phone
        nanp = normalize_nanp_phone(raw_digits)
        if nanp is not None:
            prefix = "+" if "+" in matched_str else ""
            phone_val = f"{prefix}{raw_digits}"
            verified["phone"] = phone_val
            updates["phone"] = phone_val
        else:
            # 7-digit, 8-digit, 9-digit, or invalid area code remains candidate only; not verified
            verified["phone"] = None

    # 3. Service extraction with Negation Detection
    ac_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:a/?c|air\s*condition(?:ing)?)\b|"
        r"\b(?:a/?c|air\s*condition(?:ing)?)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )
    heating_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:furnace|heating|heater|boiler|heat\s*pump)\b|"
        r"\b(?:furnace|heating|heater|boiler|heat\s*pump)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )
    tuneup_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:tune-?up|tune\s*up|maintenance|inspection)\b|"
        r"\b(?:tune-?up|tune\s*up|maintenance|inspection)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )

    this_turn_negated: list[str] = []
    if re.search(ac_neg_pat, lower):
        this_turn_negated.append("AC repair")
    if re.search(heating_neg_pat, lower):
        this_turn_negated.append("Heating repair")
    if re.search(tuneup_neg_pat, lower):
        this_turn_negated.append("HVAC tune-up")

    for neg_svc in this_turn_negated:
        if neg_svc not in negated_services:
            negated_services.append(neg_svc)
        if candidates.get("service") == neg_svc:
            candidates["service"] = None
        if verified.get("service") == neg_svc:
            verified["service"] = None

    aff_matches: list[str] = []
    if re.search(r"\b(a/?c|air\s*condition(?:ing)?|cooling|not\s+cooling)\b", lower):
        if "AC repair" not in this_turn_negated:
            aff_matches.append("AC repair")
    if re.search(r"\b(furnace|heating|heater|boiler|heat\s*pump)\b", lower):
        if "Heating repair" not in this_turn_negated:
            aff_matches.append("Heating repair")
    if re.search(r"\b(tune-?up|tune\s*up|maintenance|inspection)\b", lower):
        if "HVAC tune-up" not in this_turn_negated:
            aff_matches.append("HVAC tune-up")

    if aff_matches:
        chosen_service = aff_matches[0]
        candidates["service"] = chosen_service
        verified["service"] = chosen_service
        updates["service"] = chosen_service
        if chosen_service in negated_services:
            negated_services.remove(chosen_service)
    elif this_turn_negated:
        candidates["service"] = None
        verified["service"] = None
        updates["service"] = None

    # 4. Date extraction
    date_match = re.search(
        r"\b(\d{4}-\d{2}-\d{2}|today|tomorrow|next\s+"
        r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lower,
    )
    if date_match:
        extracted_date = date_match.group(1)
        candidates["date"] = extracted_date
        verified["date"] = extracted_date
        updates["date"] = extracted_date

    # 5. Time extraction with Ambiguity Resolution (no auto-guessing)
    word_to_hour = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
        "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    }

    # If previously clarifying AM/PM, resolve if user now specified period
    if clarification_needed == "time_am_pm" and "time" not in updates:
        has_pm = bool(re.search(r"\b(?:p\.?m\.?|afternoon|evening|night)\b", lower))
        has_am = bool(re.search(r"\b(?:a\.?m\.?|morning)\b", lower))
        cand_time_str = str(candidates.get("time") or "03:00").split()[0]
        parts = cand_time_str.split(":")
        h = int(parts[0]) if parts[0].isdigit() else 3
        m = parts[1] if len(parts) > 1 and parts[1].isdigit() else "00"
        if has_pm and not has_am:
            time_val = f"{h:02d}:{m} PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif has_am and not has_pm:
            time_val = f"{h:02d}:{m} AM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val

    # Explicit time with AM/PM: e.g. "9:00 a.m.", "3 PM", "3:30 AM", "3:00pm", "3am"
    time_match = re.search(
        r"\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b",
        lower,
    )
    if time_match:
        matched_time = time_match.group(1)
        candidates["time"] = matched_time
        verified["time"] = matched_time
        clarification_needed = None
        updates["time"] = matched_time
    elif re.search(r"\bnoon\b|\bmidday\b", lower):
        time_val = "12:00 PM"
        candidates["time"] = time_val
        verified["time"] = time_val
        clarification_needed = None
        updates["time"] = time_val
    else:
        hour_candidate: int | None = None
        min_candidate = "00"

        oclock_digits = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*o'?clock\b", lower)
        at_digits = re.search(r"\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\b", lower)
        num_words_pat = "|".join(word_to_hour.keys())
        oclock_words = re.search(rf"\b({num_words_pat})\s*o'?clock\b", lower)
        at_words = re.search(rf"\b(?:at|around)\s+({num_words_pat})\b", lower)

        if oclock_digits:
            hour_candidate = int(oclock_digits.group(1))
            if oclock_digits.group(2):
                min_candidate = oclock_digits.group(2)
        elif at_digits:
            hour_candidate = int(at_digits.group(1))
            if at_digits.group(2):
                min_candidate = at_digits.group(2)
        elif oclock_words:
            hour_candidate = word_to_hour[oclock_words.group(1)]
        elif at_words:
            hour_candidate = word_to_hour[at_words.group(1)]

        if hour_candidate is not None and 1 <= hour_candidate <= 23:
            if any(w in lower for w in ("afternoon", "evening", "night", "pm")):
                time_val = f"{hour_candidate:02d}:{min_candidate} PM"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val
            elif any(w in lower for w in ("morning", "am")):
                time_val = f"{hour_candidate:02d}:{min_candidate} AM"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val
            elif 1 <= hour_candidate <= 6:
                # AMBIGUOUS: 1..6 (e.g. "tomorrow at three" or "at 3") without AM/PM!
                # Do NOT auto-guess PM! Flag clarification_needed = "time_am_pm"
                # Keep candidate observation, but do NOT set verified.time or updates["time"]
                candidates["time"] = f"{hour_candidate:02d}:{min_candidate}"
                verified["time"] = None
                clarification_needed = "time_am_pm"
            else:
                # 7..12: standard business hours AM (or 12 PM)
                period = "AM" if hour_candidate < 12 else "PM"
                time_val = f"{hour_candidate:02d}:{min_candidate} {period}"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val

        elif re.search(r"\bmorning\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 AM"
            else:
                time_val = "09:00 AM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif re.search(r"\bafternoon\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 PM"
            else:
                time_val = "02:00 PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif re.search(r"\bevening\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 PM"
            else:
                time_val = "05:00 PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val

    # Only return updates if something changed or was extracted!
    has_changes = (
        bool(updates)
        or candidates != existing_candidates
        or verified != existing_verified
        or negated_services != existing_negated
        or clarification_needed != current_slots.get("clarification_needed")
    )

    if not has_changes:
        return {}

    updates["candidates"] = candidates
    updates["verified"] = verified
    updates["negated_services"] = negated_services
    updates["clarification_needed"] = clarification_needed

    return updates

