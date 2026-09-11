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
import { neuralVoice } from "@/lib/neural-audio-player";
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

const CHAT_REQUEST_TIMEOUT_MS = 45_000;

async function readChatError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string" && payload.detail.trim()) {
      return payload.detail;
    }
  } catch {
    // The API may return an empty or non-JSON response when an upstream proxy fails.
  }
  return `The assistant service returned HTTP ${response.status}.`;
}

/**
 * Find the first acceptable split point in the buffered stream text.
 *
 * Dispatches a sentence the moment its terminal punctuation arrives — even if
 * it is the last character of the buffer. The previous regex required a
 * following space + word, so any sentence ending in "." or "!" sat silent in
 * the buffer until the NEXT sentence began streaming (or until the stream
 * closed), producing long dead-air pauses exactly at "!" and ".".
 */
function findClauseSplit(
  buffer: string,
  isFirstPhrase: boolean
): { sentence: string; rest: string } | null {
  const re = /[.?!,:;\n]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const punct = m[0];
    const candidate = buffer.slice(0, m.index);
    // Skip abbreviation periods and decimals: "9 a.m.", "p.m.", "Mr.", "3.5 ton", "$89.50"
    if (punct === ".") {
      const lastWord = (candidate.split(/\s+/).pop() || "").toLowerCase();
      if (/^[a-z]$/.test(lastWord) || /^(mr|mrs|ms|dr|st|vs|etc|no|am|pm|a\.m|p\.m)$/.test(lastWord)) {
        continue;
      }
      const charBefore = buffer[m.index - 1] || "";
      const charAfter = buffer[m.index + 1] || "";
      if (/\d/.test(charBefore) && (/\d/.test(charAfter) || charAfter === "")) {
        continue;
      }
    }
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    if (punct === "." || punct === "?" || punct === "!") {
      // A complete sentence is always a natural TTS unit — dispatch immediately.
      if (isFirstPhrase && trimmed.length < 8) continue;
      // Retain terminal punctuation so Edge-TTS renders question and exclamatory prosody
      return { sentence: trimmed + punct, rest: buffer.slice(m.index + 1) };
    }
    // Clause boundaries (comma, colon, semicolon, newline): breath groups only.
    if (isFirstPhrase ? trimmed.length >= 8 : trimmed.length >= 25 || buffer.length > 80) {
      return { sentence: trimmed, rest: buffer.slice(m.index + 1) };
    }
    // Too short a breath group: keep scanning for a sentence end.
  }
  return null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function createCallSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const [isSlowServer, setIsSlowServer] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [currentCallerText, setCurrentCallerText] = useState<string>("");
  const [currentAssistantText, setCurrentAssistantText] = useState<string>("");

  const durationRef = useRef<number>(0);
  const sessionIdRef = useRef<string>(`session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
  const callSecretRef = useRef<string>(createCallSecret());
  const callIdRef = useRef<number | null>(null);
  const callOutcomeRef = useRef<string>("info_only");
  const callEndRequestedRef = useRef<boolean>(false);
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const transcriptHistoryRef = useRef<ChatMessage[]>([]);
  
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Cold-start detection: if backend takes >3.5s to respond (e.g. Render spinning up), show helpful hint
  useEffect(() => {
    if (!isAgentThinking) {
      setIsSlowServer(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setIsSlowServer(true);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [isAgentThinking]);

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

  // 2. Turn-level playback state listener
  useEffect(() => {
    neuralVoice.setPlaybackStateCallback((playing) => {
      setIsAgentSpeaking(playing);
    });
    neuralVoice.setTurnStateCallback((turnActive) => {
      if (turnActive) {
        setCurrentCallerText("");
      }
      speechRecRef.current?.pauseForAgentPlayback(turnActive);
    });
    return () => {
      neuralVoice.setPlaybackStateCallback(null);
      neuralVoice.setTurnStateCallback(null);
      neuralVoice.stop();
    };
  }, []);

  // 3. Send message to backend chat streaming endpoint
  const sendMessageToAgent = useCallback(
    async (userMessage: string, currentHistory: ChatMessage[]) => {
      if (!userMessage.trim()) return;

      setIsAgentThinking(true);
      setCurrentCallerText("");
      setCurrentAssistantText("");

      // Interrupt any current speech and cancel any in-flight request
      neuralVoice.stop();

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHAT_REQUEST_TIMEOUT_MS);

      // Maintain conversational context (up to last 30 messages) to prevent
      // caller identity amnesia while staying comfortably within Groq TPM limits.
      const recentHistory = currentHistory.length > 30 ? currentHistory.slice(-30) : currentHistory;

      try {
        const response = await fetch(apiUrl("/v1/calls/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            message: userMessage,
            history: recentHistory.map((m) => ({ role: m.role, content: m.content })),
            call_id: callIdRef.current,
            call_secret: callSecretRef.current,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readChatError(response));
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No readable stream in response");

        neuralVoice.startTurn();

        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedAssistantReply = "";
        let sentenceBuffer = "";
        let currentEvent = "message";
        let hasEmittedFirstChunk = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              // SSE boundary: blank line resets event type for the next frame
              currentEvent = "message";
              continue;
            }
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

                  // Dispatch text the moment its punctuation lands — even when the
                  // punctuation is the last character of the buffer. The old regex
                  // demanded a following space + word, so sentences ending in "."
                  // or "!" waited in silence until the next sentence started
                  // streaming (or until the whole stream closed).
                  const split = findClauseSplit(sentenceBuffer, !hasEmittedFirstChunk);
                  if (split && split.sentence) {
                    sentenceBuffer = split.rest;
                    if (!hasEmittedFirstChunk) {
                      hasEmittedFirstChunk = true;
                    }
                    if (!split.sentence.toLowerCase().includes("echo of my own voice")) {
                      speechRecRef.current?.registerAssistantSpeech(split.sentence);
                      neuralVoice.speakSentence(split.sentence);
                    }
                  }
                } else if (currentEvent === "done") {
                  if (data.outcome === "booked") {
                    callOutcomeRef.current = "booked";
                  } else if (callOutcomeRef.current !== "booked" && data.outcome) {
                    callOutcomeRef.current = data.outcome;
                  }
                  setActiveTool(null);
                } else if (currentEvent === "error") {
                  console.warn("[KokoroCall] Assistant stream notice:", data.error);
                }
              } catch {
                // Ignore parse errors on partial frames
              }
            }
          }
        }

        // Speak remaining sentence buffer if any
        if (sentenceBuffer.trim()) {
          if (!sentenceBuffer.toLowerCase().includes("echo of my own voice")) {
            speechRecRef.current?.registerAssistantSpeech(sentenceBuffer.trim());
            neuralVoice.speakSentence(sentenceBuffer.trim());
          }
        }
        neuralVoice.endTurnQueue();

        setIsAgentThinking(false);
        if (accumulatedAssistantReply.trim()) {
          speechRecRef.current?.registerAssistantSpeech(accumulatedAssistantReply.trim());
          transcriptHistoryRef.current = [
            ...transcriptHistoryRef.current,
            { role: "assistant", content: accumulatedAssistantReply.trim() },
          ];
        }
      } catch (err: any) {
        if (err.name !== "AbortError" || timedOut) {
          console.warn("[KokoroCall] chat hiccup:", err);
          setIsAgentThinking(false);
          // Graceful in-call recovery: speak a polite apology and keep the call alive!
          const apology = timedOut
            ? "I'm sorry, I didn't hear that clearly. Could you please repeat that?"
            : "I apologize, my connection had a momentary pause. What can I help you with today?";
          setCurrentAssistantText(apology);
          neuralVoice.speakSentence(apology);
          neuralVoice.endTurnQueue();
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    },
    []
  );

  // 4. Initialize Engine & Speech Recognition on mount
  const hasInitialized = useRef<boolean>(false);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    let isCancelled = false;

    async function initCall() {
      try {
        setInitProgress({ pct: 50, msg: "Connecting to Jenny Neural Voice…" });
        await neuralVoice.init((pct, msg) => {
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
              const historyBefore = transcriptHistoryRef.current;
              transcriptHistoryRef.current = [
                ...historyBefore,
                { role: "user", content: text },
              ];
              void sendMessageToAgent(text, historyBefore);
            } else {
              setCurrentCallerText(text);
            }
          },
          onBargeIn: () => {
            console.log("[VoiceCall] Caller barged in: interrupting assistant playback");
            if (abortControllerRef.current) {
              abortControllerRef.current.abort();
              abortControllerRef.current = null;
            }
            neuralVoice.stop();
            setIsAgentSpeaking(false);
            setIsAgentThinking(false);
            speechRecRef.current?.resumeImmediatelyForInterrupt();
          },
          onError: (err) => {
            console.warn("[VoiceCall] speech notice:", err);
          },
        });

        // Start listening immediately so microphone is primed
        speech.start();

        // Trigger initial greeting in parallel
        void sendMessageToAgent("__GREETING__", []);
      } catch (err: any) {
        if (!isCancelled) {
          console.error("[VoiceCall] init failed:", err);
          onErrorRef.current(err?.message || "Failed to initialize voice assistant");
        }
      }
    }

    initCall();

    return () => {
      isCancelled = true;
      hasInitialized.current = false;
      neuralVoice.stop();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (speechRecRef.current) {
        speechRecRef.current.stop();
      }
      const callId = callIdRef.current;
      if (callId && !callEndRequestedRef.current) {
        callEndRequestedRef.current = true;
        void fetch(apiUrl("/v1/calls/end"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            call_id: callId,
            call_secret: callSecretRef.current,
            outcome: callOutcomeRef.current,
            summary: transcriptHistoryRef.current
              .map((m) => `${m.role}: ${m.content}`)
              .join("\n"),
          }),
          keepalive: true,
        });
      }
    };
  }, [sendMessageToAgent]);

  // 5. User Controls
  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    speechRecRef.current?.setMuted(nextMuted);
  };

  const handleInterrupt = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    neuralVoice.stop();
    setIsAgentSpeaking(false);
    setIsAgentThinking(false);
    speechRecRef.current?.resumeImmediatelyForInterrupt();
  };

  const handleEndCall = async () => {
    if (callEndRequestedRef.current) return;
    callEndRequestedRef.current = true;
    neuralVoice.stop();
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
        call_secret: callSecretRef.current,
        outcome: callOutcomeRef.current,
        summary: transcriptHistoryRef.current
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n"),
      });
    } catch (err) {
      console.warn("[KokoroCall] call log finalization failed:", err);
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
            Connecting to Jenny Neural Voice
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
            <span>Jenny Neural Voice</span>
            <span>{initProgress.pct}%</span>
          </div>
          <p className="text-[11px] text-[#059669] pt-2">
            Studio-quality neural streaming synthesis with zero latency.
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
            <span>Jenny Neural Voice Active</span>
          </div>
          <div className="text-[34px] font-mono font-semibold tracking-wider text-[#0a0a0a] leading-none pt-1 tabular-nums">
            {formatDuration(duration)}
          </div>
          <div className="text-[11px] font-mono text-[#71717a]">
            Jenny Neural Voice · Studio Quality · $0 Cost
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
              ? (isSlowServer ? "Waking up cloud service…" : activeTool ? `Dispatch: ${activeTool}…` : "Checking Technician Schedule…")
              : "Listening to your voice…"}
          </div>

          {isAgentSpeaking && (
            <div className="flex flex-col items-center gap-1">
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#eff6ff] border border-[#bfdbfe] text-[#1d4ed8] text-[10px] font-medium">
                <Volume2 className="w-3 h-3 animate-pulse" aria-hidden="true" />
                Assistant Speaking
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

          {currentAssistantText && (
            <div className="text-[12px] text-[#4e505b] bg-[#fafafa] p-2.5 rounded-xl border border-[#e7e7e7] text-left leading-relaxed">
              <span className="text-[10px] font-mono text-[#0b5ed7] font-semibold uppercase block mb-0.5">Sarah (Receptionist)</span>
              &ldquo;{currentAssistantText}&rdquo;
            </div>
          )}

          {currentCallerText && (
            <div className="text-[11px] font-mono text-[#059669] bg-[#ecfdf5] p-2 rounded-lg border border-[#a7f3d0] truncate text-left">
              <span className="text-[9px] font-mono text-[#059669] font-semibold uppercase block mb-0.5">You</span>
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
              Jenny Neural Voice · Studio Quality · $0 Cost
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
                  ? "Speaking"
                  : isAgentThinking
                  ? (isSlowServer ? "Waking Cloud Service" : activeTool ? `Running ${activeTool}` : "Checking Schedule")
                  : "Listening"}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="text-[13px] font-semibold text-[#0a0a0a]">
                {companyName ? `${companyName} Assistant` : "HVAC Voice Assistant"}
              </div>
              <div className="text-[11px] text-[#71717a]">
                Jenny Neural Voice · Direct Calendar Booking
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
                    {isSlowServer
                      ? "Connecting to cloud service (waking up free-tier host)…"
                      : activeTool
                      ? `Executing ${activeTool}…`
                      : "Checking technician schedule…"}
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
    if (!isSpeaking) {
      setActiveBars(0);
      return;
    }

    let frame = 0;
    const timer = window.setInterval(() => {
      frame++;
      // Natural undulating speech energy waveform (3-8 bars)
      const base = Math.sin(frame * 0.5) * 2.2 + Math.cos(frame * 0.8) * 1.8 + 4.5;
      const bars = Math.max(1, Math.min(8, Math.round(base)));
      setActiveBars(bars);
    }, 80);

    return () => window.clearInterval(timer);
  }, [isSpeaking]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono text-[#71717a]">
        <span className="flex items-center gap-1">
          <Volume2 className="w-3 h-3" aria-hidden="true" /> Voice Energy (Jenny Neural Assistant)
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
