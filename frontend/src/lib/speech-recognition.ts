/**
 * Browser Speech Recognition service.
 * Uses Web Speech API (SpeechRecognition / webkitSpeechRecognition) for instant,
 * zero-latency, 100% free speech-to-text.
 * Provides automatic fallback to MediaRecorder + Groq Whisper API for browsers without Web Speech support.
 */

import { apiPost } from "./api";

export type SpeechTranscriptCallback = (text: string, isFinal: boolean) => void;
export type SpeechStateCallback = (isListening: boolean) => void;
export type SpeechErrorCallback = (error: string) => void;
export type SpeechBargeInCallback = () => void;

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

  private debounceTimer: number | null = null;
  private cooldownTimer: number | null = null;
  private accumulatedFinalText: string = "";

  // Fallback MediaRecorder state
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private vadInterval: number | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private silenceTimer: number | null = null;
  private lastSpeechTime: number = 0;
  private recentAssistantUtterances: string[] = [];
  private lastAgentSpeechEndTime: number = 0;

  constructor() {
    const SpeechRecognitionClass =
      typeof window !== "undefined"
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (SpeechRecognitionClass) {
      this.isSupported = true;
      this.initNativeRecognition(SpeechRecognitionClass);
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

        // Acoustic cooldown guard: discard any residual speaker reverb within 350ms of playback finish
        if (Date.now() - this.lastAgentSpeechEndTime < 350) return;

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
          console.warn("[SpeechRecognition] Permission denied, checking MediaRecorder fallback");
          this.startMediaRecorderFallback().catch((fallbackErr) => {
            console.error("[SpeechRecognition] Fallback failed:", fallbackErr);
            this.onError?.("Microphone permission denied. Please allow microphone access.");
          });
        }
      };

      this.recognition.onend = () => {
        this.isListening = false;
        // Seamlessly auto-restart continuous listening session ONLY when not paused for assistant
        if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent) {
          try {
            this.recognition.start();
            this.isListening = true;
            this.onStateChange?.(true);
          } catch {
            // Already started or starting
          }
        } else {
          this.onStateChange?.(false);
        }
      };
    } catch (err) {
      console.warn("[SpeechRecognition] Initialization failed:", err);
      this.isSupported = false;
      this.recognition = null;
    }
  }

  public setCallbacks(callbacks: {
    onTranscript?: SpeechTranscriptCallback;
    onStateChange?: SpeechStateCallback;
    onError?: SpeechErrorCallback;
    onBargeIn?: SpeechBargeInCallback;
  }) {
    if (callbacks.onTranscript) this.onTranscript = callbacks.onTranscript;
    if (callbacks.onStateChange) this.onStateChange = callbacks.onStateChange;
    if (callbacks.onError) this.onError = callbacks.onError;
    if (callbacks.onBargeIn) this.onBargeIn = callbacks.onBargeIn;
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
    if (!clean || clean.length < 5) return false;

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
      "just to confirm",
      "you re all set",
      "you are all set",
      "our technician will see you then",
      "is there anything else i can help with",
      "is there anything else",
      "sorry i heard an echo of my own voice",
    ];

    for (const sig of SIGNATURE_ASST_PATTERNS) {
      if (clean.includes(sig)) {
        console.warn("[EchoGuard] Suppressed signature assistant phrase echo:", transcript);
        return true;
      }
    }

    // 2. Direct substring or full match against any recent assistant utterance
    for (const utterance of this.recentAssistantUtterances) {
      if (utterance.length >= 12 && clean.length >= 12) {
        if (utterance.includes(clean) || clean.includes(utterance)) {
          console.warn("[EchoGuard] Suppressed substring echo match:", transcript);
          return true;
        }
      }
    }

    // 3. Multi-word overlap check against recent assistant speech
    const COMMON_STOP_WORDS = new Set([
      "the", "a", "an", "and", "or", "to", "in", "at", "for", "with", "is", "it", "that", "this", "my", "you"
    ]);
    const candidateWords = clean.split(" ").filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w));
    if (candidateWords.length >= 3) {
      const allAsstWords = new Set<string>();
      for (const u of this.recentAssistantUtterances) {
        for (const w of u.split(/\s+/)) {
          if (w.length >= 2 && !COMMON_STOP_WORDS.has(w)) allAsstWords.add(w);
        }
      }

      let matches = 0;
      for (const w of candidateWords) {
        if (allAsstWords.has(w)) matches++;
      }

      const overlap = matches / candidateWords.length;
      if (overlap >= 0.5) {
        console.warn("[EchoGuard] Suppressed multi-word overlap echo (overlap " + Math.round(overlap * 100) + "%):", transcript);
        return true;
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
    if (muted) {
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
  public resumeImmediatelyForInterrupt(): void {
    if (this.cooldownTimer !== null) {
      window.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.accumulatedFinalText = "";
    this.isPausedForAgent = false;
    this.lastAgentSpeechEndTime = 0;

    if (this.shouldBeListening && !this.isMuted && this.recognition) {
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
    }
  }

  /**
   * Hardware auto-gating with acoustic cooldown.
   * While assistant is speaking, microphone capture is completely paused and flushed
   * so speaker audio is never captured. On speech end, waits a 350ms acoustic cooldown
   * for speaker reverb to dissipate before opening the microphone for the caller's turn.
   */
  public pauseForAgentPlayback(isSpeaking: boolean) {
    if (isSpeaking) {
      this.isPausedForAgent = true;

      if (this.cooldownTimer !== null) {
        window.clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
      if (this.debounceTimer !== null) {
        window.clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.accumulatedFinalText = "";

      // Hardware auto-gating: abort recognition while assistant speaks through device speakers
      if (this.recognition) {
        try {
          this.recognition.abort();
        } catch {
          // ignore
        }
      }
      this.isListening = false;
      this.onStateChange?.(false);
    } else {
      this.lastAgentSpeechEndTime = Date.now();
      this.isPausedForAgent = false;
      this.accumulatedFinalText = "";

      if (this.cooldownTimer !== null) {
        window.clearTimeout(this.cooldownTimer);
      }

      // Acoustic cooldown: wait 350ms for room reverb and speaker DAC buffers to dissipate
      this.cooldownTimer = window.setTimeout(() => {
        this.cooldownTimer = null;
        if (this.shouldBeListening && !this.isMuted && !this.isPausedForAgent && this.recognition) {
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
      }, 350);
    }
  }

  /**
   * MediaRecorder Fallback implementation for browsers without Web Speech API.
   */
  private async startMediaRecorderFallback() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

      const options = mimeType ? { mimeType } : undefined;
      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (!this.shouldBeListening) return;
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
              if (!this.shouldBeListening) return;
              const result = reader.result as string;
              const base64 = result.split(",")[1];
              if (base64) {
                const ext = actualType.includes("mp4") ? "mp4" : "webm";
                const res = await apiPost<{ text?: string; transcript?: string }>("/v1/calls/transcribe", {
                  audio_base64: base64,
                  content_type: actualType,
                  filename: `audio.${ext}`,
                });
                if (!this.shouldBeListening) return;
                const text = res.text || res.transcript;
                if (text && text.trim()) {
                  this.onTranscript?.(text.trim(), true);
                }
              }
            } catch (innerErr) {
              console.warn("[SpeechRecognition] Fallback transcription request failed:", innerErr);
            }
          };
        } catch (err) {
          console.error("[SpeechRecognition] Fallback transcription failed:", err);
        }
      };

      this.mediaRecorder.start();
      this.isListening = true;
      this.onStateChange?.(true);

      // Simple voice activity energy monitor to detect pauses
      this.monitorFallbackVAD();
    } catch (err: any) {
      console.error("[SpeechRecognition] Fallback mic access error:", err);
      this.onError?.("Microphone access denied: " + err.message);
    }
  }

  private monitorFallbackVAD() {
    if (!this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    let speaking = false;

    this.vadInterval = window.setInterval(() => {
      if (!this.analyser || !this.mediaRecorder || this.isMuted || this.isPausedForAgent) return;

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
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
