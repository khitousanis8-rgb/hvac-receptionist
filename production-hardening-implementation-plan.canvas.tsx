import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
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
    <Pill active key="phase-0">0</Pill>,
    "Baseline and safe delivery",
    <Text key="phase-0-work" size="small">
      Branch from <Code>c56511e</Code>; keep the working tree clean; record the baseline test results. Make each phase a reviewable commit and do not combine behavior changes with database migration changes.
    </Text>,
    "All existing backend and frontend checks remain green before the first functional change.",
  ],
  [
    <Pill active key="phase-1">1</Pill>,
    "Durable booking and call-log storage",
    <Text key="phase-1-work" size="small">
      Add managed PostgreSQL, require <Code>DATABASE_URL</Code> for production, make SQLite-only engine options conditional, and introduce repeatable schema migrations. Define the booked-slot partial index for both SQLite and PostgreSQL.
    </Text>,
    "Create a booking, redeploy, and verify the booking and call log survive; cancellation must still allow a time slot to be reused.",
  ],
  [
    <Pill active key="phase-2">2</Pill>,
    "Privacy, authorization, and abuse controls",
    <Text key="phase-2-work" size="small">
      Remove appointment lookup from anonymous voice sessions until an actual ownership check exists. Centralize strict phone validation; reject oversized chat history before parsing or model use; rate-limit session creation and chat messages before invoking the model; trust forwarded IP headers only from an explicitly trusted proxy. Send TTS text in a request body and prevent user-specific audio from public caching.
    </Text>,
    "A caller with another person's phone number receives no appointment details; a two-megabyte history is rejected before model work; spoofed forwarded headers do not bypass limits; seven-digit numbers cannot book.",
  ],
  [
    <Pill key="phase-3">3</Pill>,
    "Voice correctness and mobile continuity",
    <Text key="phase-3-work" size="small">
      Tokenize protected speech values before chunking, especially times such as <Code>10:30 AM</Code>. Treat hidden pages as suspended with a grace period, not ended; finalize only on explicit hangup, actual unload, or expiry.
    </Text>,
    "Times, phone numbers, contractions, and punctuation are spoken naturally; a brief mobile app switch does not end a live call.",
  ],
  [
    <Pill key="phase-4">4</Pill>,
    "Executable regression tests and safe alternate paths",
    <Text key="phase-4-work" size="small">
      Run every voice challenger through a browser-compatible test runner, not raw Node resolution. Keep LiveKit disabled by default and route any future LiveKit booking through the same deterministic server booking authority.
    </Text>,
    "One command runs normalization, audio, speech, lifecycle, and touch tests; enabling LiveKit cannot restore direct LLM booking.",
  ],
  [
    <Pill key="phase-5">5</Pill>,
    "Staging verification and controlled release",
    <Text key="phase-5-work" size="small">
      Deploy to staging with production-like storage and proxy settings. Exercise the browser on desktop and phone, including interruption, reconnect, booking, non-disclosure, and redeploy persistence scenarios.
    </Text>,
    "Release only after the acceptance matrix passes and telemetry confirms no unexpected call-finalization or rate-limit spikes.",
  ],
];

const acceptance = [
  ["Durability", "Booking and call log remain available after a redeploy.", "P1"],
  ["Privacy", "Unknown caller cannot learn service, date, time, or customer identity from a phone number.", "P1"],
  ["Abuse resistance", "Chat requests receive deterministic 429 responses before LLM use when limits are exceeded.", "P1"],
  ["Input bounds", "An oversized history payload is rejected at request validation before prompt assembly or LLM use.", "P1"],
  ["Booking quality", "Only a complete, normalized ten-digit NANP callback number can reach booking.", "P2"],
  ["Speech quality", "10:30 AM, 5:05 PM, apostrophes, and phone digits each remain intact through chunking and TTS.", "P2"],
  ["Mobile continuity", "A short background/foreground cycle preserves the call; explicit End Call closes it once.", "P2"],
  ["Regression coverage", "The default frontend test command executes all voice adversarial suites in CI.", "P2"],
  ["TTS privacy", "Assistant text is absent from TTS URLs and user-specific speech responses are not publicly cacheable.", "P2"],
];

export default function ProductionHardeningPlanCanvas() {
  const theme = useHostTheme();

  return (
    <Stack gap={20} style={{ padding: 24, background: theme.bg.editor }}>
      <Stack gap={6}>
        <H1>Production-hardening implementation plan</H1>
        <Text tone="secondary">
          HVAC receptionist · follow-up plan for commit <Code>c56511e</Code> · ordered to remove release blockers first
        </Text>
      </Stack>

      <Callout tone="warning" title="Release rule">
        Do not promote the app to production until Phases 1 and 2 pass their acceptance gates. They protect booking durability, customer privacy, request-size safety, and model/calendar abuse.
      </Callout>

      <Grid columns={4} gap={12}>
        <Stat value="6" label="ordered phases" tone="info" />
        <Stat value="4" label="P1 blockers first" tone="danger" />
        <Stat value="4" label="behavioral test groups" tone="warning" />
        <Stat value="0" label="direct LLM bookings" tone="success" />
      </Grid>

      <Stack gap={8}>
        <H2>Implementation sequence</H2>
        <Table
          headers={["Phase", "Outcome", "Exact work", "Exit gate"]}
          rows={phases}
          rowTone={["neutral", "danger", "danger", "warning", "warning", "neutral"]}
          striped
          stickyHeader
        />
      </Stack>

      <Grid columns="minmax(0, 1.15fr) minmax(0, 1fr)" gap={16}>
        <Card>
          <CardHeader trailing={<Pill size="sm">implementation contract</Pill>}>Rules for the coding agent</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">Preserve the browser server-side booking state machine as the only authority that can create bookings.</Text>
              <Text size="small">Make security controls enforceable in code, not prompt wording alone.</Text>
              <Text size="small">Do not add an SMS, CRM, payment, or voice-vendor dependency without a separate approval.</Text>
              <Text size="small">Use one shared phone-normalization function everywhere: chat slots, API models, scheduling, and tests.</Text>
              <Text size="small">Make production configuration fail closed: no silent fallback to ephemeral SQLite.</Text>
              <Text size="small">Bound every caller-controlled collection and string at the HTTP boundary before parsing, prompt assembly, or telemetry.</Text>
              <Text size="small">Keep raw caller content out of rate-limit keys, telemetry, request URLs, and public caches.</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader trailing={<Pill size="sm">recommended first decision</Pill>}>Existing-appointment requests</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">Remove <Code>check_my_appointments</Code> from anonymous browser and LiveKit tool exposure now.</Text>
              <Text size="small">Use a neutral spoken fallback: the receptionist can help arrange a new visit, while appointment changes require a verified channel.</Text>
              <Text size="small">Add lookup later only with a server-verified ownership factor, such as a one-time code; knowing a phone number is not verification.</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Stack gap={8}>
        <H2>Required acceptance matrix</H2>
        <Table
          headers={["Area", "Required proof", "Priority"]}
          rows={acceptance.map(([area, proof, priority]) => [
            area,
            <Text key={area} size="small">{proof}</Text>,
            <Pill active={priority === "P1"} key={priority + area}>{priority}</Pill>,
          ])}
          rowTone={["danger", "danger", "danger", "danger", "warning", "warning", "warning", "warning", "warning"]}
          striped
        />
      </Stack>

      <Card>
        <CardHeader trailing={<Pill size="sm">copy-ready</Pill>}>Follow-up implementation prompt</CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text size="small">
              Implement Phases 1 through 4 of the production-hardening plan for this HVAC receptionist. Start from the current clean main branch and create small, reviewable commits. Do not modify the voice-provider setup, add a third-party identity provider, or deploy until the implementation and tests are complete.
            </Text>
            <Text size="small">
              First replace ephemeral production SQLite with managed PostgreSQL and repeatable migrations; make engine configuration dialect-aware and preserve the partial booked-slot uniqueness behavior. Then remove anonymous appointment lookup from every tool path, centralize strict ten-digit NANP phone validation, enforce maximum history-item counts and character limits at the request boundary, and enforce server-side rate limits before any LLM invocation. Trust forwarded IP headers only when a trusted proxy is explicitly configured.
            </Text>
            <Text size="small">
              Next repair speech chunking by protecting time expressions and other spoken values before sentence splitting. Do not finalize a mobile call merely because the document becomes hidden; support suspension and recovery with a bounded grace period. Move TTS text out of query strings and prevent public caching of user-specific audio. Finally, make every voice challenger executable from the default frontend test command and ensure the optional LiveKit route cannot create bookings outside the deterministic server booking state machine.
            </Text>
            <Text size="small">
              Add focused regression tests for each requirement. Report changed files, design decisions, test commands and results, any migration or deployment action that still needs human approval, and explicitly confirm that no appointment detail can be disclosed from a phone number alone.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Row gap={8} wrap>
        <Pill size="sm">No production edits made by this plan</Pill>
        <Pill size="sm">Deploy only after staging proof</Pill>
        <Pill size="sm">Preserve current prompt and booking architecture</Pill>
      </Row>
    </Stack>
  );
}
