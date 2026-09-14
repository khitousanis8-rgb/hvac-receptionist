/**
 * Comprehensive Adversarial Empirical Test Suite for frontend/src/lib/telemetry.ts
 *
 * Tests edge cases across diverse simulated browser environments:
 * 1. Client Hints (mobile=true, mobile=false, missing mobile)
 * 2. Touchscreen laptops (fine pointer + hover capable + touch points > 1 -> desktop)
 * 3. Mobile phones (coarse pointer + no hover + small screen -> mobile)
 * 4. Tablets (coarse pointer + touch points > 1 -> mobile)
 * 5. Foldables / Mini touchscreens (small screen + touch points > 1 -> mobile)
 * 6. Standard PC Desktops (fine pointer + hover + 0 touch points -> desktop)
 * 7. Browser engine detection (Chromium brands, window.chrome, Safari window/vendor/-webkit-touch-callout/webkitAudioContext, Firefox InstallTrigger/-moz-appearance, Unknown fallback)
 * 8. Permissions API graceful fallback (unavailable, throwing sync, rejecting async, prompt, granted, denied)
 * 9. Poisoned navigator.userAgent sentinel (strict privacy guarantee across all APIs)
 * 10. Degraded environments (missing matchMedia, missing CSS.supports, corrupted userAgentData)
 * 11. SSR / Headless environment (window is undefined)
 */

import {
  detectPlatformClass,
  detectBrowserEngine,
  queryMicPermission,
} from "./telemetry.ts";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      results.push({ name, passed: true });
      console.log(`PASS: ${name}`);
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, error: errorMsg });
      console.error(`FAIL: ${name} -> ${errorMsg}`);
    });
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected '${expected}', got '${actual}'`);
  }
}

// Setup a clean global environment helper
function setupMockEnv(options: {
  userAgentData?: any;
  maxTouchPoints?: number;
  matchMedia?: any;
  matchMediaQueries?: Record<string, boolean>;
  chrome?: unknown;
  safari?: unknown;
  webkitAudioContext?: unknown;
  InstallTrigger?: unknown;
  vendor?: string;
  cssSupports?: Record<string, boolean> | null;
  noCSS?: boolean;
  permissionsQuery?: ((desc: { name: string }) => Promise<{ state: string }>) | null;
  noPermissions?: boolean;
  poisonUserAgent?: boolean;
}) {
  const globalAny = globalThis as any;

  // Mock CSS
  if (options.noCSS) {
    delete globalAny.CSS;
  } else if (options.cssSupports === null) {
    globalAny.CSS = {}; // no supports method
  } else {
    globalAny.CSS = {
      supports: (property: string, value?: string) => {
        const key = value ? `${property}:${value}` : property;
        return Boolean(options.cssSupports?.[key] ?? options.cssSupports?.[property]);
      },
    };
  }

  // Mock Navigator
  const navObj: Record<string, any> = {
    maxTouchPoints: options.maxTouchPoints,
    vendor: options.vendor ?? "",
  };

  if (options.userAgentData !== undefined) {
    navObj.userAgentData = options.userAgentData;
  }

  if (options.noPermissions) {
    navObj.permissions = undefined;
  } else if (options.permissionsQuery !== undefined) {
    if (options.permissionsQuery === null) {
      navObj.permissions = {}; // permissions object without query method
    } else {
      navObj.permissions = {
        query: options.permissionsQuery,
      };
    }
  } else {
    navObj.permissions = undefined;
  }

  if (options.poisonUserAgent) {
    Object.defineProperty(navObj, "userAgent", {
      get() {
        throw new Error("CRITICAL PRIVACY VIOLATION: navigator.userAgent was accessed!");
      },
      configurable: true,
      enumerable: true,
    });
  }

  // Mock Window
  let matchMediaFn = options.matchMedia;
  if (matchMediaFn === undefined) {
    matchMediaFn = (query: string) => ({
      matches: Boolean(options.matchMediaQueries?.[query]),
      media: query,
    });
  }

  globalAny.window = {
    navigator: navObj,
    matchMedia: matchMediaFn,
    chrome: options.chrome,
    safari: options.safari,
    webkitAudioContext: options.webkitAudioContext,
    InstallTrigger: options.InstallTrigger,
  };
}

async function runAllTests() {
  console.log("==================================================");
  console.log("STARTING ADVERSARIAL TELEMETRY VERIFICATION SUITE");
  console.log("==================================================\n");

  // SECTION 1: Client Hints Available
  await runTest("Client Hints: mobile = true classifies as 'mobile'", () => {
    setupMockEnv({
      userAgentData: { mobile: true },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "Client Hints mobile=true");
  });

  await runTest("Client Hints: mobile = false classifies as 'desktop'", () => {
    setupMockEnv({
      userAgentData: { mobile: false },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Client Hints mobile=false");
  });

  await runTest("Client Hints: non-boolean mobile falls through to media queries", () => {
    setupMockEnv({
      userAgentData: { mobile: "true" as any }, // string instead of boolean
      maxTouchPoints: 0,
      matchMediaQueries: {
        "(pointer: coarse)": false,
        "(hover: none)": false,
        "(max-width: 768px)": false,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Invalid client hint falls through to desktop media query");
  });

  // SECTION 2: Client Hints Missing (Safari, Firefox, Touchscreen Laptops, Mobiles)
  await runTest("Touchscreen Laptop: fine pointer + hover capable + touch points 10 -> 'desktop'", () => {
    setupMockEnv({
      maxTouchPoints: 10,
      matchMediaQueries: {
        "(pointer: coarse)": false,
        "(hover: none)": false,
        "(max-width: 768px)": false,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Touchscreen laptop must classify as desktop");
  });

  await runTest("Touchscreen Laptop with 20 touch points + 1080p screen -> 'desktop'", () => {
    setupMockEnv({
      maxTouchPoints: 20,
      matchMediaQueries: {
        "(pointer: coarse)": false,
        "(hover: none)": false,
        "(max-width: 768px)": false,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Touchscreen laptop with 20 touch points must classify as desktop");
  });

  await runTest("Mobile Phone (iOS Safari): coarse pointer + no hover + small screen + touch points 5 -> 'mobile'", () => {
    setupMockEnv({
      maxTouchPoints: 5,
      matchMediaQueries: {
        "(pointer: coarse)": true,
        "(hover: none)": true,
        "(max-width: 768px)": true,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "iOS Safari phone must classify as mobile");
  });

  await runTest("Mobile Phone (Firefox Mobile): coarse pointer + no hover + screen <= 768 -> 'mobile'", () => {
    setupMockEnv({
      maxTouchPoints: 5,
      matchMediaQueries: {
        "(pointer: coarse)": true,
        "(hover: none)": true,
        "(max-width: 768px)": true,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "Firefox mobile must classify as mobile");
  });

  await runTest("Standard Desktop PC: fine pointer + hover + 0 touch points -> 'desktop'", () => {
    setupMockEnv({
      maxTouchPoints: 0,
      matchMediaQueries: {
        "(pointer: coarse)": false,
        "(hover: none)": false,
        "(max-width: 768px)": false,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Standard PC desktop");
  });

  await runTest("Tablet (iPad Pro): coarse pointer + touch points 5 + large screen (1024px) -> 'mobile'", () => {
    setupMockEnv({
      maxTouchPoints: 5,
      matchMediaQueries: {
        "(pointer: coarse)": true,
        "(hover: none)": true,
        "(max-width: 768px)": false, // large screen
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "Tablet coarse pointer + touch points > 1");
  });

  await runTest("Tablet with Magic Keyboard / Trackpad: coarse pointer + hover capable + touch points 5 -> 'mobile'", () => {
    setupMockEnv({
      maxTouchPoints: 5,
      matchMediaQueries: {
        "(pointer: coarse)": true,
        "(hover: none)": false, // hover capable due to trackpad
        "(max-width: 768px)": false,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "Tablet with trackpad (coarse pointer + touch > 1)");
  });

  await runTest("Foldable / Compact Touchscreen: fine pointer + small screen + touch points 5 -> 'mobile'", () => {
    setupMockEnv({
      maxTouchPoints: 5,
      matchMediaQueries: {
        "(pointer: coarse)": false,
        "(hover: none)": false,
        "(max-width: 768px)": true,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "mobile", "Small screen with touch > 1");
  });

  await runTest("Degraded media queries: window.matchMedia is missing -> fallback to desktop", () => {
    setupMockEnv({
      maxTouchPoints: 0,
      matchMedia: null,
      poisonUserAgent: true,
    });
    assertEqual(detectPlatformClass(), "desktop", "Missing matchMedia falls back to desktop");
  });

  // SECTION 3: Browser Engine Detection
  await runTest("Engine Detection: window.chrome present -> 'chromium'", () => {
    setupMockEnv({
      chrome: {},
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "window.chrome detection");
  });

  await runTest("Engine Detection: userAgentData.brands contains 'Google Chrome' -> 'chromium'", () => {
    setupMockEnv({
      userAgentData: {
        brands: [
          { brand: "Not_A Brand", version: "8" },
          { brand: "Google Chrome", version: "120" },
        ],
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "brands contains Google Chrome");
  });

  await runTest("Engine Detection: userAgentData.brands contains 'Microsoft Edge' -> 'chromium'", () => {
    setupMockEnv({
      userAgentData: {
        brands: [{ brand: "Microsoft Edge", version: "120" }],
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "brands contains Microsoft Edge");
  });

  await runTest("Engine Detection: userAgentData.brands contains 'Chromium' -> 'chromium'", () => {
    setupMockEnv({
      userAgentData: {
        brands: [{ brand: "Chromium", version: "124" }],
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "brands contains Chromium");
  });

  await runTest("Engine Detection: userAgentData.brands contains 'Opera' -> 'chromium'", () => {
    setupMockEnv({
      userAgentData: {
        brands: [{ brand: "Opera", version: "109" }],
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "brands contains Opera");
  });

  await runTest("Engine Detection: userAgentData.brands contains 'Brave' -> 'chromium'", () => {
    setupMockEnv({
      userAgentData: {
        brands: [{ brand: "Brave", version: "1" }],
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "brands contains Brave");
  });

  await runTest("Engine Detection: Safari window.safari present -> 'webkit'", () => {
    setupMockEnv({
      safari: {},
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "webkit", "window.safari detection");
  });

  await runTest("Engine Detection: Safari Apple vendor string -> 'webkit'", () => {
    setupMockEnv({
      vendor: "Apple Computer, Inc.",
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "webkit", "Apple vendor string detection");
  });

  await runTest("Engine Detection: Safari CSS -webkit-touch-callout supported -> 'webkit'", () => {
    setupMockEnv({
      cssSupports: {
        "-webkit-touch-callout:none": true,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "webkit", "CSS -webkit-touch-callout detection");
  });

  await runTest("Engine Detection: Safari webkitAudioContext present without window.chrome -> 'webkit'", () => {
    setupMockEnv({
      webkitAudioContext: function () {},
      chrome: undefined,
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "webkit", "webkitAudioContext without chrome");
  });

  await runTest("Engine Detection: Firefox window.InstallTrigger present -> 'gecko'", () => {
    setupMockEnv({
      InstallTrigger: {},
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "gecko", "window.InstallTrigger detection");
  });

  await runTest("Engine Detection: Firefox CSS -moz-appearance supported -> 'gecko'", () => {
    setupMockEnv({
      cssSupports: {
        "-moz-appearance:none": true,
      },
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "gecko", "CSS -moz-appearance detection");
  });

  await runTest("Engine Detection: Unknown browser fallback -> 'unknown'", () => {
    setupMockEnv({
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "unknown", "Unknown browser fallback");
  });

  await runTest("Engine Detection: Degraded environment without CSS object -> 'unknown'", () => {
    setupMockEnv({
      noCSS: true,
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "unknown", "Degraded environment without CSS object");
  });

  await runTest("Engine Detection Precedence: chrome + webkitAudioContext -> 'chromium'", () => {
    // Normal Chrome environment has both webkitAudioContext AND window.chrome
    setupMockEnv({
      chrome: {},
      webkitAudioContext: function () {},
      poisonUserAgent: true,
    });
    assertEqual(detectBrowserEngine(), "chromium", "Chromium precedence over webkitAudioContext");
  });

  // SECTION 4: Microphone Permission Graceful Fallback
  await runTest("Mic Permission: permissions API missing -> 'unknown'", async () => {
    setupMockEnv({
      permissionsQuery: undefined,
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "unknown", "Missing permissions API returns unknown");
  });

  await runTest("Mic Permission: permissions.query missing -> 'unknown'", async () => {
    setupMockEnv({
      permissionsQuery: null, // permissions object exists but query method missing
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "unknown", "Missing query method returns unknown");
  });

  await runTest("Mic Permission: permissions.query throws error (Safari) -> 'unknown'", async () => {
    setupMockEnv({
      permissionsQuery: () => {
        throw new TypeError("'microphone' is not a valid PermissionName");
      },
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "unknown", "Throwing permissions.query returns unknown");
  });

  await runTest("Mic Permission: permissions.query rejects promise -> 'unknown'", async () => {
    setupMockEnv({
      permissionsQuery: () => Promise.reject(new Error("Query rejected")),
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "unknown", "Rejecting permissions.query returns unknown");
  });

  await runTest("Mic Permission: permissions.query returns 'prompt' -> 'unknown'", async () => {
    setupMockEnv({
      permissionsQuery: () => Promise.resolve({ state: "prompt" }),
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "unknown", "Prompt state returns unknown");
  });

  await runTest("Mic Permission: permissions.query returns 'granted' -> 'granted'", async () => {
    setupMockEnv({
      permissionsQuery: () => Promise.resolve({ state: "granted" }),
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "granted", "Granted state returns granted");
  });

  await runTest("Mic Permission: permissions.query returns 'denied' -> 'denied'", async () => {
    setupMockEnv({
      permissionsQuery: () => Promise.resolve({ state: "denied" }),
      poisonUserAgent: true,
    });
    const state = await queryMicPermission();
    assertEqual(state, "denied", "Denied state returns denied");
  });

  // SECTION 5: Strict Privacy Audit - No navigator.userAgent Access
  await runTest("Strict Privacy: No access to navigator.userAgent across all operations", async () => {
    let userAgentReadAttempted = false;

    const globalAny = globalThis as any;
    const testNav: Record<string, any> = {
      maxTouchPoints: 2,
      userAgentData: { mobile: true, brands: [{ brand: "Chromium", version: "120" }] },
    };

    Object.defineProperty(testNav, "userAgent", {
      get() {
        userAgentReadAttempted = true;
        throw new Error("FORBIDDEN: navigator.userAgent accessed!");
      },
      configurable: true,
    });

    globalAny.window = {
      navigator: testNav,
      chrome: {},
      matchMedia: () => ({ matches: false }),
    };

    // Call all detection functions
    detectPlatformClass();
    detectBrowserEngine();
    await queryMicPermission();

    if (userAgentReadAttempted) {
      throw new Error("FAIL: navigator.userAgent was touched!");
    }
  });

  // SECTION 6: SSR / Headless Mode (window undefined)
  await runTest("SSR / Headless: window is undefined -> platform='desktop', engine='unknown', mic='unknown'", async () => {
    const globalAny = globalThis as any;
    const prevWindow = globalAny.window;
    try {
      delete globalAny.window;
      assertEqual(detectPlatformClass(), "desktop", "SSR platform fallback");
      assertEqual(detectBrowserEngine(), "unknown", "SSR engine fallback");
      assertEqual(await queryMicPermission(), "unknown", "SSR mic fallback");
    } finally {
      globalAny.window = prevWindow;
    }
  });

  console.log("\n==================================================");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`TOTAL: ${total}, PASSED: ${passed}, FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
