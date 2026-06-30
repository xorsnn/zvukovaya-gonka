/**
 * A WordScene is the content unit of the game. The MVP ships one (`кот`), but
 * the chase mechanic is fully generic: any word shaped like
 *   [sustainable vowel/sonorant] + [final stop]
 * reskins into a chase by swapping the two emoji and the on-screen text.
 *
 * Add a scene = add a data object. No new code required for more chase words.
 */
import type { Vowel } from "../audio/PhoneticFeatures";

export type SceneType = "chase";

/**
 * The acoustic shape a scene asks for — one rung of the phonetic ladder
 * (issue #1). This is NOT word recognition: it describes the *envelope and
 * texture* the cat grades on (a sustained vowel-like hold, then a stop), never
 * which word or phoneme was said. Higher rungs ask finer distinctions; the MVP
 * words sit on Rung 1 (vowel-ish vs noise).
 */
export interface AcousticPattern {
  /** Which ladder rung this scene exercises. 0 = shape only, 1 = vowel/noise. */
  rung: 0 | 1 | 2 | 3 | 4;
  /** The held part: how long, and what counts as holding. */
  sustain: {
    /** Minimum continuous hold (ms) before the pounce can arm. */
    minMs: number;
    /** "voiced" = any voicing counts; "vowel" = must be vowel-like (Rung ≥1). */
    want: "voiced" | "vowel";
  };
  /** The final stop: how long a gap of near-silence finalizes the catch. */
  release: {
    /** Required near-silence gap (ms) after the hold to fire the catch. */
    requireGapMs: number;
    /**
     * Rung 3 (#6): what the final action should be. `"stop"` asks for a genuine
     * stop consonant («кот»/«кит» → «т»: a closure, optionally a burst);
     * `"any"` (the default when absent) keeps today's behavior — any near-silence
     * gap finalizes the catch. ADDITIVE: only consulted when `config.rung3` is
     * on, and even then it only *adds* an earlier burst-catch path — it never
     * blocks the gap-only catch (simply running out of breath still wins).
     */
    want?: "stop" | "any";
  };
  /**
   * Rung 2 (#5): the nucleus vowel this scene asks for (кот → «о», кит → «и»).
   * Optional and ADDITIVE — only consulted when `config.rung2` is on, and even
   * then it only *grades* chase speed (a closer vowel runs faster); it never
   * gates the hold or the catch. Absent → no vowel-identity grading.
   */
  vowel?: Vowel;
}

export interface WordScene {
  id: string;
  type: SceneType;

  /** The whole target word, e.g. "кот". */
  word: string;

  /** Big spoken-out display, e.g. "КО-О-О-Т". Shown to the caregiver/child. */
  display: string;

  /** The held part the child sustains, e.g. "КОоо". Highlighted during chase. */
  sustainPart: string;

  /** The final burst, e.g. "Т". Highlighted at the pounce. */
  burstPart: string;

  /** Short instruction for the caregiver, e.g. "Тяни звук, потом — Т!". */
  hint: string;

  // --- chase reskin ---
  /** The pursuer emoji (e.g. cat). */
  chaser: string;
  /** The one who flees (e.g. mouse). */
  fleer: string;
  /** Background theme key. */
  theme: "meadow";

  /** The acoustic shape the cat grades this scene on (phonetic ladder). */
  pattern: AcousticPattern;
}
