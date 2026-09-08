/**
 * In-browser Text-to-Speech service powered by Kokoro-82M (kokoro-js).
 * Runs completely locally in the caller's browser via WebGPU / WebAssembly with zero server cost,
 * zero WebRTC packet loss, and zero clipping distortion.
 */

export type TTSProgressCallback = (progress: number, message: string) => void;
export type PlaybackStateCallback = (isPlaying: boolean) => void;

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
  private activeUtteranceId: number = 0;

  public voice: string = "af_sky"; // "af_sky", "af_heart", "af_bella", "am_adam"

  /**
   * Ensure AudioContext is initialized and running (resuming if suspended by browser autoplay policy).
   */
  public getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
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

  /**
   * Create and resume the audio context while a user gesture is still active.
   * Calling this from the Start button prevents autoplay policies from
   * silently suppressing the assistant's first reply.
   */
  public unlockAudio(): void {
    this.getAudioContext();
  }

  /**
   * Return the Web Audio AnalyserNode for visualizing speech energy in real time.
   */
  public getAnalyserNode(): AnalyserNode | null {
    if (!this.analyserNode) {
      this.getAudioContext();
    }
    return this.analyserNode;
  }

  /**
   * Set callback for when voice playback starts or ends.
   */
  public setPlaybackStateCallback(cb: PlaybackStateCallback | null) {
    this.onPlaybackStateChange = cb;
  }

  /**
   * Initialize and cache the quantized Kokoro-82M ONNX model in IndexedDB.
   */
  public async init(onProgress?: TTSProgressCallback): Promise<any> {
    if (this.tts) return this.tts;
    if (this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        onProgress?.(5, "Initializing voice synthesis engine…");
        const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

        // Keep the ONNX runtime out of the initial dashboard bundle. It is
        // loaded only after the visitor explicitly starts a voice demo.
        const { KokoroTTS } = await import("kokoro-js");
        const instance = await KokoroTTS.from_pretrained(model_id, {
          dtype: "q8",
          progress_callback: (item: any) => {
            if (item?.status === "progress" && typeof item.progress === "number") {
              const pct = Math.min(Math.round(item.progress * 100), 100);
              onProgress?.(pct, `Downloading voice model (${pct}%)…`);
            } else if (item?.status === "done") {
              onProgress?.(100, "Voice model loaded and ready!");
            }
          },
        });

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

  /**
   * Synthesize text to raw audio and queue it for seamless, gap-free playback.
   */
  public async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (!this.tts) {
      await this.init();
    }

    const utteranceId = this.activeUtteranceId;
    const ctx = this.getAudioContext();

    try {
      // Synthesize audio with Kokoro
      const output = await this.tts.generate(trimmed, {
        voice: this.voice,
      });

      // If user interrupted while generating this sentence, discard it
      if (utteranceId !== this.activeUtteranceId) {
        return;
      }

      if (!output || !output.audio) return;

      const rawAudio: Float32Array = output.audio;
      const sampleRate: number = output.sampling_rate || 24000;

      // Create Web Audio AudioBuffer
      const audioBuffer = ctx.createBuffer(1, rawAudio.length, sampleRate);
      audioBuffer.getChannelData(0).set(rawAudio);

      this.playbackQueue.push(audioBuffer);

      if (!this.isPlaying) {
        this.playNextInQueue();
      }
    } catch (err) {
      console.error("[KokoroTTS] Synthesis error:", err);
    }
  }

  private playNextInQueue() {
    if (this.playbackQueue.length === 0) {
      this.isPlaying = false;
      this.currentSource = null;
      this.onPlaybackStateChange?.(false);
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
      this.playNextInQueue();
    };

    source.start(0);
  }

  /**
   * Stop playback immediately, cancel the playback queue, and invalidate pending generation.
   */
  public stop() {
    this.activeUtteranceId++;
    this.playbackQueue = [];
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
  }
}

export const kokoroTTS = new KokoroTTSService();
