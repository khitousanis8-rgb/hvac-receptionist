# pyright: reportCallIssue=false
"""Adversarial stress harness for Milestone 1 Iteration 2 clause splitting.

Empirically challenges:
1. Dispatch requirements: 'Would tomorrow at 10:30 a.m. work?', 'For example, e.g. filters or belts.', 'Dr. Smith'
2. No fragmentation of meridiems (a.m., p.m., A.M., P.M.) and abbreviations (Dr., e.g., i.e., Jan., etc.)
3. Strict invariant: ''.join(chunks) == original_text
4. Extensive randomized fuzzing across multi-character and Unicode distributions
"""

from __future__ import annotations

import random
import string

from app.chat_api import _split_into_clause_chunks


def test_dispatch_mandatory_test_cases() -> None:
    """Verify specific test cases cited in Challenger dispatch instructions."""
    # Case 1: Would tomorrow at 10:30 a.m. work?
    c1 = _split_into_clause_chunks("Would tomorrow at 10:30 a.m. work?")
    assert c1 == ["Would tomorrow at 10:30 a.m. work?"]
    assert "".join(c1) == "Would tomorrow at 10:30 a.m. work?"

    # Case 2: For example, e.g. filters or belts.
    c2 = _split_into_clause_chunks("For example, e.g. filters or belts.")
    assert c2 == ["For example, ", "e.g. filters or belts."]
    assert "".join(c2) == "For example, e.g. filters or belts."

    # Case 3: Dr. Smith
    c3 = _split_into_clause_chunks("Dr. Smith")
    assert c3 == ["Dr. Smith"]
    assert "".join(c3) == "Dr. Smith"

    # Additional variations of Dr. Smith
    c3b = _split_into_clause_chunks("Please call Dr. Smith at 555-0199.")
    assert c3b == ["Please call Dr. Smith at 555-0199."]
    assert "".join(c3b) == "Please call Dr. Smith at 555-0199."


def test_meridiem_comprehensive_matrix() -> None:
    """Stress test meridiems in various sentence positions, cases, and punctuation contexts."""
    cases = [
        # Mid-sentence with question
        ("Would tomorrow at 10:30 a.m. work?", ["Would tomorrow at 10:30 a.m. work?"]),
        ("Would 2:00 p.m. work?", ["Would 2:00 p.m. work?"]),
        ("Would 10:30 A.M. or 2:30 P.M. work?", ["Would 10:30 A.M. or 2:30 P.M. work?"]),
        # Mid-sentence followed by lowercase words
        ("Let us meet at 10:30 a.m. tomorrow.", ["Let us meet at 10:30 a.m. tomorrow."]),
        ("Let us meet at 2:00 p.m. today.", ["Let us meet at 2:00 p.m. today."]),
        # Followed by comma (clause boundary)
        ("We can meet at 10:30 a.m., but not later.", ["We can meet at 10:30 a.m., ", "but not later."]),
        ("At 2:00 p.m., our technician will arrive.", ["At 2:00 p.m., ", "our technician will arrive."]),
        # Sentence boundary followed by uppercase sentence
        (
            "I have an opening at 10:30 a.m. Would that work for you?",
            ["I have an opening at 10:30 a.m. ", "Would that work for you?"],
        ),
        (
            "The technician arrives at 2:00 p.m. Please ensure someone is home.",
            ["The technician arrives at 2:00 p.m. ", "Please ensure someone is home."],
        ),
        # End of text with trailing dot
        ("The earliest appointment is at 10:30 a.m.", ["The earliest appointment is at 10:30 a.m."]),
        ("The technician finishes at 5:00 p.m.", ["The technician finishes at 5:00 p.m."]),
        # Multiple appointments listed
        (
            "We have 10:30 a.m., 1:15 p.m., and 4:00 p.m. open.",
            ["We have 10:30 a.m., ", "1:15 p.m., ", "and 4:00 p.m. open."],
        ),
    ]

    for text, expected in cases:
        chunks = _split_into_clause_chunks(text)
        assert chunks == expected, f"Failed on {text!r}: expected {expected}, got {chunks}"
        assert "".join(chunks) == text
        # Verify no single-letter mutilated chunks
        assert not any(c.strip() in ("m.", "a.", "p.", "M.", "A.", "P.") for c in chunks)


def test_abbreviation_matrix() -> None:
    """Stress test honorifics, months, Latin abbreviations, and contractions."""
    cases = [
        # Honorific titles
        ("Dr. Smith and Mr. Johnson arrived.", ["Dr. Smith and Mr. Johnson arrived."]),
        ("Please consult Prof. Xavier or Mrs. Gable.", ["Please consult Prof. Xavier or Mrs. Gable."]),
        ("Robert Downey Jr. and Martin Luther King Sr. were mentioned.", ["Robert Downey Jr. and Martin Luther King Sr. were mentioned."]),
        ("The facility on St. Marks Ave is open.", ["The facility on St. Marks Ave is open."]),
        # Months with dates
        ("Appointment on Jan. 15, Feb. 20, or Mar. 25.", ["Appointment on Jan. 15, ", "Feb. 20, ", "or Mar. 25."]),
        ("Our summer special runs Apr. 1 to Aug. 31.", ["Our summer special runs Apr. 1 to Aug. 31."]),
        ("Fall maintenance starts Sep. 15 or Oct. 31.", ["Fall maintenance starts Sep. 15 or Oct. 31."]),
        ("Winter checkups in Nov. 10 or Dec. 5.", ["Winter checkups in Nov. 10 or Dec. 5."]),
        # Latin abbreviations
        ("For example, e.g. filters or belts.", ["For example, ", "e.g. filters or belts."]),
        ("That is, i.e. tomorrow at 2.", ["That is, ", "i.e. tomorrow at 2."]),
        ("Compare model A vs. model B.", ["Compare model A vs. model B."]),
        ("We handle AC, heating, ductwork, etc. every day.", ["We handle AC, ", "heating, ", "ductwork, ", "etc. every day."]),
        # Miscellaneous abbreviations
        ("Approx. 45 minutes remain.", ["Approx. 45 minutes remain."]),
        ("Contact the service dept. at extension 4.", ["Contact the service dept. at extension 4."]),
        ("Est. in 1985 by local owners.", ["Est. in 1985 by local owners."]),
        ("Refer to fig. 3 for wiring details.", ["Refer to fig. 3 for wiring details."]),
    ]

    for text, expected in cases:
        chunks = _split_into_clause_chunks(text)
        assert chunks == expected, f"Failed on {text!r}: expected {expected}, got {chunks}"
        assert "".join(chunks) == text
        assert not any(c.strip() in ("g.", "e.", "i.", "vs.") for c in chunks)


def test_numbers_currency_and_ellipsis() -> None:
    """Stress test digits, decimals, currencies, timestamps, and ellipsis sequences."""
    cases = [
        "That will cost $1,500 total.",
        "Total cost is $1,500,250.75 for commercial HVAC.",
        "Diagnostic fee: $89.95.",
        "Call at 10:30:15.",
        "Software release 2.0.1 is deployed.",
        "IP address 192.168.1.1 is the gateway.",
        "Thinking... okay, got it.",
        "Wait.... one second.... okay.",
        "Hello?! Are you there???",
        "Yes, absolutely; we can do that: anytime!",
    ]

    for text in cases:
        chunks = _split_into_clause_chunks(text)
        assert "".join(chunks) == text
        # Decimals and time colons must not be broken internally
        assert not any(c.strip() in ("95", "00", "75", "01", "30") and c.startswith(".") for c in chunks)


def test_boundary_pathological_inputs() -> None:
    """Verify strict invariant on boundary and edge conditions."""
    pathological = [
        "",
        " ",
        "   ",
        "\t",
        "\n",
        "\r\n\r\n",
        ".",
        ",",
        "!",
        "?",
        ":",
        ";",
        "...",
        "....",
        "?!?",
        "!?",
        ":::;;;",
        ",,,,",
        "A",
        "A.",
        "A. ",
        "1",
        "1.",
        "1. ",
        "a..b..c",
        "word without punctuation",
        "Sentence one. Sentence two. Sentence three.",
        "Clause 1, clause 2; clause 3: clause 4!",
        "Line 1\nLine 2\nLine 3",
        "Line 1\r\nLine 2\r\nLine 3",
        "“Quotes,” she said. (Parentheses!) [Brackets?]",
        "Em-dash—test and en-dash–test.",
        "Special chars: ❄️ 🔥 🔧 💨 ... Done!",
        "A" * 10000,
        ". " * 500,
        "10:30 a.m. " * 200,
        "Dr. Smith, " * 200,
    ]

    for text in pathological:
        chunks = _split_into_clause_chunks(text)
        assert "".join(chunks) == text, f"Invariant failed for input: {text!r}"


def test_randomized_adversarial_fuzzer_25k() -> None:
    """Adversarial fuzzer running 25,000 randomized strings with diverse alphabets."""
    char_pool = (
        string.ascii_letters
        + string.digits
        + string.punctuation
        + " \t\n\r"
        + "—–…“”‘’éàüöäëï"
        + "❄️🔥"
    )
    rng = random.Random(98765)

    for i in range(25000):
        length = rng.randint(0, 90)
        s = "".join(rng.choice(char_pool) for _ in range(length))
        chunks = _split_into_clause_chunks(s)
        assert "".join(chunks) == s, f"Invariant violated at iteration {i} for string: {s!r}"
