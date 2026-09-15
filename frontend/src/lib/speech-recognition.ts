/**
 * Browser Speech Recognition service.
 * Uses Web Speech API (SpeechRecognition / webkitSpeechRecognition) for instant,
 * zero-latency, 100% free speech-to-text.
 * Provides automatic fallback to MediaRecorder + Groq Whisper API for browsers without Web Speech support.
 */

import { apiPost } from "./api";
import { type InputPath } from "./telemetry";

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
      this.initNativeRecognition(SpeechRecognitionClass);
    }
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

  private initNativeRecognition(SpeechRecognitionClass: any) {
    try {
      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = "en-US";
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (event: any) => {
        // Drop any microphone capture while muted, inactive, or while assistant is speaking
        if (!this.shouldBeListening || this.isMuted || this.isPausedForAgent) return;

        // Acoustic cooldown guard: discard any residual speaker reverb within 1100ms of playback finish
        if (Date.now() - this.lastAgentSpeechEndTime < 1100) return;

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

  public registerAssistantSpeech(text: string): void {
    const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length > 5) {
      this.recentAssistantUtterances.push(clean);
      if (this.recentAssistantUtterances.length > 12) {
        this.recentAssistantUtterances.shift();
      }
    }
  }

  private isAcousticEcho(transcript: string): boolean {
    const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2) return false;

    // Explicit caller booking confirmations, conversational greetings, and common affirmative answers are NEVER echo
    const GENUINE_CONFIRMATIONS = new Set([
      "hello", "hi", "hey", "hi there", "hello there", "good morning", "good afternoon", "good evening",
      "yes", "yeah", "yep", "sure", "ok", "okay", "go ahead",
      "yes please", "yes go ahead", "yes please go ahead", "yeah go ahead",
      "sure go ahead", "yes book it", "yes book that", "go ahead please",
      "please book it", "please book that", "that works", "sounds good",
      "correct", "perfect", "absolutely", "no", "nope", "cancel",
    ]);
    if (GENUINE_CONFIRMATIONS.has(clean)) {
      return false;
    }

    // 1. Signature assistant phrases that should NEVER be accepted as caller input
    const SIGNATURE_ASST_PATTERNS = [
      "thank you for calling",
      "thanks for calling",
      "my name is sarah",
      "this is sarah",
      "how can i assist",
      "how can i help",
      "heating or cooling today",
      "with your heating or cooling",
      "what service do you need help with",
      "what is the best callback phone number",
      "what s the best callback phone number",
      "best callback phone number",
      "technician to reach you",
      "would you like me to book it",
      "i just need a quick yes or no",
      "quick yes or no",
      "confirm your appointment",
      "book your appointment",
      "just to confirm",
      "you re all set",
      "you are all set",
      "our technician will see you then",
      "is there anything else i can help with",
      "is there anything else",
      "sorry i heard an echo of my own voice",
      "no problem at all",
      "what day and time works best",
      "what day and time works",
      "check a different day or time",
    ];

    for (const sig of SIGNATURE_ASST_PATTERNS) {
      if (clean.includes(sig)) {
        this.echoSuppressionCount++;
        console.warn("[EchoGuard] Suppressed signature assistant phrase echo:", transcript);
        return true;
      }
    }

    // 2. Per-utterance evaluation against recent assistant speech:
    // Evaluate one assistant utterance at a time to avoid false positives on genuine caller inputs.
    const COMMON_STOP_WORDS = new Set([
      "the", "a", "an", "and", "or", "to", "in", "at", "for", "with", "is", "it", "that", "this", "my", "you", "of", "on"
    ]);
    const candidateWords = clean.split(/\s+/).filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w));
    const rawWords = clean.split(/\s+/).filter(Boolean);

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

    if (this.isSupported && this.recognition) {
      try {
        this.recognition.start();
        this.isListening = true;
        this.onStateChange?.(true);
      } catch (e: any) {
        if (e.name !== "InvalidStateError") {
          console.error("[SpeechRecognition] Start error:", e);
        }
      }
    } else {
      // Start Fallback MediaRecorder
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
        this.recognition.abort();
      } catch {
        // ignore
      }
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
  public resumeImmediatelyForInterrupt(): void {
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

    // 200ms tail-audio drain cooldown
    this.cooldownTimer = window.setTimeout(() => {
      this.cooldownTimer = null;
      this.isPausedForAgent = false;

      // Re-enable physical microphone tracks after speaker tail-energy settled
      if (this.mediaStream && !this.isMuted) {
        this.mediaStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      }

      if (!this.shouldBeListening || this.isMuted) return;

      if (this.isSupported && this.recognition) {
        try {
          this.recognition.start();
          this.isListening = true;
          this.onStateChange?.(true);
        } catch (err: any) {
          if (err?.name === "InvalidStateError") {
            this.isListening = true;
            this.onStateChange?.(true);
          }
        }
      } else {
        this.startMediaRecorderFallback().catch((err) => {
          console.warn("[SpeechRecognition] Fallback start on interrupt:", err);
        });
      }
    }, 200);
  }

  /**
   * Hardware auto-gating with 1,100ms acoustic cooldown.
   * While assistant is speaking, both native recognition and fallback MediaRecorder
   * are completely halted and any pending audio chunks discarded.
   * On speech finish, waits 1,100ms before resuming exactly one input method.
   */
  public pauseForAgentPlayback(isSpeaking: boolean) {
    if (isSpeaking) {
      this.captureEpoch++;
      this.isPausedForAgent = true;

      if (this.restartTimer !== null) {
        window.clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      // True hardware gating: mute physical mediaStream tracks so zero signal reaches AudioContext/VAD
      if (this.mediaStream) {
        this.mediaStream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
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

      // 1. Native Web Speech: abort recognition immediately so speaker audio is never captured
      if (this.recognition) {
        try {
          this.recognition.abort();
        } catch {
          // ignore
        }
      }

      // 2. MediaRecorder Fallback: stop recorder, clear audio chunks, and cancel VAD
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try {
          this.mediaRecorder.stop();
        } catch {
          // ignore
        }
      }
      this.audioChunks = [];
      if (this.vadInterval !== null) {
        window.clearInterval(this.vadInterval);
        this.vadInterval = null;
      }

      this.isListening = false;
      this.onStateChange?.(false);
    } else {
      this.lastAgentSpeechEndTime = Date.now();
      // Keep isPausedForAgent = true during cooldown so asynchronous onend events
      // from abort() do not prematurely restart recognition before speaker reverb drains.
      this.accumulatedFinalText = "";
      this.audioChunks = [];

      if (this.cooldownTimer !== null) {
        window.clearTimeout(this.cooldownTimer);
      }

      // Acoustic cooldown: 1,100ms for speaker reverb, DAC buffers, and cloud recognition to drain
      const cooldownMs = 1100;
      this.cooldownTimer = window.setTimeout(() => {
        this.cooldownTimer = null;
        this.isPausedForAgent = false;
        if (!this.shouldBeListening || this.isMuted) return;

        // Re-enable hardware media tracks after speaker reverberation has fully settled
        if (this.mediaStream) {
          this.mediaStream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
        }

        // Resume exactly one active input method
        if (this.isSupported && this.recognition) {
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
        } else {
          this.startMediaRecorderFallback().catch((err) => {
            console.warn("[SpeechRecognition] Fallback restart after cooldown:", err);
          });
        }
      }, cooldownMs);
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
