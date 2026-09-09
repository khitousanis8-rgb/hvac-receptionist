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

  private debounceTimer: number | null = null;
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
        if (this.isPausedForAgent || this.isMuted) return;
        // Enforce acoustic cooldown: ignore microphone audio within 600ms of assistant speaking
        if (Date.now() - this.lastAgentSpeechEndTime < 600) return;

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
          // Check if finalized chunk is self-speech echo
          if (this.isAcousticEcho(finalText.trim())) {
            console.warn("[EchoGuard] Suppressed microphone acoustic echo chunk:", finalText.trim());
            return;
          }

          this.accumulatedFinalText = (this.accumulatedFinalText + " " + finalText).trim();
          if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
          }
          // Show accumulated text in UI while waiting for pause
          this.onTranscript?.(this.accumulatedFinalText, false);

          // Wait 700ms of silence before declaring the caller's turn finished
          this.debounceTimer = window.setTimeout(() => {
            const full = this.accumulatedFinalText.trim();
            this.accumulatedFinalText = "";
            this.debounceTimer = null;
            if (full && this.onTranscript && !this.isPausedForAgent && !this.isMuted) {
              if (this.isAcousticEcho(full)) {
                console.warn("[EchoGuard] Suppressed full microphone acoustic echo:", full);
                return;
              }
              this.onTranscript(full, true);
            }
          }, 700);
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
        if (event.error === "no-speech") return;
        if (event.error === "aborted") return;

        console.warn("[SpeechRecognition] Error:", event.error);
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.onError?.("Microphone permission denied or speech service not allowed.");
        }
      };

      this.recognition.onend = () => {
        this.isListening = false;
        // Auto-restart if we are supposed to be listening and not explicitly stopped
        if (this.shouldBeListening && !this.isPausedForAgent && !this.isMuted) {
          try {
            this.recognition.start();
            this.isListening = true;
            this.onStateChange?.(true);
          } catch {
            // Already started or restarting
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
  }) {
    if (callbacks.onTranscript) this.onTranscript = callbacks.onTranscript;
    if (callbacks.onStateChange) this.onStateChange = callbacks.onStateChange;
    if (callbacks.onError) this.onError = callbacks.onError;
  }

  public registerAssistantSpeech(text: string): void {
    const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
    if (clean.length > 5) {
      this.recentAssistantUtterances.push(clean);
      if (this.recentAssistantUtterances.length > 8) {
        this.recentAssistantUtterances.shift();
      }
    }
  }

  private isAcousticEcho(transcript: string): boolean {
    const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
    if (!clean || clean.length < 4) return false;

    // Check against standard receptionist system phrases
    const receptionistPhrases = [
      "my name is sarah",
      "this is sarah",
      "thank you for calling",
      "how can i assist you",
      "heating or cooling today",
      "heating and air conditioning",
      "example hvac",
      "welcome to example hvac",
      "how can i help you with your heating",
    ];
    for (const phrase of receptionistPhrases) {
      if (clean.includes(phrase)) {
        return true;
      }
    }

    // Check against recently queued assistant speech
    for (const utterance of this.recentAssistantUtterances) {
      if (utterance.includes(clean) || clean.includes(utterance)) {
        return true;
      }
      // Check word overlap for acoustic partials
      const cleanWords = clean.split(/\s+/).filter((w) => w.length > 3);
      if (cleanWords.length >= 3) {
        const matches = cleanWords.filter((w) => utterance.includes(w));
        if (matches.length / cleanWords.length >= 0.65) {
          return true;
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
   * Pause speech recognition while the virtual assistant is speaking
   * to eliminate acoustic feedback and self-transcription.
   */
  public pauseForAgentPlayback(isSpeaking: boolean) {
    this.isPausedForAgent = isSpeaking;

    if (isSpeaking) {
      if (this.debounceTimer !== null) {
        window.clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.accumulatedFinalText = "";

      if (this.recognition) {
        try {
          // abort() immediately cancels recognition and dumps audio buffers without emitting onresult
          this.recognition.abort();
        } catch {
          // ignore
        }
      }
      this.isListening = false;
      this.onStateChange?.(false);
    } else {
      this.lastAgentSpeechEndTime = Date.now();
      // Resume listening after 600ms acoustic room decay cooldown so speaker audio doesn't bleed into mic
      if (this.shouldBeListening && !this.isMuted) {
        window.setTimeout(() => {
          if (this.shouldBeListening && !this.isPausedForAgent && !this.isMuted) {
            try {
              this.recognition?.start();
              this.isListening = true;
              this.onStateChange?.(true);
            } catch (err: any) {
              // If already active or starting, sync state
              if (err?.name === "InvalidStateError") {
                this.isListening = true;
                this.onStateChange?.(true);
              }
            }
          }
        }, 600);
      }
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
        : "audio/mp4";

      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (this.audioChunks.length === 0) return;
        const blob = new Blob(this.audioChunks, { type: mimeType });
        this.audioChunks = [];

        if (blob.size < 1000) return; // Skip tiny clicks

        try {
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          reader.onloadend = async () => {
            const result = reader.result as string;
            const base64 = result.split(",")[1];
            if (base64) {
              const res = await apiPost<{ text?: string; transcript?: string }>("/v1/calls/transcribe", {
                audio_base64: base64,
                content_type: mimeType,
              });
              const text = res.text || res.transcript;
              if (text && text.trim()) {
                this.onTranscript?.(text.trim(), true);
              }
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
