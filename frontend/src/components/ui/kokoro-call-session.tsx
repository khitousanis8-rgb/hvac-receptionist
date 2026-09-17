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
import {
  type ClientTelemetry,
  type MicPermissionState,
  type EndReason,
  detectPlatformClass,
  detectBrowserEngine,
  queryMicPermission,
} from "@/lib/telemetry";
import { normalizeSpokenText, findClauseSplit } from "@/lib/text-normalization";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ConfirmationTicketData {
  ticket_id: string;
  service: string;
  phone: string;
  date: string;
  time: string;
  fingerprint: string;
  expires_in_seconds?: number;
}

interface KokoroCallSessionProps {
  companyName?: string;
  initialMediaStream?: MediaStream | null;
  onCallEnded: (duration: number, telemetry?: ClientTelemetry) => void;
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
  initialMediaStream,
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
  const [confirmationTicket, setConfirmationTicket] = useState<ConfirmationTicketData | null>(null);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [confirmedBookingId, setConfirmedBookingId] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);

  const durationRef = useRef<number>(0);
  const isMutedRef = useRef<boolean>(false);
  const isAgentSpeakingRef = useRef<boolean>(false);
  const sessionIdRef = useRef<string>(`session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
  const callSecretRef = useRef<string>(createCallSecret());
  const callIdRef = useRef<number | null>(null);
  const callOutcomeRef = useRef<string>("info_only");
  const callEndRequestedRef = useRef<boolean>(false);
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const transcriptHistoryRef = useRef<ChatMessage[]>([]);
  const visibilityGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Telemetry tracking refs
  const callStartTimeRef = useRef<number>(Date.now());
  const firstAssistantAudioMsRef = useRef<number | null>(null);
  const firstCallerTranscriptMsRef = useRef<number | null>(null);
  const ttsErrorCountRef = useRef<number>(0);
  const endReasonRef = useRef<EndReason>("caller_hangup");
  const micPermissionRef = useRef<MicPermissionState>("unknown");

  const getFullTelemetry = useCallback((): ClientTelemetry => {
    return {
      platform_class: detectPlatformClass(),
      browser_engine: detectBrowserEngine(),
      input_path: speechRecRef.current?.getInputPath() ?? "native_web_speech",
      mic_permission: micPermissionRef.current,
      first_assistant_audio_ms: firstAssistantAudioMsRef.current,
      first_caller_transcript_ms: firstCallerTranscriptMsRef.current,
      echo_suppressions: speechRecRef.current?.getEchoSuppressionCount() ?? 0,
      stt_errors: speechRecRef.current?.getSttErrorCount() ?? 0,
      tts_errors: ttsErrorCountRef.current,
      end_reason: endReasonRef.current,
    };
  }, []);

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
      isAgentSpeakingRef.current = playing;
      if (playing && firstAssistantAudioMsRef.current === null) {
        firstAssistantAudioMsRef.current = Date.now() - callStartTimeRef.current;
      }
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
    async (userMessage: string) => {
      if (!userMessage.trim()) return;

      setIsAgentThinking(true);
      setCurrentCallerText("");
      setCurrentAssistantText("");

      // Immediately pause speech recognition so mic is completely dead while agent thinks & responds
      speechRecRef.current?.pauseForAgentPlayback(true);

      // Interrupt any current speech and cancel any in-flight request
      neuralVoice.stop();
      // Ensure microphone remains locked in paused state after neuralVoice.stop()
      speechRecRef.current?.pauseForAgentPlayback(true);

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHAT_REQUEST_TIMEOUT_MS);

      try {
        const startTelemetry: ClientTelemetry = {
          platform_class: detectPlatformClass(),
          browser_engine: detectBrowserEngine(),
          input_path: speechRecRef.current?.getInputPath() ?? "native_web_speech",
          mic_permission: micPermissionRef.current,
        };

        // Server-owned conversation authority: Send only userMessage + credentials + telemetry.
        // Client history is stripped to ensure server CallTurn records remain the sole authority.
        const response = await fetch(apiUrl("/v1/calls/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            message: userMessage,
            call_id: callIdRef.current,
            call_secret: callSecretRef.current,
            client_telemetry: startTelemetry,
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
                } else if (currentEvent === "confirmation_ticket") {
                  setConfirmationTicket(data);
                  setConfirmationError(null);
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
                  // Phase 5: Drain every completed sentence from sentenceBuffer in a loop
                  while (true) {
                    const split = findClauseSplit(sentenceBuffer, !hasEmittedFirstChunk);
                    if (!split || !split.sentence) {
                      break;
                    }
                    sentenceBuffer = split.rest;
                    if (!hasEmittedFirstChunk) {
                      hasEmittedFirstChunk = true;
                    }
                    if (!split.sentence.toLowerCase().includes("echo of my own voice")) {
                      speechRecRef.current?.registerAssistantSpeech(split.sentence);
                      const spoken = normalizeSpokenText(split.sentence);
                      if (spoken.trim()) {
                        neuralVoice.speakSentence(spoken);
                      }
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
                  ttsErrorCountRef.current++;
                  console.warn("[KokoroCall] Assistant stream notice:", data.error);
                }
              } catch {
                // Ignore parse errors on partial frames
              }
            }
          }
        }

        // Speak remaining sentence buffer if any (Phase 5 sentence draining)
        if (sentenceBuffer.trim()) {
          if (!sentenceBuffer.toLowerCase().includes("echo of my own voice")) {
            speechRecRef.current?.registerAssistantSpeech(sentenceBuffer.trim());
            const spoken = normalizeSpokenText(sentenceBuffer.trim());
            if (spoken.trim()) {
              neuralVoice.speakSentence(spoken);
            }
          }
          sentenceBuffer = "";
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
          ttsErrorCountRef.current++;
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

        // Query microphone permission state asynchronously
        void queryMicPermission().then((perm) => {
          if (perm !== "unknown") {
            micPermissionRef.current = perm;
          }
        });

        if (initialMediaStream) {
          micPermissionRef.current = "granted";
        }

        // Setup speech recognition
        const speech = new BrowserSpeechRecognition(initialMediaStream);
        speechRecRef.current = speech;

        speech.setCallbacks({
          onTranscript: (text, isFinal) => {
            if (isCancelled) return;
            if (text.trim()) {
              micPermissionRef.current = "granted";
              if (firstCallerTranscriptMsRef.current === null) {
                firstCallerTranscriptMsRef.current = Date.now() - callStartTimeRef.current;
              }
            }
            if (isFinal) {
              setCurrentCallerText("");
              transcriptHistoryRef.current = [
                ...transcriptHistoryRef.current,
                { role: "user", content: text },
              ];
              void sendMessageToAgent(text);
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
            isAgentSpeakingRef.current = false;
            setIsAgentThinking(false);
            speechRecRef.current?.resumeImmediatelyForInterrupt();
          },
          onError: (err) => {
            console.warn("[VoiceCall] speech notice:", err);
            if (
              typeof err === "string" &&
              (err.toLowerCase().includes("denied") || err.toLowerCase().includes("not-allowed"))
            ) {
              micPermissionRef.current = "denied";
              endReasonRef.current = "mic_denied";
            }
          },
        });

        // Pause microphone immediately so opening greeting audio is not captured as echo
        speech.pauseForAgentPlayback(true);

        // Start listening (in paused state) so permission is requested and mic is primed
        speech.start();

        // Trigger initial greeting in parallel
        void sendMessageToAgent("__GREETING__");
      } catch (err: any) {
        if (!isCancelled) {
          console.error("[VoiceCall] init failed:", err);
          endReasonRef.current = "error";
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
      if (visibilityGraceTimerRef.current) {
        clearTimeout(visibilityGraceTimerRef.current);
        visibilityGraceTimerRef.current = null;
      }
      const callId = callIdRef.current;
      if (callId && !callEndRequestedRef.current) {
        callEndRequestedRef.current = true;
        if (callOutcomeRef.current === "booked") {
          endReasonRef.current = "assistant_completed";
        } else if (endReasonRef.current === "caller_hangup") {
          endReasonRef.current = "session_aborted";
        }
        const rawSummary = transcriptHistoryRef.current
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n");
        const safeSummary = rawSummary ? rawSummary.slice(0, 3000) : "Call ended";
        const fullTelemetry = getFullTelemetry();

        void fetch(apiUrl("/v1/calls/end"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            call_id: callId,
            call_secret: callSecretRef.current,
            outcome: callOutcomeRef.current,
            summary: safeSummary,
            client_telemetry: fullTelemetry,
          }),
          keepalive: true,
        });
      }
    };
  }, [sendMessageToAgent, getFullTelemetry]);

  // Lifecycle listeners: pagehide for immediate unload, visibilitychange with 45s grace period for mobile continuity
  useEffect(() => {
    const handleFinalize = (reason: EndReason = "page_unload") => {
      if (visibilityGraceTimerRef.current) {
        clearTimeout(visibilityGraceTimerRef.current);
        visibilityGraceTimerRef.current = null;
      }
      const callId = callIdRef.current;
      if (callId && !callEndRequestedRef.current) {
        callEndRequestedRef.current = true;
        endReasonRef.current = reason;

        const rawSummary = transcriptHistoryRef.current
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n");
        const safeSummary = rawSummary
          ? rawSummary.slice(0, 3000)
          : "Call terminated due to page unload";

        const telemetryPayload = getFullTelemetry();
        telemetryPayload.end_reason = reason;

        const payload = JSON.stringify({
          session_id: sessionIdRef.current,
          call_id: callId,
          call_secret: callSecretRef.current,
          outcome: callOutcomeRef.current,
          summary: safeSummary,
          client_telemetry: telemetryPayload,
        });

        // 1. Primary: fetch with keepalive: true (supports JSON body and cross-origin CORS safely)
        try {
          void fetch(apiUrl("/v1/calls/end"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          });
        } catch {
          // 2. Fallback: navigator.sendBeacon
          if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
            navigator.sendBeacon(
              apiUrl("/v1/calls/end"),
              new Blob([payload], { type: "application/json" })
            );
          }
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Mobile continuity: start 45s grace period before finalizing
        if (!visibilityGraceTimerRef.current && !callEndRequestedRef.current) {
          visibilityGraceTimerRef.current = setTimeout(() => {
            visibilityGraceTimerRef.current = null;
            handleFinalize("page_unload");
          }, 45_000);
        }
      } else if (document.visibilityState === "visible") {
        // User switched back before grace period expired
        if (visibilityGraceTimerRef.current) {
          clearTimeout(visibilityGraceTimerRef.current);
          visibilityGraceTimerRef.current = null;
        }
        // Ensure recognition is listening if call is active, unmuted, and assistant not speaking
        if (!isMutedRef.current && !isAgentSpeakingRef.current && speechRecRef.current) {
          void speechRecRef.current.start();
        }
      }
    };

    const handlePageHide = () => {
      handleFinalize("page_unload");
    };

    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (visibilityGraceTimerRef.current) {
        clearTimeout(visibilityGraceTimerRef.current);
        visibilityGraceTimerRef.current = null;
      }
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [getFullTelemetry]);

  // Handle intentional confirmation of single-use ticket
  const handleConfirmBooking = async () => {
    if (!confirmationTicket || isConfirming || confirmedBookingId) return;
    setIsConfirming(true);
    setConfirmationError(null);

    try {
      const res = await apiPost<{
        status: string;
        booking_id?: number | string;
        already_confirmed?: boolean;
        message?: string;
      }>("/v1/calls/confirm-booking", {
        session_id: sessionIdRef.current,
        call_id: callIdRef.current,
        call_secret: callSecretRef.current,
        ticket_id: confirmationTicket.ticket_id,
        fingerprint: confirmationTicket.fingerprint,
      });

      const bookingId = res?.booking_id ? String(res.booking_id) : "confirmed";
      setConfirmedBookingId(bookingId);
      callOutcomeRef.current = "booked";

      // Reassuring spoken confirmation
      const confirmSpeech = "Your appointment is confirmed! Our technician will see you then.";
      setCurrentAssistantText(confirmSpeech);
      neuralVoice.speakSentence(confirmSpeech);
      neuralVoice.endTurnQueue();
    } catch (err: any) {
      console.error("[KokoroCall] Failed to confirm booking:", err);
      setConfirmationError(err?.message || "Failed to confirm booking. Please try again.");
    } finally {
      setIsConfirming(false);
    }
  };

  const renderReviewCard = (compact: boolean = false) => {
    if (!confirmationTicket) return null;

    return (
      <AnimatePresence>
        <motion.div
          key="booking-review-card"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          data-testid="booking-review-card"
          className={cn(
            "w-full rounded-xl border transition-all text-left shadow-xs",
            confirmedBookingId
              ? "border-[#a7f3d0] bg-[#f0fdf4]"
              : "border-[#bfdbfe] bg-[#f8faff]",
            compact ? "p-3.5 my-2" : "p-4 my-3"
          )}
        >
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-1.5">
              <CalendarCheck2
                className={cn(
                  "w-4 h-4 shrink-0",
                  confirmedBookingId ? "text-[#059669]" : "text-[#0b5ed7]"
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "text-[12px] font-semibold uppercase tracking-wider",
                  confirmedBookingId ? "text-[#059669]" : "text-[#0b5ed7]"
                )}
              >
                {confirmedBookingId ? "Booking Confirmed" : "Review Appointment Details"}
              </span>
            </div>
            {confirmationTicket.expires_in_seconds && !confirmedBookingId && (
              <span className="text-[10px] font-mono text-[#71717a]">
                Ticket #{confirmationTicket.ticket_id.slice(-6)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] mb-3 bg-white/90 rounded-lg p-2.5 border border-[#e7e7e7]/70">
            <div>
              <span className="text-[10px] font-mono uppercase text-[#71717a] block">Service</span>
              <span className="font-medium text-[#0a0a0a]">{confirmationTicket.service}</span>
            </div>
            <div>
              <span className="text-[10px] font-mono uppercase text-[#71717a] block">Phone</span>
              <span className="font-medium text-[#0a0a0a]">{confirmationTicket.phone}</span>
            </div>
            <div className="col-span-2 pt-1 border-t border-[#f4f4f5]">
              <span className="text-[10px] font-mono uppercase text-[#71717a] block">Date & Time</span>
              <span className="font-medium text-[#0a0a0a]">
                {confirmationTicket.date} at {confirmationTicket.time}
              </span>
            </div>
          </div>

          {confirmationError && (
            <div className="mb-2.5 p-2 rounded-lg bg-[#fff1f2] border border-[#fecdd3] text-[#e11d48] text-[11px] flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{confirmationError}</span>
            </div>
          )}

          {confirmedBookingId ? (
            <div className="p-2.5 rounded-lg bg-[#ecfdf5] border border-[#a7f3d0] text-center">
              <span className="text-[12px] font-semibold text-[#059669] flex items-center justify-center gap-1.5">
                <CalendarCheck2 className="w-4 h-4" aria-hidden="true" />
                Confirmed (Ref #{confirmedBookingId})
              </span>
              <p className="text-[11px] text-[#047857] mt-0.5">
                Our technician has been scheduled.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <button
                type="button"
                data-testid="confirm-booking-button"
                disabled={isConfirming}
                onClick={handleConfirmBooking}
                className={cn(
                  "w-full min-h-[48px] px-4 py-2.5 rounded-lg font-semibold text-[13px] text-white transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer",
                  isConfirming
                    ? "bg-[#93c5fd] cursor-not-allowed"
                    : "bg-[#0b5ed7] hover:bg-[#0a58ca] active:scale-[0.98]"
                )}
              >
                {isConfirming ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Confirming Booking…</span>
                  </>
                ) : (
                  <>
                    <CalendarCheck2 className="w-4 h-4" aria-hidden="true" />
                    <span>Confirm Booking</span>
                  </>
                )}
              </button>
              <p className="text-[10px] text-[#71717a] text-center">
                Tap to confirm. Voice response alone does not finalize the booking.
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    );
  };

  // 5. User Controls
  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    isMutedRef.current = nextMuted;
    speechRecRef.current?.setMuted(nextMuted);
  };

  const handleInterrupt = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    neuralVoice.stop();
    setIsAgentSpeaking(false);
    isAgentSpeakingRef.current = false;
    setIsAgentThinking(false);
    speechRecRef.current?.resumeImmediatelyForInterrupt();
  };

  const handleEndCall = async () => {
    if (visibilityGraceTimerRef.current) {
      clearTimeout(visibilityGraceTimerRef.current);
      visibilityGraceTimerRef.current = null;
    }
    if (callEndRequestedRef.current) return;
    callEndRequestedRef.current = true;
    if (callOutcomeRef.current === "booked") {
      endReasonRef.current = "assistant_completed";
    } else if (!endReasonRef.current || endReasonRef.current === "caller_hangup") {
      endReasonRef.current = "caller_hangup";
    }

    neuralVoice.stop();
    if (speechRecRef.current) {
      speechRecRef.current.stop();
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const rawSummary = transcriptHistoryRef.current
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const safeSummary = rawSummary ? rawSummary.slice(0, 3000) : "Call completed";
    const fullTelemetry = getFullTelemetry();

    try {
      await apiPost("/v1/calls/end", {
        session_id: sessionIdRef.current,
        call_id: callIdRef.current,
        call_secret: callSecretRef.current,
        outcome: callOutcomeRef.current,
        summary: safeSummary,
        client_telemetry: fullTelemetry,
      });
    } catch (err) {
      console.warn("[KokoroCall] call log finalization failed, retrying minimal payload:", err);
      try {
        await apiPost("/v1/calls/end", {
          session_id: sessionIdRef.current,
          call_id: callIdRef.current,
          call_secret: callSecretRef.current,
          outcome: callOutcomeRef.current,
          summary: "Call completed",
          client_telemetry: fullTelemetry,
        });
      } catch (retryErr) {
        console.error("[KokoroCall] minimal call finalization failed:", retryErr);
      }
    }

    onCallEnded(durationRef.current, fullTelemetry);
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
                aria-label="Interrupt Assistant Speech"
                className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 mt-1 rounded-full text-[12px] font-semibold text-[#0b5ed7] bg-[#eff6ff] border border-[#bfdbfe] hover:bg-[#dbeafe] active:scale-95 transition-transform cursor-pointer"
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

        {/* Booking Review Card */}
        {renderReviewCard(true)}

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

        {/* Booking Review Card */}
        {confirmationTicket && (
          <div className="px-5 py-3 bg-[#fafafa]/60 border-t border-[#e7e7e7]">
            {renderReviewCard(false)}
          </div>
        )}

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
