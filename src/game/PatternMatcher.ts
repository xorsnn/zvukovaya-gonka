/**
 * PatternMatcher — the hold → gap → stop shape state machine (issue #1, Rung 0/1).
 *
 * It turns a stream of {@link AudioFrame}s into three things the chase needs:
 *   - `driveQuality` 0..1 — how fast the cat should run *right now* (graded by
 *     how vowel-like and loud the sound is). NEVER gates to zero on its own; the
 *     floor lives in {@link GameView}. A clearer vowel drives faster; a noisy
 *     sound still drives.
 *   - `holdSatisfied` — has the child sustained a vowel-like sound long enough
 *     that the pounce may arm? This is what defeats the "single short shout".
 *   - `caught` — the catch event: fires only after a real hold *and* a genuine
 *     stop (a near-silence gap). This is what defeats the "continuous scream"
 *     (no gap) and is the generous "just stop / run out of breath" finale.
 *
 * LENIENCY BY DESIGN — two thresholds, not one:
 *   - a *lenient* `holdThreshold` decides whether a sound "counts as trying"
 *     (accumulates hold time);
 *   - the *graded* `vowelLikeness` itself sets the speed.
 * So an imperfect-but-real vowel still counts and still moves the cat.
 *
 * The `assist` knob (0..1) relaxes every threshold continuously toward today's
 * loudness-only feel — a safety valve for a noisy room or a detector miss. It
 * relaxes the gate; it never silently bypasses it.
 *
 * Pure and deterministic: feed it canned frames in a test, no mic required.
 */

import type { AudioFrame } from "../audio/AudioEngine";
import type { AcousticPattern } from "./types";

/** A flicker shorter than this does not reset an in-progress hold. */
export const DROPOUT_GRACE_MS = 150;

/** Lower bound for the hold threshold even after baseline calibration. */
export const MIN_HOLD_THRESHOLD = 0.4;

export interface MatchState {
  /** 0..1 chase-speed factor for this frame (graded by vowel-likeness × level). */
  driveQuality: number;
  /** True once a long-enough vowel-like hold has been sustained (latches). */
  holdSatisfied: boolean;
  /** True on the single frame the catch fires (hold satisfied + a real stop). */
  caught: boolean;
  /** Continuous vowel-like hold accumulated so far, ms (for UI/debug). */
  sustainHeldMs: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class PatternMatcher {
  readonly pattern: AcousticPattern;

  /** 0 = strict (grade hard), 1 = easy (close to today's loudness-only feel). */
  assist: number;

  /** Base vowel-likeness needed to count as "holding"; from calibration. */
  private holdThreshold: number;

  private sustainHeldMs = 0;
  private dropoutMs = 0;
  private holdSatisfied = false;
  private done = false;

  constructor(
    pattern: AcousticPattern,
    opts?: { assist?: number; holdThreshold?: number },
  ) {
    this.pattern = pattern;
    this.assist = clamp01(opts?.assist ?? 0.5);
    this.holdThreshold = Math.max(
      MIN_HOLD_THRESHOLD,
      opts?.holdThreshold ?? MIN_HOLD_THRESHOLD,
    );
  }

  /** Start a fresh round. */
  reset(): void {
    this.sustainHeldMs = 0;
    this.dropoutMs = 0;
    this.holdSatisfied = false;
    this.done = false;
  }

  setAssist(assist: number): void {
    this.assist = clamp01(assist);
  }

  // ---- assist-scaled effective thresholds (the leniency continuum) ----

  private get effHoldThreshold(): number {
    return this.holdThreshold * (1 - this.assist * 0.7);
  }
  private get effMinMs(): number {
    return this.pattern.sustain.minMs * (1 - this.assist * 0.6);
  }
  private get effGapMs(): number {
    return this.pattern.release.requireGapMs * (1 - this.assist * 0.6);
  }

  /**
   * Advance the machine by one frame. `dtMs` is the elapsed time since the last
   * call (already clamped by the caller). Returns this frame's verdict.
   */
  update(frame: AudioFrame, dtMs: number): MatchState {
    const wantVowel = this.pattern.sustain.want === "vowel";

    // --- speed grading (always non-zero on real voicing; floor is in GameView) ---
    // assist lifts the effective vowel-likeness toward 1, easing the grading.
    const effVowel = lerp(frame.vowelLikeness, 1, this.assist * 0.5);
    const quality = wantVowel ? effVowel : 1; // Rung 0 grades on loudness only.
    const driveQuality = clamp01(quality * frame.level);

    // --- hold accumulation with dropout grace ---
    const holdOk =
      frame.voiced &&
      (!wantVowel || frame.vowelLikeness >= this.effHoldThreshold);

    if (holdOk) {
      this.sustainHeldMs += dtMs;
      this.dropoutMs = 0;
    } else {
      this.dropoutMs += dtMs;
      // A brief flicker is forgiven; a real break (before the hold is satisfied)
      // resets the accumulator. Once satisfied, the hold latches — the break is
      // the *stop* we're now waiting for.
      if (this.dropoutMs > DROPOUT_GRACE_MS && !this.holdSatisfied) {
        this.sustainHeldMs = 0;
      }
    }
    if (this.sustainHeldMs >= this.effMinMs) {
      this.holdSatisfied = true;
    }

    // --- catch: a real hold, then a genuine near-silence stop gap ---
    // `frame.silenceMs` is continuous near-silence since voicing dropped (the
    // engine's off-threshold is exactly the "near-silence" gap). A burst-after-
    // gap "Т" is subsumed: the stop closure produces the gap first, so the catch
    // fires on the closure. A continuous scream never produces a gap → no catch.
    let caught = false;
    if (this.holdSatisfied && !this.done && frame.silenceMs >= this.effGapMs) {
      caught = true;
      this.done = true;
    }

    return {
      driveQuality,
      holdSatisfied: this.holdSatisfied,
      caught,
      sustainHeldMs: this.sustainHeldMs,
    };
  }
}
