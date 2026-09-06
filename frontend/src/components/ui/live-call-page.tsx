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
} from "lucide-react";
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
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function LiveCallPage({ onNavigateToCalls }: LiveCallPageProps) {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [tokenData, setTokenData] = useState<TokenResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastDuration, setLastDuration] = useState<number>(0);
  const [lastRoom, setLastRoom] = useState<string | null>(null);

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
    <div className="w-full max-w-4xl space-y-6 font-sans">
      {/* Top Console Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e7e7e7] pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[#0a0a0a]">
              Live Receptionist Console
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#e7e7e7] bg-[#fafafa] text-[#4e505b]">
              Phase A · WebRTC
            </span>
          </div>
          <p className="text-[12px] text-[#4e505b]">
            Direct in-browser audio channel to the LiveKit voice agent worker.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[#4e505b]">
            Status:
          </span>
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
              phase === "in-call"
                ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                : phase === "connecting"
                ? "bg-[#fffbeb] border-[#fde68a] text-[#d97706]"
                : phase === "error"
                ? "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                : "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
            )}
          >
            {phase.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Screen States */}
      {phase === "idle" && <IdleState onStart={startCall} />}

      {phase === "connecting" && <ConnectingState />}

      {phase === "in-call" && tokenData && (
        <ActiveCallSession
          tokenData={tokenData}
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
function IdleState({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-6">
      {/* Primary Action Card */}
      <div className="rounded-lg border border-[#e7e7e7] bg-[#ffffff] p-6 space-y-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-[14px] font-semibold text-[#0a0a0a]">
              Start Test Call Session
            </h2>
            <p className="text-[12px] text-[#4e505b] max-w-xl">
              Connects your browser microphone to the AI receptionist. The call record, audio stream, and transcription will be processed and saved automatically.
            </p>
          </div>

          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-[12px] font-semibold text-[#ffffff] bg-[#0b5ed7] hover:bg-[#0a53be] active:bg-[#0948a3] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] focus-visible:ring-offset-2 cursor-pointer whitespace-nowrap w-full sm:w-auto"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span>Connect &amp; Start Call</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-[#e7e7e7]">
          <div className="p-3 rounded-md border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="text-[10px] font-mono uppercase text-[#4e505b]">
              Audio Transport
            </div>
            <div className="text-[12px] font-semibold text-[#0a0a0a]">
              WebRTC (LiveKit Cloud)
            </div>
          </div>
          <div className="p-3 rounded-md border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="text-[10px] font-mono uppercase text-[#4e505b]">
              Agent Worker
            </div>
            <div className="text-[12px] font-semibold text-[#0a0a0a]">
              hvac-receptionist
            </div>
          </div>
          <div className="p-3 rounded-md border border-[#e7e7e7] bg-[#fafafa] space-y-1">
            <div className="text-[10px] font-mono uppercase text-[#4e505b]">
              Persistence
            </div>
            <div className="text-[12px] font-semibold text-[#0a0a0a]">
              SQLite CallRecord
            </div>
          </div>
        </div>
      </div>

      {/* Suggested Testing Prompts Table */}
      <div className="rounded-lg border border-[#e7e7e7] bg-[#ffffff] overflow-hidden shadow-xs">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#e7e7e7] bg-[#fafafa]">
          <Terminal className="w-3.5 h-3.5 text-[#4e505b]" aria-hidden="true" />
          <span className="text-[12px] font-semibold text-[#0a0a0a]">
            Suggested Voice Test Scenarios
          </span>
        </div>

        <div className="divide-y divide-[#e7e7e7] text-[12px]">
          <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="font-semibold text-[#0a0a0a]">
              Appointment Booking
            </span>
            <span className="font-mono text-[#4e505b] text-[11px]">
              &ldquo;My AC is blowing warm air, can I schedule a technician for tomorrow morning?&rdquo;
            </span>
          </div>
          <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="font-semibold text-[#0a0a0a]">
              Check Existing Appointments
            </span>
            <span className="font-mono text-[#4e505b] text-[11px]">
              &ldquo;Can you look up my upcoming appointments for 555-555-0100?&rdquo;
            </span>
          </div>
          <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="font-semibold text-[#0a0a0a]">
              Services &amp; Hours
            </span>
            <span className="font-mono text-[#4e505b] text-[11px]">
              &ldquo;What services do you offer, and what are your operating hours?&rdquo;
            </span>
          </div>
          <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="font-semibold text-[#e11d48]">
              Emergency Safety Boundary
            </span>
            <span className="font-mono text-[#4e505b] text-[11px]">
              &ldquo;I smell strong gas near my heater and hear a hissing noise.&rdquo;
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 2. CONNECTING STATE
 */
function ConnectingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-[#e7e7e7] bg-[#ffffff] p-10 text-center space-y-3 shadow-xs"
    >
      <div className="inline-block text-[11px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-full border border-[#fde68a] bg-[#fffbeb] text-[#d97706]">
        Dispatching Worker...
      </div>
      <h3 className="text-[14px] font-semibold text-[#0a0a0a]">
        Connecting to Receptionist Agent
      </h3>
      <p className="text-[12px] text-[#4e505b] max-w-md mx-auto">
        Requesting short-lived session token from <code className="font-mono text-[11px]">/v1/calls/token</code> and establishing WebRTC room connection.
      </p>
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
}: {
  tokenData: TokenResponse;
  onCallEnded: (duration: number) => void;
  onError: (msg: string) => void;
}) {
  return (
    <LiveKitRoom
      serverUrl={tokenData.url}
      token={tokenData.token}
      connect={true}
      audio={true}
      video={false}
      onDisconnected={() => {}}
      onError={(err) => {
        onError(err?.message || "LiveKit connection failed");
      }}
      className="w-full"
    >
      <RoomAudioRenderer />
      <ActiveCallInner tokenData={tokenData} onCallEnded={onCallEnded} />
    </LiveKitRoom>
  );
}

/**
 * Active Call Controls and Audio Telemetry
 */
function ActiveCallInner({
  tokenData,
  onCallEnded,
}: {
  tokenData: TokenResponse;
  onCallEnded: (duration: number) => void;
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
      className="rounded-lg border border-[#e7e7e7] bg-[#ffffff] divide-y divide-[#e7e7e7] shadow-xs"
    >
      {/* Session Metadata Header */}
      <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 bg-[#fafafa]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#059669] uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-[#059669]" />
            Session Active
          </span>
          <span className="text-[11px] font-mono text-[#4e505b]">
            Room: {tokenData.room}
          </span>
        </div>

        <div className="flex items-center gap-2 text-[12px] font-mono font-semibold text-[#0a0a0a]">
          <Clock className="w-3.5 h-3.5 text-[#4e505b]" aria-hidden="true" />
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Two-Column Telemetry Grid */}
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Agent Telemetry Card */}
        <div className="rounded-md border border-[#e7e7e7] bg-[#ffffff] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-[#4e505b]">
              Remote Agent
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                isAgentSpeaking
                  ? "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]"
                  : isAgentThinking
                  ? "bg-[#fffbeb] border-[#fde68a] text-[#d97706]"
                  : "bg-[#fafafa] border-[#e7e7e7] text-[#4e505b]"
              )}
            >
              {isAgentSpeaking
                ? "Speaking"
                : isAgentThinking
                ? "Processing"
                : "Listening"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-[13px] font-semibold text-[#0a0a0a]">
              HVAC Receptionist
            </div>
            <div className="text-[11px] font-mono text-[#4e505b]">
              Identity: {voiceAssistant.agent?.identity || "hvac-receptionist"}
            </div>
          </div>

          {/* Audio Track Activity */}
          <div className="pt-2 border-t border-[#e7e7e7]">
            {voiceAssistant.audioTrack ? (
              <AudioActivityBars track={voiceAssistant.audioTrack} />
            ) : (
              <div className="text-[11px] text-[#4e505b]">
                Waiting for agent audio stream...
              </div>
            )}
          </div>
        </div>

        {/* Local Caller Card */}
        <div className="rounded-md border border-[#e7e7e7] bg-[#ffffff] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-[#4e505b]">
              Local Participant
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                isMicrophoneEnabled
                  ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                  : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
              )}
            >
              {isMicrophoneEnabled ? "Mic Active" : "Mic Muted"}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-[13px] font-semibold text-[#0a0a0a]">
              Caller (Browser Audio)
            </div>
            <div className="text-[11px] font-mono text-[#4e505b]">
              Identity: {localParticipant.identity}
            </div>
          </div>

          <div className="pt-2 border-t border-[#e7e7e7] text-[11px] text-[#4e505b]">
            {isMicrophoneEnabled
              ? "Microphone is transmitting to LiveKit."
              : "Microphone is disabled. Press M to unmute."}
          </div>
        </div>
      </div>

      {/* Action Controls Footer */}
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 bg-[#fafafa]">
        <button
          type="button"
          onClick={toggleMic}
          aria-pressed={!isMicrophoneEnabled}
          aria-label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "w-full sm:w-auto inline-flex items-center justify-center gap-2 px-3.5 py-2.5 sm:py-2 rounded-md text-[12px] font-semibold border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer",
            isMicrophoneEnabled
              ? "bg-[#ffffff] border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#f4f4f5]"
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
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 rounded-md text-[12px] font-semibold text-[#ffffff] bg-[#dc2626] hover:bg-[#b91c1c] active:bg-[#991b1b] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#dc2626] focus-visible:ring-offset-2 cursor-pointer"
        >
          <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
          <span>End Call [Esc]</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Clean Level Meter for Audio Track
 */
function AudioActivityBars({ track }: { track: any }) {
  const volume = useTrackVolume(track);
  // Quantize volume (0 to 1) into 8 active bars
  const activeBars = Math.min(8, Math.round(volume * 16));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono text-[#4e505b]">
        <span>Agent Voice Output</span>
        <span>{Math.round(volume * 100)}%</span>
      </div>
      <div className="flex items-center gap-1 h-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "flex-1 h-full rounded-sm transition-colors duration-75",
              i < activeBars
                ? "bg-[#0b5ed7]"
                : "bg-[#e7e7e7]"
            )}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 4. ENDED STATE
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
    <div className="rounded-lg border border-[#e7e7e7] bg-[#ffffff] p-6 space-y-5 shadow-xs">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full border border-[#a7f3d0] bg-[#ecfdf5] flex items-center justify-center text-[#059669]">
          <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold text-[#0a0a0a]">
            Call Session Terminated
          </h3>
          <p className="text-[12px] text-[#4e505b]">
            Session completed cleanly and written to CallRecord database.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-3 rounded-md border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#4e505b]">
            Total Elapsed Time
          </div>
          <div className="text-[14px] font-mono font-semibold text-[#0a0a0a]">
            {formatDuration(duration)}
          </div>
        </div>

        <div className="p-3 rounded-md border border-[#e7e7e7] bg-[#fafafa]">
          <div className="text-[10px] font-mono uppercase text-[#4e505b]">
            Session Room
          </div>
          <div className="text-[12px] font-mono text-[#0a0a0a] truncate">
            {roomName || "—"}
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3 pt-2">
        <button
          type="button"
          onClick={onStartAgain}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 rounded-md text-[12px] font-semibold text-[#ffffff] bg-[#0b5ed7] hover:bg-[#0a53be] active:bg-[#0948a3] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Start Another Call</span>
        </button>

        {onViewCalls && (
          <button
            type="button"
            onClick={onViewCalls}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 rounded-md text-[12px] font-semibold bg-[#ffffff] border border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#f4f4f5] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer"
          >
            <span>Open Calls Log</span>
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
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
      className="rounded-lg border border-[#fecdd3] bg-[#fff1f2] p-6 space-y-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-[#e11d48] flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-[14px] font-semibold text-[#9f1239]">
            Connection Failure
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
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 sm:py-1.5 rounded-md text-[12px] font-semibold text-[#ffffff] bg-[#e11d48] hover:bg-[#be123c] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48] cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Retry</span>
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full sm:w-auto px-3.5 py-2.5 sm:py-1.5 rounded-md text-[12px] font-medium border border-[#e7e7e7] bg-[#ffffff] text-[#0a0a0a] hover:bg-[#f4f4f5] transition-colors duration-150 cursor-pointer text-center"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
