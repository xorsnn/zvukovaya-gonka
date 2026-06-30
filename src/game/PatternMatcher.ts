/**
 * PatternMatcher — the hold → gap → stop shape state machine (issue #1; now also
 * carries Rung 2 vowel identity (#5) and Rung 3 consonant class (#6)).
 *
 * It turns a stream of {@link AudioFrame}s into three things the chase needs:
 *   - `driveQuality` 0..1 — how fast the cat should run *right now* (graded by
 *     how vowel-like and loud the sound is). NEVER gates to zero on its own; the
 *     floor lives in {@link GameView}. A clearer vowel drives faster; a noisy
 *     sound still drives.
 *   - `holdSatisfied` — has the child sustained a vowel-like sound long enough
 *     that the pounce may arm? This is what defeats the "single short shout".
 *   - `caught` — the catch event: fires after a real hold *and* a genuine stop.
 *     The stop is a near-silence gap (`silenceMs >= effGapMs`) — the generous
 *     "just stop / run out of breath" finale — OR, on a Rung-3 "stop" scene, the
 *     real fast «т» stop-burst (`frame.stopBurst`, #12). Which one is required is
 *     ASSIST-SCALED (#12): toward the easy end the breath-stop gap still wins;
 *     toward the strict end it is withdrawn and only a real «т» burst catches.
 *     Either way the "continuous scream" (no gap, no burst) never catches.
 *
 * LENIENCY BY DESIGN — two thresholds, not one:
 *   - a *lenient* `holdThreshold` decides whether a sound "counts as trying"
 *     (accumulates hold time);
 *   - the *graded* `vowelLikeness` itself sets the speed.
 * So an imperfect-but-real vowel still counts and still moves the cat.
 *
 * The `assist` knob (0..1) is the single difficulty dial. It relaxes every
 * threshold continuously toward today's loudness-only feel AND, post-#12, scales
 * the tug-of-war: at the easy end leniency is preserved (a wrong vowel still
 * keeps most of its drive, a breath-stop still wins); at the strict end a clearly
 * wrong vowel can net-negative and the «т» burst is required. It relaxes the
 * gate; it never silently bypasses it, and there is still no fail state — the
 * child always recovers by making the right sounds.
 *
 * Pure and deterministic: feed it canned frames in a test, no mic required.
 */

import type { AudioFrame } from "../audio/AudioEngine";
import {
  vowelMatch,
  classifyConsonant,
  type VowelBaseline,
  type ConsonantClass,
  type ReleaseFrame,
} from "../audio/PhoneticFeatures";
import type { AcousticPattern } from "./types";

/** A flicker shorter than this does not reset an in-progress hold. */
export const DROPOUT_GRACE_MS = 150;

/** Lower bound for the hold threshold even after baseline calibration. */
export const MIN_HOLD_THRESHOLD = 0.4;

/**
 * Rung 3 (#6): how many recent frames the consonant-class window keeps (~0.5 s
 * at 60 fps) — enough to see a sustained hold *and* the closure that follows it.
 * Only maintained when rung3 is on, so the default config allocates nothing.
 */
export const RUNG3_WINDOW_FRAMES = 32;

/**
 * Rung 3 (#12): the assist value at/below which a "stop" scene REQUIRES the real
 * «т» burst to catch — the breath-stop (run-out-of-breath) gap no longer finishes
 * it. Above this, the gap still wins (today's lenient finale, the default-safe
 * behavior). The escape hatch is the slider itself: a child not yet ready to
 * drill the «т» plays at a higher assist and still finishes by simply stopping.
 * Set so the default (0.5) stays lenient and only the deliberately-strict end
 * demands the «т». Placeholder pending real-mic tuning (#12, AC#6).
 */
export const BURST_REQUIRED_ASSIST = 0.3;

/**
 * Rung 2 (#5) leniency bound, EASY end. At the easy end a "wrong" vowel still
 * keeps at least this fraction of the vowel-graded drive, so the cat chases
 * clearly above the GameView `MIN_FLOOR` — "a bit slower", never "stalled". A
 * perfect vowel keeps the full drive (factor 1).
 */
export const VOWEL_MATCH_FLOOR = 0.55;

/**
 * Rung 2 (#12) leniency bound, STRICT end. The wrong-vowel floor is now
 * ASSIST-SCALED (`lerp(STRICT, EASY, assist)`): at the strict end it drops to
 * this, so a clearly-wrong vowel's drive can fall far enough that the mouse-flee
 * (GameView) nets it negative — the tug-of-war the issue calls for. It is still a
 * positive floor (the cat's own forward drive never hits zero); the regression
 * comes from the flee, not from a zeroed drive. At the easy/default end the floor
 * stays {@link VOWEL_MATCH_FLOOR}, preserving Rung-2 leniency. Placeholder pending
 * real-mic tuning (#12, AC#6).
 */
export const VOWEL_MATCH_FLOOR_STRICT = 0.15;

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
  /** Rung 3 (#6): coarse class of the recent release window ("none" when rung3
   * off / too little signal). For the debug overlay + tests. */
  consonantClass: ConsonantClass;
  /** Rung 3 (#12): true on the frame the real fast «т» stop-burst
   * (`frame.stopBurst`) fires the catch on a "stop" scene. Toward the strict end
   * this is the ONLY catch path (the breath-stop gap is withdrawn); toward easy it
   * is an early bonus on top of the gap. For the debug overlay + tests. */
  burstDetected: boolean;
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

  /**
   * Whether Rung 3 (consonant class / a real «т» stop, #6) grades this round.
   * Default OFF, so a matcher built without it behaves exactly as the shipped
   * Rung-1/2 matcher (parity, leniency invariant #1). When on, it maintains a
   * small release window to LABEL the consonant class, and — for a scene whose
   * release asks for a `"stop"` — ADDS an earlier burst-catch path. It never
   * touches the hold, the drive, or the gap-only catch.
   */
  private rung3: boolean;

  private sustainHeldMs = 0;
  private dropoutMs = 0;
  private holdSatisfied = false;
  private done = false;

  /** Rung 3 (#6) rolling release window (voiced + zcr per frame), kept only to
   * LABEL the consonant class for the debug overlay; only filled when rung3 is on,
   * so the default config allocates nothing here. The «т» catch itself no longer
   * derives from this window — it reads the engine's fast `frame.stopBurst` (#12). */
  private recent: ReleaseFrame[] = [];

  constructor(
    pattern: AcousticPattern,
    opts?: {
      assist?: number;
      holdThreshold?: number;
      rung1?: boolean;
      rung2?: boolean;
      rung3?: boolean;
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
    this.rung3 = opts?.rung3 ?? false;
    this.vowelBaseline = opts?.vowelBaseline ?? null;
  }

  /** Start a fresh round. */
  reset(): void {
    this.sustainHeldMs = 0;
    this.dropoutMs = 0;
    this.holdSatisfied = false;
    this.done = false;
    this.recent.length = 0;
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

    // --- Rung 2 (#5/#12): vowel-identity speed factor (graded, NEVER a hard gate) ---
    // A raw 0..1 closeness to the scene's target vowel, scored in HER formant
    // space. `assist` lifts the match toward 1 so a high assist makes vowel
    // identity barely matter (back to the Rung-1 feel). With rung2 off / no target
    // / no baseline this is exactly 1 → byte-identical Rung-1 drive (parity,
    // leniency invariant #1). It touches ONLY driveQuality; the hold and the catch
    // below stay pure Rung-1.
    //
    // The factor's FLOOR is now assist-scaled (#12): at the easy/default end it is
    // VOWEL_MATCH_FLOOR (a wrong vowel keeps most of its drive — leniency
    // preserved), but toward the strict end it relaxes to VOWEL_MATCH_FLOOR_STRICT
    // so a clearly-wrong vowel's drive falls far enough for the GameView
    // mouse-flee to net it negative (the tug-of-war). At assist=1, effMatch=1 →
    // vowelFactor=1 regardless of the floor, so easy is still byte-for-byte today.
    const vmatch =
      this.rung2 && this.pattern.vowel
        ? vowelMatch(
            { f1: frame.f1, f2: frame.f2 },
            this.pattern.vowel,
            this.vowelBaseline,
          )
        : 1;
    const effMatch = lerp(vmatch, 1, this.assist);
    const floor = lerp(VOWEL_MATCH_FLOOR_STRICT, VOWEL_MATCH_FLOOR, this.assist);
    const vowelFactor = floor + (1 - floor) * effMatch;

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

    // --- Rung 3 (#6): release window + consonant-class label (additive) ---
    // Filled only when rung3 is on (parity + zero cost otherwise). The label
    // feeds the debug overlay and the burst highlight; it gates nothing.
    let consonantClass: ConsonantClass = "none";
    if (this.rung3) {
      this.recent.push({ voiced: frame.voiced, zcr: frame.zcr });
      if (this.recent.length > RUNG3_WINDOW_FRAMES) this.recent.shift();
      consonantClass = classifyConsonant(this.recent);
    }

    // --- catch: a real hold, then a genuine stop (#12, consonant-gated) ---
    // Two stop evidences, the bar between them scaled by the one `assist` knob:
    //   • the «т» BURST — the engine's fast `frame.stopBurst` (a real closure→burst
    //     of 50–150 ms, #12), only on a Rung-3 "stop" scene. Always sufficient.
    //   • the breath-stop GAP — `frame.silenceMs >= effGapMs`, the generous "ran
    //     out of breath" finale. A continuous scream never produces a gap → no
    //     catch, exactly as before.
    // On a "stop" scene the gap is WITHDRAWN toward the strict end
    // (assist <= BURST_REQUIRED_ASSIST) so only a real «т» burst wins there (AC#3);
    // above it (default/easy) the gap still wins (leniency preserved). On a non-«т»
    // scene (or rung3 off) the gap ALWAYS wins — we never demand a burst a word
    // lacks, so «дом»/Rung-1 behavior is untouched.
    const rung3Stop = this.rung3 && this.pattern.release.want === "stop";
    const burstDetected = rung3Stop && frame.stopBurst;
    const breathStopWins = !rung3Stop || this.assist > BURST_REQUIRED_ASSIST;
    const gapCatch = breathStopWins && frame.silenceMs >= this.effGapMs;
    let caught = false;
    if (this.holdSatisfied && !this.done && (gapCatch || burstDetected)) {
      caught = true;
      this.done = true;
    }

    return {
      driveQuality,
      holdSatisfied: this.holdSatisfied,
      caught,
      sustainHeldMs: this.sustainHeldMs,
      vowelMatch: vmatch,
      consonantClass,
      burstDetected,
    };
  }
}
