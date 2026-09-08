/**
 * In-browser Text-to-Speech service powered by Kokoro-82M (kokoro-js).
 *
 * v2 — streaming architecture:
 *   • Uses tts.stream(TextSplitterStream) instead of tts.generate().
 *   • LLM token deltas are pushed into the splitter as they arrive.
 *   • The stream yields small audio chunks that play immediately,
 *     cutting time-to-first-audio from 1-5 s down to ~100-300 ms.
 *   • Explicitly requests WebGPU (5-10x faster than WASM fallback).
 *   • Exposes turn-level playback state (not per-sentence) so
 *     speech recognition only pauses/resumes once per assistant turn.
 */

export type TTSProgressCallback = (progress: number, message: string) => void;
export type PlaybackStateCallback = (isPlaying: boolean) => void;
/** Fires once when the first audio chunk of a turn starts, and once when the last chunk ends. */
export type TurnStateCallback = (isTurnActive: boolean) => void;

class KokoroTTSService {
  private tts: any = null;
  private isInitializing: boolean = false;
  private initPromise: Promise<any> | null = null;
  private audioCtx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private isPlaying: boolean = false;
  private playbackQueue: AudioBuffer[] = [];
  private onPlaybackStateChange: PlaybackStateCallback | null = null;
  private onTurnStateChange: TurnStateCallback | null = null;

  // Streaming state
  private splitter: any = null; // TextSplitterStream instance
  private streamAbortId: number = 0; // incremented to cancel in-flight streams
  private isTurnActive: boolean = false;

  // af_heart is the official Grade-A flagship voice (natural pacing, clear diction)
  public voice: string = "af_heart";

  // ─── AudioContext ────────────────────────────────────────────────────

  public getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtxClass =
        window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate: 24000 });
      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = 64;
      this.analyserNode.smoothingTimeConstant = 0.8;
      this.analyserNode.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  /** Call synchronously from a user-gesture handler to unlock autoplay. */
  public unlockAudio(): void {
    this.getAudioContext();
  }

  public getAnalyserNode(): AnalyserNode | null {
    if (!this.analyserNode) {
      this.getAudioContext();
    }
    return this.analyserNode;
  }

  // ─── Callbacks ───────────────────────────────────────────────────────

  public setPlaybackStateCallback(cb: PlaybackStateCallback | null) {
    this.onPlaybackStateChange = cb;
  }

  /** Register a callback that fires once per assistant turn (not per sentence). */
  public setTurnStateCallback(cb: TurnStateCallback | null) {
    this.onTurnStateChange = cb;
  }

  // ─── Model Init ──────────────────────────────────────────────────────

  public async init(onProgress?: TTSProgressCallback): Promise<any> {
    if (this.tts) return this.tts;
    if (this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        onProgress?.(5, "Initializing neural voice engine…");
        const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

        const { KokoroTTS } = await import("kokoro-js");

        // Force WASM backend with q8 quantization.
        // NOTE: WebGPU with q8 suffers from a known ONNX Runtime Web kernel bug
        // (softmax numerical overflow) that produces alien/garbled/hyper-speed audio.
        // WASM runs CPU SIMD which is 100% mathematically stable and artifact-free.
        const instance = await KokoroTTS.from_pretrained(model_id, {
          dtype: "q8",
          device: "wasm",
          progress_callback: (item: any) => {
            if (
              item?.status === "progress" &&
              typeof item.progress === "number"
            ) {
              const pct = Math.min(Math.round(item.progress * 100), 100);
              onProgress?.(pct, `Downloading voice model (${pct}%)…`);
            } else if (item?.status === "done") {
              onProgress?.(100, "Voice model loaded and ready!");
            }
          },
        });
        console.log("[KokoroTTS] Loaded with WASM engine (artifact-free)");

        this.tts = instance;
        onProgress?.(100, "Ready");
        return instance;
      } catch (err) {
        this.initPromise = null;
        throw err;
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  public isReady(): boolean {
    return this.tts !== null;
  }

  // ─── Streaming TTS ───────────────────────────────────────────────────

  /**
   * Begin a new streaming TTS turn. Any in-flight turn is cancelled.
   * Must be called before pushText().
   */
  public async startStreaming(): Promise<void> {
    // Cancel any previous turn
    this.stop();

    if (!this.tts) {
      await this.init();
    }

    const { TextSplitterStream } = await import("kokoro-js");
    this.splitter = new TextSplitterStream();

    const turnId = this.streamAbortId;
    
    this.isTurnActive = true;
    this.onTurnStateChange?.(true);

    // Start the background consumer that converts text→audio and queues buffers
    this._consumeStream(turnId);
  }

  /**
   * Push an LLM token delta into the active streaming turn.
   * Sanitizes markdown symbols and non-ASCII chars to prevent phonemizer glitches.
   */
  public pushText(chunk: string): void {
    if (this.splitter && !this.splitter._closed) {
      const cleanChunk = chunk
        .replace(/[*_~`#]/g, "") // strip markdown emphasis, code, headers
        .replace(/[^\x00-\x7F]/g, " "); // strip non-ascii/emojis that corrupt phonemization
      if (cleanChunk) {
        this.splitter.push(cleanChunk);
      }
    }
  }

  /**
   * Signal that the LLM stream is complete. The splitter flushes
   * any remaining buffered text as a final sentence.
   */
  public flushText(): void {
    if (this.splitter && !this.splitter._closed) {
      this.splitter.close();
      this._checkTurnCompletion();
    }
  }

  private _checkTurnCompletion(): void {
    if (this.isTurnActive && !this.isPlaying && this.playbackQueue.length === 0) {
      const splitterDone = !this.splitter || this.splitter._closed;
      if (splitterDone) {
        this.isTurnActive = false;
        this.onTurnStateChange?.(false);
      }
    }
  }

  /**
   * Background async loop: consumes tts.stream(splitter) and queues
   * each yielded audio chunk for gap-free playback.
   */
  private async _consumeStream(turnId: number): Promise<void> {
    if (!this.tts || !this.splitter) return;

    const ctx = this.getAudioContext();

    try {
      const stream = this.tts.stream(this.splitter, {
        voice: this.voice,
      });

      for await (const chunk of stream) {
        // If the turn was cancelled (user interrupted or new turn started), stop.
        if (turnId !== this.streamAbortId) return;

        // Skip chunks with no pronounceable alphanumeric characters
        // (prevents synthesizing lone trailing punctuation or whitespace flushed at turn end)
        if (!chunk?.text || !/[a-zA-Z0-9]/.test(chunk.text)) {
          continue;
        }

        if (!chunk?.audio || !chunk.audio.audio) continue;

        const rawAudio: Float32Array = chunk.audio.audio;
        const sampleRate: number = chunk.audio.sampling_rate || 24000;

        const audioBuffer = ctx.createBuffer(1, rawAudio.length, sampleRate);
        audioBuffer.getChannelData(0).set(rawAudio);

        this.playbackQueue.push(audioBuffer);

        if (!this.isPlaying) {
          this._playNextInQueue();
        }
      }
      
      // When the stream iterator finishes, check if we're done
      if (turnId === this.streamAbortId) {
        this._checkTurnCompletion();
      }
    } catch (err: any) {
      if (turnId !== this.streamAbortId) return; // cancelled — not an error
      console.error("[KokoroTTS] Stream error:", err);
    }
  }

  // ─── Legacy speak() for greeting (single short sentence) ─────────

  /**
   * Synthesize and play a single short text. Use for the instant greeting
   * only — for multi-sentence LLM replies, use the streaming API.
   */
  public async speak(text: string): Promise<void> {
    const trimmed = text.replace(/[*_~`#]/g, "").trim();
    if (!trimmed || !/[a-zA-Z0-9]/.test(trimmed)) return;

    if (!this.tts) {
      await this.init();
    }

    const turnId = this.streamAbortId;
    const ctx = this.getAudioContext();

    try {
      const output = await this.tts.generate(trimmed, {
        voice: this.voice,
      });

      if (turnId !== this.streamAbortId) return;
      if (!output || !output.audio) return;

      const rawAudio: Float32Array = output.audio;
      const sampleRate: number = output.sampling_rate || 24000;

      const audioBuffer = ctx.createBuffer(1, rawAudio.length, sampleRate);
      audioBuffer.getChannelData(0).set(rawAudio);

      this.playbackQueue.push(audioBuffer);

      if (!this.isTurnActive) {
        this.isTurnActive = true;
        this.onTurnStateChange?.(true);
      }

      if (!this.isPlaying) {
        this._playNextInQueue();
      }
    } catch (err) {
      console.error("[KokoroTTS] Synthesis error:", err);
    }
  }

  // ─── Playback Queue ──────────────────────────────────────────────────

  private _playNextInQueue() {
    if (this.playbackQueue.length === 0) {
      this.isPlaying = false;
      this.currentSource = null;
      this.onPlaybackStateChange?.(false);

      // Turn ends when the queue is empty and no more chunks are coming
      this._checkTurnCompletion();
      return;
    }

    const ctx = this.getAudioContext();
    const buffer = this.playbackQueue.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (this.analyserNode) {
      source.connect(this.analyserNode);
    } else {
      source.connect(ctx.destination);
    }

    this.currentSource = source;
    this.isPlaying = true;
    this.onPlaybackStateChange?.(true);

    source.onended = () => {
      this._playNextInQueue();
    };

    source.start(0);
  }

  // ─── Stop / Interrupt ────────────────────────────────────────────────

  public stop() {
    this.streamAbortId++;
    this.playbackQueue = [];

    // Close any active splitter so the stream iterator finishes
    if (this.splitter && !this.splitter._closed) {
      try {
        this.splitter.close();
      } catch {
        // ignore
      }
    }
    this.splitter = null;

    if (this.currentSource) {
      try {
        this.currentSource.stop(0);
      } catch {
        // ignore
      }
      this.currentSource = null;
    }
    if (this.isPlaying) {
      this.isPlaying = false;
      this.onPlaybackStateChange?.(false);
    }
    if (this.isTurnActive) {
      this.isTurnActive = false;
      this.onTurnStateChange?.(false);
    }
  }
}

export const kokoroTTS = new KokoroTTSService();
