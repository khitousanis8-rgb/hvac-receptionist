/**
 * Browser Speech Recognition service.
 * Uses Web Speech API (SpeechRecognition / webkitSpeechRecognition) for instant,
 * zero-latency, 100% free speech-to-text.
 * Provides automatic fallback to MediaRecorder + Groq Whisper API for browsers without Web Speech support.
 */

import { apiPost } from "./api.ts";
import { type InputPath, detectPlatformClass, detectBrowserEngine } from "./telemetry.ts";
import { neuralVoice } from "./neural-audio-player.ts";

export type SpeechTranscriptCallback = (text: string, isFinal: boolean) => void;
export type SpeechStateCallback = (isListening: boolean) => void;
export type SpeechErrorCallback = (error: string) => void;
export type SpeechBargeInCallback = () => void;
export type SpeechInputPathCallback = (path: InputPath) => void;

interface TranscribeResponse {
  transcript: string;
}

export class BrowserSpeechRecognition {
  private recognition: any = null;
  private isSupported: boolean = false;
  private isListening: boolean = false;
  private shouldBeListening: boolean = false;
  private isPausedForAgent: boolean = false;
  private isMuted: boolean = false;

  private onTranscript: SpeechTranscriptCallback | null = null;
  private onStateChange: SpeechStateCallback | null = null;
  private onError: SpeechErrorCallback | null = null;
  private onBargeIn: SpeechBargeInCallback | null = null;
  private onInputPathChange: SpeechInputPathCallback | null = null;

  private echoSuppressionCount: number = 0;
  private sttErrorCount: number = 0;

  private debounceTimer: number | null = null;
  private cooldownTimer: number | null = null;
  private accumulatedFinalText: string = "";
  private restartTimer: number | null = null;

  // Fallback MediaRecorder state
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private vadInterval: number | null = null;
  private audioCtx: AudioContext | null = null;
  private isAudioCtxShared: boolean = false;
  private analyser: AnalyserNode | null = null;
  private lastSpeechTime: number = 0;
  private recentAssistantUtterances: string[] = [];
  private lastAgentSpeechEndTime: number = 0;
  private captureEpoch: number = 0;
  private speechEpoch: number = 1;
  private activeRecognitionEpoch: number = 0;
  private currentSpeechEpoch: number = 1;
  private activeListeningEpoch: number = 0;
  private sessionStartTime: number = 0;
  private SpeechRecognitionClass: any = null;
  private isAudioOutputActiveFn: (() => boolean) | null = null;

  constructor(initialStream?: MediaStream | null, sharedAudioCtx?: AudioContext | null) {
    if (initialStream) {
      this.mediaStream = initialStream;
    }
    if (sharedAudioCtx && sharedAudioCtx.state !== "closed") {
      this.audioCtx = sharedAudioCtx;
      this.isAudioCtxShared = true;
    }
    const SpeechRecognitionClass =
      typeof window !== "undefined"
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (SpeechRecognitionClass) {
      this.isSupported = true;
      this.SpeechRecognitionClass = SpeechRecognitionClass;
      this.initNativeRecognition(SpeechRecognitionClass);
    }
  }

  public getCurrentSpeechEpoch(): number {
    return this.currentSpeechEpoch;
  }

  public getActiveListeningEpoch(): number {
    return this.activeListeningEpoch;
  }

  public setSpeechEpoch(epoch: number): void {
    this.currentSpeechEpoch = epoch;
    this.speechEpoch = epoch;
  }

  public setMediaStream(stream: MediaStream | null): void {
    this.mediaStream = stream;
  }

  public setAudioContext(ctx: AudioContext | null): void {
    if (ctx && ctx.state !== "closed") {
      this.audioCtx = ctx;
      this.isAudioCtxShared = true;
    }
  }

  public setAudioOutputActiveCheck(fn: (() => boolean) | null): void {
    this.isAudioOutputActiveFn = fn;
  }

  public isAudioOutputActive(thresholdDb: number = -60): boolean {
    if (this.isAudioOutputActiveFn) {
      return this.isAudioOutputActiveFn();
    }
    try {
      return neuralVoice.isAudioOutputActive(thresholdDb);
    } catch {
      return false;
    }
  }

  private initNativeRecognition(SpeechRecognitionClass: any) {
    try {
      this.SpeechRecognitionClass = SpeechRecognitionClass;
      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = "en-US";
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (event: any) => {
        // Drop any microphone capture while muted, inactive, while assistant is speaking,
        // or if this result belongs to an earlier speech epoch (e.g. in-flight Google Speech socket frames)
        if (
          !this.shouldBeListening ||
          this.isMuted ||
          this.isPausedForAgent ||
          this.activeListeningEpoch !== this.currentSpeechEpoch
        ) {
          console.warn(`[EpochGuard] Dropped stale transcript from epoch ${this.activeListeningEpoch} (current: ${this.currentSpeechEpoch})`);
          return;
        }

        // Minimum Speech Latency Guard: any transcript arriving within 350ms of session start
        // is physically impossible to be human conversational speech and must be dropped
        // (e.g. in-flight Google Speech socket frames or residual audio buffer bleed-through).
        if (Date.now() - this.sessionStartTime < 350) {
          return;
        }

        // Level-based gating: immediately drop capture if physical audio output is active
        if (this.isAudioOutputActive()) {
          return;
        }

        // Acoustic cooldown guard: discard any residual speaker reverb within acoustic cooldown of playback finish
        if (Date.now() - this.lastAgentSpeechEndTime < this.getAcousticCooldownMs()) return;

        let interimText = "";
        let finalText = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interimText += transcript;
          }
        }

        if (finalText.trim()) {
          if (this.isAcousticEcho(finalText.trim())) {
            console.warn("[EchoGuard] Suppressed microphone acoustic echo chunk:", finalText.trim());
            return;
          }

          this.accumulatedFinalText = (this.accumulatedFinalText + " " + finalText).trim();
          if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
          }
          // Show accumulated text in UI while waiting for natural pause
          this.onTranscript?.(this.accumulatedFinalText, false);

          // Snappy 280ms pause detection before finalizing turn (eliminates 420ms of dead silence)
          this.debounceTimer = window.setTimeout(() => {
            const full = this.accumulatedFinalText.trim();
            this.accumulatedFinalText = "";
            this.debounceTimer = null;
            if (full && this.onTranscript && !this.isMuted && !this.isPausedForAgent) {
              if (this.isAcousticEcho(full)) {
                console.warn("[EchoGuard] Suppressed full microphone acoustic echo:", full);
                return;
              }
              this.onTranscript(full, true);
            }
          }, 280);
        } else if (interimText.trim() && this.onTranscript) {
          if (this.isAcousticEcho(interimText.trim())) {
            return;
          }
          const combined = (this.accumulatedFinalText + " " + interimText).trim();
          this.onTranscript(combined, false);
        }
      };

      this.recognition.onerror = (event: any) => {
        // "no-speech" is normal when caller pauses; do not trigger error state
        if (event.error === "no-speech" || event.error === "aborted") return;

        this.sttErrorCount++;
        console.warn("[SpeechRecognition] Event error:", event.error);
        // "network" or "audio-capture" are recoverable browser session timeouts, not fatal errors
        if (event.error === "network" || event.error === "audio-capture") {
          if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent) {
            window.setTimeout(() => {
              if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent && this.recognition) {
                try {
                  this.activeRecognitionEpoch = this.speechEpoch;
                  this.recognition.start();
                  this.isListening = true;
                  this.onStateChange?.(true);
                } catch {
                  // Already active
                }
              }
            }, 300);
          }
          return;
        }

        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          console.warn("[SpeechRecognition] Native recognition unavailable, switching permanently to MediaRecorder fallback");
          this.isSupported = false;
          this.onInputPathChange?.("media_recorder_transcription");
          if (this.recognition) {
            try {
              this.recognition.abort();
            } catch {}
            this.recognition = null;
          }
          this.startMediaRecorderFallback().catch((fallbackErr) => {
            console.error("[SpeechRecognition] Fallback failed:", fallbackErr);
            this.onError?.("Microphone permission denied. Please allow microphone access.");
          });
        }
      };

      this.recognition.onend = () => {
        this.isListening = false;
        if (this.restartTimer !== null) {
          window.clearTimeout(this.restartTimer);
          this.restartTimer = null;
        }

        // On Android Chrome, Google Speech unbinds its audio recording channel asynchronously.
        // Restarting immediately synchronously causes DOMException: InvalidStateError.
        // Use a 150ms backoff with state guards before attempting to restart.
        if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent && this.recognition) {
          this.restartTimer = window.setTimeout(() => {
            this.restartTimer = null;
            if (!this.shouldBeListening || this.isMuted || this.isPausedForAgent || !this.recognition) {
              this.onStateChange?.(false);
              return;
            }

            try {
              this.activeRecognitionEpoch = this.speechEpoch;
              this.sessionStartTime = Date.now();
              this.recognition.start();
              this.isListening = true;
              this.onStateChange?.(true);
            } catch (err) {
              console.warn("[SpeechRecognition] onend restart failed, switching to MediaRecorder fallback:", err);
              this.isSupported = false;
              this.onInputPathChange?.("media_recorder_transcription");
              if (this.recognition) {
                try {
                  this.recognition.abort();
                } catch {}
                this.recognition = null;
              }
              this.startMediaRecorderFallback().catch(() => {});
            }
          }, 150);
        } else {
          this.onStateChange?.(false);
        }
      };
    } catch (err) {
      console.warn("[SpeechRecognition] Initialization failed:", err);
      this.isSupported = false;
      this.recognition = null;
      this.onInputPathChange?.("media_recorder_transcription");
    }
  }

  public setCallbacks(callbacks: {
    onTranscript?: SpeechTranscriptCallback;
    onStateChange?: SpeechStateCallback;
    onError?: SpeechErrorCallback;
    onBargeIn?: SpeechBargeInCallback;
    onInputPathChange?: SpeechInputPathCallback;
  }) {
    if (callbacks.onTranscript) this.onTranscript = callbacks.onTranscript;
    if (callbacks.onStateChange) this.onStateChange = callbacks.onStateChange;
    if (callbacks.onError) this.onError = callbacks.onError;
    if (callbacks.onBargeIn) this.onBargeIn = callbacks.onBargeIn;
    if (callbacks.onInputPathChange) this.onInputPathChange = callbacks.onInputPathChange;
  }

  public getEchoSuppressionCount(): number {
    return this.echoSuppressionCount;
  }

  public getSttErrorCount(): number {
    return this.sttErrorCount;
  }

  public getInputPath(): InputPath {
    return this.isSupported ? "native_web_speech" : "media_recorder_transcription";
  }

  public getDynamicAcousticCooldownMs(): { minFloorMs: number; maxTimeoutMs: number; targetDb: number } {
    const platform = detectPlatformClass();
    const engine = detectBrowserEngine();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    const isApple = engine === "webkit" || /iPhone|iPad|iPod|Macintosh/i.test(ua);

    if (isApple) {
      // iOS / macOS: 250ms min floor, < -50 dBFS threshold, 500ms max timeout (VoiceProcessingIO hardware AEC active)
      return { minFloorMs: 250, maxTimeoutMs: 500, targetDb: -50 };
    }
    if (platform === "mobile" || /Android/i.test(ua)) {
      // Android Mobile: 500ms min floor (180ms HAL + 250ms room reverb + safety), < -55 dBFS threshold, 750ms max timeout
      return { minFloorMs: 500, maxTimeoutMs: 750, targetDb: -55 };
    }
    // Windows Desktop: 450ms min floor (100ms HAL + 250ms room reverb + safety), < -55 dBFS threshold, 700ms max timeout
    return { minFloorMs: 450, maxTimeoutMs: 700, targetDb: -55 };
  }

  public getAcousticCooldownMs(): number {
    return this.getDynamicAcousticCooldownMs().minFloorMs;
  }

  public registerAssistantSpeech(text: string): void {
    const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length > 5) {
      this.recentAssistantUtterances.push(clean);
      if (this.recentAssistantUtterances.length > 12) {
        this.recentAssistantUtterances.shift();
      }
    }
  }

  /**
   * Check if candidate text matches words or clauses in the tail of recent assistant speech.
   * Eliminates the Whitelist Paradox by detecting when options presented by the assistant
   * bleed into the microphone immediately when playback ends.
   */
  public isTailOfRecentAssistantSpeech(cleanText: string): boolean {
    if (!cleanText || this.recentAssistantUtterances.length === 0) return false;
    const clean = cleanText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return false;

    const candWords = clean.split(/\s+/).filter(Boolean);
    if (candWords.length === 0) return false;

    // Filter out common stop words to examine content words
    const STOP_WORDS = new Set([
      "the", "a", "an", "and", "or", "to", "in", "at", "for", "with", "is", "it", "that", "this", "my", "you", "of", "on", "your"
    ]);
    const contentWords = candWords.filter((w) => !STOP_WORDS.has(w));
    const wordsToMatch = contentWords.length > 0 ? contentWords : candWords;

    // Inspect the 2 most recent assistant utterances (clause + full sentence)
    const recent = this.recentAssistantUtterances.slice(-2);
    for (const utterance of recent) {
      const uWords = utterance.split(/\s+/).filter(Boolean);
      if (uWords.length === 0) continue;

      // Exact substring of the utterance
      if (utterance.includes(clean)) return true;

      // The tail is the last 65% of words (or up to the last 16 words)
      const tailCount = Math.max(Math.ceil(uWords.length * 0.65), Math.min(uWords.length, 16));
      const tailWords = new Set(uWords.slice(-tailCount));

      // If ALL words in candidate appear in the tail of this assistant utterance
      if (wordsToMatch.every((w) => tailWords.has(w))) {
        return true;
      }

      // If candidate has >= 3 words and >= 75% appear in the utterance
      if (candWords.length >= 3) {
        const uSet = new Set(uWords);
        const matchCount = candWords.filter((w) => uSet.has(w)).length;
        if (matchCount / candWords.length >= 0.75) {
          return true;
        }
      }
    }

    return false;
  }

  private isAcousticEcho(transcript: string): boolean {
    const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2) return false;

    const rawWords = clean.split(/\s+/).filter(Boolean);
    const isAssistantLeadIn =
      clean.startsWith("just to confirm") ||
      clean.startsWith("would you like me to book") ||
      clean.startsWith("my name is") ||
      clean.startsWith("this is sarah") ||
      clean.startsWith("thank you for calling") ||
      clean.startsWith("thanks for calling") ||
      clean.startsWith("tap confirm") ||
      clean.startsWith("confirm booking") ||
      clean.startsWith("our technician will");

    // Early Acoustic Bleed Discrimination:
    // Any transcript arriving within 650ms of microphone activation or 750ms of assistant speech end
    // that matches words in the assistant prompt tail is physically an acoustic reflection, not human speech.
    const elapsedSinceSessionStart = this.sessionStartTime > 0 ? Date.now() - this.sessionStartTime : 9999;
    const elapsedSinceAgentEnd = this.lastAgentSpeechEndTime > 0 ? Date.now() - this.lastAgentSpeechEndTime : 9999;
    const isEarlyAcousticWindow = elapsedSinceSessionStart < 650 || elapsedSinceAgentEnd < 750;

    if (isEarlyAcousticWindow && this.isTailOfRecentAssistantSpeech(clean)) {
      this.echoSuppressionCount++;
      console.warn("[EchoGuard] Suppressed prompt-tail echo during early acoustic bleed window:", transcript);
      return true;
    }

    // 0a. Caller providing phone digits is NEVER an echo of Sarah's callback question
    const rawDigits = transcript.replace(/\D/g, "");
    if (rawDigits.length >= 7 && !isAssistantLeadIn) {
      return false;
    }

    // 0b. Explicit caller booking confirmations, conversational greetings, and common affirmative answers are NEVER echo
    const GENUINE_CONFIRMATIONS = new Set([
      "hello", "hi", "hey", "hi there", "hello there", "good morning", "good afternoon", "good evening",
      "morning", "afternoon", "evening",
      "yes", "yeah", "yep", "sure", "ok", "okay", "go ahead",
      "yes please", "yes go ahead", "yes please go ahead", "yeah go ahead",
      "sure go ahead", "yes book it", "yes book that", "go ahead please",
      "please book it", "please book that", "that works", "sounds good",
      "correct", "perfect", "absolutely", "no", "nope", "cancel",
    ]);
    if (GENUINE_CONFIRMATIONS.has(clean)) {
      return false;
    }

    // 0c. Whitelist short (<= 6 words) genuine service selections and date/time phrases.
    // When the assistant offers choices ("...heating or AC repair?", "...furnace tune up?", "...openings tomorrow at 10 AM?"),
    // the caller naturally responds with those exact words ("ac repair", "tune up", "tomorrow at 10 AM", "furnace maintenance").
    // These must NEVER be suppressed as acoustic echo, provided they don't contain assistant signature prompts or lead-in phrases.
    const isAssistantPromptFragment =
      clean === "cooling" ||
      clean === "heating" ||
      clean === "cooling today" ||
      clean === "heating today" ||
      clean === "heating or cooling" ||
      clean === "heating or cooling today" ||
      clean === "with your heating" ||
      clean === "with your cooling" ||
      clean === "with your heating or cooling" ||
      clean === "with your heating or cooling today" ||
      clean === "callback phone";

    if (rawWords.length <= 6 && !isAssistantLeadIn && !isAssistantPromptFragment) {
      const isEarlyEcho = isEarlyAcousticWindow && this.isTailOfRecentAssistantSpeech(clean);
      if (!isEarlyEcho) {
        const hasServiceTerm = /\b(ac|air|conditioning|repair|tune|tuneup|maintenance|furnace|heat|heating|cooling|pump|leak|leaking|noise|duct|pipe|thermostat|filter|service|hvac|inspection|boiler)\b/i.test(clean);
        const hasDateTimeTerm = /\b(tomorrow|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|am|pm|noon|asap|earliest|\d+)\b/i.test(clean);
        if (hasServiceTerm || hasDateTimeTerm) {
          return false;
        }
      }
    }

    // 1. Signature assistant phrases that should NEVER be accepted as caller input
    const SIGNATURE_ASST_PATTERNS = [
      "thank you for calling",
      "thanks for calling",
      "my name is sarah",
      "this is sarah",
      "how can i assist",
      "with your heating or cooling",
      "what is the best callback phone number",
      "what s the best callback phone number",
      "best callback phone number",
      "technician to reach you",
      "technician reach",
      "callback phone",
      "cooling today",
      "for our technician to visit",
      "tap confirm booking",
      "confirm booking on your screen",
      "would you like me to book it",
      "i just need a quick yes or no",
      "quick yes or no",
      "confirm your appointment",
      "book your appointment",
      "our technician will see you then",
      "sorry i heard an echo of my own voice",
      "check a different day or time",
    ];

    for (const sig of SIGNATURE_ASST_PATTERNS) {
      if (clean.includes(sig)) {
        this.echoSuppressionCount++;
        console.warn("[EchoGuard] Suppressed signature assistant phrase echo:", transcript);
        return true;
      }
    }

    // 3. Per-utterance evaluation against recent assistant speech:
    // Evaluate one assistant utterance at a time to avoid false positives on genuine caller inputs.
    const COMMON_STOP_WORDS = new Set([
      "the", "a", "an", "and", "or", "to", "in", "at", "for", "with", "is", "it", "that", "this", "my", "you", "of", "on"
    ]);
    const candidateWords = clean.split(/\s+/).filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w));

    for (const utterance of this.recentAssistantUtterances) {
      // 2a. Prefix / Suffix match: if candidate is an exact prefix or suffix of the assistant utterance (>= 2 words)
      // e.g. "hi there", "got it", "no problem at all", "would you like me to book it"
      if (rawWords.length >= 2) {
        if (utterance.startsWith(clean) || utterance.endsWith(clean)) {
          this.echoSuppressionCount++;
          console.warn("[EchoGuard] Suppressed prefix/suffix echo match:", transcript);
          return true;
        }
      }

      // 2b. Direct substring match if >= 3 words and >= 8 characters
      if (rawWords.length >= 3 && clean.length >= 8 && utterance.includes(clean)) {
        this.echoSuppressionCount++;
        console.warn("[EchoGuard] Suppressed substring echo match:", transcript);
        return true;
      }

      // 2c. Contiguous phrase match of 4 or more words appearing in this assistant utterance
      if (rawWords.length >= 4) {
        for (let i = 0; i <= rawWords.length - 4; i++) {
          const phrase = rawWords.slice(i, i + 4).join(" ");
          if (phrase.length >= 14 && utterance.includes(phrase)) {
            this.echoSuppressionCount++;
            console.warn("[EchoGuard] Suppressed contiguous 4-word phrase echo:", phrase);
            return true;
          }
        }
      }

      // 2d. Per-utterance >= 70% word overlap against this specific utterance
      if (candidateWords.length >= 3) {
        const uWords = new Set(utterance.split(/\s+/).filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w)));
        if (uWords.size >= 3) {
          let matches = 0;
          for (const w of candidateWords) {
            if (uWords.has(w)) matches++;
          }
          const overlap = matches / candidateWords.length;
          if (overlap >= 0.7) {
            this.echoSuppressionCount++;
            console.warn("[EchoGuard] Suppressed per-utterance >=70% overlap echo:", transcript);
            return true;
          }
        }
      }

      // 2e. 2-word exact content subset: if candidate has exactly 2 content words and both appear in this assistant utterance
      if (candidateWords.length === 2) {
        const uWords = new Set(utterance.split(/\s+/).filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w)));
        if (candidateWords.every((w) => uWords.has(w))) {
          // Verify candidate is not a genuine service, date/time, or problem inquiry
          const isDateOrTimeOrNumber = /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|am|pm|noon|\d+)\b/i.test(clean);
          const isServiceTerm = /\b(repair|tune|tuneup|maintenance|pump|furnace|leak|noise|duct|filter|thermostat|ac|air)\b/i.test(clean);
          if (!isDateOrTimeOrNumber && !isServiceTerm) {
            this.echoSuppressionCount++;
            console.warn("[EchoGuard] Suppressed 2-word content echo match:", transcript);
            return true;
          }
        }
      }
    }

    return false;
  }


  public async start() {
    this.shouldBeListening = true;
    this.isMuted = false;

    if (this.isPausedForAgent) {
      // Do not start microphone while assistant is speaking; will auto-resume on speech finish
      return;
    }

    if (this.isSupported) {
      if (!this.recognition && this.SpeechRecognitionClass) {
        this.initNativeRecognition(this.SpeechRecognitionClass);
      }
      if (this.recognition) {
        try {
          this.activeListeningEpoch = this.currentSpeechEpoch;
          this.activeRecognitionEpoch = this.currentSpeechEpoch;
          this.speechEpoch = this.currentSpeechEpoch;
          this.sessionStartTime = Date.now();
          this.recognition.start();
          this.isListening = true;
          this.onStateChange?.(true);
        } catch (e: any) {
          if (e.name !== "InvalidStateError") {
            console.error("[SpeechRecognition] Start error:", e);
          }
        }
      }
    } else {
      // Start Fallback MediaRecorder
      this.activeListeningEpoch = this.currentSpeechEpoch;
      this.activeRecognitionEpoch = this.currentSpeechEpoch;
      this.speechEpoch = this.currentSpeechEpoch;
      this.sessionStartTime = Date.now();
      await this.startMediaRecorderFallback();
    }
  }

  public stop() {
    this.shouldBeListening = false;
    this.isListening = false;
    this.isPausedForAgent = false;
    this.audioChunks = [];

    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.cooldownTimer !== null) {
      window.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    // Drop any pending finalized transcript so it cannot fire after the
    // call has ended (e.g. user hangs up within the 280ms debounce window).
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.accumulatedFinalText = "";

    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {
        // ignore
      }
      this.recognition = null;
    }

    this.stopMediaRecorderFallback();
    this.onStateChange?.(false);
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (muted) {
      this.captureEpoch++;
      if (this.restartTimer !== null) {
        window.clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      if (this.cooldownTimer !== null) {
        window.clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
      if (this.isListening && this.recognition) {
        try {
          this.recognition.abort();
        } catch {
          // ignore
        }
      }
      this.isListening = false;
      this.onStateChange?.(false);
    } else if (this.shouldBeListening && !this.isPausedForAgent) {
      this.start();
    }
  }

  /**
   * Immediately resume speech recognition without waiting for acoustic cooldown
   * when the caller explicitly clicks "Interrupt" or presses Spacebar.
   */
  /**
   * Snappy 200ms interrupt cooldown with tail-audio drain.
   * When caller interrupts Sarah, abort current recognition/recorder buffers immediately,
   * bump captureEpoch to discard in-flight frames, wait 200ms for speaker tail-energy to dissipate,
   * then resume input.
   */
  public resumeImmediatelyForInterrupt(epoch?: number): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.cooldownTimer !== null) {
      window.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (epoch !== undefined) {
      this.currentSpeechEpoch = epoch;
      this.speechEpoch = epoch;
    } else {
      this.currentSpeechEpoch++;
      this.speechEpoch = this.currentSpeechEpoch;
    }
    this.captureEpoch++;
    this.accumulatedFinalText = "";
    this.audioChunks = [];
    this.isPausedForAgent = true;
    this.lastAgentSpeechEndTime = 0;

    // Keep physical microphone tracks muted during the 200ms tail-drain window
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }

    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // ignore
      }
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }

    const targetEpoch = this.currentSpeechEpoch;
    // 200ms tail-audio drain cooldown
    this.cooldownTimer = window.setTimeout(() => {
      this.cooldownTimer = null;
      if (targetEpoch !== this.currentSpeechEpoch) return;
      this.activeListeningEpoch = targetEpoch;
      this.activeRecognitionEpoch = targetEpoch;
      this.speechEpoch = targetEpoch;
      this.isPausedForAgent = false;

      // Re-enable physical microphone tracks after speaker tail-energy settled
      if (this.mediaStream && !this.isMuted) {
        this.mediaStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      }

      if (!this.shouldBeListening || this.isMuted) return;

      if (this.isSupported) {
        if (!this.recognition && this.SpeechRecognitionClass) {
          this.initNativeRecognition(this.SpeechRecognitionClass);
        }
        if (this.recognition) {
          try {
            this.sessionStartTime = Date.now();
            this.recognition.start();
            this.isListening = true;
            this.onStateChange?.(true);
          } catch (err: any) {
            if (err?.name === "InvalidStateError") {
              this.isListening = true;
              this.onStateChange?.(true);
            }
          }
        }
      } else {
        this.sessionStartTime = Date.now();
        this.startMediaRecorderFallback().catch((err) => {
          console.warn("[SpeechRecognition] Fallback start on interrupt:", err);
        });
      }
    }, 200);
  }

  /**
   * Monotonically enter assistant playback turn.
   * Immediately invalidates and aborts any active or pending recognition events,
   * nullifies event listeners on recognition, clears all timers, releases recognition instance,
   * halts MediaRecorder, and mutes physical MediaStreamTracks.
   */
  public enterAssistantTurn(turnEpoch?: number): number {
    this.currentSpeechEpoch = turnEpoch ?? (this.currentSpeechEpoch + 1);
    this.speechEpoch = this.currentSpeechEpoch;
    this.captureEpoch++;
    this.isPausedForAgent = true;

    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.cooldownTimer !== null) {
      window.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.accumulatedFinalText = "";
    this.audioChunks = [];

    // 1. Native Web Speech: detach all handlers, abort recognition, and nullify instance
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {
        // ignore
      }
      this.recognition = null;
    }

    // 2. MediaRecorder Fallback: stop recorder, clear audio chunks, and cancel VAD
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    if (this.vadInterval !== null) {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    // 3. True hardware gating: mute physical mediaStream tracks so zero signal reaches AudioContext/VAD
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }

    this.isListening = false;
    this.onStateChange?.(false);
    return this.currentSpeechEpoch;
  }

  /**
   * Resume recognition bound strictly to the current monotonic epoch after
   * acoustic decay verification passes.
   */
  public resumeAfterAcousticDecay(epoch: number): void {
    // If epoch changed while waiting for decay, discard this resumption
    if (epoch !== this.currentSpeechEpoch || !this.shouldBeListening || this.isMuted) {
      return;
    }

    this.activeListeningEpoch = epoch;
    this.activeRecognitionEpoch = epoch;
    this.speechEpoch = epoch;
    this.isPausedForAgent = false;
    this.sessionStartTime = Date.now();

    // Re-enable physical microphone tracks after speaker reverberation has fully settled
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    }

    // Resume exactly one active input method
    if (this.isSupported) {
      if (!this.recognition && this.SpeechRecognitionClass) {
        this.initNativeRecognition(this.SpeechRecognitionClass);
      }
      if (this.recognition) {
        try {
          this.recognition.start();
          this.isListening = true;
          this.onStateChange?.(true);
        } catch (err: any) {
          if (err?.name === "InvalidStateError") {
            this.isListening = true;
            this.onStateChange?.(true);
          } else {
            console.warn("[SpeechRecognition] Start after cooldown:", err);
          }
        }
      }
    } else {
      this.sessionStartTime = Date.now();
      this.startMediaRecorderFallback().catch((err) => {
        console.warn("[SpeechRecognition] Fallback restart after cooldown:", err);
      });
    }
  }

  /**
   * Hardware auto-gating with platform-aware acoustic cooldown.
   * While assistant is speaking, both native recognition and fallback MediaRecorder
   * are completely halted and any pending audio chunks discarded.
   * On speech finish, waits for acoustic drain before resuming input on the current epoch.
   */
  public pauseForAgentPlayback(isSpeaking: boolean) {
    if (isSpeaking) {
      this.enterAssistantTurn();
    } else {
      this.lastAgentSpeechEndTime = Date.now();
      this.accumulatedFinalText = "";
      this.audioChunks = [];

      if (this.cooldownTimer !== null) {
        window.clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }

      const epochToResume = this.currentSpeechEpoch;
      const { minFloorMs, maxTimeoutMs, targetDb } = this.getDynamicAcousticCooldownMs();
      const startTime = Date.now();

      const checkDecayAndResume = () => {
        if (epochToResume !== this.currentSpeechEpoch || !this.shouldBeListening || this.isMuted) {
          this.cooldownTimer = null;
          return;
        }

        const elapsed = Date.now() - startTime;

        // 1. Wait out the minimum platform acoustic floor
        if (elapsed < minFloorMs) {
          this.cooldownTimer = window.setTimeout(checkDecayAndResume, 25);
          return;
        }

        // 2. Poll AnalyserNode for true silence (< targetDb)
        const isOutputActive = this.isAudioOutputActive(targetDb);
        if (isOutputActive && elapsed < maxTimeoutMs) {
          this.cooldownTimer = window.setTimeout(checkDecayAndResume, 30);
          return;
        }

        // 3. Silence verified or safety timeout reached: resume recognition on current epoch
        this.cooldownTimer = null;
        this.resumeAfterAcousticDecay(epochToResume);
      };

      this.cooldownTimer = window.setTimeout(checkDecayAndResume, minFloorMs);
    }
  }

  /**
   * MediaRecorder Fallback implementation for browsers without Web Speech API.
   * Efficiently reuses MediaStream and AudioContext across pauses/resumes.
   */
  private async startMediaRecorderFallback() {
    this.isSupported = false;
    this.onInputPathChange?.("media_recorder_transcription");

    try {
      if (!this.mediaStream || this.mediaStream.getTracks().every((t) => t.readyState === "ended")) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      if (this.isPausedForAgent || this.isMuted) {
        this.mediaStream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      const AudioCtxClass =
        typeof window !== "undefined"
          ? window.AudioContext || (window as any).webkitAudioContext
          : null;

      if (AudioCtxClass && (!this.audioCtx || this.audioCtx.state === "closed")) {
        try {
          this.audioCtx = new AudioCtxClass();
        } catch {
          try {
            this.audioCtx = new AudioCtxClass({ sampleRate: 24000 });
          } catch (e) {
            console.warn("[SpeechRecognition] Failed to instantiate fallback AudioContext:", e);
          }
        }
      }

      if (this.audioCtx) {
        if (this.audioCtx.state === "suspended" || (this.audioCtx.state as string) === "interrupted") {
          try {
            await this.audioCtx.resume();
          } catch (err) {
            console.warn("[SpeechRecognition] AudioContext resume failed in fallback:", err);
          }
        }

        if (this.mediaStream && !this.analyser) {
          try {
            const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.3;
            source.connect(this.analyser);
          } catch (err) {
            console.warn("[SpeechRecognition] MediaStreamSource connection error:", err);
          }
        }
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

      const options = mimeType ? { mimeType } : undefined;
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
        this.audioChunks = [];

        this.mediaRecorder.ondataavailable = (event) => {
          if (this.isPausedForAgent || this.isMuted) {
            return;
          }
          if (event.data && event.data.size > 0) {
            this.audioChunks.push(event.data);
          }
        };

        this.mediaRecorder.onstop = async () => {
          const epoch = this.captureEpoch;
          if (!this.shouldBeListening || this.isPausedForAgent || this.isMuted) {
            this.audioChunks = [];
            return;
          }
          if (this.audioChunks.length === 0) return;
          const actualType = mimeType || "audio/webm";
          const blob = new Blob(this.audioChunks, { type: actualType });
          this.audioChunks = [];

          if (blob.size < 1000) return; // Skip tiny clicks

          try {
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = async () => {
              try {
                if (epoch !== this.captureEpoch) return;
                if (!this.shouldBeListening || this.isPausedForAgent || this.isMuted) return;
                const result = reader.result as string;
                const base64 = result?.split(",")[1];
                if (base64) {
                  const ext = actualType.includes("mp4") ? "mp4" : "webm";
                  const res = await apiPost<{ text?: string; transcript?: string }>("/v1/calls/transcribe", {
                    audio_base64: base64,
                    content_type: actualType,
                    filename: `audio.${ext}`,
                  });
                  if (epoch !== this.captureEpoch) return;
                  if (!this.shouldBeListening || this.isPausedForAgent || this.isMuted) return;
                  const text = res.text || res.transcript;
                  if (text && text.trim()) {
                    if (this.isAcousticEcho(text.trim())) {
                      console.warn("[EchoGuard] Suppressed fallback acoustic echo:", text.trim());
                      return;
                    }
                    this.onTranscript?.(text.trim(), true);
                  }
                }
              } catch (innerErr) {
                if (epoch !== this.captureEpoch) return;
                this.sttErrorCount++;
                console.warn("[SpeechRecognition] Fallback transcription request failed:", innerErr);
              }
            };
          } catch (err) {
            if (epoch !== this.captureEpoch) return;
            this.sttErrorCount++;
            console.error("[SpeechRecognition] Fallback transcription failed:", err);
          }
        };
      }

      if (this.mediaRecorder.state === "inactive") {
        this.mediaRecorder.start();
      }
      this.isListening = true;
      this.onStateChange?.(true);

      // Simple voice activity energy monitor to detect pauses
      this.monitorFallbackVAD();
    } catch (err: any) {
      this.sttErrorCount++;
      console.error("[SpeechRecognition] Fallback mic access error:", err);
      this.onError?.("Microphone access denied: " + err.message);
    }
  }

  private monitorFallbackVAD() {
    if (!this.analyser) return;
    if (this.vadInterval !== null) {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    let speaking = false;

    this.vadInterval = window.setInterval(() => {
      if (!this.analyser || !this.mediaRecorder || this.isMuted || this.isPausedForAgent) return;

      if (this.audioCtx && (this.audioCtx.state === "suspended" || (this.audioCtx.state as string) === "interrupted")) {
        this.audioCtx.resume().catch(() => {});
      }

      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;

      // Energy threshold for speech
      if (avg > 15) {
        this.lastSpeechTime = Date.now();
        if (!speaking) {
          speaking = true;
          this.onTranscript?.("…", false);
        }
      } else if (speaking && Date.now() - this.lastSpeechTime > 1200) {
        // 1.2s silence detected after speaking: cycle the recorder to transcribe chunk
        speaking = false;
        if (this.mediaRecorder.state === "recording") {
          this.mediaRecorder.stop();
          if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent) {
            setTimeout(() => {
              if (this.mediaRecorder && this.mediaRecorder.state === "inactive") {
                this.mediaRecorder.start();
              }
            }, 100);
          }
        }
      }
    }, 100);
  }

  private stopMediaRecorderFallback() {
    this.captureEpoch++;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
      this.analyser = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioCtx && !this.isAudioCtxShared && this.audioCtx.state !== "closed") {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
