"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  PhoneCall,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Check,
  Copy,
  Zap,
  CalendarCheck2,
  ShieldCheck,
  Headphones,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { speechTTS } from "@/lib/speech-synthesis";
import { KokoroCallSession } from "./kokoro-call-session";

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

const TEST_SCENARIOS = [
  {
    title: "Urgent cooling repair",
    phrase: "My AC stopped blowing cold air today and it's over 90° outside. Can I schedule a technician for tomorrow morning?",
    badge: "Priority",
    roi: "Tests how the receptionist collects the key details and moves an urgent request toward a booking.",
    urgent: true,
  },
  {
    title: "Appointment check",
    phrase: "Can you look up my upcoming maintenance appointment for phone number 555-0144?",
    badge: "Scheduling",
    roi: "Tests a normal scheduling question without interrupting the front office.",
  },
  {
    title: "Equipment question",
    phrase: "What are your standard operating hours and do you install residential heat pumps or ductless mini-splits?",
    badge: "Service info",
    roi: "Tests whether services and hours are explained clearly before a caller decides to book.",
  },
  {
    title: "Gas leak safety check",
    phrase: "I smell strong gas near my furnace in the utility closet and hear a loud hissing sound.",
    badge: "Safety",
    roi: "Tests how an immediate safety concern is identified and handled first.",
    urgent: true,
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

  useEffect(() => {
    onCallStateChange?.(phase === "in-call");
  }, [phase, onCallStateChange]);

  const startCall = () => {
    // This must happen synchronously in the click handler to unlock audio autoplay
    speechTTS.unlockAudio();
    setErrorMessage(null);
    setLastRoom("Voice Assistant Demo");
    setPhase("in-call");
  };

  const handleCallEnded = useCallback((durationSeconds: number) => {
    setLastDuration(durationSeconds);
    setPhase("ended");
  }, []);

  const handleReset = () => {
    setErrorMessage(null);
    setPhase("idle");
  };

  return (
    <div className="w-full max-w-4xl space-y-5 font-sans pb-12 md:pb-6">
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
 * 1. IDLE STATE
 */
function IdleState({
  onStart,
  companyName,
}: {
  onStart: () => void;
  companyName?: string;
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const copyPhrase = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1800);
  };

  return (
    <div className="space-y-5">
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
              Speak as a customer and test a realistic scheduling, service, or safety request. The conversation is logged here so you can inspect the handoff.
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

        {/* Demo capabilities */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-5 mt-5 border-t border-[#f4f4f5]">
          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <Zap className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
              <span>Clear handoff</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              The agent asks for the details needed to make the next step understandable to your team.
            </p>
          </div>

          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <CalendarCheck2 className="w-3.5 h-3.5 text-[#059669]" aria-hidden="true" />
              <span>Schedule aware</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              Booking requests are placed into the same appointment view your dispatch team uses.
            </p>
          </div>

          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <ShieldCheck className="w-3.5 h-3.5 text-[#d97706]" aria-hidden="true" />
              <span>Safety first</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              Emergency-style requests are recognized before ordinary service questions are handled.
            </p>
          </div>
        </div>
      </div>

      {/* Suggested testing scenarios */}
      <div className="rounded-2xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[#e7e7e7] bg-[#fafafa]">
          <div className="flex items-center gap-2">
            <Headphones className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Suggested test prompts
            </span>
          </div>
          <span className="text-[10px] font-mono text-[#71717a] hidden sm:inline-block">
            Copy any prompt
          </span>
        </div>

        <div className="divide-y divide-[#f4f4f5] text-[12px]">
          {TEST_SCENARIOS.map((item, idx) => (
            <div
              key={item.title}
              onClick={() => copyPhrase(item.phrase, idx)}
              className="p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#fafafa] transition-colors cursor-pointer group"
            >
              <div className="space-y-1 max-w-2xl">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={cn(
                      "font-semibold",
                      item.urgent ? "text-[#e11d48]" : "text-[#0a0a0a]"
                    )}
                  >
                    {item.title}
                  </span>
                  <span
                    className={cn(
                      "text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.2 rounded border font-medium",
                      item.urgent
                        ? "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                        : "bg-[#eff6ff] border-[#bfdbfe] text-[#0b5ed7]"
                    )}
                  >
                    {item.badge}
                  </span>
                </div>
                <p className="font-mono text-[#4e505b] text-[11px]">
                  &ldquo;{item.phrase}&rdquo;
                </p>
                {item.roi && (
                  <p className="text-[11px] text-[#059669] flex items-center gap-1.5 pt-0.5">
                    <span className="font-semibold text-[9px] uppercase font-mono tracking-wider bg-[#ecfdf5] border border-[#a7f3d0] px-1 py-0.2 rounded text-[#059669] shrink-0">
                      Test focus
                    </span>
                    <span className="text-[#059669]">{item.roi}</span>
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1 text-[10px] font-mono text-[#71717a] shrink-0 self-end sm:self-auto">
                {copiedIdx === idx ? (
                  <span className="text-[#059669] flex items-center gap-1 font-semibold">
                    <Check className="w-3 h-3" aria-hidden="true" /> Copied
                  </span>
                ) : (
                  <span className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                    <Copy className="w-3 h-3" aria-hidden="true" /> Copy to test
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
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
  onStartAgain,
  onViewCalls,
}: {
  duration: number;
  roomName: string | null;
  onStartAgain: () => void;
  onViewCalls?: () => void;
}) {
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
          <span>Try another prompt</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 3. ERROR STATE
 */
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
            {message}
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
