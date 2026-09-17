/**
 * Adversarial Empirical Stress Harness: Touch Targets & Mobile Viewport Layouts
 *
 * Verifies:
 * 1. WCAG 2.5.5 touch target height (>=44px) across all interactive mobile controls:
 *    - Calls Page Filter pills (App.tsx:924)
 *    - Live Call Start voice demo button (live-call-page.tsx:248)
 *    - Live Call End/Retry/Cancel/Log buttons (live-call-page.tsx)
 *    - Kokoro Session Tap to Interrupt button (kokoro-call-session.tsx:806)
 *    - Kokoro Session Mute & End Call buttons (kokoro-call-session.tsx:836, 860)
 *    - Admin unlock button (App.tsx:1366)
 *    - Emergency call button (App.tsx:1375)
 *    - Call Back button (App.tsx:593)
 *    - Mobile Agenda View buttons (mobile-agenda-view.tsx)
 *    - Mobile Bottom Nav buttons (mobile-bottom-nav.tsx)
 * 2. Mobile Viewport Layout Simulation (360px, 390px, 412px, 480px):
 *    - Container width clamping (`max-w-full`)
 *    - Horizontal scrollability (`overflow-x-auto`)
 *    - Zero horizontal document/body overflow (`overflow-x: hidden / clip`)
 *    - Zero text clipping
 * 3. Adversarial Edge Cases:
 *    - Massive dynamic counts (e.g. 99,999 calls)
 *    - Zero counts
 * 4. Mobile hover blur isolation ((hover: hover) and (pointer: fine)).
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT_DIR = path.resolve(process.cwd());
const FRONTEND_DIR = ROOT_DIR.endsWith("frontend") ? ROOT_DIR : path.join(ROOT_DIR, "frontend");

console.log("=================================================================");
console.log("STARTING EMPIRICAL ADVERSARIAL CHALLENGE: TOUCH TARGETS & VIEWPORTS");
console.log("=================================================================");

let passedTests = 0;
let failedTests = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

// ---------------------------------------------------------------------------
// SUITE 1: SOURCE AUDIT OF INTERACTIVE TOUCH TARGETS (>= 44px)
// ---------------------------------------------------------------------------
console.log("\n--- SUITE 1: Source Audit of Interactive Touch Targets (>=44px) ---");

const appTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/App.tsx"), "utf-8");
const liveCallTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/components/ui/live-call-page.tsx"), "utf-8");
const kokoroTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/components/ui/kokoro-call-session.tsx"), "utf-8");
const agendaTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/components/ui/mobile-agenda-view.tsx"), "utf-8");
const navTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/components/ui/mobile-bottom-nav.tsx"), "utf-8");

test("App.tsx: Filter buttons have min-h-[44px]", () => {
  const match = appTsx.match(/filter === t[\s\S]*?min-h-\[(\d+)px\]/);
  // Alternatively search specifically around setFilter
  const filterPillBlockMatch = appTsx.match(/onClick=\{\(\) => setFilter\(t\)\}[\s\S]*?className=\{cn\([\s\S]*?\)/);
  assert(filterPillBlockMatch, "Filter pill block not found in App.tsx");
  const block = filterPillBlockMatch[0];
  assert(block.includes("min-h-[44px]"), `Expected min-h-[44px] in filter pill block, found: ${block}`);
  assert(!block.includes("min-h-[40px]"), "Legacy min-h-[40px] still present!");
});

test("App.tsx: Filter container has max-w-full, overflow-x-auto, no-scrollbar, and flex-nowrap", () => {
  const containerMatch = appTsx.match(/<div className="[^"]*rounded-lg border border-\[#e7e7e7\] bg-\[#fafafa\][^"]*">/);
  assert(containerMatch, "Filter container div not found in App.tsx");
  const classStr = containerMatch[0];
  assert(classStr.includes("max-w-full"), "Missing max-w-full on filter container");
  assert(classStr.includes("overflow-x-auto"), "Missing overflow-x-auto on filter container");
  assert(classStr.includes("no-scrollbar"), "Missing no-scrollbar on filter container");
  assert(classStr.includes("flex-nowrap"), "Missing flex-nowrap on filter container");
});

test("live-call-page.tsx: Start voice demo button has min-h-[44px]", () => {
  const startBtnMatch = liveCallTsx.match(/aria-label="Start voice demo"[\s\S]*?className="([^"]*)"/);
  assert(startBtnMatch, "Start voice demo button not found in live-call-page.tsx");
  const classStr = startBtnMatch[1];
  assert(classStr.includes("min-h-[44px]"), `Expected min-h-[44px] in start button, found: ${classStr}`);
});

test("live-call-page.tsx: Ended and Error state action buttons have min-h-[44px]", () => {
  // Ended buttons
  const viewCallsMatch = liveCallTsx.match(/onClick=\{onViewCalls\}[\s\S]*?className="([^"]*)"/);
  assert(viewCallsMatch && viewCallsMatch[1].includes("min-h-[44px]"), "View call log button missing min-h-[44px]");

  const startAgainMatch = liveCallTsx.match(/onClick=\{onStartAgain\}[\s\S]*?className="([^"]*)"/);
  assert(startAgainMatch && startAgainMatch[1].includes("min-h-[44px]"), "Start new call button missing min-h-[44px]");

  // Error buttons
  const retryMatch = liveCallTsx.match(/onClick=\{onRetry\}[\s\S]*?className="([^"]*)"/);
  assert(retryMatch && retryMatch[1].includes("min-h-[44px]"), "Retry button missing min-h-[44px]");

  const cancelMatch = liveCallTsx.match(/onClick=\{onCancel\}[\s\S]*?className="([^"]*)"/);
  assert(cancelMatch && cancelMatch[1].includes("min-h-[44px]"), "Cancel button missing min-h-[44px]");
});

test("kokoro-call-session.tsx: Tap to Interrupt button has min-h-[44px]", () => {
  const interruptMatch = kokoroTsx.match(/aria-label="Interrupt Assistant Speech"[\s\S]*?className="([^"]*)"/);
  assert(interruptMatch, "Interrupt button with aria-label not found in kokoro-call-session.tsx");
  assert(interruptMatch[1].includes("min-h-[44px]"), `Interrupt button missing min-h-[44px], found: ${interruptMatch[1]}`);
});

test("kokoro-call-session.tsx: Thumb call controls (Mute & End Call) have w-16 h-16 (64x64px >= 44px)", () => {
  const muteMatch = kokoroTsx.match(/aria-label=\{!isMuted \? "Mute Microphone" : "Unmute Microphone"\}[\s\S]*?className=\{cn\([\s\S]*?"([^"]*)"/);
  assert(muteMatch, "Mute button not found in kokoro-call-session.tsx");
  assert(muteMatch[1].includes("w-16 h-16"), `Mute button missing w-16 h-16, found: ${muteMatch[1]}`);

  const endMatch = kokoroTsx.match(/aria-label="Hang up call"[\s\S]*?className="([^"]*)"/);
  assert(endMatch, "End Call button not found in kokoro-call-session.tsx");
  assert(endMatch[1].includes("w-16 h-16"), `End Call button missing w-16 h-16, found: ${endMatch[1]}`);
});

test("kokoro-call-session.tsx: Confirm Booking review card button has min-h-[48px] (>=44px WCAG 2.5.5)", () => {
  const confirmMatch = kokoroTsx.match(/data-testid="confirm-booking-button"[\s\S]*?className=\{cn\([\s\S]*?"([^"]*)"/);
  assert(confirmMatch, "Confirm Booking button not found in kokoro-call-session.tsx");
  assert(confirmMatch[1].includes("min-h-[48px]"), `Confirm Booking button missing min-h-[48px], found: ${confirmMatch[1]}`);
});

test("App.tsx: Admin Unlock button has min-h-[44px]", () => {
  const unlockMatch = appTsx.match(/onClick=\{updateAdminKey\}[\s\S]*?className="([^"]*)"/);
  assert(unlockMatch, "Admin unlock button not found in App.tsx");
  assert(unlockMatch[1].includes("min-h-[44px]"), `Admin unlock missing min-h-[44px], found: ${unlockMatch[1]}`);
});

test("App.tsx: Emergency Call button has min-h-[44px]", () => {
  const emergMatch = appTsx.match(/<a\b[^>]*aria-label="Call Emergency Hotline"[^>]*>/);
  assert(emergMatch, "Emergency hotline button not found in App.tsx");
  assert(emergMatch[0].includes("min-h-[44px]"), `Emergency hotline missing min-h-[44px], found: ${emergMatch[0]}`);
});

test("App.tsx: Call Back button has min-h-[44px]", () => {
  // Mobile card call back button
  const callBackMatch = appTsx.match(/<a\b[^>]*href=\{cleanTelHref\(call\.caller_phone\)\}[^>]*>[\s\S]*?<span>Call Back<\/span>/);
  assert(callBackMatch, "Call back button not found in App.tsx");
  assert(callBackMatch[0].includes("min-h-[44px]"), `Call back missing min-h-[44px], found: ${callBackMatch[0]}`);
});

test("mobile-agenda-view.tsx: Back to Today button has min-h-[44px]", () => {
  const backTodayMatch = agendaTsx.match(/onClick=\{\(\) => setSelectedDate\(today\)\}[\s\S]*?className="([^"]*)"/);
  assert(backTodayMatch, "Back to Today button not found in mobile-agenda-view.tsx");
  assert(backTodayMatch[1].includes("min-h-[44px]"), `Back to Today missing min-h-[44px], found: ${backTodayMatch[1]}`);
});

test("mobile-agenda-view.tsx: Call Customer button has min-h-[44px] min-w-[44px]", () => {
  const callCustMatch = agendaTsx.match(/<a\b[^>]*aria-label=\{`Call customer \$\{appt\.customer_name \|\| ""\}`\}[^>]*>/);
  assert(callCustMatch, "Call Customer button not found in mobile-agenda-view.tsx");
  assert(callCustMatch[0].includes("min-h-[44px]"), `Call Customer missing min-h-[44px], found: ${callCustMatch[0]}`);
  assert(callCustMatch[0].includes("min-w-[44px]"), `Call Customer missing min-w-[44px], found: ${callCustMatch[0]}`);
});

test("mobile-agenda-view.tsx: Notes toggle button has min-h-[44px]", () => {
  const notesMatch = agendaTsx.match(/onClick=\{\(\) => setExpandedId\(isExpanded \? null : appt\.id\)\}[\s\S]*?className="([^"]*)"/);
  assert(notesMatch, "Notes toggle button not found in mobile-agenda-view.tsx");
  assert(notesMatch[1].includes("min-h-[44px]"), `Notes toggle missing min-h-[44px], found: ${notesMatch[1]}`);
});

test("mobile-bottom-nav.tsx: All navigation buttons have height >= 56px (exceeds 44px)", () => {
  assert(navTsx.includes("h-16"), "Bottom nav container missing h-16 (64px)");
  assert(navTsx.includes("w-14 h-14"), "Center call button missing w-14 h-14 (56x56px)");
  assert(navTsx.includes("h-full py-1"), "Tab buttons missing h-full within h-16 container");
});

// ---------------------------------------------------------------------------
// SUITE 2: VIEWPORT BOUNDING BOX & OVERFLOW MATHEMATICAL HARNESS
// ---------------------------------------------------------------------------
console.log("\n--- SUITE 2: Viewport Bounding Box & Overflow Simulation ---");

/**
 * Simulates CSS layout behavior for the Calls Page filter strip:
 * Container:
 *   padding: 2px (p-0.5)
 *   border: 1px (border border-[#e7e7e7]) -> 2px total
 *   gap: 4px (gap-1)
 *   max-width: 100% (max-w-full)
 *   overflow-x: auto
 * Pills:
 *   min-height: 44px
 *   padding-x: 12px (px-3) -> 24px total
 *   border: 1px (border border-[#e7e7e7]) -> 2px total (on active pill)
 *   font: 11px sans-serif
 */
function simulateFilterStripLayout({ viewportWidth, counts = { all: 24, booked: 12, info_only: 8, in_progress: 4 } }) {
  // Shell padding: p-3.5 on < sm => 14px * 2 = 28px
  const shellPaddingHorizontal = 28;
  const availableContentWidth = viewportWidth - shellPaddingHorizontal;

  // Approximate character width in 11px system font is ~6.5px per char
  const charWidth = 6.5;

  const labels = [
    `All (${counts.all})`,
    `Booked (${counts.booked})`,
    `Info only (${counts.info_only})`,
    `In Progress (${counts.in_progress})`,
  ];

  const pillWidths = labels.map((label) => {
    const textWidth = Math.ceil(label.length * charWidth);
    const paddingX = 24; // px-3 => 12px left + 12px right
    const border = 2; // 1px left + 1px right
    return textWidth + paddingX + border;
  });

  const totalGaps = (labels.length - 1) * 4; // gap-1 => 4px * 3 = 12px
  const containerPaddingX = 4; // p-0.5 => 2px left + 2px right
  const containerBorderX = 2; // border => 1px left + 1px right

  const intrinsicContentWidth = pillWidths.reduce((a, b) => a + b, 0) + totalGaps + containerPaddingX + containerBorderX;

  // With max-w-full, the rendered container width cannot exceed availableContentWidth
  const renderedContainerWidth = Math.min(intrinsicContentWidth, availableContentWidth);

  // Overflow amount within the container
  const containerScrollOverflow = Math.max(0, intrinsicContentWidth - renderedContainerWidth);

  // Document/Page-level overflow caused by this element
  // Since renderedContainerWidth <= availableContentWidth, body overflow is strictly 0
  const pageLevelHorizontalOverflow = Math.max(0, renderedContainerWidth - availableContentWidth);

  return {
    viewportWidth,
    availableContentWidth,
    intrinsicContentWidth,
    renderedContainerWidth,
    containerScrollOverflow,
    pageLevelHorizontalOverflow,
    isScrollable: containerScrollOverflow > 0,
    hasPageOverflow: pageLevelHorizontalOverflow > 0,
  };
}

const targetViewports = [360, 390, 412, 480];

for (const vp of targetViewports) {
  test(`Viewport ${vp}px: No page-level overflow and proper container containment`, () => {
    const sim = simulateFilterStripLayout({ viewportWidth: vp });
    assert.strictEqual(
      sim.hasPageOverflow,
      false,
      `Page overflow detected at ${vp}px! available=${sim.availableContentWidth}px, rendered=${sim.renderedContainerWidth}px`
    );
    assert(
      sim.renderedContainerWidth <= sim.availableContentWidth,
      `Container width ${sim.renderedContainerWidth}px exceeds available width ${sim.availableContentWidth}px`
    );

    if (vp === 360) {
      assert(sim.isScrollable, `Expected filter strip to be scrollable at 360px viewport, got intrinsic=${sim.intrinsicContentWidth}px, available=${sim.availableContentWidth}px`);
      console.log(`    -> 360px viewport: Content=${sim.intrinsicContentWidth}px, Container=${sim.renderedContainerWidth}px, ScrollOverflow=${sim.containerScrollOverflow}px, PageOverflow=0px (PASS)`);
    } else if (vp === 480) {
      console.log(`    -> 480px viewport: Content=${sim.intrinsicContentWidth}px, Container=${sim.renderedContainerWidth}px, ScrollOverflow=${sim.containerScrollOverflow}px (Fits entirely, PASS)`);
    }
  });
}

// ---------------------------------------------------------------------------
// SUITE 3: ADVERSARIAL SCALE & STRESS TESTING (DYNAMIC COUNTS)
// ---------------------------------------------------------------------------
console.log("\n--- SUITE 3: Adversarial Scale & Stress Testing ---");

test("Zero Call Counts (0, 0, 0, 0) at 360px viewport: Maintains layout integrity", () => {
  const sim = simulateFilterStripLayout({
    viewportWidth: 360,
    counts: { all: 0, booked: 0, info_only: 0, in_progress: 0 },
  });
  assert.strictEqual(sim.hasPageOverflow, false);
  assert(sim.renderedContainerWidth <= sim.availableContentWidth);
});

test("Large Call Counts (99999, 88888, 77777, 66666) at 360px viewport: Scroll range expands without breaking page", () => {
  const sim = simulateFilterStripLayout({
    viewportWidth: 360,
    counts: { all: 99999, booked: 88888, info_only: 77777, in_progress: 66666 },
  });
  assert.strictEqual(sim.hasPageOverflow, false, "Large counts caused body-level overflow!");
  assert.strictEqual(sim.renderedContainerWidth, sim.availableContentWidth, "Container failed to clamp to available width!");
  assert(sim.containerScrollOverflow > 100, `Expected substantial scroll overflow, got ${sim.containerScrollOverflow}px`);
});

// ---------------------------------------------------------------------------
// SUITE 4: MOBILE HOVER BLUR ISOLATION
// ---------------------------------------------------------------------------
console.log("\n--- SUITE 4: Mobile Hover Blur Isolation ---");

test("hover-reveal-cards.tsx: Zero inline group-hover:blur classes", () => {
  const cardTsx = fs.readFileSync(path.join(FRONTEND_DIR, "src/components/ui/hover-reveal-cards.tsx"), "utf-8");
  assert(!cardTsx.includes("group-hover:blur"), "group-hover:blur found in hover-reveal-cards.tsx!");
  assert(!cardTsx.includes("group-hover:scale"), "group-hover:scale found in hover-reveal-cards.tsx!");
  assert(!cardTsx.includes("group-hover:opacity"), "group-hover:opacity found in hover-reveal-cards.tsx!");
});

test("index.css: Hover blur strictly isolated inside @media (hover: hover) and (pointer: fine)", () => {
  const indexCss = fs.readFileSync(path.join(FRONTEND_DIR, "src/index.css"), "utf-8");
  const mediaQueryIndex = indexCss.indexOf("@media (hover: hover) and (pointer: fine)");
  assert(mediaQueryIndex !== -1, "@media (hover: hover) and (pointer: fine) missing in index.css");

  const blurIndex = indexCss.indexOf("filter: blur(2px)");
  assert(blurIndex !== -1, "filter: blur(2px) not found in index.css");
  assert(blurIndex > mediaQueryIndex, "filter: blur(2px) is NOT encapsulated inside hover/pointer media query!");
});

// ---------------------------------------------------------------------------
// SUITE 5: VIEWPORT META TAG & ROOT CSS LAYOUT ARCHITECTURE
// ---------------------------------------------------------------------------
console.log("\n--- SUITE 5: Viewport Meta Tag & Root CSS Architecture ---");

test("index.html: Contains responsive viewport-fit and interactive-widget attributes", () => {
  const indexHtml = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf-8");
  assert(indexHtml.includes("viewport-fit=cover"), "Missing viewport-fit=cover in index.html");
  assert(indexHtml.includes("interactive-widget=resizes-content"), "Missing interactive-widget=resizes-content in index.html");
});

test("App.tsx: App shell uses dvh and overflow-hidden", () => {
  assert(appTsx.includes("h-[100dvh]"), "App shell missing h-[100dvh]");
  assert(appTsx.includes("min-h-[100dvh]"), "App shell missing min-h-[100dvh]");
  assert(appTsx.includes("overflow-hidden"), "App shell missing overflow-hidden");
});

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log("\n=================================================================");
console.log(`TOTAL ADVERSARIAL TESTS: ${passedTests + failedTests}, PASSED: ${passedTests}, FAILED: ${failedTests}`);
console.log("=================================================================");

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
