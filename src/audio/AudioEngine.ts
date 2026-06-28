/**
 * AudioEngine — the heart of the game.
 *
 * DESIGN RULE (non-negotiable): there is NO speech recognition here. We never
 * try to tell which phoneme or word was said. We only read the microphone
 * LOUDNESS ENVELOPE (RMS amplitude) in real time. Any voiced sound is rewarded.
 *
 * What we expose every frame (see {@link AudioFrame}):
 *   - level:   self-scaling 0..1 loudness for meters & chase speed. Auto-adapts
 *              to the child's own volume so even a quiet child fills the meter.
 *   - voiced:  is there sound above the noise floor right now (with hysteresis).
 *   - onset:   a fresh quiet→loud transition this frame (used as the "burst").
 *   - release: a loud→quiet transition this frame.
 *
 * Calibration is automatic: we measure the ambient noise floor at startup and
 * keep adapting it slowly while the room is quiet, so it survives a normal noisy
 * room without any knobs.
 */

export interface AudioFrame {
  /** Raw smoothed RMS amplitude (roughly 0..0.5 for normal speech). */
  rms: number;
  /** Current adaptive noise floor estimate. */
  noiseFloor: number;
  /** Self-scaling loudness 0..1 (relative to the child's recent loudest). */
  level: number;
  /** True while sound is above the voice threshold (with hysteresis). */
  voiced: boolean;
  /** True on the single frame a quiet→loud transition happens. */
  onset: boolean;
  /** True on the single frame a loud→quiet transition happens. */
  release: boolean;
  /** Milliseconds the current voiced burst has lasted (0 when not voiced). */
  voicedMs: number;
  /** Milliseconds of silence since voicing stopped (0 while voiced). */
  silenceMs: number;
}

export type MicStatus =
  | "idle"
  | "requesting"
  | "running"
  | "denied"
  | "error";

export class AudioEngine {
  status: MicStatus = "idle";
  errorMessage = "";

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(0);

  // Smoothed RMS with asymmetric attack/release so the meter snaps up fast but
  // settles down gently (feels alive, not jittery).
  private smoothed = 0;

  // Adaptive noise floor. Starts pessimistic, calibrates down quickly to the
  // real ambient level, then tracks slow upward drift in room noise.
  private noiseFloor = 0.015;
  private calibrating = true;
  private calibSamples: number[] = [];

  // Self-scaling reference for `level`: the child's recent loudest sound maps to
  // 1.0 and decays slowly so the meter keeps feeling responsive.
  private loudRef = 0.06;

  // Voiced-state hysteresis + timers.
  private voiced = false;
  private voicedSince = 0;
  private silenceSince = 0;

  private lastSampleTime = 0;

  get isRunning(): boolean {
    return this.status === "running";
  }

  /**
   * Request the mic and wire up the analyser. MUST be called from a user
   * gesture (button tap) so the browser allows getUserMedia + AudioContext.
   */
  async init(): Promise<boolean> {
    this.status = "requesting";
    try {
      // Disable every browser-side processing stage. AGC would flatten the
      // loudness dynamics the whole game depends on; noiseSuppression/echo
      // cancellation can gate a child's quiet, breathy sounds — exactly what we
      // need to hear. We do our own noise-floor handling instead.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err: unknown) {
      const e = err as DOMException;
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
        this.status = "denied";
      } else {
        this.status = "error";
        this.errorMessage = (e && e.message) || String(err);
      }
      return false;
    }

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // We smooth manually for full control over attack/release.
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);

    await this.resume();
    this.status = "running";
    this.lastSampleTime = performance.now();
    return true;
  }

  /** Resume a suspended AudioContext (needed after backgrounding on mobile). */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  /** Restart the short auto-calibration window (e.g. parent re-checks mic). */
  recalibrate(): void {
    this.calibrating = true;
    this.calibSamples = [];
  }

  /**
   * Read one frame. Call once per requestAnimationFrame. Cheap (one pass over a
   * 1024-sample buffer). Returns a neutral frame until the mic is running.
   */
  sample(now: number): AudioFrame {
    if (!this.analyser) {
      return {
        rms: 0,
        noiseFloor: this.noiseFloor,
        level: 0,
        voiced: false,
        onset: false,
        release: false,
        voicedMs: 0,
        silenceMs: 0,
      };
    }

    const dt = Math.min(100, now - this.lastSampleTime || 16);
    this.lastSampleTime = now;

    // ---- raw RMS ----
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      sum += v * v;
    }
    const rawRms = Math.sqrt(sum / this.buf.length);

    // ---- asymmetric smoothing (fast attack, slow release) ----
    const rising = rawRms > this.smoothed;
    const attack = 1 - Math.exp(-dt / 30); // ~30ms time constant up
    const releaseTc = 1 - Math.exp(-dt / 120); // ~120ms time constant down
    const a = rising ? attack : releaseTc;
    this.smoothed += (rawRms - this.smoothed) * a;
    const rms = this.smoothed;

    // ---- auto noise-floor calibration ----
    if (this.calibrating) {
      this.calibSamples.push(rawRms);
      // ~1.2s at 60fps. Use a high percentile of ambient as the floor so the
      // occasional click doesn't fool us, then pad it a touch.
      if (this.calibSamples.length >= 70) {
        const sorted = [...this.calibSamples].sort((x, y) => x - y);
        const p80 = sorted[Math.floor(sorted.length * 0.8)];
        this.noiseFloor = Math.max(0.006, p80 * 1.6);
        this.calibrating = false;
        this.calibSamples = [];
      }
    } else {
      // Slowly track the quiet baseline. When clearly quiet, let the floor
      // ease toward the current level; never let it run away upward.
      if (rms < this.noiseFloor * 1.3) {
        this.noiseFloor += (Math.max(0.006, rms * 1.5) - this.noiseFloor) * 0.02;
      }
    }

    // ---- voice threshold with hysteresis ----
    const onThreshold = this.noiseFloor * 2.2;
    const offThreshold = this.noiseFloor * 1.4;
    let onset = false;
    let release = false;
    if (!this.voiced && rms > onThreshold) {
      this.voiced = true;
      this.voicedSince = now;
      onset = true;
    } else if (this.voiced && rms < offThreshold) {
      this.voiced = false;
      this.silenceSince = now;
      release = true;
    }

    // ---- self-scaling level for meter & chase speed ----
    // loudRef rises instantly to new peaks, decays slowly so a single loud burst
    // sets the scale for a while. This is what lets a quiet child still "win".
    if (rms > this.loudRef) {
      this.loudRef = rms;
    } else {
      this.loudRef += (Math.max(0.04, rms) - this.loudRef) * 0.002;
    }
    const span = Math.max(0.0001, this.loudRef - this.noiseFloor);
    let level = (rms - this.noiseFloor) / span;
    level = Math.max(0, Math.min(1, level));
    // Slight curve so quiet sounds still register visibly.
    level = Math.pow(level, 0.7);

    const voicedMs = this.voiced ? now - this.voicedSince : 0;
    const silenceMs = this.voiced ? 0 : now - this.silenceSince;

    return {
      rms,
      noiseFloor: this.noiseFloor,
      level,
      voiced: this.voiced,
      onset,
      release,
      voicedMs,
      silenceMs,
    };
  }

  /** Stop the mic and release the device. */
  dispose(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
    }
    this.analyser = null;
    this.ctx = null;
    this.stream = null;
    this.status = "idle";
  }
}
