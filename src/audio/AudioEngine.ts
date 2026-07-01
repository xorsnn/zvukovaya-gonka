/**
 * AudioEngine — the heart of the game.
 *
 * DESIGN RULE (updated 2026-06-29, issue #1): there is still NO speech
 * recognition here — we never decode which word or phoneme was said. What we DO
 * now read, in addition to the loudness envelope, is a handful of cheap
 * *acoustic features* (spectral flatness, centroid, low-band ratio,
 * zero-crossing rate) blended into a single 0..1 `vowelLikeness`. That lets the
 * game tell a sustained «о-о-о» from a flat shriek without ever asking which
 * vowel it was. Any voiced sound is still rewarded; a clearer vowel is rewarded
 * *more* (graded, never punished — see {@link PatternMatcher}).
 *
 * The whole spectral layer is additive and sits behind a config-driven flag
 * (see {@link AudioEngine.setPhoneticEnabled}, fed from `PhoneticConfig`). With
 * no rung enabled `sample()` returns exactly the pre-#1 loudness-only frame.
 *
 * What we expose every frame (see {@link AudioFrame}):
 *   - level:   self-scaling 0..1 loudness for meters & chase speed. Auto-adapts
 *              to the child's own volume so even a quiet child fills the meter.
 *   - voiced:  is there sound above the noise floor right now (with hysteresis).
 *   - onset:   a fresh quiet→loud transition this frame (used as the "burst").
 *   - release: a loud→quiet transition this frame.
 *   - flatness/centroid/lowBandRatio/zcr/vowelLikeness: the phonetic layer.
 *
 * Calibration is automatic: we measure the ambient noise floor at startup and
 * keep adapting it slowly while the room is quiet, so it survives a normal noisy
 * room without any knobs.
 */

import {
  spectralFlatness,
  spectralCentroid,
  lowBandRatio as lowBandRatioOf,
  zeroCrossingRate,
  vowelLikeness,
  estimateFormants,
  detectStopBurst,
  type VowelBaseline,
} from "./PhoneticFeatures";

/**
 * The slice of `AnalyserNode` the engine actually uses. Declaring it as an
 * interface lets tests inject a fake that fills the buffers from canned data —
 * no AudioContext, no microphone — while a real `AnalyserNode` satisfies it
 * structurally.
 */
export interface SpectralAnalyserLike {
  fftSize: number;
  frequencyBinCount: number;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
  getFloatFrequencyData(array: Float32Array<ArrayBuffer>): void;
}

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

  // ---- phonetic layer (issue #1); all 0 when the phonetic layer is off ----
  /** Spectral flatness 0..1: ~0 tonal/vowel, ~1 noisy/shriek. */
  flatness: number;
  /** Spectral centroid in Hz: low = dark/vowel, high = bright/shriek. */
  centroid: number;
  /** Fraction of energy below 1 kHz, 0..1: high for vowels. */
  lowBandRatio: number;
  /** Zero-crossing rate 0..1: low for vowels, high for fricatives/shrieks. */
  zcr: number;
  /** Blended 0..1 "how vowel-like is this sound" — the score the game grades on. */
  vowelLikeness: number;
  /** First formant estimate in Hz (Rung 2, #5); 0 when off or silent. */
  f1: number;
  /** Second formant estimate in Hz (Rung 2, #5); 0 when off or silent. */
  f2: number;
  /** Rung 3 (#12): true on the single frame a real «т» stop-burst — a brief
   * energy dip (closure) then a transient — completes, read from a FAST envelope
   * independent of the 120 ms-smoothed `voiced` path. False when the phonetic
   * layer is off. The matcher consumes this for the strict consonant-gated catch. */
  stopBurst: boolean;
}

export type MicStatus =
  | "idle"
  | "requesting"
  | "running"
  | "denied"
  | "error";

/** Fast-envelope attack time constant (ms) for the stop-burst detector (#12) —
 * short, so a «т» release transient registers within a frame or two. */
const FAST_ENV_ATTACK_MS = 4;
/** Fast-envelope release time constant (ms) — short, so a «т» closure collapses
 * the envelope within ~50 ms instead of the 120 ms-smoothed path's ~387 ms. */
const FAST_ENV_RELEASE_MS = 18;
/** How many recent `fastEnv` frames the detector inspects (~0.3 s at 60 fps) —
 * enough to hold a vowel, a 50–150 ms closure, and the burst together. */
const FAST_ENV_HIST_FRAMES = 20;

export class AudioEngine {
  status: MicStatus = "idle";
  errorMessage = "";

  private ctx: AudioContext | null = null;
  private analyser: SpectralAnalyserLike | null = null;
  private stream: MediaStream | null = null;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(0);
  private freqDb: Float32Array<ArrayBuffer> = new Float32Array(0);
  private mag: Float32Array<ArrayBuffer> = new Float32Array(0);
  // Reusable scratch for the formant envelope, so estimateFormants allocates
  // nothing per frame (matches how mag/freqDb/buf are reused). See Rung 2 (#5).
  private formantEnv: Float32Array<ArrayBuffer> = new Float32Array(0);
  private sampleRate = 44100;

  // Optional per-child vowel baseline (from the mic-check calibration) so a
  // 3-yr-old's high formants aren't misread as noise. Null = use adult default.
  private vowelBaseline: VowelBaseline | null = null;

  // Whether the spectral (phonetic) layer runs. Driven by the caregiver config
  // ("is any rung enabled?", issue #4) — the generalization of the old
  // USE_PHONETIC kill-switch. Defaults on so a directly-constructed engine
  // (e.g. tests) keeps the Increment-1 behavior without extra wiring.
  private phoneticEnabled = true;

  // Whether to estimate F1/F2 (Rung 2, #5). Gated separately from the rest of the
  // spectral layer because the formant pass is ONLY consumed when rung2 grades a
  // scene; in the shipped default (rung2 off) computing it every frame would be
  // pure waste. Defaults on so a directly-constructed engine (tests) still emits
  // f1/f2 without extra wiring; the host narrows it to `config.rung2`.
  private rung2Enabled = true;

  // Smoothed RMS with asymmetric attack/release so the meter snaps up fast but
  // settles down gently (feels alive, not jittery).
  private smoothed = 0;

  // A SECOND, much faster envelope used only for the «т» stop-burst detector
  // (#12). Fast attack + fast release (a few ms each) so it tracks a 50–150 ms
  // closure-then-burst that the 120 ms-release `smoothed`/`voiced` path is far too
  // sluggish to see (#11). Kept entirely separate so it can't perturb `level`,
  // `voiced`, or any pre-#12 frame field. Only updated when the phonetic layer is on.
  private fastEnv = 0;
  /** Rolling history of `fastEnv` (oldest→newest) the pure detector reads. */
  private fastEnvHist: number[] = [];

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

  /**
   * @param opts.analyser — inject a fake analyser for tests; when given, the
   *   engine is wired up for `sample()` without `init()` / a real mic.
   * @param opts.sampleRate — sample rate to assume for the injected analyser.
   */
  constructor(opts?: { analyser?: SpectralAnalyserLike; sampleRate?: number }) {
    if (opts?.analyser) {
      this.attachAnalyser(opts.analyser, opts.sampleRate ?? 44100);
      this.status = "running";
      this.lastSampleTime = 0;
    }
  }

  get isRunning(): boolean {
    return this.status === "running";
  }

  /** Allocate the working buffers for a given analyser + sample rate. */
  private attachAnalyser(
    analyser: SpectralAnalyserLike,
    sampleRate: number,
  ): void {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.buf = new Float32Array(analyser.fftSize);
    this.freqDb = new Float32Array(analyser.frequencyBinCount);
    this.mag = new Float32Array(analyser.frequencyBinCount);
    this.formantEnv = new Float32Array(analyser.frequencyBinCount);
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
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    // We smooth manually for full control over attack/release.
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    this.attachAnalyser(analyser, this.ctx.sampleRate);

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
    // Drop any stale per-child vowel baseline; main.ts re-measures it during
    // the mic-check that follows a recalibrate.
    this.vowelBaseline = null;
  }

  /**
   * Set (or clear) the per-child sustained-vowel baseline used to score the
   * spectral centroid *relative* to her own voice. See the age note in #1.
   */
  setVowelBaseline(baseline: VowelBaseline | null): void {
    this.vowelBaseline = baseline;
  }

  /** The current per-child vowel baseline (centroid + optional F1/F2), so the
   * host can hand it to the matcher for Rung-2 vowel-match scoring (#5). */
  getVowelBaseline(): VowelBaseline | null {
    return this.vowelBaseline;
  }

  /**
   * Enable/disable the spectral (phonetic) layer. The host passes
   * `anyRungOn(config)` (issue #4): when disabled, `sample()` skips all spectral
   * work and every phonetic field is 0 — the exact pre-#1 loudness-only frame.
   * Cheap to flip live (mid-session), which is the config's rollback path.
   */
  setPhoneticEnabled(enabled: boolean): void {
    this.phoneticEnabled = enabled;
  }

  /**
   * Enable/disable the per-frame F1/F2 formant estimate (Rung 2, #5). The host
   * passes `config.rung2`: off → `sample()` skips the formant pass entirely and
   * `f1/f2` stay 0, so the default config pays nothing for a disabled feature.
   */
  setRung2Enabled(enabled: boolean): void {
    this.rung2Enabled = enabled;
  }

  /**
   * Read one frame. Call once per requestAnimationFrame. Cheap (one pass over a
   * 1024-sample buffer, one over the 512-bin spectrum). Returns a neutral frame
   * until the mic is running.
   */
  sample(now: number): AudioFrame {
    if (!this.analyser) {
      return this.neutralFrame();
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

    // ---- phonetic layer (additive, behind the kill-switch) ----
    let flatness = 0;
    let centroid = 0;
    let lowBand = 0;
    let zcr = 0;
    let vl = 0;
    let f1 = 0;
    let f2 = 0;
    let stopBurst = false;
    if (this.phoneticEnabled) {
      this.analyser.getFloatFrequencyData(this.freqDb);
      // AnalyserNode hands back dB; convert once to linear magnitude. Empty bins
      // are -Infinity dB → 0 magnitude (no NaN).
      for (let i = 0; i < this.freqDb.length; i++) {
        this.mag[i] = Math.pow(10, this.freqDb[i] / 20);
      }
      flatness = spectralFlatness(this.mag);
      centroid = spectralCentroid(this.mag, this.sampleRate);
      lowBand = lowBandRatioOf(this.mag, this.sampleRate);
      zcr = zeroCrossingRate(this.buf);
      vl = vowelLikeness(
        { flatness, centroid, lowBandRatio: lowBand, zcr },
        this.vowelBaseline,
      );
      // Coarse F1/F2 for Rung 2 (#5), only when a consumer exists. Reuses the
      // shared envelope scratch so the hot path allocates nothing per frame.
      if (this.rung2Enabled) {
        ({ f1, f2 } = estimateFormants(
          this.mag,
          this.sampleRate,
          this.formantEnv,
        ));
      }

      // Fast envelope for the «т» stop-burst (#12). Tracks `rawRms`, NOT the
      // 120 ms-smoothed `rms`, so a brief closure-then-burst is visible. Then ask
      // the pure detector whether the latest frame completes that shape.
      const fAttack = 1 - Math.exp(-dt / FAST_ENV_ATTACK_MS);
      const fRelease = 1 - Math.exp(-dt / FAST_ENV_RELEASE_MS);
      this.fastEnv += (rawRms - this.fastEnv) * (rawRms > this.fastEnv ? fAttack : fRelease);
      this.fastEnvHist.push(this.fastEnv);
      if (this.fastEnvHist.length > FAST_ENV_HIST_FRAMES) this.fastEnvHist.shift();
      stopBurst = detectStopBurst(this.fastEnvHist, this.noiseFloor, dt);
    }

    return {
      rms,
      noiseFloor: this.noiseFloor,
      level,
      voiced: this.voiced,
      onset,
      release,
      voicedMs,
      silenceMs,
      flatness,
      centroid,
      lowBandRatio: lowBand,
      zcr,
      vowelLikeness: vl,
      f1,
      f2,
      stopBurst,
    };
  }

  /** The frame returned before the mic is running (all-quiet, no phonetics). */
  private neutralFrame(): AudioFrame {
    return {
      rms: 0,
      noiseFloor: this.noiseFloor,
      level: 0,
      voiced: false,
      onset: false,
      release: false,
      voicedMs: 0,
      silenceMs: 0,
      flatness: 0,
      centroid: 0,
      lowBandRatio: 0,
      zcr: 0,
      vowelLikeness: 0,
      f1: 0,
      f2: 0,
      stopBurst: false,
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
