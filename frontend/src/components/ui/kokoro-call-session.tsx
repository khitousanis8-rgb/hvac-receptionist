"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  PhoneOff,
  Bot,
  Volume2,
  Clock,
  Sparkles,
  CalendarCheck2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { kokoroTTS } from "@/lib/kokoro-tts";
import { BrowserSpeechRecognition } from "@/lib/speech-recognition";
import { apiUrl, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface KokoroCallSessionProps {
  companyName?: string;
  onCallEnded: (duration: number) => void;
  onError: (msg: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function KokoroCallSession({
  companyName,
  onCallEnded,
  onError,
}: KokoroCallSessionProps) {
  const [initProgress, setInitProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [isModelReady, setIsModelReady] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState<boolean>(false);
  const [isAgentThinking, setIsAgentThinking] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [transcriptHistory, setTranscriptHistory] = useState<ChatMessage[]>([]);
  const [currentCallerText, setCurrentCallerText] = useState<string>("");
  const [currentAssistantText, setCurrentAssistantText] = useState<string>("");

  const durationRef = useRef<number>(0);
  const sessionIdRef = useRef<string>(`session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
  const callIdRef = useRef<number | null>(null);
  const callOutcomeRef = useRef<string>("info_only");
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeUtteranceQueue = useRef<string[]>([]);
  const isProcessingQueue = useRef<boolean>(false);

  // 1. Duration Timer
  useEffect(() => {
    if (!isModelReady) return;
    const timer = setInterval(() => {
      setDuration((d) => {
        durationRef.current = d + 1;
        return d + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isModelReady]);

  // 2. Playback state listener
  useEffect(() => {
    kokoroTTS.setPlaybackStateCallback((playing) => {
      setIsAgentSpeaking(playing);
      speechRecRef.current?.pauseForAgentPlayback(playing);
    });
    return () => {
      kokoroTTS.setPlaybackStateCallback(null);
    };
  }, []);

  // Helper to split text stream into complete speakable sentences
  const queueSentenceAndSpeak = useCallback((text: string) => {
    activeUtteranceQueue.current.push(text);
    if (!isProcessingQueue.current) {
      processNextSentence();
    }
  }, []);

  const processNextSentence = async () => {
    if (activeUtteranceQueue.current.length === 0) {
      isProcessingQueue.current = false;
      return;
    }
    isProcessingQueue.current = true;
    const nextText = activeUtteranceQueue.current.shift();
    if (nextText) {
      try {
        await kokoroTTS.speak(nextText);
      } catch (err) {
        console.error("[KokoroCall] speak error:", err);
      }
    }
    processNextSentence();
  };

  // 3. Send message to backend chat streaming endpoint
  const sendMessageToAgent = useCallback(
    async (userMessage: string, currentHistory: ChatMessage[]) => {
      if (!userMessage.trim()) return;

      setIsAgentThinking(true);
      setCurrentCallerText("");
      setCurrentAssistantText("");
      activeUtteranceQueue.current = [];

      // Interrupt any current speech
      kokoroTTS.stop();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch(apiUrl("/v1/calls/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            message: userMessage,
            history: currentHistory.map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Chat request failed with HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No readable stream in response");

        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedAssistantReply = "";
        let sentenceBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "message";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.replace("event:", "").trim();
            } else if (line.startsWith("data:")) {
              const dataStr = line.replace("data:", "").trim();
              if (!dataStr) continue;

              try {
                const data = JSON.parse(dataStr);

                if (currentEvent === "call_started" && data.call_id) {
                  callIdRef.current = data.call_id;
                } else if (currentEvent === "tool_call") {
                  setActiveTool(data.name || "Checking dispatch");
                } else if (currentEvent === "delta" && data.text) {
                  setIsAgentThinking(false);
                  accumulatedAssistantReply += data.text;
                  sentenceBuffer += data.text;
                  setCurrentAssistantText(accumulatedAssistantReply);

                  // Chunk by natural speech pauses: . ? ! \n
                  const match = sentenceBuffer.match(/^(.*?[.?!:\n])\s+(.*)$/s);
                  if (match) {
                    const completeSentence = match[1].trim();
                    sentenceBuffer = match[2];
                    if (completeSentence) {
                      queueSentenceAndSpeak(completeSentence);
                    }
                  }
                } else if (currentEvent === "done") {
                  if (data.outcome) {
                    callOutcomeRef.current = data.outcome;
                  }
                  setActiveTool(null);
                } else if (currentEvent === "error") {
                  onError(data.error || "Streaming error from assistant");
                }
              } catch {
                // Ignore parse errors on partial frames
              }
            }
          }
        }

        // Speak remaining sentence buffer if any
        if (sentenceBuffer.trim()) {
          queueSentenceAndSpeak(sentenceBuffer.trim());
        }

        setIsAgentThinking(false);
        if (accumulatedAssistantReply.trim()) {
          setTranscriptHistory((prev) => [
            ...prev,
            { role: "assistant", content: accumulatedAssistantReply.trim() },
          ]);
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("[KokoroCall] chat error:", err);
          setIsAgentThinking(false);
          onError(err?.message || "Failed to communicate with receptionist");
        }
      }
    },
    [onError, queueSentenceAndSpeak]
  );

  // 4. Initialize Engine & Speech Recognition on mount
  useEffect(() => {
    let isCancelled = false;

    async function initCall() {
      try {
        setInitProgress({ pct: 10, msg: "Initializing neural voice engine…" });
        await kokoroTTS.init((pct, msg) => {
          if (!isCancelled) {
            setInitProgress({ pct, msg });
          }
        });

        if (isCancelled) return;

        setIsModelReady(true);
        setInitProgress(null);

        // Setup speech recognition
        const speech = new BrowserSpeechRecognition();
        speechRecRef.current = speech;

        speech.setCallbacks({
          onTranscript: (text, isFinal) => {
            if (isCancelled) return;
            if (isFinal) {
              setCurrentCallerText("");
              setTranscriptHistory((prev) => {
                const nextHistory: ChatMessage[] = [...prev, { role: "user", content: text }];
                sendMessageToAgent(text, prev);
                return nextHistory;
              });
            } else {
              setCurrentCallerText(text);
            }
          },
          onError: (err) => {
            console.warn("[KokoroCall] speech error:", err);
          },
        });

        // Trigger initial greeting instantly
        await sendMessageToAgent("__GREETING__", []);

        // Start listening for caller speech
        speech.start();
      } catch (err: any) {
        if (!isCancelled) {
          console.error("[KokoroCall] init failed:", err);
          onError(err?.message || "Failed to initialize in-browser voice engine");
        }
      }
    }

    initCall();

    return () => {
      isCancelled = true;
      kokoroTTS.stop();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (speechRecRef.current) {
        speechRecRef.current.stop();
      }
    };
  }, [onError, sendMessageToAgent]);

  // 5. User Controls
  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    speechRecRef.current?.setMuted(nextMuted);
  };

  const handleInterrupt = () => {
    kokoroTTS.stop();
    activeUtteranceQueue.current = [];
    setIsAgentSpeaking(false);
    speechRecRef.current?.pauseForAgentPlayback(false);
  };

  const handleEndCall = async () => {
    kokoroTTS.stop();
    activeUtteranceQueue.current = [];
    if (speechRecRef.current) {
      speechRecRef.current.stop();
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    try {
      await apiPost("/v1/calls/end", {
        session_id: sessionIdRef.current,
        call_id: callIdRef.current,
        outcome: callOutcomeRef.current,
        summary: transcriptHistory.map((m) => `${m.role}: ${m.content}`).join("\n"),
      });
    } catch {
      // ignore
    }

    onCallEnded(durationRef.current);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleEndCall();
      } else if (e.key === " " && isAgentSpeaking) {
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMuted, isAgentSpeaking]);

  // Loading / Model Download view
  if (initProgress) {
    return (
      <div className="rounded-2xl border border-[#e7e7e7] bg-white p-8 sm:p-12 text-center space-y-5 shadow-xs">
        <div className="w-14 h-14 rounded-full bg-[#eff6ff] border border-[#bfdbfe] text-[#0b5ed7] flex items-center justify-center mx-auto">
          <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
        </div>
        <div className="space-y-2 max-w-md mx-auto">
          <h3 className="text-[16px] font-semibold text-[#0a0a0a]">
            Loading In-Browser Voice Engine
          </h3>
          <p className="text-[12px] text-[#71717a]">
            {initProgress.msg}
          </p>
          <div className="w-full bg-[#f4f4f5] h-2.5 rounded-full overflow-hidden border border-[#e7e7e7] mt-3">
            <motion.div
              className="bg-[#0b5ed7] h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${initProgress.pct}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <div className="flex justify-between text-[11px] font-mono text-[#71717a] pt-1">
            <span>Free Local Kokoro-82M TTS</span>
            <span>{initProgress.pct}%</span>
          </div>
          <p className="text-[11px] text-[#059669] pt-2">
            Cached in your browser for instant future load. Zero server audio streaming fees.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Active in-browser phone call session"
      className="rounded-2xl border border-[#e7e7e7] bg-white overflow-hidden shadow-xs"
    >
      {/* ==================================================================== */}
      {/* DEDICATED PHONE EXPERIENCE (Mobile screens < md)                    */}
      {/* ==================================================================== */}
      <div className="md:hidden p-5 flex flex-col items-center justify-between min-h-[460px] text-center space-y-6">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#ecfdf5] border border-[#a7f3d0] text-[#059669] text-[10px] font-mono uppercase tracking-wider font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-[#059669] animate-pulse" aria-hidden="true" />
            <span>Local Voice Engine Active</span>
          </div>
          <div className="text-[34px] font-mono font-semibold tracking-wider text-[#0a0a0a] leading-none pt-1 tabular-nums">
            {formatDuration(duration)}
          </div>
          <div className="text-[11px] font-mono text-[#71717a]">
            100% Free · Zero Audio Clicks
          </div>
        </div>

        {/* Central Voice Avatar */}
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
              ? (activeTool ? `Dispatch: ${activeTool}…` : "Checking Technician Schedule…")
              : "Listening to your voice…"}
          </div>

          {isAgentSpeaking && (
            <div className="flex flex-col items-center gap-1">
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#eff6ff] border border-[#bfdbfe] text-[#1d4ed8] text-[10px] font-medium">
                <Volume2 className="w-3 h-3 animate-pulse" aria-hidden="true" />
                Assistant Speaking (Kokoro)
              </span>
              <button
                type="button"
                onClick={handleInterrupt}
                className="text-[11px] font-semibold text-[#0b5ed7] hover:underline cursor-pointer pt-0.5"
              >
                Tap to Interrupt [Space]
              </button>
            </div>
          )}

          <div className="px-4">
            <KokoroAudioBars isSpeaking={isAgentSpeaking} compact />
          </div>

          {currentCallerText && (
            <div className="text-[11px] font-mono text-[#0b5ed7] bg-[#eff6ff] p-2 rounded-lg border border-[#bfdbfe] truncate">
              &ldquo;{currentCallerText}&rdquo;
            </div>
          )}
        </div>

        {/* Thumb Call Controls */}
        <div className="w-full pt-4 border-t border-[#f4f4f5]">
          <div className="flex items-center justify-center gap-8">
            <div className="flex flex-col items-center gap-1.5">
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={toggleMute}
                aria-label={!isMuted ? "Mute Microphone" : "Unmute Microphone"}
                className={cn(
                  "flex items-center justify-center w-16 h-16 rounded-full border shadow-sm transition-colors cursor-pointer",
                  !isMuted
                    ? "bg-white border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#fafafa]"
                    : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                )}
              >
                {!isMuted ? (
                  <Mic className="w-6 h-6" aria-hidden="true" />
                ) : (
                  <MicOff className="w-6 h-6" aria-hidden="true" />
                )}
              </motion.button>
              <span className="text-[11px] font-medium text-[#71717a]">
                {!isMuted ? "Mute" : "Unmute"}
              </span>
            </div>

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
              Live In-Browser Receptionist
            </span>
            <span className="text-[10px] font-mono text-[#0b5ed7] bg-[#eff6ff] border border-[#bfdbfe] px-2 py-0.5 rounded">
              Kokoro-82M Voice · 0ms WebRTC Delay · $0 Cost
            </span>
          </div>

          <div className="flex items-center gap-2 text-[12px] font-mono font-semibold text-[#0a0a0a] tabular-nums">
            <Clock className="w-3.5 h-3.5 text-[#71717a]" aria-hidden="true" />
            <span>{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Two-Column Telemetry Grid */}
        <div className="p-5 grid grid-cols-2 gap-4">
          {/* Agent Card */}
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
                  ? "Speaking (Kokoro)"
                  : isAgentThinking
                  ? (activeTool ? `Running ${activeTool}` : "Checking Schedule")
                  : "Listening"}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-[#0a0a0a]">
                {companyName ? `${companyName} Assistant` : "HVAC Voice Assistant"}
              </div>
              <div className="text-[11px] text-[#71717a]">
                Local Synthesis · Direct Calendar Booking
              </div>
            </div>

            <div className="pt-2 border-t border-[#f4f4f5]">
              <KokoroAudioBars isSpeaking={isAgentSpeaking} />
            </div>

            {currentAssistantText && (
              <p className="text-[11px] text-[#4e505b] italic border-l-2 border-[#bfdbfe] pl-2 line-clamp-2">
                &ldquo;{currentAssistantText}&rdquo;
              </p>
            )}
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
                  !isMuted
                    ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]"
                    : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
                )}
              >
                {!isMuted ? "Microphone Live" : "Microphone Muted"}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-[#0a0a0a]">
                Your Voice (Homeowner / Caller)
              </div>
              <div className="text-[11px] text-[#71717a]">
                Speak naturally about your AC or heating problem
              </div>
            </div>

            <div className="pt-2 border-t border-[#f4f4f5] text-[11px]">
              {!isMuted ? (
                isAgentSpeaking ? (
                  <div className="flex items-center justify-between gap-2 p-1.5 rounded-md bg-[#eff6ff] border border-[#bfdbfe]">
                    <span className="text-[#1d4ed8] flex items-center gap-1.5 font-medium text-[11px]">
                      <Volume2 className="w-3.5 h-3.5 text-[#1d4ed8] animate-pulse" aria-hidden="true" />
                      Assistant speaking · Your turn next
                    </span>
                    <button
                      type="button"
                      onClick={handleInterrupt}
                      className="text-[11px] font-semibold text-[#0b5ed7] hover:underline cursor-pointer"
                    >
                      Interrupt [Space]
                    </button>
                  </div>
                ) : isAgentThinking ? (
                  <span className="text-[#d97706] flex items-center gap-1.5 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#d97706] animate-ping" aria-hidden="true" />
                    {activeTool ? `Executing ${activeTool}…` : "Checking technician schedule…"}
                  </span>
                ) : (
                  <span className="text-[#059669] flex items-center gap-1.5 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#059669] animate-pulse" aria-hidden="true" />
                    Your Turn · Speak naturally to receptionist
                  </span>
                )
              ) : (
                <span className="text-[#71717a]">
                  Microphone is muted. Press [M] or click unmute below.
                </span>
              )}
            </div>

            {currentCallerText && (
              <p className="text-[11px] text-[#0b5ed7] font-mono bg-[#eff6ff] p-1.5 rounded border border-[#bfdbfe] truncate">
                Hearing: &ldquo;{currentCallerText}&rdquo;
              </p>
            )}
          </div>
        </div>

        {/* Action Controls Footer */}
        <div className="px-5 py-3.5 flex items-center justify-between gap-3 bg-[#fafafa]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={isMuted}
              className={cn(
                "inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[12px] font-semibold border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b5ed7] cursor-pointer",
                !isMuted
                  ? "bg-white border-[#e7e7e7] text-[#0a0a0a] hover:bg-[#f4f4f5]"
                  : "bg-[#fff1f2] border-[#fecdd3] text-[#e11d48]"
              )}
            >
              {!isMuted ? (
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

            {isAgentSpeaking && (
              <button
                type="button"
                onClick={handleInterrupt}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold bg-[#eff6ff] border border-[#bfdbfe] text-[#1d4ed8] hover:bg-[#dbeafe] cursor-pointer transition-colors"
              >
                <span>Interrupt Assistant [Space]</span>
              </button>
            )}
          </div>

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
 * Visual Frequency Meter reading from Kokoro AnalyserNode
 */
function KokoroAudioBars({ isSpeaking, compact = false }: { isSpeaking: boolean; compact?: boolean }) {
  const [activeBars, setActiveBars] = useState<number>(0);

  useEffect(() => {
    let animId: number;
    const analyser = kokoroTTS.getAnalyserNode();

    if (!isSpeaking || !analyser) {
      setActiveBars(0);
      return;
    }

    const data = new Uint8Array(analyser.frequencyBinCount);

    const checkVolume = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i];
      }
      const avg = sum / (data.length || 1);
      const bars = Math.min(8, Math.round((avg / 128) * 8));
      setActiveBars(bars);
      animId = requestAnimationFrame(checkVolume);
    };

    animId = requestAnimationFrame(checkVolume);
    return () => cancelAnimationFrame(animId);
  }, [isSpeaking]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono text-[#71717a]">
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" aria-hidden="true" /> Voice Energy (Kokoro-82M)
        </span>
        <span className="tabular-nums">{Math.round((activeBars / 8) * 100)}%</span>
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

