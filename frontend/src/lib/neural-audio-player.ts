/**
 * Neural Audio Player for Streaming Voice Synthesis (Edge-TTS Azure Neural).
 *
 * Features:
 *   • Broadcast-grade human warmth using Azure Neural (en-US-JennyNeural).
 *   • Seamless gapless scheduling on Web Audio API AudioContext hardware clock (0ms inter-sentence dead air).
 *   • Pre-buffers upcoming sentences concurrently while prior sentences are playing.
 *   • Graceful fallback to window.speechSynthesis if network audio stream fails.
 *   • Full interruption / barge-in support via stop() with zero zombie sounds and anti-click ramp down.
 *   • Turn state synchronization for echo-free microphone gating.
 *   • Resilient AudioContext lifecycle with iOS Safari gesture unlocking and sampleRate compatibility.
 *   • Capped LRU AudioBuffer memory cache preventing micro-leaks.
 */

import { apiUrl } from "./api.ts";

export type PlaybackStateCallback = (isPlaying: boolean) => void;
export type TurnStateCallback = (isTurnActive: boolean) => void;

interface QueuedItem {
  text: string;
  abortController: AbortController;
  turnId: number;
  fetchPromise?: Promise<{ buffer: AudioBuffer | null; error: Error | null }>;
}

const MAX_CACHE_SIZE = 40;

export class NeuralAudioPlayer {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private voice: string = "en-US-JennyNeural";
  private isTurnActive: boolean = false;
  private isPlaying: boolean = false;
  private nextPlayTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private queue: QueuedItem[] = [];
  private isFetching: boolean = false;
  private inFlightControllers: Set<AbortController> = new Set();
  private currentTurnId: number = 0;
  private endTurnSignaled: boolean = false;
  private endTurnTimer: number | null = null;
  private consecutiveSilentFrames: number = 0;
  private readonly REQUIRED_SILENT_FRAMES: number = 4;

  // SpeechSynthesis Fallback state
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private synthKeepAliveTimer: number | null = null;
  private cachedVoices: SpeechSynthesisVoice[] = [];

  private onPlaybackStateChange: PlaybackStateCallback | null = null;
  private onTurnStateChange: TurnStateCallback | null = null;

  // In-memory LRU AudioBuffer cache for instant repeated sentences
  private static bufferCache: Map<string, AudioBuffer> = new Map();

  private handleWake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible" && this.audioContext) {
      this.unlockAudio();
    }
  };

  constructor() {
    // Lazily initialized; AudioContext will be created on unlockAudio or first use
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleWake);
      window.addEventListener("focus", this.handleWake);
    }
  }

  private initAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;

    if (!this.audioContext || this.audioContext.state === "closed") {
      this.nextPlayTime = 0;
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      if (!AudioCtx) return null;

      // Initialize AudioContext using native hardware sample rate (typically 44.1k or 48k Hz)
      // for 100% compatibility across all desktop OS sound cards (Windows WASAPI, macOS CoreAudio)
      // and mobile devices. decodeAudioData automatically resamples the 24kHz stream audio.
      try {
        this.audioContext = new AudioCtx();
      } catch {
        try {
          this.audioContext = new AudioCtx({ sampleRate: 24000 });
        } catch (e) {
          console.warn("[NeuralAudioPlayer] Failed to instantiate AudioContext:", e);
          return null;
        }
      }

      try {
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.setValueAtTime(1.0, this.audioContext.currentTime);

        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 1024;
        this.analyserNode.smoothingTimeConstant = 0.0;

        this.masterGain.connect(this.analyserNode);
        this.analyserNode.connect(this.audioContext.destination);
      } catch (err) {
        console.warn("[NeuralAudioPlayer] Node wiring warning:", err);
      }
    }

    return this.audioContext;
  }

  public setPlaybackStateCallback(cb: PlaybackStateCallback | null): void {
    this.onPlaybackStateChange = cb;
  }

  public setTurnStateCallback(cb: TurnStateCallback | null): void {
    this.onTurnStateChange = cb;
  }

  public setVoice(voice: string): void {
    this.voice = voice;
  }

  public getVoice(): string {
    return this.voice;
  }

  public getAnalyserNode(): AnalyserNode | null {
    this.initAudioContext();
    return this.analyserNode;
  }

  public getAudioContext(): AudioContext | null {
    return this.initAudioContext();
  }

  /**
   * Real-time 32-bit floating-point AnalyserNode monitoring down to -60 dBFS.
   * Target threshold: -60 dBFS (linear amplitude < 0.0010).
   */
  public getOutputDecibelLevel(): { peakDb: number; rmsDb: number; isTrueSilence: boolean } {
    if (!this.analyserNode || !this.audioContext || this.audioContext.state !== "running") {
      return { peakDb: -100, rmsDb: -100, isTrueSilence: true };
    }

    try {
      const fftSize = this.analyserNode.fftSize || 1024;
      const buffer = new Float32Array(fftSize);
      if (typeof this.analyserNode.getFloatTimeDomainData === "function") {
        this.analyserNode.getFloatTimeDomainData(buffer);
        let peak = 0;
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const abs = Math.abs(buffer[i]);
          if (abs > peak) peak = abs;
          sumSquares += abs * abs;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
        const rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -120;

        // < -60 dBFS corresponds to linear amplitude < 0.0010
        const isTrueSilence = peak < 0.0010 && rms < 0.0010;
        return { peakDb, rmsDb, isTrueSilence };
      } else if (typeof this.analyserNode.getByteTimeDomainData === "function") {
        const byteData = new Uint8Array(fftSize);
        this.analyserNode.getByteTimeDomainData(byteData);
        let maxDev = 0;
        for (let i = 0; i < byteData.length; i++) {
          const dev = Math.abs(byteData[i] - 128);
          if (dev > maxDev) maxDev = dev;
        }
        const isTrueSilence = maxDev === 0;
        return {
          peakDb: isTrueSilence ? -100 : -36,
          rmsDb: isTrueSilence ? -100 : -36,
          isTrueSilence,
        };
      }
    } catch {}

    return { peakDb: -100, rmsDb: -100, isTrueSilence: true };
  }

  /**
   * Real-time audio output active check.
   * Determines if physical sound is currently playing or lingering through speakers,
   * active AudioBufferSourceNodes, scheduled Web Audio clock time, speech synthesis,
   * or AnalyserNode peak time-domain amplitude (> thresholdDb, default -60 dBFS).
   */
  public isAudioOutputActive(thresholdDb: number = -60): boolean {
    if (this.isPlaying || this.activeSources.length > 0) return true;
    if (this.audioContext && this.audioContext.currentTime < this.nextPlayTime) return true;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) return true;
    }
    const { peakDb, isTrueSilence } = this.getOutputDecibelLevel();
    if (isTrueSilence) return false;
    return peakDb > thresholdDb;
  }

  /**
   * Synchronously unlock AudioContext on user interaction (touch/click).
   * Mobile Safari requires a silent buffer to be played synchronously
   * inside the user gesture event loop to unlock the physical audio hardware.
   */
  public unlockAudio(): void {
    const ctx = this.initAudioContext();
    if (!ctx) return;

    if (ctx.state === "running") {
      return;
    }

    if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
      try {
        const resumePromise = ctx.resume();
        if (resumePromise && typeof resumePromise.catch === "function") {
          resumePromise.catch((err) => console.warn("[NeuralAudioPlayer] AudioContext resume error:", err));
        }
      } catch (err) {
        console.warn("[NeuralAudioPlayer] AudioContext resume synchronous error:", err);
      }
    }

    // Play 1-sample silent buffer to unlock iOS Safari WebKit audio pipeline
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        try {
          source.disconnect();
        } catch {}
      };
      source.start(0);
    } catch {
      // Ignore unlock buffer warmup error
    }

    // Preload system voices for fallback
    this.loadSpeechSynthesisVoices();
  }

  public isReady(): boolean {
    return true;
  }

  public async init(onProgress?: (pct: number, msg: string) => void): Promise<void> {
    onProgress?.(50, "Configuring neural voice stream…");
    this.unlockAudio();
    onProgress?.(100, "Ready");
  }

  /** Begin an assistant turn. Speech recognition will pause. */
  public startTurn(turnId?: number): number {
    this.stopAudioInternal();
    this.currentTurnId = turnId ?? (this.currentTurnId + 1);
    this.isTurnActive = true;
    this.endTurnSignaled = false;
    this.consecutiveSilentFrames = 0;
    this.onTurnStateChange?.(true);
    this.unlockAudio();
    return this.currentTurnId;
  }

  public getCurrentTurnId(): number {
    return this.currentTurnId;
  }

  private triggerFetchForItem(item: QueuedItem): void {
    if (item.fetchPromise) return;
    this.inFlightControllers.add(item.abortController);
    item.fetchPromise = this.fetchAudioBuffer(item.text, item.abortController.signal)
      .then((buffer) => ({ buffer, error: null as Error | null }))
      .catch((err: unknown) => ({ buffer: null, error: err as Error }))
      .finally(() => {
        this.inFlightControllers.delete(item.abortController);
      });
  }

  /** Queue a single sentence for streaming neural synthesis. */
  public speakSentence(sentence: string): void {
    // Normalize smart curly punctuation and strip unwanted noise
    const clean = sentence
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[*_~`#]/g, "")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\.{2,}/g, ".")
      .replace(/[,;—–-]+/g, ", ")
      .replace(/\s+/g, " ")
      .trim();

    if (!clean || !/[a-zA-Z0-9]/.test(clean)) return;

    if (!this.isTurnActive) {
      this.currentTurnId++;
      this.isTurnActive = true;
      this.consecutiveSilentFrames = 0;
      this.onTurnStateChange?.(true);
    }

    const item: QueuedItem = {
      text: clean,
      abortController: new AbortController(),
      turnId: this.currentTurnId,
    };
    this.triggerFetchForItem(item);
    this.queue.push(item);
    this.processQueue();
  }

  /** Signal that all sentences for this turn have been dispatched from SSE deltas. */
  public endTurnQueue(): void {
    if (!this.isTurnActive) return;
    this.endTurnSignaled = true;
    this.checkTurnCompletion();
  }

  /**
   * Internal halt of all active audio, fetches, and utterances without resetting turn state.
   */
  private stopAudioInternal(): void {
    // 1. Abort all in-flight parallel prefetches immediately
    for (const controller of this.inFlightControllers) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    this.inFlightControllers.clear();

    // 2. Abort all pending queued fetches
    for (const item of this.queue) {
      try {
        item.abortController.abort();
      } catch {
        // ignore
      }
    }
    this.queue = [];
    this.isFetching = false;

    // 3. Smoothly ramp master gain to 0 over 8ms to eliminate DC-offset clicks/pops on barge-in
    if (this.masterGain && this.audioContext && this.audioContext.state === "running") {
      const now = this.audioContext.currentTime;
      try {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.008);
      } catch {
        // ignore
      }
    }

    // 4. Halt and decouple all active buffer sources
    // Decouple source.onended to prevent asynchronous onended callbacks from corrupting future turns
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Source may already be stopped
      }
    }
    this.activeSources = [];

    // 5. Cancel SpeechSynthesis fallback
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    this.currentUtterance = null;
    this.stopSynthKeepAlive();

    // 6. Clear completion timers
    if (this.endTurnTimer) {
      window.clearTimeout(this.endTurnTimer);
      this.endTurnTimer = null;
    }
    this.consecutiveSilentFrames = 0;

    // 7. Reset hardware playback clock
    if (this.audioContext) {
      this.nextPlayTime = this.audioContext.currentTime;
    } else {
      this.nextPlayTime = 0;
    }

    if (this.isPlaying) {
      this.isPlaying = false;
      this.onPlaybackStateChange?.(false);
    }
  }

  /**
   * Immediately stop all active audio playback, cancel in-flight fetches,
   * reset the audio clock, and finish the assistant turn (for caller barge-in).
   */
  public stop(): void {
    this.currentTurnId++; // Invalidate any completing async tasks
    this.stopAudioInternal();
    this.finishTurn();
  }

  private finishTurn(): void {
    if (!this.isTurnActive) return;
    this.isTurnActive = false;
    this.endTurnSignaled = false;
    this.onTurnStateChange?.(false);
  }

  private async processQueue(): Promise<void> {
    if (this.isFetching) {
      // Inter-sentence batch trigger: prefetch newly enqueued sentences in parallel immediately
      for (const item of this.queue) {
        this.triggerFetchForItem(item);
      }
      return;
    }
    if (this.queue.length === 0) return;
    this.isFetching = true;
    const workerTurnId = this.currentTurnId;

    try {
      while (this.queue.length > 0 && this.isTurnActive && this.currentTurnId === workerTurnId) {
        // Pre-trigger parallel fetches for all pending sentences
        for (const item of this.queue) {
          this.triggerFetchForItem(item);
        }

        const item = this.queue.shift()!;
        if (item.turnId !== this.currentTurnId || !this.isTurnActive) {
          try {
            item.abortController.abort();
          } catch {}
          continue;
        }

        this.triggerFetchForItem(item);
        const { buffer, error } = await item.fetchPromise!;

        // Zero Zombie Sounds: drop everything if the turn changed mid-batch
        if (item.turnId !== this.currentTurnId || !this.isTurnActive) {
          try {
            item.abortController.abort();
          } catch {}
          break;
        }

        if (error) {
          if ((error as Error)?.name === "AbortError" || (error as DOMException)?.code === 20) {
            break;
          }
          if (this.isTurnActive && this.currentTurnId === item.turnId) {
            console.warn("[NeuralAudioPlayer] Stream fetch failed, falling back to Web Speech API:", error);
            this.fallbackSpeak(item.text, item.turnId);
          }
          continue;
        }

        if (buffer && this.isTurnActive && this.currentTurnId === item.turnId) {
          await this.scheduleAudioBuffer(buffer, item.text, item.turnId);
        }
      }
    } finally {
      // A stopped worker must not release the replacement worker's queue lock.
      if (this.currentTurnId === workerTurnId) {
        this.isFetching = false;
        if (this.queue.length > 0 && this.isTurnActive) {
          this.processQueue();
        }
      }
    }
    if (this.currentTurnId === workerTurnId) {
      this.checkTurnCompletion();
    }
  }

  private async fetchAudioBuffer(text: string, signal: AbortSignal): Promise<AudioBuffer | null> {
    const cacheKey = `${this.voice}:${text}`;

    // LRU cache check: re-insert to update access order
    if (NeuralAudioPlayer.bufferCache.has(cacheKey)) {
      const cached = NeuralAudioPlayer.bufferCache.get(cacheKey)!;
      NeuralAudioPlayer.bufferCache.delete(cacheKey);
      NeuralAudioPlayer.bufferCache.set(cacheKey, cached);
      return cached;
    }

    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const url = apiUrl("/v1/voice/stream");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        text,
        voice: this.voice,
      }),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`TTS server returned status ${resp.status}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const ctx = this.initAudioContext();
    if (!ctx) return null;

    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // decodeAudioData automatically resamples the 24kHz stream audio to the AudioContext's sample rate
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    // Evict oldest item if LRU cache limit reached
    if (NeuralAudioPlayer.bufferCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = NeuralAudioPlayer.bufferCache.keys().next().value;
      if (oldestKey) {
        NeuralAudioPlayer.bufferCache.delete(oldestKey);
      }
    }
    NeuralAudioPlayer.bufferCache.set(cacheKey, audioBuffer);

    return audioBuffer;
  }

  private async scheduleAudioBuffer(
    buffer: AudioBuffer,
    _sentence: string,
    turnId: number = this.currentTurnId,
  ): Promise<void> {
    const ctx = this.initAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
      try {
        await Promise.race([
          ctx.resume(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("AudioContext resume timeout")), 1500)),
        ]);
      } catch (err) {
        console.warn("[NeuralAudioPlayer] Resume error:", err);
      }
    }

    // resume() may settle after stop(), a replacement turn, or context disposal.
    if (!this.isTurnActive || this.currentTurnId !== turnId || this.audioContext !== ctx) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Connect through master gain for smooth anti-click gating
    if (this.masterGain) {
      const now = ctx.currentTime;
      // Restore master gain cleanly for new playback
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(1.0, now);
      source.connect(this.masterGain);
    } else {
      source.connect(ctx.destination);
    }

    const now = ctx.currentTime;
    // Seamless gapless scheduling on hardware clock with 15ms anti-clip lookahead headroom
    const startTime = Math.max(now + 0.015, this.nextPlayTime);
    source.start(startTime);
    this.nextPlayTime = startTime + buffer.duration;

    this.activeSources.push(source);

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.onPlaybackStateChange?.(true);
    }

    source.onended = () => {
      source.onended = null;
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }

      this.checkTurnCompletion();
    };
  }

  private checkTurnCompletion(): void {
    if (!this.isTurnActive) return;

    const ctx = this.audioContext;
    const isSynthSpeaking =
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      (window.speechSynthesis.speaking || window.speechSynthesis.pending);

    // Audio is playing if sources exist, context clock hasn't passed nextPlayTime, or synth is speaking
    const isAudioPlaying =
      this.activeSources.length > 0 ||
      (ctx !== null && ctx.currentTime < this.nextPlayTime) ||
      isSynthSpeaking;

    if (this.endTurnSignaled && this.queue.length === 0 && !this.isFetching && !isAudioPlaying) {
      // Physical output silence verification: verify speaker energy has decayed below -60 dBFS
      const { isTrueSilence } = this.getOutputDecibelLevel();

      if (!isTrueSilence) {
        this.consecutiveSilentFrames = 0;
        if (this.endTurnTimer) {
          window.clearTimeout(this.endTurnTimer);
        }
        this.endTurnTimer = window.setTimeout(() => {
          this.checkTurnCompletion();
        }, 20);
        return;
      }

      this.consecutiveSilentFrames++;
      if (this.consecutiveSilentFrames < this.REQUIRED_SILENT_FRAMES) {
        if (this.endTurnTimer) {
          window.clearTimeout(this.endTurnTimer);
        }
        this.endTurnTimer = window.setTimeout(() => {
          this.checkTurnCompletion();
        }, 20);
        return;
      }

      // Audio has decayed to true silence (< -60 dBFS) for 4 consecutive frames (~80ms)
      this.consecutiveSilentFrames = 0;
      if (this.isPlaying) {
        this.isPlaying = false;
        this.onPlaybackStateChange?.(false);
      }
      this.finishTurn();
    } else if (isAudioPlaying && ctx) {
      // Re-check 20ms after the scheduled completion timestamp
      if (this.endTurnTimer) {
        window.clearTimeout(this.endTurnTimer);
      }
      const delayMs = Math.max(15, Math.round((this.nextPlayTime - ctx.currentTime) * 1000) + 20);
      this.endTurnTimer = window.setTimeout(() => {
        this.checkTurnCompletion();
      }, delayMs);
    }
  }

  /**
   * Graceful fallback to browser speech synthesis if backend stream is unreachable.
   */
  private fallbackSpeak(text: string, turnId: number): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      this.checkTurnCompletion();
      return;
    }

    if (!this.isTurnActive || this.currentTurnId !== turnId) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.selectBestSpeechSynthesisVoice();
    if (voice) {
      utterance.voice = voice;
    }
    utterance.lang = voice?.lang || "en-US";
    utterance.rate = 1.05;
    utterance.pitch = 1.02;

    utterance.onstart = () => {
      if (this.currentTurnId !== turnId || !this.isTurnActive) return;
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.onPlaybackStateChange?.(true);
      }
    };

    utterance.onend = () => {
      this.currentUtterance = null;
      this.stopSynthKeepAlive();
      if (this.currentTurnId === turnId) {
        this.checkTurnCompletion();
      }
    };

    utterance.onerror = (e) => {
      this.currentUtterance = null;
      this.stopSynthKeepAlive();
      if (e.error !== "canceled" && e.error !== "interrupted") {
        console.warn("[NeuralAudioPlayer] SpeechSynthesis error:", e.error);
      }
      if (this.currentTurnId === turnId) {
        this.checkTurnCompletion();
      }
    };

    this.currentUtterance = utterance;
    this.startSynthKeepAlive();
    window.speechSynthesis.speak(utterance);
  }

  private loadSpeechSynthesisVoices(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    this.cachedVoices = window.speechSynthesis.getVoices();
    if (this.cachedVoices.length === 0 && window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = () => {
        this.cachedVoices = window.speechSynthesis.getVoices();
      };
    }
  }

  private selectBestSpeechSynthesisVoice(): SpeechSynthesisVoice | null {
    if (this.cachedVoices.length === 0 && typeof window !== "undefined" && "speechSynthesis" in window) {
      this.cachedVoices = window.speechSynthesis.getVoices();
    }
    if (this.cachedVoices.length === 0) return null;

    const englishVoices = this.cachedVoices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    const scoreVoice = (v: SpeechSynthesisVoice): number => {
      const name = v.name.toLowerCase();
      if (name.includes("natural") && (name.includes("jenny") || name.includes("aria"))) return 150;
      if (name.includes("natural") || name.includes("online")) return 130;
      if (name.includes("neural") || name.includes("premium")) return 120;
      if (name.includes("google") && name.includes("us english")) return 110;
      if (name.includes("siri") || name.includes("enhanced")) return 90;
      if (v.lang === "en-US") return 60;
      return 10;
    };
    englishVoices.sort((a, b) => scoreVoice(b) - scoreVoice(a));
    return englishVoices[0] || this.cachedVoices[0] || null;
  }

  /** Workaround for Chrome bug where long speech pauses after 15 seconds */
  private startSynthKeepAlive(): void {
    this.stopSynthKeepAlive();
    this.synthKeepAliveTimer = window.setInterval(() => {
      if (
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        window.speechSynthesis.speaking &&
        !window.speechSynthesis.paused
      ) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 5000);
  }

  private stopSynthKeepAlive(): void {
    if (this.synthKeepAliveTimer !== null) {
      window.clearInterval(this.synthKeepAliveTimer);
      this.synthKeepAliveTimer = null;
    }
  }

  /** Static helper to evict all decoded PCM buffers from memory */
  public static clearCache(): void {
    NeuralAudioPlayer.bufferCache.clear();
  }

  /** Cleanly tear down the player, close AudioContext, and release memory */
  public close(): void {
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleWake);
      window.removeEventListener("focus", this.handleWake);
    }
    this.stop();
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.masterGain = null;
    this.analyserNode = null;
    this.onPlaybackStateChange = null;
    this.onTurnStateChange = null;
  }

  public destroy(): void {
    this.close();
  }
}

export const neuralVoice = new NeuralAudioPlayer();
export const speechTTS = neuralVoice;
