"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useVoiceAssistant,
  useLocalParticipant,
  useRoomContext,
  useTrackVolume,
} from "@livekit/components-react";
import {
  PhoneCall,
  PhoneOff,
  Mic,
  MicOff,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Clock,
  ArrowRight,
  Terminal,
  Bot,
  Sparkles,
  Volume2,
  Check,
  Copy,
  Zap,
  CalendarCheck2,
  ShieldCheck,
  Headphones,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TokenResponse {
  url: string;
  token: string;
  room: string;
}

type CallPhase = "idle" | "connecting" | "in-call" | "ended" | "error";

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
    title: "Urgent AC Repair Booking",
    phrase: "My AC stopped blowing cold air today and it's over 90° outside. Can I schedule a technician for tomorrow morning?",
    badge: "Revenue Protection",
    roi: "Captures a high-ticket $1,500+ repair or replacement job before the caller dials a competitor.",
    urgent: true,
  },
  {
    title: "Upcoming Service Verification",
    phrase: "Can you look up my upcoming maintenance appointment for phone number 555-0144?",
    badge: "Office Efficiency",
    roi: "Eliminates 30+ repetitive daily inquiry calls so your front office stays focused on technician dispatch.",
  },
  {
    title: "High-Margin Equipment Inquiry",
    phrase: "What are your standard operating hours and do you install residential heat pumps or ductless mini-splits?",
    badge: "System Sales",
    roi: "Instantly qualifies lucrative $8,000+ new equipment installations and heat pump replacements.",
  },
  {
    title: "Gas Leak & Emergency Triage",
    phrase: "I smell strong gas near my furnace in the utility closet and hear a loud hissing sound.",
    badge: "Safety Triage",
    roi: "Provides immediate life-safety evacuation guidance while alerting your on-call emergency technician.",
    urgent: true,
  },
];

export function LiveCallPage({
  onNavigateToCalls,
  onCallStateChange,
  companyName,
}: LiveCallPageProps) {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [tokenData, setTokenData] = useState<TokenResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastDuration, setLastDuration] = useState<number>(0);
  const [lastRoom, setLastRoom] = useState<string | null>(null);

  useEffect(() => {
    onCallStateChange?.(phase === "in-call");
  }, [phase, onCallStateChange]);

  const startCall = async () => {
    try {
      setPhase("connecting");
      setErrorMessage(null);
      const res = await apiPost<TokenResponse>("/v1/calls/token", {});
      setTokenData(res);
      setLastRoom(res.room);
      setPhase("in-call");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect to agent service";
      setErrorMessage(msg);
      setPhase("error");
    }
  };

  const handleCallEnded = useCallback((durationSeconds: number) => {
    setLastDuration(durationSeconds);
    setTokenData(null);
    setPhase("ended");
  }, []);

  const handleReset = () => {
    setTokenData(null);
    setErrorMessage(null);
    setPhase("idle");
  };

  return (
    <div className="w-full max-w-4xl space-y-5 font-sans pb-12 md:pb-6">
      {/* Top Value Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e7e7e7] pb-3.5">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[#0a0a0a] tracking-tight">
              Interactive Voice Demo
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#bfdbfe] bg-[#eff6ff] text-[#0b5ed7] font-semibold">
              24/7 Dispatch Assistant
            </span>
          </div>
          <p className="text-[12px] text-[#71717a] text-pretty">
            Experience how your callers get booked on the 1st ring — zero hold times, no voicemails, and zero lost jobs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-mono uppercase font-semibold tracking-wider px-2.5 py-0.5 rounded-full border flex items-center gap-1.5",
              phase === "in-call"
                ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                : phase === "connecting"
                ? "bg-[#fffbeb] border-[#fde68a] text-[#d97706]"
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
                  : phase === "connecting"
                  ? "bg-[#d97706] animate-ping"
                  : phase === "error"
                  ? "bg-[#e11d48]"
                  : "bg-[#a1a1aa]"
              )}
              aria-hidden="true"
            />
            {phase === "in-call"
              ? "CALL IN PROGRESS"
              : phase === "connecting"
              ? "ANSWERING…"
              : phase === "ended"
              ? "CALL LOGGED"
              : "ASSISTANT READY"}
          </span>
        </div>
      </div>

      {/* Screen States */}
      {phase === "idle" && <IdleState onStart={startCall} companyName={companyName} />}

      {phase === "connecting" && <ConnectingState companyName={companyName} />}

      {phase === "in-call" && tokenData && (
        <ActiveCallSession
          tokenData={tokenData}
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
 * 1. IDLE STATE - Framed for HVAC Business Owners & ROI
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
              <span>Never Miss Another HVAC Job</span>
            </div>
            <h2 className="text-[18px] sm:text-[21px] font-semibold text-[#0a0a0a] tracking-tight text-balance">
              Test Drive Your 24/7 Voice Receptionist
            </h2>
            <p className="text-[12px] sm:text-[13px] text-[#4e505b] leading-relaxed text-pretty">
              Click below to speak as a customer. Hear how naturally she answers questions, diagnoses AC or heating problems, and books confirmed appointments directly into your dispatch schedule.
            </p>
          </div>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={onStart}
            aria-label="Start Voice Demo"
            className="inline-flex items-center justify-center gap-2.5 px-6 py-3.5 sm:py-3 rounded-xl text-[13px] font-semibold text-white bg-[#0b5ed7] hover:bg-[#0a53be] active:bg-[#0948a3] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] focus-visible:ring-offset-2 cursor-pointer whitespace-nowrap shadow-sm shadow-blue-500/20 w-full md:w-auto shrink-0"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span>Start Voice Demo (Talk to AI)</span>
          </motion.button>
        </div>

        {/* 3 Core Business Value Pillars */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-5 mt-5 border-t border-[#f4f4f5]">
          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <Zap className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
              <span>Instant 1st-Ring Answer</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              Zero hold times. Captures urgent repair calls before frustrated homeowners hang up to dial a competitor.
            </p>
          </div>

          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <CalendarCheck2 className="w-3.5 h-3.5 text-[#059669]" aria-hidden="true" />
              <span>Direct Calendar Booking</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              Qualifies the job, collects address &amp; phone, and reserves the dispatch directly on your technician board.
            </p>
          </div>

          <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0a0a]">
              <ShieldCheck className="w-3.5 h-3.5 text-[#d97706]" aria-hidden="true" />
              <span>24/7 After-Hours Revenue</span>
            </div>
            <p className="text-[11px] text-[#71717a] leading-relaxed">
              Secures lucrative weekend and evening emergency calls with $0 in overtime receptionist payroll.
            </p>
          </div>
        </div>
      </div>

      {/* Suggested Testing Scenarios */}
      <div className="rounded-2xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[#e7e7e7] bg-[#fafafa]">
          <div className="flex items-center gap-2">
            <Headphones className="w-3.5 h-3.5 text-[#0b5ed7]" aria-hidden="true" />
            <span className="text-[12px] font-semibold text-[#0a0a0a]">
              Simulate Real Customer Scenarios (Tap any to copy prompt)
            </span>
          </div>
          <span className="text-[10px] font-mono text-[#71717a] hidden sm:inline-block">
            4 Core Business Inquiries
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
                      Why It Matters
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
                    <Copy className="w-3 h-3" aria-hidden="true" /> Copy Prompt
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
 * 2. CONNECTING STATE
 */
function ConnectingState({ companyName }: { companyName?: string }) {
  const displayName = companyName || "HVAC Receptionist";
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-2xl border border-[#e7e7e7] bg-white p-10 text-center space-y-4 shadow-xs"
    >
      <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
        <motion.div
          animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0.2, 0.6] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-full bg-[#0b5ed7]/15"
        />
        <div className="w-12 h-12 rounded-full bg-[#eff6ff] border border-[#bfdbfe] flex items-center justify-center text-[#0b5ed7]">
          <PhoneCall className="w-5 h-5 animate-pulse" aria-hidden="true" />
        </div>
      </div>

      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold text-[#0a0a0a] text-balance">
          Connecting to {displayName}…
        </h3>
        <p className="text-[12px] text-[#71717a] max-w-sm mx-auto text-pretty">
          Simulating an incoming homeowner call. Answers in under 2 seconds with zero hold time.
        </p>
      </div>
    </div>
  );
}

/**
 * 3. ACTIVE CALL CONTAINER
 */
function ActiveCallSession({
  tokenData,
  onCallEnded,
  onError,
  companyName,
}: {
  tokenData: TokenResponse;
  onCallEnded: (duration: number) => void;
  onError: (msg: string) => void;
  companyName?: string;
}) {
  return (
    <LiveKitRoom
      serverUrl={tokenData.url}
      token={tokenData.token}
      connect={true}
      audio={{
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }}
      options={{
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }}
      video={false}
      onDisconnected={() => {}}
      onError={(err) => {
        onError(err?.message || "LiveKit connection failed");
      }}
      className="w-full"
    >
      <RoomAudioRenderer volume={0.85} />
      <ActiveCallInner
        tokenData={tokenData}
        onCallEnded={onCallEnded}
        companyName={companyName}
      />
    </LiveKitRoom>
  );
}

/**
 * Active Call Controller - Houses both Mobile Phone Dial Screen and Desktop Telemetry Console
 */
function ActiveCallInner({
  tokenData,
  onCallEnded,
  companyName,
}: {
  tokenData: TokenResponse;
  onCallEnded: (duration: number) => void;
  companyName?: string;
}) {
  const room = useRoomContext();
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const voiceAssistant = useVoiceAssistant();

  const [duration, setDuration] = useState<number>(0);
  const durationRef = useRef<number>(0);

  // Timer
  useEffect(() => {
    const timer = setInterval(() => {
      setDuration((d) => {
        durationRef.current = d + 1;
        return d + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Room disconnect event
  useEffect(() => {
    const handleDisconnect = () => {
      onCallEnded(durationRef.current);
    };
    room.on("disconnected", handleDisconnect);
    return () => {
      room.off("disconnected", handleDisconnect);
    };
  }, [room, onCallEnded]);

  const handleEndCall = () => {
    room.disconnect();
    onCallEnded(durationRef.current);
  };

  const toggleMic = async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      // ignore
    }
  };

  // Keyboard shortcuts: M for mute, Escape for end call
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMic();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleEndCall();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMicrophoneEnabled]);

  const agentState = voiceAssistant.state;
  const isAgentSpeaking = agentState === "speaking";
  const isAgentThinking = agentState === "thinking";

  return (
    <div
      role="region"
      aria-label="Active phone call session"
      className="rounded-2xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs"
    >
      {/* ==================================================================== */}
      {/* DEDICATED PHONE EXPERIENCE (Mobile screens < md)                    */}
      {/* ==================================================================== */}
      <div className="md:hidden p-5 flex flex-col items-center justify-between min-h-[460px] text-center space-y-6">
        {/* Mobile Header: Duration and Status */}
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#ecfdf5] border border-[#a7f3d0] text-[#059669] text-[10px] font-mono uppercase tracking-wider font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-[#059669] animate-pulse" aria-hidden="true" />
            <span>Call Connected</span>
          </div>
          <div className="text-[34px] font-mono font-semibold tracking-wider text-[#0a0a0a] leading-none pt-1 tabular-nums">
            {formatDuration(duration)}
          </div>
          <div className="text-[11px] font-mono text-[#71717a]">
            Inbound Dispatch Line Active
          </div>
        </div>

        {/* Central Voice Avatar & Ripple Radar */}
        <div className="relative flex items-center justify-center my-4">
          {isAgentSpeaking && (
            <>
              <motion.div
                animate={{ scale: [1, 1.45, 1.8], opacity: [0.4, 0.2, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
                className="absolute w-36 h-36 rounded-full bg-[#0b5ed7]/15 pointer-events-none"
              />
              <motion.div
                animate={{ scale: [1, 1.25, 1.5], opacity: [0.5, 0.25, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, delay: 0.4, ease: "easeOut" }}
                className="absolute w-36 h-36 rounded-full bg-[#0b5ed7]/25 pointer-events-none"
              />
            </>
          )}

          <div
            className={cn(
              "relative z-10 flex items-center justify-center w-28 h-28 rounded-full border-2 transition-all duration-300 shadow-md",
              isAgentSpeaking
                ? "bg-[#eff6ff] border-[#0b5ed7] text-[#0b5ed7] shadow-[#0b5ed7]/20 scale-105"
                : isAgentThinking
                ? "bg-[#fffbeb] border-[#d97706] text-[#d97706] shadow-[#d97706]/20"
                : "bg-white border-[#e7e7e7] text-[#0a0a0a]"
            )}
          >
            <Bot className="w-12 h-12" aria-hidden="true" />
          </div>
        </div>

        {/* Dynamic State Text & Audio Level */}
        <div className="space-y-2 w-full max-w-xs">
          <div className="text-[15px] font-semibold text-[#0a0a0a] tracking-tight">
            {isAgentSpeaking
              ? "Receptionist Speaking…"
              : isAgentThinking
              ? "Checking Technician Schedule…"
              : "Listening to your voice…"}
          </div>

          {/* Mini Audio Bar */}
          {voiceAssistant.audioTrack && (
            <div className="px-4">
              <AudioActivityBars track={voiceAssistant.audioTrack} compact />
            </div>
          )}
        </div>

        {/* Thumb Call Controls Dock (Bottom 1/3 reach zone) */}
        <div className="w-full pt-4 border-t border-[#f4f4f5]">
          <div className="flex items-center justify-center gap-8">
            {/* 64x64 Mute Button */}
            <div className="flex flex-col items-center gap-1.5">
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={toggleMic}
                aria-label={isMicrophoneEnabled ? "Mute Microphone" : "Unmute Microphone"}
                className={cn(
                  "flex items-center justify-center w-16 h-16 rounded-full border shadow-sm transition-colors cursor-pointer",
                  isMicrophoneEnabled
                    ? "bg-white border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#fafafa]"
                    : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                )}
              >
                {isMicrophoneEnabled ? (
                  <Mic className="w-6 h-6" aria-hidden="true" />
                ) : (
                  <MicOff className="w-6 h-6" aria-hidden="true" />
                )}
              </motion.button>
              <span className="text-[11px] font-medium text-[#71717a]">
                {isMicrophoneEnabled ? "Mute" : "Unmute"}
              </span>
            </div>

            {/* 64x64 Hangup Button */}
            <div className="flex flex-col items-center gap-1.5">
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={handleEndCall}
                aria-label="Hang up call"
                className="flex items-center justify-center w-16 h-16 rounded-full bg-[#dc2626] text-white shadow-md shadow-red-500/25 hover:bg-[#b91c1c] active:bg-[#991b1b] cursor-pointer transition-transform active:scale-95"
              >
                <PhoneOff className="w-6 h-6" aria-hidden="true" />
              </motion.button>
              <span className="text-[11px] font-medium text-[#dc2626]">
                End Call
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* DESKTOP EXPERIENCE (Screens >= md)                                 */}
      {/* ==================================================================== */}
      <div className="hidden md:block divide-y divide-[#e7e7e7]">
        {/* Session Metadata Header */}
        <div className="px-5 py-3.5 flex items-center justify-between gap-3 bg-[#fafafa]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#059669] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-[#059669] animate-pulse" aria-hidden="true" />
              Live Call Connected
            </span>
            <span className="text-[11px] text-[#4e505b]">
              Automatic Call Qualification &amp; Scheduling
            </span>
          </div>

          <div className="flex items-center gap-2 text-[12px] font-mono font-semibold text-[#0a0a0a] tabular-nums">
            <Clock className="w-3.5 h-3.5 text-[#71717a]" aria-hidden="true" />
            <span>{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Two-Column Telemetry Grid */}
        <div className="p-5 grid grid-cols-2 gap-4">
          {/* Agent Telemetry Card */}
          <div className="rounded-xl border border-[#e7e7e7] bg-white p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-[#71717a]">
                Virtual Receptionist
              </span>
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                  isAgentSpeaking
                    ? "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]"
                    : isAgentThinking
                    ? "bg-[#fffbeb] border-[#fde68a] text-[#d97706]"
                    : "bg-[#fafafa] border-[#e7e7e7] text-[#71717a]"
                )}
              >
                {isAgentSpeaking
                  ? "Speaking"
                  : isAgentThinking
                  ? "Checking Schedule"
                  : "Listening"}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-[#0a0a0a]">
                {companyName ? `${companyName} Assistant` : "HVAC Voice Assistant"}
              </div>
              <div className="text-[11px] text-[#71717a]">
                Active: Inbound Qualification &amp; Booking
              </div>
            </div>

            {/* Audio Track Activity */}
            <div className="pt-2 border-t border-[#f4f4f5]">
              {voiceAssistant.audioTrack ? (
                <AudioActivityBars track={voiceAssistant.audioTrack} />
              ) : (
                <div className="text-[11px] text-[#71717a]">
                  Connecting assistant voice audio…
                </div>
              )}
            </div>
          </div>

          {/* Local Caller Card */}
          <div className="rounded-xl border border-[#e7e7e7] bg-white p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-[#71717a]">
                Customer Simulation
              </span>
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                  isMicrophoneEnabled
                    ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                    : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                )}
              >
                {isMicrophoneEnabled ? "Microphone Live" : "Microphone Muted"}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-[#0a0a0a]">
                Your Voice (Homeowner / Caller)
              </div>
              <div className="text-[11px] text-[#71717a]">
                Speak naturally about your AC or furnace problem
              </div>
            </div>

            <div className="pt-2 border-t border-[#f4f4f5] text-[11px] text-[#71717a]">
              {isMicrophoneEnabled
                ? "Microphone is transmitting live audio to assistant."
                : "Microphone is muted. Press [M] or click unmute below."}
            </div>
          </div>
        </div>

        {/* Desktop Action Controls Footer */}
        <div className="px-5 py-3.5 flex items-center justify-between gap-3 bg-[#fafafa]">
          <button
            type="button"
            onClick={toggleMic}
            aria-pressed={!isMicrophoneEnabled}
            className={cn(
              "inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[12px] font-semibold border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer",
              isMicrophoneEnabled
                ? "bg-white border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#f4f4f5]"
                : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
            )}
          >
            {isMicrophoneEnabled ? (
              <>
                <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Mute Mic [M]</span>
              </>
            ) : (
              <>
                <MicOff className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Unmute Mic [M]</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleEndCall}
            aria-label="End call session"
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold text-white bg-[#dc2626] hover:bg-[#b91c1c] active:bg-[#991b1b] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#dc2626] focus-visible:ring-offset-2 cursor-pointer shadow-xs"
          >
            <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
            <span>End Call [Esc]</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Clean Level Meter for Audio Track
 */
function AudioActivityBars({ track, compact = false }: { track: any; compact?: boolean }) {
  const volume = useTrackVolume(track);
  const activeBars = Math.min(8, Math.round(volume * 16));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono text-[#71717a]">
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" aria-hidden="true" /> Voice Energy
        </span>
        <span className="tabular-nums">{Math.round(volume * 100)}%</span>
      </div>
      <div className={cn("flex items-center gap-1", compact ? "h-2" : "h-3")}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "flex-1 h-full rounded-sm transition-colors duration-75",
              i < activeBars ? "bg-[#0b5ed7]" : "bg-[#e7e7e7]"
            )}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 4. ENDED STATE - Business Call Outcome
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
            Customer Call Completed &amp; Saved to Dispatch Log
          </h3>
          <p className="text-[12px] text-[#71717a] text-pretty">
            The assistant summarized the customer's issue, categorized the outcome, and recorded the dispatch in your dashboard for technician assignment.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#71717a]">
            Customer Conversation Time
          </div>
          <div className="text-[16px] font-mono font-semibold text-[#0a0a0a] mt-0.5 tabular-nums">
            {formatDuration(duration)}
          </div>
          <p className="text-[11px] text-[#71717a] mt-1">
            Fast resolution keeps lines open for other paying callers.
          </p>
        </div>

        <div className="p-3.5 rounded-xl border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#71717a]">
            Status &amp; Next Action
          </div>
          <div className="text-[14px] font-semibold text-[#059669] mt-0.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#059669]" />
            Logged &amp; Ready for Dispatch
          </div>
          <p className="text-[11px] text-[#71717a] mt-1">
            Recorded in Call Records and Dispatch Schedule.
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
            <span>View Call In Dashboard</span>
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </motion.button>
        )}

        <button
          type="button"
          onClick={onStartAgain}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[12px] font-semibold bg-white border border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#fafafa] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Test Another Scenario</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 5. ERROR STATE
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
