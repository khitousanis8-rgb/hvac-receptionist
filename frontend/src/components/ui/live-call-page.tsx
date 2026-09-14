"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  PhoneCall,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { neuralVoice } from "@/lib/neural-audio-player";
import { KokoroCallSession } from "./kokoro-call-session";
import { HoverRevealCards, CardItem } from "./hover-reveal-cards";
import {
  type ClientTelemetry,
  detectPlatformClass,
  detectBrowserEngine,
} from "@/lib/telemetry";

type CallPhase = "idle" | "in-call" | "ended" | "error";

interface LiveCallPageProps {
  onNavigateToCalls?: () => void;
  onCallStateChange?: (inCall: boolean) => void;
  companyName?: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const HVAC_CAPABILITIES: CardItem[] = [
  {
    id: "emergency",
    title: "Emergency Response",
    subtitle: "24/7 Rapid Triage",
    badge: "Safety First",
    description: "Instant priority triage for gas odors, water leaks, and extreme weather failures.",
    imageUrl: "/images/hvac-emergency.jpg",
  },
  {
    id: "scheduling",
    title: "Automated Booking",
    subtitle: "Live Calendar Sync",
    badge: "Schedule Aware",
    description: "Direct real-time appointment booking synced with dispatch opening hours.",
    imageUrl: "/images/hvac-scheduling.jpg",
  },
  {
    id: "service",
    title: "Diagnostic & Tune-Up",
    subtitle: "Precision Service",
    badge: "Certified Care",
    description: "Heat pump, furnace, and AC seasonal maintenance with clear problem intake.",
    imageUrl: "/images/hvac-service.jpg",
  },
  {
    id: "voice",
    title: "AI Voice Receptionist",
    subtitle: "Zero Wait Handoff",
    badge: "Studio Audio",
    description: "Natural conversational receptionist answering front office calls 24/7 with zero delay.",
    imageUrl: "/images/hvac-voice.jpg",
  },
];

export function LiveCallPage({
  onNavigateToCalls,
  onCallStateChange,
  companyName,
}: LiveCallPageProps) {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastDuration, setLastDuration] = useState<number>(0);
  const [lastRoom, setLastRoom] = useState<string | null>(null);
  const [lastTelemetry, setLastTelemetry] = useState<ClientTelemetry | null>(null);
  const [initialMediaStream, setInitialMediaStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    onCallStateChange?.(phase === "in-call");
  }, [phase, onCallStateChange]);

  const startCall = async () => {
    // This must happen synchronously in the click handler to unlock audio autoplay on mobile
    neuralVoice.unlockAudio();
    setErrorMessage(null);
    setLastRoom("Voice Assistant Demo");

    // Direct gesture microphone permission (Phase 3)
    let stream: MediaStream | null = null;
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err: any) {
        console.warn("[LiveCallPage] getUserMedia in user gesture:", err);
      }
    }
    setInitialMediaStream(stream);
    setPhase("in-call");
  };

  const handleCallEnded = useCallback((durationSeconds: number, telemetry?: ClientTelemetry) => {
    setLastDuration(durationSeconds);
    setLastTelemetry(telemetry ?? null);
    setPhase("ended");
  }, []);

  const handleReset = () => {
    setErrorMessage(null);
    setPhase("idle");
  };

  return (
    <div className="w-full max-w-5xl space-y-6 font-sans pb-12 md:pb-6">
      {/* Voice demo status */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e7e7e7] pb-3.5">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[#0a0a0a] tracking-tight">
              Voice demo
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#bfdbfe] bg-[#eff6ff] text-[#0b5ed7] font-semibold">
              Reception simulation
            </span>
          </div>
          <p className="text-[12px] text-[#71717a] text-pretty">
            Test the exact conversational flow a customer will experience when they call your business.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-mono uppercase font-semibold tracking-wider px-2.5 py-0.5 rounded-full border flex items-center gap-1.5",
              phase === "in-call"
                ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                : phase === "error"
                ? "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                : "bg-[#fafafa] border-[#e7e7e7] text-[#71717a]"
            )}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                phase === "in-call"
                  ? "bg-[#059669] animate-pulse"
                  : phase === "error"
                  ? "bg-[#e11d48]"
                  : "bg-[#a1a1aa]"
              )}
              aria-hidden="true"
            />
            {phase === "in-call"
              ? "CALL IN PROGRESS"
              : phase === "ended"
              ? "CALL LOGGED"
              : "ASSISTANT READY"}
          </span>
        </div>
      </div>

      {/* Screen States */}
      {phase === "idle" && (
        <IdleState
          onStart={startCall}
          companyName={companyName}
        />
      )}

      {phase === "in-call" && (
        <KokoroCallSession
          initialMediaStream={initialMediaStream}
          companyName={companyName}
          onCallEnded={handleCallEnded}
          onError={(msg) => {
            setErrorMessage(msg);
            setPhase("error");
          }}
        />
      )}

      {phase === "ended" && (
        <EndedState
          duration={lastDuration}
          roomName={lastRoom}
          telemetry={lastTelemetry}
          onStartAgain={startCall}
          onViewCalls={onNavigateToCalls}
        />
      )}

      {phase === "error" && (
        <ErrorState
          message={errorMessage || "An unexpected error occurred."}
          onRetry={startCall}
          onCancel={handleReset}
        />
      )}
    </div>
  );
}

/**
 * 1. IDLE STATE - Hero Banner + HoverRevealCards Capabilities
 */
function IdleState({
  onStart,
  companyName,
}: {
  onStart: () => void;
  companyName?: string;
}) {
  return (
    <div className="space-y-6">
      {/* Primary Action Hero Card */}
      <div className="rounded-2xl border border-[#e7e7e7] bg-white p-5 sm:p-7 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="space-y-1.5 max-w-xl">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-[#eff6ff] text-[#0b5ed7] text-[11px] font-medium border border-[#bfdbfe]">
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              <span>Customer-facing test</span>
            </div>
            <h2 className="text-[18px] sm:text-[21px] font-semibold text-[#0a0a0a] tracking-tight text-balance">
              Test the reception flow
            </h2>
            <p className="text-[12px] sm:text-[13px] text-[#4e505b] leading-relaxed text-pretty">
              Speak as a customer and test a realistic scheduling, service, or safety request. The conversation is logged automatically in the dispatch dashboard.
            </p>
          </div>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={onStart}
            aria-label="Start voice demo"
            className="inline-flex items-center justify-center gap-2.5 px-6 py-3.5 sm:py-3 rounded-xl text-[13px] font-semibold text-white bg-[#0b5ed7] hover:bg-[#0a53be] active:bg-[#0948a3] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] focus-visible:ring-offset-2 cursor-pointer whitespace-nowrap shadow-sm shadow-blue-500/20 w-full md:w-auto shrink-0"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span>Start voice demo</span>
          </motion.button>
        </div>
      </div>

      {/* Scoped HVAC Capabilities Showcase - HoverRevealCards */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-[#0a0a0a]">
              Receptionist Capabilities
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#e7e7e7] bg-[#fafafa] text-[#71717a]">
              Live Interactive Cards
            </span>
          </div>
          <span className="text-[11px] text-[#71717a] hidden sm:inline-block">
            Tap or click any card to launch demo
          </span>
        </div>

        <HoverRevealCards
          items={HVAC_CAPABILITIES}
          onCardClick={() => onStart()}
        />
      </div>
    </div>
  );
}

/**
 * 2. ENDED STATE - Business Call Outcome
 */
function EndedState({
  duration,
  roomName,
  telemetry,
  onStartAgain,
  onViewCalls,
}: {
  duration: number;
  roomName: string | null;
  telemetry?: ClientTelemetry | null;
  onStartAgain: () => void;
  onViewCalls?: () => void;
}) {
  const platform = telemetry?.platform_class ?? detectPlatformClass();
  const engine = telemetry?.browser_engine ?? detectBrowserEngine();
  const inputPath = telemetry?.input_path ?? "native_web_speech";
  const echoCount = telemetry?.echo_suppressions ?? 0;

  return (
    <div className="rounded-2xl border border-[#e7e7e7] bg-white p-6 space-y-5 shadow-xs">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full border border-[#a7f3d0] bg-[#ecfdf5] flex items-center justify-center text-[#059669] shrink-0">
          <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-[15px] font-semibold text-[#0a0a0a] text-balance">
            Conversation complete and saved to the call log
          </h3>
          <p className="text-[12px] text-[#71717a] text-pretty">
            The conversation summary and outcome are available in the dashboard for follow-up.
          </p>
        </div>
      </div>

      {/* Session Attribution Pill */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl border border-[#e7e7e7] bg-[#fafafa]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#0b5ed7]" aria-hidden="true" />
          <span className="text-[11px] font-semibold text-[#0a0a0a]">
            Session Attribution
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-[#e7e7e7] text-[#0a0a0a]">
            <span className="text-[#71717a]">Platform:</span>
            <span className="capitalize font-semibold">{platform}</span>
            <span className="text-[#71717a] text-[10px] font-mono">({engine})</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-[#e7e7e7] text-[#0a0a0a]">
            <span className="text-[#71717a]">Input Path:</span>
            <span className="font-mono text-[10px] uppercase font-semibold text-[#0b5ed7]">
              {inputPath === "media_recorder_transcription"
                ? "Whisper Fallback"
                : "Native Web Speech"}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-[#e7e7e7] text-[#0a0a0a]">
            <span className="text-[#71717a]">Echo Suppressions:</span>
            <span className="font-mono tabular-nums font-semibold text-[#059669]">
              {echoCount}
            </span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#71717a]">
            Conversation time
          </div>
          <div className="text-[16px] font-mono font-semibold text-[#0a0a0a] mt-0.5 tabular-nums">
            {formatDuration(duration)}
          </div>
          <p className="text-[11px] text-[#71717a] mt-1">
            A concise test session is enough to evaluate the handoff.
          </p>
        </div>

        <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#71717a]">
            Log status
          </div>
          <div className="text-[14px] font-semibold text-[#059669] mt-0.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#059669]" />
            Logged and ready to review
          </div>
          <p className="text-[11px] text-[#71717a] mt-1">
            Recorded in the calls view and schedule when applicable.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
        {onViewCalls && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={onViewCalls}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-semibold text-white bg-[#0b5ed7] hover:bg-[#0a53be] active:bg-[#0948a3] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
          >
            <span>View call log</span>
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </motion.button>
        )}

        <button
          type="button"
          onClick={onStartAgain}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[12px] font-semibold bg-white border border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#fafafa] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Start new call</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 3. ERROR STATE
 */
function formatFriendlyErrorMessage(raw: string): string {
  if (!raw) return "An unexpected connection issue occurred. Please retry.";
  const lower = raw.toLowerCase();
  if (raw.includes("429") || lower.includes("rate limit") || lower.includes("tokens per day")) {
    return "The AI voice provider reached its daily token capacity limit. Please wait a few moments or retry.";
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("failed to fetch")) {
    return "Network connection to the receptionist service was interrupted. Please check your internet connection.";
  }
  const match = raw.match(/['"]message['"]:\s*['"]([^'"]+)['"]/);
  if (match && match[1]) {
    return match[1];
  }
  return raw;
}

function ErrorState({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-[#fecdd3] bg-[#fff1f2] p-6 space-y-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-[#e11d48] shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-[14px] font-semibold text-[#9f1239]">
            Connection Issue
          </h3>
          <p className="text-[12px] text-[#be123c]">
            {formatFriendlyErrorMessage(message)}
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-semibold text-white bg-[#e11d48] hover:bg-[#be123c] transition-colors duration-150 cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Retry Connection</span>
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full sm:w-auto px-4 py-2 rounded-xl text-[12px] font-medium border border-[#e7e7e7] bg-white text-[#0a0a0a] hover:bg-[#f4f4f5] transition-colors duration-150 cursor-pointer text-center"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
