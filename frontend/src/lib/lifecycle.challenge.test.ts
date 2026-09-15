/**
 * Adversarial Verification Suite: Android Lifecycle & Keepalive Finalization
 *
 * Simulates and verifies:
 * 1. Rapid succession of visibilitychange (hidden) + pagehide
 * 2. Rapid succession of handleEndCall + pagehide / visibilitychange
 * 3. Component unmount race conditions
 * 4. Fetch keepalive execution and payload verification
 * 5. Fetch synchronous throw (e.g. 64KB keepalive limit) and sendBeacon fallback
 * 6. Fetch asynchronous rejection behavior (network offline / unhandled rejection audit)
 * 7. Truncation of rawSummary at 3000 chars and empty-transcript fallback
 * 8. Telemetry payload verification: end_reason="page_unload", platform_class, browser_engine
 * 9. Schema alignment with backend EndCallRequest
 */

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ClientTelemetry {
  platform_class: "mobile" | "desktop";
  browser_engine: "chromium" | "webkit" | "gecko" | "unknown";
  input_path: string;
  mic_permission: string;
  first_assistant_audio_ms?: number | null;
  first_caller_transcript_ms?: number | null;
  echo_suppressions?: number;
  stt_errors?: number;
  tts_errors?: number;
  end_reason?: string;
}

interface EndCallPayload {
  session_id: string;
  call_id: number;
  call_secret: string;
  outcome: string;
  summary: string;
  client_telemetry: ClientTelemetry;
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ FAIL: ${testName} ${detail ? " - " + detail : ""}`);
  }
}

/**
 * Replicates the exact lifecycle finalizer logic from
 * frontend/src/components/ui/kokoro-call-session.tsx (Lines 546-606)
 */
class MockKokoroLifecycleHarness {
  callIdRef: { current: number | null } = { current: 101 };
  callEndRequestedRef: { current: boolean } = { current: false };
  endReasonRef: { current: string } = { current: "caller_hangup" };
  transcriptHistoryRef: { current: ChatMessage[] } = { current: [] };
  sessionIdRef: { current: string } = { current: "sess-test-123" };
  callSecretRef: { current: string } = { current: "secret-01234567890123456789012345678901" };
  callOutcomeRef: { current: string } = { current: "info_only" };

  // Track dispatches
  fetchDispatches: Array<{ url: string; options: any; parsedBody: EndCallPayload }> = [];
  beaconDispatches: Array<{ url: string; data: any; parsedBody: EndCallPayload }> = [];
  unhandledRejections: any[] = [];

  // Configurable mock behaviors
  mockFetchBehavior: "success" | "throw_sync" | "reject_async" = "success";
  mockBeaconBehavior: "success" | "unavailable" | "return_false" = "success";

  apiUrl(path: string): string {
    return `http://localhost:8000${path}`;
  }

  getFullTelemetry(): ClientTelemetry {
    return {
      platform_class: "mobile",
      browser_engine: "chromium",
      input_path: "native_web_speech",
      mic_permission: "granted",
      first_assistant_audio_ms: 850,
      first_caller_transcript_ms: 1900,
      echo_suppressions: 0,
      stt_errors: 0,
      tts_errors: 0,
      end_reason: this.endReasonRef.current,
    };
  }

  visibilityGraceTimer: any = null;

  handleVisibilityChange = (state: "hidden" | "visible") => {
    if (state === "hidden") {
      if (!this.visibilityGraceTimer && !this.callEndRequestedRef.current) {
        this.visibilityGraceTimer = setTimeout(() => {
          this.visibilityGraceTimer = null;
          this.handleFinalize("page_unload");
        }, 45000);
      }
    } else if (state === "visible") {
      if (this.visibilityGraceTimer) {
        clearTimeout(this.visibilityGraceTimer);
        this.visibilityGraceTimer = null;
      }
    }
  };

  handlePageHide = () => {
    if (this.visibilityGraceTimer) {
      clearTimeout(this.visibilityGraceTimer);
      this.visibilityGraceTimer = null;
    }
    this.handleFinalize("page_unload");
  };

  // Exact reproduction of handleFinalize from kokoro-call-session.tsx
  handleFinalize = (reason: string = "page_unload") => {
    if (this.visibilityGraceTimer) {
      clearTimeout(this.visibilityGraceTimer);
      this.visibilityGraceTimer = null;
    }
    const callId = this.callIdRef.current;
    if (callId && !this.callEndRequestedRef.current) {
      this.callEndRequestedRef.current = true;
      this.endReasonRef.current = reason;

      const rawSummary = this.transcriptHistoryRef.current
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      const safeSummary = rawSummary
        ? rawSummary.slice(0, 3000)
        : "Call terminated due to page unload";

      const telemetryPayload = this.getFullTelemetry();
      telemetryPayload.end_reason = reason;

      const payload = JSON.stringify({
        session_id: this.sessionIdRef.current,
        call_id: callId,
        call_secret: this.callSecretRef.current,
        outcome: this.callOutcomeRef.current,
        summary: safeSummary,
        client_telemetry: telemetryPayload,
      });

      // 1. Primary: fetch with keepalive: true (supports JSON body and cross-origin CORS safely)
      try {
        void this.mockFetch(this.apiUrl("/v1/calls/end"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        });
      } catch {
        // 2. Fallback: navigator.sendBeacon
        if (this.mockBeaconBehavior !== "unavailable") {
          this.mockSendBeacon(
            this.apiUrl("/v1/calls/end"),
            new Blob([payload], { type: "application/json" })
          );
        }
      }
    }
  };

  mockFetch = (url: string, options: any): Promise<any> => {
    if (this.mockFetchBehavior === "throw_sync") {
      throw new TypeError("Failed to execute 'fetch' on 'Window': The total amount of data in pending keepalive requests exceeds 64KB.");
    }
    const parsed = JSON.parse(options.body);
    this.fetchDispatches.push({ url, options, parsedBody: parsed });

    if (this.mockFetchBehavior === "reject_async") {
      return Promise.reject(new TypeError("Failed to fetch (network error)"));
    }
    return Promise.resolve({ ok: true, status: 200 });
  };

  mockSendBeacon = (url: string, data: any): boolean => {
    let text = "";
    if (typeof data?.text === "function") {
      // Blob in Node environment or mock
    }
    // We can parse the blob string or extract data
    let parsed: any;
    try {
      // In node, if data is Blob, simulate string representation
      parsed = JSON.parse(data);
    } catch {
      // fallback mock payload store
      parsed = JSON.parse(this.fetchDispatches[0]?.options.body || "{}");
    }
    this.beaconDispatches.push({ url, data, parsedBody: parsed });
    return this.mockBeaconBehavior === "return_false" ? false : true;
  };
}

async function runAdversarialLifecycleTests() {
  console.log("=================================================================");
  console.log("STARTING EMPIRICAL ADVERSARIAL CHALLENGE: LIFECYCLE & KEEPALIVE");
  console.log("=================================================================\n");

  // SUITE 1: Rapid Succession of visibilitychange and pagehide
  console.log("--- SUITE 1: Rapid Succession & Duplicate Prevention ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    assert(!harness.callEndRequestedRef.current, "Initial callEndRequestedRef is false");

    // Rapid event 1: visibilitychange (hidden)
    let visibilityState = "hidden";
    if (visibilityState === "hidden") {
      harness.handleFinalize();
    }

    // Rapid event 2: pagehide immediately in same or next tick
    harness.handleFinalize();

    // Rapid event 3: second visibilitychange (e.g. system retry or OS notification)
    if (visibilityState === "hidden") {
      harness.handleFinalize();
    }

    assert(harness.callEndRequestedRef.current === true, "callEndRequestedRef is true after finalize");
    assert(harness.fetchDispatches.length === 1, "Exactly 1 fetch dispatch occurs despite 3 rapid firing events");
    assert(harness.endReasonRef.current === "page_unload", "endReason set to page_unload");
  }

  // SUITE 2: Reverse Succession: pagehide then visibilitychange
  console.log("\n--- SUITE 2: Reverse Succession (pagehide then visibilitychange) ---");
  {
    const harness = new MockKokoroLifecycleHarness();

    // Event 1: pagehide
    harness.handleFinalize();
    // Event 2: visibilitychange (hidden)
    harness.handleFinalize();

    assert(harness.fetchDispatches.length === 1, "Exactly 1 fetch dispatch when pagehide fires before visibilitychange");
  }

  // SUITE 3: User Hangup followed by visibilitychange / pagehide
  console.log("\n--- SUITE 3: User Hangup race with pagehide ---");
  {
    const harness = new MockKokoroLifecycleHarness();

    // User taps "End Call"
    // handleEndCall logic:
    if (!harness.callEndRequestedRef.current) {
      harness.callEndRequestedRef.current = true;
      harness.endReasonRef.current = "caller_hangup";
      // simulates user hangup dispatch
      harness.fetchDispatches.push({
        url: harness.apiUrl("/v1/calls/end"),
        options: {},
        parsedBody: {
          session_id: harness.sessionIdRef.current,
          call_id: harness.callIdRef.current!,
          call_secret: harness.callSecretRef.current,
          outcome: harness.callOutcomeRef.current,
          summary: "User hung up",
          client_telemetry: { ...harness.getFullTelemetry(), end_reason: "caller_hangup" },
        },
      });
    }

    // User closes browser immediately after tapping End Call
    harness.handleFinalize();

    assert(harness.fetchDispatches.length === 1, "No duplicate /v1/calls/end sent on pagehide after user hangup");
    assert(harness.fetchDispatches[0].parsedBody.client_telemetry.end_reason === "caller_hangup", "Original user hangup reason preserved");
  }

  // SUITE 4: Unload before Call Connected (callId is null)
  console.log("\n--- SUITE 4: Pre-connection unload (callId === null) ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    harness.callIdRef.current = null; // call has not yet received call_started event

    harness.handleFinalize();

    assert(harness.fetchDispatches.length === 0, "No network request sent when callId is null");
    assert(harness.callEndRequestedRef.current === false, "callEndRequestedRef remains false so later start can proceed or cleanly abort");
  }

  // SUITE 5: Fetch Throws Synchronously (Keepalive Quota Exceeded / TypeError) -> sendBeacon Fallback
  console.log("\n--- SUITE 5: Synchronous Fetch Throw -> sendBeacon Fallback ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    harness.mockFetchBehavior = "throw_sync"; // Throws TypeError

    let threw = false;
    try {
      harness.handleFinalize();
    } catch {
      threw = true;
    }

    assert(!threw, "handleFinalize does NOT crash caller when fetch throws synchronously");
    assert(harness.beaconDispatches.length === 1, "sendBeacon fallback caught synchronous fetch error and dispatched");
  }

  // SUITE 6: Fetch Throws Synchronously AND sendBeacon is Unavailable
  console.log("\n--- SUITE 6: Synchronous Fetch Throw + sendBeacon Unavailable ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    harness.mockFetchBehavior = "throw_sync";
    harness.mockBeaconBehavior = "unavailable";

    let threw = false;
    try {
      harness.handleFinalize();
    } catch {
      threw = true;
    }

    assert(!threw, "handleFinalize handles degraded environment with no fetch and no sendBeacon without crashing");
  }

  // SUITE 7: Fetch Rejects Asynchronously (Network Drop / Timeout)
  console.log("\n--- SUITE 7: Asynchronous Fetch Rejection Behavior ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    harness.mockFetchBehavior = "reject_async";

    // In kokoro-call-session.tsx:
    // try {
    //   void fetch(apiUrl("/v1/calls/end"), { ... keepalive: true });
    // } catch { ... }
    // When fetch returns a rejected Promise, does synchronous try...catch catch it?
    let syncCaught: boolean = false;
    let promiseCaught: boolean = false;

    // Simulate exact code
    try {
      const p = harness.mockFetch(harness.apiUrl("/v1/calls/end"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: 1 }),
        keepalive: true,
      });
    // The code uses: void fetch(...);
    // It does NOT attach .catch()
    void p;
    const catchPromise = p.catch(() => {
      promiseCaught = true;
    });
    await catchPromise;
  } catch {
    syncCaught = true;
  }

    assert(Boolean(syncCaught) === false, "sync catch cannot intercept asynchronous promise rejection (Fundamental JS behavior)");
    assert(Boolean(promiseCaught) === true, "async rejection only intercepted if .catch() is attached to the promise");
  }

  // SUITE 8: Payload Truncation & Telemetry
  console.log("\n--- SUITE 8: Payload Truncation & Telemetry Verification ---");
  {
    // 8.1 Empty transcript
    const harness1 = new MockKokoroLifecycleHarness();
    harness1.transcriptHistoryRef.current = [];
    harness1.handleFinalize();

    const p1 = harness1.fetchDispatches[0].parsedBody;
    assert(p1.summary === "Call terminated due to page unload", "Empty transcript defaults to safe fallback summary");
    assert(p1.client_telemetry.end_reason === "page_unload", "client_telemetry.end_reason is 'page_unload'");
    assert(p1.client_telemetry.platform_class === "mobile", "platform_class is 'mobile'");
    assert(p1.client_telemetry.browser_engine === "chromium", "browser_engine is 'chromium'");
    assert(p1.client_telemetry.input_path === "native_web_speech", "input_path is 'native_web_speech'");
    assert(p1.client_telemetry.mic_permission === "granted", "mic_permission is 'granted'");

    // 8.2 Huge transcript > 10,000 chars
    const harness2 = new MockKokoroLifecycleHarness();
    const longText = "A".repeat(8000);
    harness2.transcriptHistoryRef.current = [
      { role: "user", content: longText },
      { role: "assistant", content: longText },
    ];
    harness2.handleFinalize();

    const p2 = harness2.fetchDispatches[0].parsedBody;
    assert(p2.summary.length === 3000, `Massive 16,000-char transcript truncated to exactly 3000 chars (got ${p2.summary.length})`);
    assert(p2.summary.startsWith("user: AAAAA"), "Summary starts with user transcript");

    // 8.3 Moderate transcript < 3000 chars
    const harness3 = new MockKokoroLifecycleHarness();
    harness3.transcriptHistoryRef.current = [
      { role: "assistant", content: "Hello, thanks for calling Apex HVAC." },
      { role: "user", content: "My AC is blowing warm air and making a rattling sound." },
      { role: "assistant", content: "I can help with that. Let's get an emergency technician dispatched." }
    ];
    harness3.handleFinalize();

    const p3 = harness3.fetchDispatches[0].parsedBody;
    const expectedSummary = [
      "assistant: Hello, thanks for calling Apex HVAC.",
      "user: My AC is blowing warm air and making a rattling sound.",
      "assistant: I can help with that. Let's get an emergency technician dispatched."
    ].join("\n");
    assert(p3.summary === expectedSummary, "Moderate transcript preserved in its entirety without alteration");
  }

  // SUITE 9: Backend EndCallRequest Schema Alignment Audit
  console.log("\n--- SUITE 9: Backend EndCallRequest Schema Alignment ---");
  {
    const harness = new MockKokoroLifecycleHarness();
    harness.handleFinalize();
    const payload = harness.fetchDispatches[0].parsedBody;

    // Backend app/chat_api.py:
    // class EndCallRequest(BaseModel):
    //     session_id: str = Field(max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    //     call_id: int = Field(ge=1)
    //     call_secret: str = Field(min_length=32, max_length=128)
    //     outcome: str = Field(default="info_only", pattern="^(booked|info_only)$")
    //     summary: str | None = Field(default=None, max_length=50_000)
    //     client_telemetry: ClientTelemetry | None = None

    const sessionIdPattern = /^[a-zA-Z0-9_-]+$/;
    assert(sessionIdPattern.test(payload.session_id) && payload.session_id.length <= 64, "session_id complies with backend regex & max_length");
    assert(typeof payload.call_id === "number" && payload.call_id >= 1, "call_id is integer >= 1");
    assert(payload.call_secret.length >= 32 && payload.call_secret.length <= 128, "call_secret complies with min_length 32 & max_length 128");
    assert(payload.outcome === "booked" || payload.outcome === "info_only", "outcome matches backend enum pattern");
    assert(payload.summary.length <= 50000, "summary is within backend 50k limit (and bounded by 3000 char frontend clamp)");
    assert(payload.client_telemetry !== null && typeof payload.client_telemetry === "object", "client_telemetry is present object");
  }

  // SUITE 10: Mobile Visibility Grace Period & Suspension
  console.log("\n--- SUITE 10: Mobile Visibility Grace Period (45s) & Suspension ---");
  {
    const harness = new MockKokoroLifecycleHarness();

    // 10.1: Switching away (visibility hidden) does NOT immediately terminate the call
    harness.handleVisibilityChange("hidden");
    assert(harness.visibilityGraceTimer !== null, "Grace timer is scheduled when document hidden");
    assert(!harness.callEndRequestedRef.current, "Call is NOT terminated immediately on visibility hidden");
    assert(harness.fetchDispatches.length === 0, "No /v1/calls/end request sent during initial suspension");

    // 10.2: Switching back (visibility visible) cancels the grace timer
    harness.handleVisibilityChange("visible");
    assert(harness.visibilityGraceTimer === null, "Grace timer cancelled when document becomes visible again");
    assert(!harness.callEndRequestedRef.current, "Call remains active and alive after returning from background");
    assert(harness.fetchDispatches.length === 0, "Zero disconnect requests dispatched for brief app switches");

    // 10.3: Switching away followed by pagehide triggers immediate finalization and cancels timer
    harness.handleVisibilityChange("hidden");
    assert(harness.visibilityGraceTimer !== null, "Grace timer started on second hidden event");
    harness.handlePageHide();
    assert(harness.visibilityGraceTimer === null, "Grace timer cancelled when pagehide occurs");
    assert(harness.callEndRequestedRef.current === true, "Call finalized immediately on pagehide");
    assert(harness.fetchDispatches.length === 1, "Exactly 1 disconnect request sent on terminal pagehide");
  }

  console.log("\n=================================================================");
  console.log(`TOTAL ADVERSARIAL TESTS: ${totalTests}, PASSED: ${passedTests}, FAILED: ${failedTests}`);
  console.log("=================================================================");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAdversarialLifecycleTests();
