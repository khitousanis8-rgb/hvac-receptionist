/**
 * Privacy-safe client platform and audio telemetry module.
 *
 * STRICT PRIVACY REQUIREMENT:
 * NEVER inspect, log, or persist raw navigator.userAgent.
 * Device and browser detection relies strictly on standard User-Agent Client Hints,
 * CSS capabilities, and vendor API feature detection.
 */

export type PlatformClass = "desktop" | "mobile";
export type BrowserEngine = "chromium" | "webkit" | "gecko" | "unknown";
export type InputPath = "native_web_speech" | "media_recorder_transcription";
export type MicPermissionState = "granted" | "denied" | "dismissed" | "unknown";
export type EndReason =
  | "caller_hangup"
  | "assistant_completed"
  | "mic_denied"
  | "session_aborted"
  | "page_unload"
  | "error";

export interface ClientTelemetry {
  platform_class?: PlatformClass;
  browser_engine?: BrowserEngine;
  input_path?: InputPath;
  mic_permission?: MicPermissionState;
  first_assistant_audio_ms?: number | null;
  first_caller_transcript_ms?: number | null;
  echo_suppressions?: number;
  stt_errors?: number;
  tts_errors?: number;
  end_reason?: EndReason | string | null;
}

/**
 * Detect platform class without inspecting raw user-agent strings.
 * 1. Uses navigator.userAgentData.mobile (W3C standard User-Agent Client Hints).
 * 2. Uses CSS media queries (pointer: coarse, hover: none, viewport width).
 * 3. Handles touch capabilities (maxTouchPoints).
 *
 * STRICT PRIVACY: Zero usage of navigator.userAgent.
 */
export function detectPlatformClass(): PlatformClass {
  if (typeof window === "undefined") return "desktop";

  // 1. Standard Client Hints API (Chromium, Edge, Opera, Android WebViews)
  const nav = window.navigator as {
    userAgentData?: {
      mobile?: boolean;
    };
    maxTouchPoints?: number;
  };

  if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") {
    return nav.userAgentData.mobile ? "mobile" : "desktop";
  }

  // 2. CSS Media Queries for pointer and hover capabilities
  const hasCoarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const hasNoHover =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none)").matches;
  const isSmallScreen =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches;
  const maxTouchPoints = nav.maxTouchPoints ?? 0;

  // Touch-screen mobile / tablet devices
  if (hasCoarsePointer && (hasNoHover || isSmallScreen || maxTouchPoints > 1)) {
    return "mobile";
  }

  if (maxTouchPoints > 1 && isSmallScreen) {
    return "mobile";
  }

  return "desktop";
}

/**
 * Detect browser engine via feature detection and vendor capabilities.
 * 1. Chromium: window.chrome or navigator.userAgentData.brands containing Chromium brands.
 * 2. WebKit: window.safari, Apple vendor prefix, -webkit-touch-callout CSS support,
 *    or webkitAudioContext without window.chrome.
 * 3. Gecko: window.InstallTrigger or -moz-appearance CSS support.
 * 4. Fallback: "unknown".
 *
 * STRICT PRIVACY: Zero usage of navigator.userAgent.
 */
export function detectBrowserEngine(): BrowserEngine {
  if (typeof window === "undefined") return "unknown";

  const win = window as unknown as {
    chrome?: unknown;
    safari?: unknown;
    webkitAudioContext?: unknown;
    InstallTrigger?: unknown;
  };

  const nav = window.navigator as unknown as {
    vendor?: string;
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
    };
  };

  // 1. Chromium engine (Chrome, Edge, Opera, Brave, Chromium-based browsers)
  if (
    typeof win.chrome !== "undefined" ||
    Boolean(
      nav.userAgentData?.brands?.some((b) =>
        ["Chromium", "Google Chrome", "Microsoft Edge", "Opera", "Brave"].some((brand) =>
          b.brand.includes(brand)
        )
      )
    )
  ) {
    return "chromium";
  }

  // 2. WebKit engine (Apple Safari, iOS WebKit, WKWebView)
  const isAppleVendor = nav.vendor === "Apple Computer, Inc.";
  const hasWebkitTouchCallout =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-webkit-touch-callout", "none");
  const hasWebkitAudioWithoutChrome =
    typeof win.webkitAudioContext !== "undefined" && typeof win.chrome === "undefined";

  if (
    typeof win.safari !== "undefined" ||
    isAppleVendor ||
    hasWebkitTouchCallout ||
    hasWebkitAudioWithoutChrome
  ) {
    return "webkit";
  }

  // 3. Gecko engine (Mozilla Firefox)
  const hasMozAppearance =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-moz-appearance", "none");

  if (typeof win.InstallTrigger !== "undefined" || hasMozAppearance) {
    return "gecko";
  }

  return "unknown";
}

/**
 * Query current microphone permission state gracefully via Permissions API.
 * Safely handles environments where permissions.query is missing or throws (e.g. Safari).
 */
export async function queryMicPermission(): Promise<MicPermissionState> {
  if (
    typeof window === "undefined" ||
    typeof window.navigator === "undefined" ||
    !window.navigator.permissions ||
    typeof window.navigator.permissions.query !== "function"
  ) {
    return "unknown";
  }

  try {
    const status = await window.navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") return "granted";
    if (status.state === "denied") return "denied";
    if (status.state === "prompt") return "unknown";
  } catch {
    // Safari and certain mobile browsers throw on "microphone" permission query
  }

  return "unknown";
}
