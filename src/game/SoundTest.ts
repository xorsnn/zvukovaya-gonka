/**
 * SoundTest — pure scoring logic for the dev/caregiver detection-test screen
 * (issue #22). No DOM, no `Date.now()`, no `Math.random()`, so it is unit-testable
 * in plain Node exactly like {@link PhoneticFeatures}/{@link PatternMatcher}.
 *
 * The test screen MEASURES detection quality; it never gates gameplay and shares
 * no state with the matcher (the same read-only invariant as the live-vowel chip,
 * #13). This module owns three pieces of that measurement:
 *
 *   1. {@link BurstAccumulator} — segments the mic stream into one *attempt* per
 *      voiced burst (onset→release, plus a short tail so a terminal «т» release is
 *      caught), applying a validity filter that drops clicks / room noise.
 *   2. {@link burstVerdict} — the pure rule that turns one attempt's frames into a
 *      detected label, scoring EXACTLY what the game/chip act on: the modal gated
 *      {@link LetterIndicator} verdict across the sustained core (vowel targets),
 *      or "did a «т» stop-burst fire in the window" (target Т).
 *   3. {@link ScoreTally} — a reducer over (target, detected) pairs that exposes
 *      the hit rate + a confusion breakdown for one target.
 *
 * STILL NOT speech recognition: `detected` is only the coarse feature verdict the
 * rest of the game already computes (argmax vowel region / stop-burst shape),
 * never a decoded phoneme. The screen just tallies how often it matches intent.
 */

/** A practice target the caregiver aims for: the four nucleus vowels or the «т»
 * stop. Uppercase «Т» matches the letter shown on the scoring UI; the vowels are
 * lowercase to line up with {@link Vowel}/{@link classifyVowel}. */
export type TestTarget = "а" | "о" | "у" | "и" | "Т";

/** The detected outcome of one attempt: a target, or «—» (weak / ambiguous /
 * below-gate — a real outcome, the "А→—" confusion row, not an error). */
export type Detected = TestTarget | "—";

/** The five targets in cycle order (а→о→у→и→Т→а), shared by the "next target"
 * button and the confusion display so both stay in sync. */
export const TEST_TARGETS: readonly TestTarget[] = ["а", "о", "у", "и", "Т"] as const;

/** All possible detected labels, for a fully-initialised confusion record. */
export const DETECTED_LABELS: readonly Detected[] = [
  "а",
  "о",
  "у",
  "и",
  "Т",
  "—",
] as const;

/** A burst shorter than this (core onset→release, ms) is a click, not an attempt. */
export const MIN_BURST_MS = 120;
/** A burst whose peak `level` never reaches this is room noise, not an attempt. */
export const MIN_BURST_PEAK = 0.3;
/** Extra window after the voiced release during which a terminal «т» burst still
 * counts toward the attempt — a stop release fires around/after the release. */
export const T_TAIL_MS = 250;
/** Frames within this many ms of onset are the attack (the EMA is still settling),
 * excluded from the vowel verdict's sustained core. ~5 frames at 16 ms. */
export const ATTACK_EXCLUDE_MS = 80;
/** A frame counts toward the sustained core only if its `level` is at least this
 * fraction of the burst peak — so the quiet onset/decay ramps don't vote. */
export const CORE_LEVEL_FRACTION = 0.5;

/** One frame fed into the {@link BurstAccumulator}. Deliberately minimal — the
 * exact fields the screen already samples from an {@link AudioFrame} plus the
 * gated {@link LetterIndicator} verdict for the frame. */
export interface TestFrame {
  /** ms since the previous frame (drives the burst/tail timers). */
  dtMs: number;
  /** self-scaling loudness 0..1 (`AudioFrame.level`). */
  level: number;
  /** voiced above the noise floor this frame. */
  voiced: boolean;
  /** a fresh quiet→loud transition this frame (`AudioFrame.onset`) — opens a burst. */
  onset: boolean;
  /** a loud→quiet transition this frame (`AudioFrame.release`) — starts the tail. */
  release: boolean;
  /** the gated LetterIndicator verdict this frame ('а'|'о'|'у'|'и', or null=«—»). */
  gatedVowel: "а" | "о" | "у" | "и" | null;
  /** a real «т» stop-burst fired this frame (`AudioFrame.stopBurst`). */
  stopBurst: boolean;
}

/** One collected frame inside an attempt (the subset the verdict needs). */
export interface AttemptFrame {
  /** ms offset from the burst's onset (0 on the onset frame). */
  tMs: number;
  level: number;
  gatedVowel: "а" | "о" | "у" | "и" | null;
  stopBurst: boolean;
}

/** A closed, valid burst — one scoring attempt. */
export interface Attempt {
  /** Duration of the voiced core (onset→release), ms — what the validity filter
   * and the "sustained" window are measured against. */
  durMs: number;
  /** Peak `level` over the collected frames. */
  peakLevel: number;
  /** The collected frames: the voiced core plus the post-release «т» tail. */
  frames: AttemptFrame[];
}

/**
 * BurstAccumulator — a deterministic state machine that turns a per-frame mic
 * stream into discrete {@link Attempt}s, one per voiced burst.
 *
 * Lifecycle, driven purely by the frame's `onset`/`release` flags + `dtMs`:
 *   - idle → a frame with `onset` begins a burst (core), tMs = 0.
 *   - core → frames accumulate; a frame with `release` closes the core and opens
 *     the tail (so a terminal «т» burst, which fires around/after the release, is
 *     still captured).
 *   - tail → frames keep accumulating until {@link T_TAIL_MS} elapses (or a new
 *     `onset` arrives, which closes this attempt and immediately starts the next).
 *
 * On close, the validity filter drops bursts shorter than {@link MIN_BURST_MS} or
 * quieter than {@link MIN_BURST_PEAK} (returns null). Pure: no clock, no RNG — the
 * only time source is the caller's `dtMs`, so a canned sequence replays exactly.
 */
export class BurstAccumulator {
  private state: "idle" | "core" | "tail" = "idle";
  private frames: AttemptFrame[] = [];
  private tMs = 0;
  private coreDurMs = 0;
  private peakLevel = 0;
  private tailMs = 0;

  /** Drop any in-progress burst (on screen enter / target switch / reset). */
  reset(): void {
    this.state = "idle";
    this.frames = [];
    this.tMs = 0;
    this.coreDurMs = 0;
    this.peakLevel = 0;
    this.tailMs = 0;
  }

  /**
   * Feed one frame. Returns a valid {@link Attempt} on the frame that closes a
   * burst (null if that burst failed the validity filter, or no burst closed
   * this frame). At most one attempt closes per call — a new onset during the
   * tail closes the current burst and starts the next, returning the closed one.
   */
  push(f: TestFrame): Attempt | null {
    if (this.state === "idle") {
      if (f.onset) this.begin(f);
      return null;
    }

    if (this.state === "core") {
      this.collect(f);
      if (f.release) {
        this.coreDurMs = this.tMs;
        this.state = "tail";
        this.tailMs = 0;
      }
      return null;
    }

    // tail: a new onset closes this attempt and immediately opens the next.
    if (f.onset) {
      const done = this.finish();
      this.begin(f);
      return done;
    }
    this.tailMs += f.dtMs;
    this.collect(f);
    if (this.tailMs >= T_TAIL_MS) return this.finish();
    return null;
  }

  /** Start a fresh core with the onset frame at tMs = 0. */
  private begin(f: TestFrame): void {
    this.state = "core";
    this.frames = [];
    this.tMs = 0;
    this.coreDurMs = 0;
    this.peakLevel = 0;
    this.tailMs = 0;
    this.collect(f, true);
  }

  /** Append a frame, advancing the running offset (except on the onset frame). */
  private collect(f: TestFrame, isOnset = false): void {
    if (!isOnset) this.tMs += f.dtMs;
    if (f.level > this.peakLevel) this.peakLevel = f.level;
    this.frames.push({
      tMs: this.tMs,
      level: f.level,
      gatedVowel: f.gatedVowel,
      stopBurst: f.stopBurst,
    });
  }

  /** Close the current burst, applying the validity filter, and go idle. */
  private finish(): Attempt | null {
    const attempt: Attempt = {
      durMs: this.coreDurMs,
      peakLevel: this.peakLevel,
      frames: this.frames,
    };
    this.reset();
    if (attempt.durMs < MIN_BURST_MS || attempt.peakLevel < MIN_BURST_PEAK) {
      return null;
    }
    return attempt;
  }
}

/**
 * burstVerdict — the pure rule mapping one attempt's frames to a detected label.
 *
 * Vowel target (а/о/у/и): the MODAL gated verdict across the sustained core —
 * frames whose `level` ≥ {@link CORE_LEVEL_FRACTION} × the burst peak, excluding
 * the first {@link ATTACK_EXCLUDE_MS} of attack while the EMA settles. Each such
 * frame votes its gated vowel (or «—» when the gate said "no letter"). The unique
 * mode wins; a tie, an all-«—» core, or no qualifying frame → «—». This scores
 * EXACTLY what the game/chip act on, and «—» is a real outcome, not an error.
 *
 * Target Т: detected = "Т" if ANY frame in the attempt (core + tail) carried a
 * `stopBurst`, else «—». A sustained vowel with no closure, or a plain
 * run-out-of-breath, has no burst → «—», never a false Т.
 */
export function burstVerdict(frames: AttemptFrame[], target: TestTarget): Detected {
  if (target === "Т") {
    return frames.some((f) => f.stopBurst) ? "Т" : "—";
  }

  let peak = 0;
  for (const f of frames) if (f.level > peak) peak = f.level;
  const gate = peak * CORE_LEVEL_FRACTION;

  const counts = new Map<Detected, number>();
  let considered = 0;
  for (const f of frames) {
    if (f.tMs < ATTACK_EXCLUDE_MS) continue; // skip the attack
    if (f.level < gate) continue; // skip the quiet ramps
    considered++;
    const key: Detected = f.gatedVowel ?? "—";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (considered === 0) return "—";

  // Unique mode wins; a tie for the top count → «—» (ambiguous, not a coin flip).
  let bestKey: Detected = "—";
  let best = -1;
  let tie = false;
  for (const [key, n] of counts) {
    if (n > best) {
      best = n;
      bestKey = key;
      tie = false;
    } else if (n === best) {
      tie = true;
    }
  }
  return tie ? "—" : bestKey;
}

/** Snapshot of a {@link ScoreTally} for rendering. */
export interface TallySnapshot {
  /** Attempts recorded for the current target. */
  total: number;
  /** Of those, how many matched the target (detected === target). */
  hits: number;
  /** Count of each detected label seen (all labels present, 0 when unseen). */
  confusion: Record<Detected, number>;
}

/**
 * ScoreTally — a small reducer accumulating one target's attempts. `record`
 * bumps the total, the hit count (when the detected label matches the target),
 * and the per-label confusion tally. Deterministic; the host resets it on target
 * switch and on the reset button.
 */
export class ScoreTally {
  private _total = 0;
  private _hits = 0;
  private _confusion: Record<Detected, number> = ScoreTally.zeroConfusion();

  private static zeroConfusion(): Record<Detected, number> {
    return { а: 0, о: 0, у: 0, и: 0, Т: 0, "—": 0 };
  }

  /** Record one scored attempt against `target`. */
  record(target: TestTarget, detected: Detected): void {
    this._total++;
    if (detected === target) this._hits++;
    this._confusion[detected]++;
  }

  /** Clear the tally (target switch / reset button). */
  reset(): void {
    this._total = 0;
    this._hits = 0;
    this._confusion = ScoreTally.zeroConfusion();
  }

  get total(): number {
    return this._total;
  }
  get hits(): number {
    return this._hits;
  }
  /** Hit rate 0..1 (0 when no attempts yet). */
  get rate(): number {
    return this._total > 0 ? this._hits / this._total : 0;
  }
  /** A fresh copy of the confusion counts (all labels present). */
  get confusion(): Record<Detected, number> {
    return { ...this._confusion };
  }
  /** A full snapshot for rendering. */
  snapshot(): TallySnapshot {
    return { total: this._total, hits: this._hits, confusion: this.confusion };
  }
}
