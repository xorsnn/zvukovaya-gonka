/**
 * A WordScene is the content unit of the game. The MVP ships one (`кот`), but
 * the chase mechanic is fully generic: any word shaped like
 *   [sustainable vowel/sonorant] + [final stop]
 * reskins into a chase by swapping the two emoji and the on-screen text.
 *
 * Add a scene = add a data object. No new code required for more chase words.
 */
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
  };
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
