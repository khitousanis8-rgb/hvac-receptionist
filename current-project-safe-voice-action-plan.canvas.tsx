import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

const phases = [
  [
    <Pill active key="p0">0</Pill>,
    "Freeze unsafe authority",
    <Text key="p0-work" size="small">
      Keep the browser path as the only active path. Disable anonymous appointment lookup and voice-only booking completion while the replacement is built. Keep <Code>ENABLE_LIVEKIT_WORKER=false</Code>.
    </Text>,
    "No new provider",
    "A one-word ASR transcript cannot create a booking or disclose an appointment.",
  ],
  [
    <Pill active key="p1">1</Pill>,
    "Make the server the conversation authority",
    <Text key="p1-work" size="small">
      Replace browser-supplied history with a server-owned <Code>CallTurn</Code> record. The browser sends only the new caller message plus call credentials. Retain a bounded recent turn window on the server.
    </Text>,
    "Schema migration",
    "Fake assistant history, oversized history, and replayed browser context cannot reach the LLM.",
  ],
  [
    <Pill active key="p2">2</Pill>,
    "Separate candidate facts from verified facts",
    <Text key="p2-work" size="small">
      Change <Code>session_slots</Code> to store observed candidates separately from verified values. Treat speech extraction as a candidate only. Require canonical service, ten-digit phone, exact future date, and exact AM/PM time before a recap.
    </Text>,
    "No new provider",
    "Ambiguous or negated speech triggers a clarification; it cannot become a bookable field.",
  ],
  [
    <Pill active key="p3">3</Pill>,
    "Add a browser confirmation ticket",
    <Text key="p3-work" size="small">
      On a deterministic recap, issue a short-lived, single-use ticket bound to the call ID and booking fingerprint. Render the exact details in the existing React call UI and require an intentional Confirm Booking tap. Consume the ticket atomically before calling the scheduler.
    </Text>,
    "No SMS; existing React UI",
    "Echoed or accidental “yes” never books. Double-click and replay yield exactly one booking.",
  ],
  [
    <Pill key="p4">4</Pill>,
    "Constrain model output and public facts",
    <Text key="p4-work" size="small">
      Remove lookup from LLM tool exposure. Let the model choose only allowlisted dialogue intents; render booking facts, hours, policies, and fallback wording from server templates and configured business data.
    </Text>,
    "No new model or API",
    "The model cannot invent a service, price, policy, availability, or appointment status.",
  ],
  [
    <Pill key="p5">5</Pill>,
    "Make the voice loop recoverable",
    <Text key="p5-work" size="small">
      Keep half-duplex audio while Sarah speaks, move echo matching to server-owned utterance hashes and timestamps, protect time/phone tokens before chunking, and pause—not finalize—on a short mobile background event.
    </Text>,
    "No new voice provider",
    "Assistant audio cannot authorize a booking; a brief phone app switch preserves the call.",
  ],
  [
    <Pill key="p6">6</Pill>,
    "Add production data and release gates",
    <Text key="p6-work" size="small">
      Move production from ephemeral Render SQLite to PostgreSQL, add migrations and dialect-aware SQLAlchemy configuration, and apply chat/session/booking rate limits at the API edge. Run staging tests before deploy.
    </Text>,
    "Managed PostgreSQL required",
    "Bookings and call logs survive redeploy; abusive traffic cannot consume LLM capacity unchecked.",
  ],
];

const acceptance = [
  ["Echoed confirmation", "Server receives assistant-like “yes” after TTS.", "No ticket consumption; no appointment."],
  ["Accidental spoken yes", "Caller says “yes” before tapping the review card.", "No appointment; UI remains available for intentional confirmation."],
  ["Ambiguous time", "Caller says “tomorrow at three.”", "Clarify AM or PM; no recap ticket."],
  ["Negated service", "Caller says “not AC, heating.”", "Heating is candidate; AC never becomes verified."],
  ["Forged history", "Browser posts a fabricated assistant turn.", "Ignored; only server-persisted turns are used."],
  ["Lookup request", "Caller gives another person’s phone number.", "No appointment details disclosed."],
  ["Replay", "Confirmation request is sent twice.", "One transaction succeeds; one booking exists."],
  ["Mobile interruption", "Phone locks or app briefly backgrounds.", "Call resumes; no premature end event."],
  ["Redeploy", "A confirmed booking is created, then production restarts.", "Call log and appointment remain available."],
];

const dependencies = [
  ["CRM", "No", "The existing private dashboard, CallRecord, Customer, and Appointment tables cover current operations. Add a webhook adapter later if a client chooses a CRM."],
  ["SMS / OTP", "No for this release", "The browser confirmation ticket replaces it. SMS or DTMF is only needed later for fully voice-only booking or protected appointment lookup."],
  ["Model training / fine-tuning", "No", "Use deterministic state, validation, templates, and tests first. Consider training only after consented, redacted real-call data proves one repeatable failure class."],
  ["New LLM API", "No", "Keep the existing OpenAI-compatible LLM configuration. The change is authority and output constraints, not a model swap."],
  ["New voice API", "No", "Keep browser Kokoro and the current recognition path. Improve gating, server-side echo protection, and fallbacks."],
  ["Durable database", "Yes before production", "The current Render service uses ephemeral SQLite. Use managed PostgreSQL plus a PostgreSQL driver and migration tool."],
  ["Rate-limit store", "Recommended before public launch", "An edge limiter or Redis-backed limiter is needed when more than one API instance can run; in-memory limits are not sufficient for durable public protection."],
];

export default function CurrentProjectSafeVoiceActionPlan() {
  const theme = useHostTheme();

  return (
    <Stack gap={20} style={{ padding: 24, background: theme.bg.editor }}>
      <Stack gap={6}>
        <H1>Current-project action plan</H1>
        <Text tone="secondary">
          HVAC receptionist · scoped to the current FastAPI backend, React browser voice UI, existing dashboard, and deployment files · commit <Code>c56511e</Code>
        </Text>
      </Stack>

      <Callout tone="warning" title="The release target is zero unverified actions, not zero spoken-word errors.">
        Do not train or replace the model first. The first release must prevent an ASR mistake, echo, or model mistake from creating a booking, revealing an appointment, or changing trusted state.
      </Callout>

      <Grid columns={4} gap={12}>
        <Stat value="7" label="ordered delivery phases" tone="info" />
        <Stat value="0" label="new CRM builds now" tone="success" />
        <Stat value="0" label="SMS integrations now" tone="success" />
        <Stat value="1" label="production service required" tone="warning" />
      </Grid>

      <Grid columns="minmax(0, 1.18fr) minmax(0, 1fr)" gap={16}>
        <Card>
          <CardHeader trailing={<Pill size="sm">build now</Pill>}>Boundaries for this delivery</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">Keep the existing browser Kokoro path, FastAPI API, scheduling model, and private dashboard.</Text>
              <Text size="small">Use a deliberate browser tap as the booking second factor; it needs no SMS provider, CRM, or model training.</Text>
              <Text size="small">Keep all appointment mutations inside the server and within one database transaction.</Text>
              <Text size="small">Leave the opt-in LiveKit worker off until it uses the same ticketed confirmation service.</Text>
            </Stack>
          </CardBody>
        </Card>
        <Stack gap={10}>
          <H3>Architecture after Phase 3</H3>
          <Text size="small">
            ASR → candidate fields → deterministic validation → server recap → one-time ticket → user tap → atomic booking → template spoken by TTS.
          </Text>
          <Text size="small" tone="secondary">
            The LLM remains responsible for friendly conversation and clarification, never for booking authority or factual records.
          </Text>
        </Stack>
      </Grid>

      <Stack gap={8}>
        <H2>Delivery sequence and exit gates</H2>
        <Table
          headers={["Phase", "Outcome", "Exact project work", "Dependency", "Exit gate"]}
          rows={phases}
          rowTone={["danger", "danger", "warning", "warning", "warning", "warning", "danger"]}
          striped
          stickyHeader
        />
      </Stack>

      <Divider />

      <Stack gap={8}>
        <H2>Non-negotiable acceptance tests</H2>
        <Text size="small" tone="secondary">
          These are test cases to automate in backend and frontend suites, then repeat manually on a phone and desktop before staging release.
        </Text>
        <Table
          headers={["Scenario", "Test input", "Required result"]}
          rows={acceptance.map(([scenario, input, result]) => [
            scenario,
            <Text key={scenario + "input"} size="small">{input}</Text>,
            <Text key={scenario + "result"} size="small">{result}</Text>,
          ])}
          rowTone={["danger", "danger", "warning", "warning", "danger", "danger", "danger", "warning", "danger"]}
          striped
        />
      </Stack>

      <Grid columns="minmax(0, 1.05fr) minmax(0, 1fr)" gap={16}>
        <Stack gap={8}>
          <H2>Dependencies: required versus deferred</H2>
          <Table
            headers={["Item", "Decision", "Reason in this project"]}
            rows={dependencies.map(([item, decision, reason]) => [
              item,
              <Pill active={decision === "Yes before production"} key={item + decision}>{decision}</Pill>,
              <Text key={item + "reason"} size="small">{reason}</Text>,
            ])}
            rowTone={["neutral", "neutral", "neutral", "neutral", "neutral", "warning", "warning"]}
            striped
          />
        </Stack>
        <Card>
          <CardHeader trailing={<Pill size="sm">human decisions</Pill>}>Inputs needed before production</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">Approve the browser review-and-tap flow as the only booking completion path for this release.</Text>
              <Text size="small">Provide the canonical services, aliases, opening hours, timezone, and approved answers to frequently asked business questions.</Text>
              <Text size="small">Choose the managed PostgreSQL host and provide its production connection secret outside source control.</Text>
              <Text size="small">Decide the handoff destination for unsupported requests: business phone, email queue, or a fixed callback request.</Text>
              <Text size="small">Approve staging before any deployment action; deployment remains a separate step.</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Card>
        <CardHeader trailing={<Pill size="sm">copy-ready</Pill>}>Implementation prompt for the next coding task</CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text size="small">
              Implement Phases 0 through 5 of the current-project action plan in the HVAC receptionist repository. Work only on the existing FastAPI backend and React browser call interface. Do not add SMS, OTP, CRM, model training, a new LLM provider, a new voice provider, or a deployment.
            </Text>
            <Text size="small">
              First remove anonymous appointment lookup and prevent speech-only confirmation from creating a booking. Persist authoritative conversation turns on the server and stop accepting browser-supplied assistant history. Bound every user message and retained turn. Represent extracted details as candidates until deterministic validation and an exact recap make them verified.
            </Text>
            <Text size="small">
              Add a short-lived, single-use confirmation ticket bound to the call ID, call secret, and canonical booking fingerprint. Render the service, normalized phone, date, and time in the existing browser UI, then require a deliberate Confirm Booking tap. Consume the ticket atomically and make duplicate or stale confirmation attempts harmless.
            </Text>
            <Text size="small">
              Restrict the LLM to dialogue intent and friendly clarification. Keep booking facts, policies, hours, availability, recaps, emergency responses, and fallback text deterministic and server-rendered. Keep the call half-duplex during TTS, make echo suppression use server-owned assistant utterance data, preserve time and phone tokens through TTS chunking, and do not finalize a call on a brief visibility change.
            </Text>
            <Text size="small">
              Add focused regression tests for every acceptance scenario in this plan. Report changed files, migration requirements, test results, and any human decision needed for Phase 6. Do not commit, push, or deploy.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Row gap={8} wrap>
        <Pill size="sm">No CRM this release</Pill>
        <Pill size="sm">No SMS this release</Pill>
        <Pill size="sm">No model training this release</Pill>
        <Pill size="sm">PostgreSQL before production</Pill>
      </Row>
    </Stack>
  );
}
