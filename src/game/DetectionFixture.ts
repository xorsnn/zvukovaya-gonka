/**
 * DetectionFixture — the offline capture + replay harness (issue #24).
 *
 * WHY THIS EXISTS. Every acoustic threshold in {@link PhoneticFeatures} is a
 * placeholder "tuned blind, live with the child" (the project rule). That makes
 * tuning non-reproducible (a different room/mic/mood each session) and lossy
 * (nothing is captured, so a regression can't be caught by CI). This module is
 * the fix's second half: it takes a clip of the child's REAL frames — captured
 * on the #22 detection-test screen — and replays it, frame-by-frame, through the
 * exact same pure stack the live game uses, so a threshold can be measured and
 * swept offline and a good outcome locked as a regression test.
 *
 * STILL INSIDE THE CORE RULE. A clip carries a COARSE label ({@link CoarseLabel})
 * — a content class the tuner already KNOWS they produced (a кот clip, a hiss
 * clip), never a decoded transcript. We train no model and decode no phoneme; we
 * only score whether the EXISTING feature detectors read the clip the way its
 * label implies. It is a measurement + regression harness for the current pure
 * functions, nothing more.
 *
 * FIDELITY BY CONSTRUCTION. Replay runs the real {@link AudioEngine} against a
 * {@link ClipAnalyser} — a fake `AnalyserNode` that plays the captured buffers
 * back — so every stateful path (adaptive noise floor, the self-scaling `level`,
 * the fast «т» envelope, voiced hysteresis) is reproduced exactly, not
 * re-implemented. On top of that the scorer reuses the screen's own
 * {@link LetterIndicator} + {@link BurstAccumulator} + {@link burstVerdict}, so an
 * offline verdict is byte-for-byte the verdict the child saw.
 *
 * Pure + Node-testable: no DOM, no `AudioContext`, no `Date.now()`/`Math.random()`.
 */

import {
  AudioEngine,
  type AudioFrame,
  type SpectralAnalyserLike,
} from "../audio/AudioEngine";
import {
  classifyConsonant,
  type ConsonantClass,
  type ReleaseFrame,
  type VowelBaseline,
} from "../audio/PhoneticFeatures";
import { LetterIndicator } from "./LetterIndicator";
import {
  BurstAccumulator,
  ScoreTally,
  burstVerdict,
  type Detected,
  type TestTarget,
} from "./SoundTest";

/** Clip schema version — bumped only on a breaking format change so an old file
 * fails loudly in {@link parseClip} instead of replaying wrong. */
export const CLIP_VERSION = 1 as const;

/**
 * The coarse content classes a caregiver labels a recording with. Each is a class
 * they KNOW they just produced, never a decode:
 *   - `silence`  — ambient room, no attempt.
 *   - `bare-a/o/u/i` — one sustained nucleus vowel.
 *   - `hiss`     — a sustained voiceless fricative («шшш»/«ссс»).
 *   - `kot`      — a кот-shaped word: a held vowel released by a «т» stop.
 */
export type CoarseLabel =
  | "silence"
  | "bare-a"
  | "bare-o"
  | "bare-u"
  | "bare-i"
  | "hiss"
  | "kot";

/** The fixed picker list (capture UI + fixture validation), in display order. */
export const COARSE_LABELS: readonly CoarseLabel[] = [
  "bare-a",
  "bare-o",
  "bare-u",
  "bare-i",
  "hiss",
  "kot",
  "silence",
] as const;

/**
 * The coarse OUTCOME the replayed detectors read a clip as — the four things the
 * game acts on, collapsed to one label so a clip's read can be checked against
 * its intent. NOT a phoneme: `vowel` is "any voiced nucleus", not «which vowel».
 */
export type ClipOutcome = "silence" | "vowel" | "hiss" | "stop";

/** What each coarse label SHOULD read as — the regression expectation a fixture
 * is locked against. (Every bare vowel collapses to the coarse `vowel` outcome;
 * *which* vowel is scored separately, only when a baseline is present.) */
export const LABEL_OUTCOME: Record<CoarseLabel, ClipOutcome> = {
  silence: "silence",
  "bare-a": "vowel",
  "bare-o": "vowel",
  "bare-u": "vowel",
  "bare-i": "vowel",
  hiss: "hiss",
  kot: "stop",
};

/** The target-practice {@link TestTarget} a label maps to for the on-screen
 * scorer (the sweep's hit metric). `silence`/`hiss` have no vowel/stop target —
 * they are the "must NOT falsely fire" clips, not scored for a positive hit. */
export const LABEL_TARGET: Partial<Record<CoarseLabel, TestTarget>> = {
  "bare-a": "а",
  "bare-o": "о",
  "bare-u": "у",
  "bare-i": "и",
  kot: "Т",
};

// ---- outcome-classifier knobs (HARNESS-ONLY, not shipped detector thresholds).
// These grade the replayed SUMMARY into a coarse outcome; they gate no gameplay
// and tune no detector. Choosing them is not the "live threshold tuning" the
// project rule guards — that is the constants inside PhoneticFeatures, untouched
// here (issue #24 delivers the ability to sweep those, not any change to them).

/** Peak self-scaling `level` below which a clip is treated as silence — nothing
 * loud enough happened to be an attempt. */
export const OUTCOME_SILENCE_PEAK = 0.25;
/** Mean `vowelLikeness` over the loud core at/above which a voiced clip reads as
 * a vowel rather than a hiss. */
export const OUTCOME_VOWEL_VL = 0.45;
/** A frame counts toward the "loud core" (for the mean-vowelLikeness read) only
 * if its `level` is at least this fraction of the clip's peak — mirrors
 * {@link CORE_LEVEL_FRACTION} on the screen so the two reads agree. */
export const OUTCOME_CORE_FRACTION = 0.5;

/** One captured frame: the raw buffers plus the frame's own `dtMs`. */
export interface ClipFrame {
  /** ms since the previous captured frame (the live loop's `dt`). */
  dtMs: number;
  /** Raw time-domain samples ≈[-1,1], length === {@link DetectionClip.fftSize}. */
  time: number[];
  /** dB magnitude spectrum (AnalyserNode convention), length ===
   * {@link DetectionClip.binCount}. Omit for a time-only clip — the spectral
   * features then read as silent (≈0). */
  freq?: number[];
}

/** A captured clip: a header + a sequence of raw frames. This is the on-disk /
 * downloaded JSON shape (`tests/fixtures/*.json`). */
export interface DetectionClip {
  version: typeof CLIP_VERSION;
  /** The caregiver's coarse content label (see {@link CoarseLabel}). */
  label: CoarseLabel;
  /** Analyser sample rate at capture (drives the frequency→bin mapping). */
  sampleRate: number;
  /** Raw time buffer length (analyser.fftSize). */
  fftSize: number;
  /** Spectrum length (analyser.frequencyBinCount). */
  binCount: number;
  /** строго↔легче assist active at capture, so the offline «т» detector tracks
   * the same slider the child was playing on. */
  assist: number;
  /** Screen-local vowel baseline active at capture (so `classifyVowel` replays in
   * her formant space). Absent/`null` when the clip was recorded uncalibrated. */
  baseline?: VowelBaseline | null;
  /** The captured frames, oldest first. */
  frames: ClipFrame[];
  /** Optional freeform note (mic, room, child age) — never a transcript. */
  note?: string;
}

/** A dB value this quiet is effectively silence; used to fill a missing spectrum
 * so a time-only clip's spectral features read ≈0. Matches the engine's capture
 * floor. */
const SILENT_DB = -140;

/**
 * ClipAnalyser — a {@link SpectralAnalyserLike} that plays a captured clip back
 * into the engine. The replay loop calls {@link setFrame} before each
 * `engine.sample()`, and the engine's two reads (`getFloatTimeDomainData` then
 * `getFloatFrequencyData`) both draw from that one frame — so a clip drives the
 * engine exactly as a live mic did, with no `AudioContext`.
 */
export class ClipAnalyser implements SpectralAnalyserLike {
  readonly fftSize: number;
  readonly frequencyBinCount: number;
  private cur: ClipFrame | null = null;

  constructor(clip: DetectionClip) {
    this.fftSize = clip.fftSize;
    this.frequencyBinCount = clip.binCount;
  }

  /** Point the analyser at the frame the next `sample()` should read. */
  setFrame(f: ClipFrame): void {
    this.cur = f;
  }

  getFloatTimeDomainData(buf: Float32Array): void {
    const t = this.cur?.time;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = t && i < t.length ? t[i] : 0;
    }
  }

  getFloatFrequencyData(buf: Float32Array): void {
    const f = this.cur?.freq;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = f && i < f.length ? f[i] : SILENT_DB;
    }
  }
}

/** Options overriding a clip's captured `assist`/`baseline` on replay — the
 * lever the sweep pulls (replay the SAME clip at a different assist). */
export interface ReplayOpts {
  /** строго↔легче assist to replay at (default: the clip's captured `assist`). */
  assist?: number;
  /** Baseline to replay with (default: the clip's captured `baseline`). Pass
   * `null` to force the uncalibrated path. */
  baseline?: VowelBaseline | null;
}

/** The per-frame engine output of a replay, plus the resolved replay settings. */
export interface ReplayResult {
  clip: DetectionClip;
  /** The engine's frame for each clip frame, in order — faithful to the live run. */
  frames: AudioFrame[];
  assist: number;
  baseline: VowelBaseline | null;
}

/**
 * replayClip — run a captured clip through the REAL {@link AudioEngine} (fed by a
 * {@link ClipAnalyser}) and collect the per-frame {@link AudioFrame}s. The
 * spectral + formant passes are forced on (as the test screen does) so every
 * detector has data; `assist`/`baseline` default to the clip's captured values.
 *
 * The engine's `dt` derives from the timestamps we feed, so we advance a virtual
 * clock by each frame's own `dtMs` — reproducing the exact envelope/noise-floor
 * evolution of the live capture. Pure: no wall clock, no DOM.
 */
export function replayClip(clip: DetectionClip, opts?: ReplayOpts): ReplayResult {
  const analyser = new ClipAnalyser(clip);
  const engine = new AudioEngine({ analyser, sampleRate: clip.sampleRate });
  engine.setPhoneticEnabled(true);
  engine.setRung2Enabled(true);
  const assist = opts?.assist ?? clip.assist;
  engine.setAssist(assist);
  const baseline =
    opts && "baseline" in opts ? opts.baseline ?? null : clip.baseline ?? null;
  engine.setVowelBaseline(baseline);

  const frames: AudioFrame[] = [];
  let now = 0;
  for (const cf of clip.frames) {
    analyser.setFrame(cf);
    now += cf.dtMs > 0 ? cf.dtMs : 16;
    frames.push(engine.sample(now));
  }
  return { clip, frames, assist, baseline };
}

/** The measured read of a replayed clip — the numbers behind {@link ClipOutcome}. */
export interface ClipVerdict {
  /** The coarse outcome the detectors read this clip as. */
  outcome: ClipOutcome;
  /** Peak self-scaling `level` over the clip. */
  peakLevel: number;
  /** Mean `vowelLikeness` over the loud core (0 when the clip has no core). */
  meanVowelLikeness: number;
  /** How many frames formed the loud core. */
  coreFrames: number;
  /** Number of frames on which a real «т» stop-burst fired. */
  stopBurstCount: number;
  /** ms from clip start to the first stop-burst (null when none fired). */
  firstBurstMs: number | null;
  /** classifyConsonant over the whole clip's {voiced, zcr} track. */
  consonantClass: ConsonantClass;
}

/**
 * clipVerdict — collapse a replay into the robust, baseline-free {@link ClipVerdict}.
 *
 * The loud core is the frames whose `level` ≥ {@link OUTCOME_CORE_FRACTION} of the
 * clip peak (the sustained part, not the quiet on/offset ramps). The coarse
 * {@link ClipOutcome} follows a small, decisive order:
 *   1. silence — nothing reached {@link OUTCOME_SILENCE_PEAK}.
 *   2. stop — at least one real «т» burst fired (decisive: a burst is a stop).
 *   3. hiss — the core is voiced but not vowel-like (`vowelLikeness` below
 *      {@link OUTCOME_VOWEL_VL}, or classifyConsonant called it a fricative).
 *   4. vowel — a loud, vowel-like sustained core with no closure/burst.
 */
export function clipVerdict(result: ReplayResult): ClipVerdict {
  const { frames } = result;

  let peakLevel = 0;
  for (const f of frames) if (f.level > peakLevel) peakLevel = f.level;

  const coreGate = peakLevel * OUTCOME_CORE_FRACTION;
  let vlSum = 0;
  let coreFrames = 0;
  for (const f of frames) {
    if (f.level >= coreGate && f.voiced) {
      vlSum += f.vowelLikeness;
      coreFrames++;
    }
  }
  const meanVowelLikeness = coreFrames > 0 ? vlSum / coreFrames : 0;

  // The engine frame carries no dt, so recover the first-burst time from the
  // clip's own cumulative `dtMs` — the capture timeline.
  let stopBurstCount = 0;
  let firstBurstMs: number | null = null;
  let tMs = 0;
  for (let i = 0; i < frames.length; i++) {
    tMs += result.clip.frames[i]?.dtMs || 16;
    if (frames[i].stopBurst) {
      stopBurstCount++;
      if (firstBurstMs === null) firstBurstMs = tMs;
    }
  }

  const releaseTrack: ReleaseFrame[] = frames.map((f) => ({
    voiced: f.voiced,
    zcr: f.zcr,
  }));
  const consonantClass = classifyConsonant(releaseTrack);

  let outcome: ClipOutcome;
  if (peakLevel < OUTCOME_SILENCE_PEAK) {
    outcome = "silence";
  } else if (stopBurstCount > 0) {
    outcome = "stop";
  } else if (consonantClass === "fricative" || meanVowelLikeness < OUTCOME_VOWEL_VL) {
    outcome = "hiss";
  } else {
    outcome = "vowel";
  }

  return {
    outcome,
    peakLevel,
    meanVowelLikeness,
    coreFrames,
    stopBurstCount,
    firstBurstMs,
    consonantClass,
  };
}

/**
 * scoreClip — run a clip through the FULL on-screen scoring pipeline for a given
 * {@link TestTarget}, returning the {@link Detected} label(s) the caregiver would
 * have seen on the #22 screen. This reuses the exact screen components — a
 * {@link LetterIndicator} for the gated vowel, a {@link BurstAccumulator} to
 * segment attempts, and {@link burstVerdict} to score each — so the offline
 * detection is identical to the live one, not an approximation.
 *
 * Returns every closed attempt's detected label (usually one per clip) so a clip
 * with an accidental second burst is visible rather than silently dropped.
 */
export function scoreClip(
  clip: DetectionClip,
  target: TestTarget,
  opts?: ReplayOpts,
): { detected: Detected[]; result: ReplayResult } {
  const result = replayClip(clip, opts);
  const indicator = new LetterIndicator();
  const accumulator = new BurstAccumulator();
  const detected: Detected[] = [];

  for (let i = 0; i < result.frames.length; i++) {
    const f = result.frames[i];
    const dtMs = clip.frames[i]?.dtMs || 16;
    const gated = indicator.update(
      { f1: f.f1, f2: f.f2 },
      f.level,
      f.voiced,
      result.baseline,
      dtMs,
    );
    const attempt = accumulator.push({
      dtMs,
      level: f.level,
      voiced: f.voiced,
      onset: f.onset,
      release: f.release,
      gatedVowel: gated.vowel,
      stopBurst: f.stopBurst,
    });
    if (attempt) detected.push(burstVerdict(attempt.frames, target));
  }
  return { detected, result };
}

/** One row of an assist sweep: how the whole clip set scored at one assist. */
export interface SweepRow {
  assist: number;
  /** Clips whose label had a {@link LABEL_TARGET} (bare vowels + kot). */
  scored: number;
  /** Of those, how many produced their target as the (first) detected label. */
  hits: number;
  /** hits / scored (0 when nothing was scored). */
  rate: number;
  /** «т» false-alarm rate: fraction of NON-stop clips that fired ≥1 stop-burst. */
  falseStopRate: number;
  /** Per-target confusion of the first detected label, keyed `target→detected`. */
  confusion: Record<string, number>;
}

/** A full assist sweep + the assist that scored best (highest rate, then lowest
 * false-stop rate). */
export interface SweepReport {
  rows: SweepRow[];
  best: SweepRow | null;
}

/**
 * sweepAssist — replay every clip at each assist in `assists` and tabulate how
 * well the detectors separate intent from confusion. This grids the ONE shipped,
 * already-parameterised tunable — the строго↔легче assist, which maps onto the
 * «т» detector's bounds via {@link burstOptsForAssist} — so the sweep needs no
 * change to any detector signature (issue #24 is a harness, not a retune).
 *
 * Per assist: score each clip that has a {@link LABEL_TARGET} against that target
 * (hit = first detected label equals the target), and separately measure the «т»
 * false-alarm rate over the non-stop clips (silence/hiss/vowel that fire a
 * spurious burst). `best` maximises the hit rate, breaking ties toward the lower
 * false-stop rate. Pure — the caller prints the table and picks by eye too.
 */
export function sweepAssist(
  clips: DetectionClip[],
  assists: readonly number[],
): SweepReport {
  const rows: SweepRow[] = assists.map((assist) => {
    let scored = 0;
    let hits = 0;
    let nonStop = 0;
    let falseStops = 0;
    const confusion: Record<string, number> = {};

    for (const clip of clips) {
      const target = LABEL_TARGET[clip.label];
      if (target) {
        const { detected } = scoreClip(clip, target, { assist });
        const first = detected[0] ?? "—";
        scored++;
        if (first === target) hits++;
        const key = `${target}→${first}`;
        confusion[key] = (confusion[key] ?? 0) + 1;
      }
      if (LABEL_OUTCOME[clip.label] !== "stop") {
        nonStop++;
        const { frames } = replayClip(clip, { assist });
        if (frames.some((f) => f.stopBurst)) falseStops++;
      }
    }

    return {
      assist,
      scored,
      hits,
      rate: scored > 0 ? hits / scored : 0,
      falseStopRate: nonStop > 0 ? falseStops / nonStop : 0,
      confusion,
    };
  });

  let best: SweepRow | null = null;
  for (const r of rows) {
    if (
      !best ||
      r.rate > best.rate ||
      (r.rate === best.rate && r.falseStopRate < best.falseStopRate)
    ) {
      best = r;
    }
  }
  return { rows, best };
}

// ---- serialize / parse --------------------------------------------------

/** Serialize a clip to its on-disk / downloadable JSON string. */
export function serializeClip(clip: DetectionClip): string {
  return JSON.stringify(clip);
}

/** Fields checked by {@link validateClip} — kept in one place so the error names
 * the exact missing/blank piece. */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * validateClip — narrow untrusted JSON to a {@link DetectionClip} or throw. Guards
 * the version, the label (must be a known {@link CoarseLabel}), the numeric
 * header, and the frame array (each frame a finite `dtMs` + a `time` array). This
 * is a fixture/loader boundary, so a bad file fails loudly instead of replaying
 * garbage.
 */
export function validateClip(raw: unknown): DetectionClip {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("clip: not an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== CLIP_VERSION) {
    throw new Error(`clip: unsupported version ${String(o.version)}`);
  }
  if (!COARSE_LABELS.includes(o.label as CoarseLabel)) {
    throw new Error(`clip: unknown label ${String(o.label)}`);
  }
  if (!isFiniteNumber(o.sampleRate) || o.sampleRate <= 0) {
    throw new Error("clip: bad sampleRate");
  }
  if (!isFiniteNumber(o.fftSize) || o.fftSize <= 0) {
    throw new Error("clip: bad fftSize");
  }
  if (!isFiniteNumber(o.binCount) || o.binCount <= 0) {
    throw new Error("clip: bad binCount");
  }
  if (!isFiniteNumber(o.assist)) {
    throw new Error("clip: bad assist");
  }
  if (!Array.isArray(o.frames)) {
    throw new Error("clip: frames not an array");
  }
  for (const [i, f] of (o.frames as unknown[]).entries()) {
    if (typeof f !== "object" || f === null) {
      throw new Error(`clip: frame ${i} not an object`);
    }
    const ff = f as Record<string, unknown>;
    if (!isFiniteNumber(ff.dtMs)) throw new Error(`clip: frame ${i} bad dtMs`);
    if (!Array.isArray(ff.time)) throw new Error(`clip: frame ${i} missing time`);
    if (ff.freq !== undefined && !Array.isArray(ff.freq)) {
      throw new Error(`clip: frame ${i} bad freq`);
    }
  }
  // Shape is sound; the field types above are the ones replay reads.
  return raw as DetectionClip;
}

/** Parse + validate a clip from its JSON string (throws on a bad file). */
export function parseClip(json: string): DetectionClip {
  return validateClip(JSON.parse(json));
}

/** Re-export so a caller can build a fresh tally over replayed attempts without
 * reaching into {@link SoundTest} directly. */
export { ScoreTally };
