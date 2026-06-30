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
import { vowelMatch, type VowelBaseline } from "../audio/PhoneticFeatures";
import type { AcousticPattern } from "./types";

/** A flicker shorter than this does not reset an in-progress hold. */
export const DROPOUT_GRACE_MS = 150;

/** Lower bound for the hold threshold even after baseline calibration. */
export const MIN_HOLD_THRESHOLD = 0.4;

/**
 * Rung 2 (#5) leniency bound. A "wrong" vowel still keeps at least this fraction
 * of the vowel-graded drive, so the cat always chases clearly above the
 * GameView `MIN_FLOOR` — the worst case is "a bit slower", never "stalled". A
 * perfect vowel keeps the full drive (factor 1). This is what makes Rung 2
 * *graded, never gated*: identifying the vowel can only ADD speed for a match,
 * it can never punish a real attempt down to nothing. See issue #5's leniency
 * invariants.
 */
export const VOWEL_MATCH_FLOOR = 0.55;

export interface MatchState {
  /** 0..1 chase-speed factor for this frame (graded by vowel-likeness × level). */
  driveQuality: number;
  /** True once a long-enough vowel-like hold has been sustained (latches). */
  holdSatisfied: boolean;
  /** True on the single frame the catch fires (hold satisfied + a real stop). */
  caught: boolean;
  /** Continuous vowel-like hold accumulated so far, ms (for UI/debug). */
  sustainHeldMs: number;
  /** Rung 2 (#5): raw 0..1 closeness to the scene's target vowel (1 = no opinion,
   * i.e. rung2 off / no target / no baseline). For the debug overlay + tests. */
  vowelMatch: number;
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

  /**
   * Whether Rung 1 (vowel-ish vs noise) grades this round (issue #4 config).
   * When off, the hold gate is loudness-only — any voicing counts, regardless of
   * the scene's `want: "vowel"` — so the matcher reduces to Rung 0. Rungs 2/3
   * (vowel identity / consonant class, #5/#6) layer additively on top of this and
   * default off, so with only rung1 on the behavior is exactly Increment-1.
   */
  private rung1: boolean;

  /**
   * Whether Rung 2 (vowel identity, #5) grades this round. Default OFF, so a
   * matcher built without it behaves exactly as the shipped Rung-1 matcher
   * (snapshot/feature parity, leniency invariant #1). When on AND the scene has
   * a target `vowel` AND a calibrated formant baseline exists, a gentle,
   * bounded vowel-match factor folds into `driveQuality` — never into the hold
   * or the catch.
   */
  private rung2: boolean;

  /** Per-child formant baseline (her «а»), so vowel-match is scored in HER vowel
   * space, not absolute Hz. Null → Rung 2 stays neutral (no penalty). */
  private vowelBaseline: VowelBaseline | null;

  private sustainHeldMs = 0;
  private dropoutMs = 0;
  private holdSatisfied = false;
  private done = false;

  constructor(
    pattern: AcousticPattern,
    opts?: {
      assist?: number;
      holdThreshold?: number;
      rung1?: boolean;
      rung2?: boolean;
      vowelBaseline?: VowelBaseline | null;
    },
  ) {
    this.pattern = pattern;
    this.assist = clamp01(opts?.assist ?? 0.5);
    this.holdThreshold = Math.max(
      MIN_HOLD_THRESHOLD,
      opts?.holdThreshold ?? MIN_HOLD_THRESHOLD,
    );
    this.rung1 = opts?.rung1 ?? true;
    this.rung2 = opts?.rung2 ?? false;
    this.vowelBaseline = opts?.vowelBaseline ?? null;
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
    // Rung 1 off → grade on loudness alone (Rung 0), even for a "vowel" scene.
    const wantVowel = this.pattern.sustain.want === "vowel" && this.rung1;

    // --- speed grading (always non-zero on real voicing; floor is in GameView) ---
    // assist lifts the effective vowel-likeness toward 1, easing the grading.
    const effVowel = lerp(frame.vowelLikeness, 1, this.assist * 0.5);
    const quality = wantVowel ? effVowel : 1; // Rung 0 grades on loudness only.

    // --- Rung 2 (#5): vowel-identity speed factor (graded, NEVER a gate) ---
    // A raw 0..1 closeness to the scene's target vowel, scored in HER formant
    // space. We only ADD speed for a match: the factor is bounded to
    // [VOWEL_MATCH_FLOOR, 1], and `assist` lifts the match toward 1 so a high
    // assist makes vowel identity barely matter (back to the Rung-1 feel). With
    // rung2 off / no target / no baseline this is exactly 1 → byte-identical
    // Rung-1 drive (parity, leniency invariant #1). It touches ONLY driveQuality;
    // the hold and the catch below stay pure Rung-1.
    const vmatch =
      this.rung2 && this.pattern.vowel
        ? vowelMatch(
            { f1: frame.f1, f2: frame.f2 },
            this.pattern.vowel,
            this.vowelBaseline,
          )
        : 1;
    const effMatch = lerp(vmatch, 1, this.assist);
    const vowelFactor = VOWEL_MATCH_FLOOR + (1 - VOWEL_MATCH_FLOOR) * effMatch;

    const driveQuality = clamp01(quality * frame.level * vowelFactor);

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
      vowelMatch: vmatch,
    };
  }
}
