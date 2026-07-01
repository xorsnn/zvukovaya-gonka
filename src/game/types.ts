/**
 * A WordScene is the content unit of the game. The acoustic mechanic is fully
 * generic: any word shaped like
 *   [sustainable vowel/sonorant] + [final stop]
 * reskins by swapping the two emoji and the on-screen text.
 *
 * Two axes of variation, and they cost differently:
 *   - a new *word* on an existing `SceneType` is DATA ONLY — add a data object,
 *     no new code (кот/дом/кит all reskin the one chase render path);
 *   - a new *mode* (a new `SceneType`) needs a matching render branch in
 *     `GameView` + a picker entry, because a mode is a different *picture*, not a
 *     different word. The «т»/hold acoustic stack is reused verbatim across modes.
 *
 * Modes shipped (issue #16): `"chase"` (кот — the cat runs the mouse) and
 * `"pull"` (вот — the rabbit pulls the carrot free). See root CLAUDE.md.
 */
import type { Vowel } from "../audio/PhoneticFeatures";

export type SceneType = "chase" | "pull";

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
     * Rung 3 (#6/#12): what the final action should be. `"stop"` asks for a
     * genuine stop consonant («кот»/«кит» → «т»: a closure then a burst); `"any"`
     * (the default when absent) keeps today's behavior — any near-silence gap
     * finalizes the catch. Consulted only when `config.rung3` is on. Toward the
     * EASY end it still only *adds* an earlier «т» burst-catch (a breath-stop also
     * wins); toward the STRICT end the «т» burst becomes REQUIRED (#12) — the
     * escape hatch is the assist slider, not a fail screen.
     */
    want?: "stop" | "any";
    /**
     * Rung 3 (#12): the target consonant grapheme shown for teaching (кот/кит →
     * «Т»). It is NOT decoded acoustically — the trigger is the letter's coarse
     * CLASS (a stop burst), since telling «т» from «к»/«п» (place of articulation)
     * is the banned ASR territory. Display/teaching + the `?debug` overlay use it;
     * it mirrors {@link WordScene.burstPart} but lives with the acoustic pattern so
     * the matcher/debug layer can name the target without reaching into UI fields.
     */
    letter?: string;
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

  // --- actor reskin (two emoji; their ROLE depends on `type`) ---
  /**
   * The active actor. `type: "chase"` → the pursuer (cat); `type: "pull"` → the
   * puller (rabbit). Reused across modes rather than adding mode-specific fields,
   * so the content model stays two-emoji-and-text for every `SceneType`.
   */
  chaser: string;
  /**
   * The passive actor / goal. `type: "chase"` → the one who flees (mouse);
   * `type: "pull"` → the prize being pulled free (carrot).
   */
  fleer: string;
  /** Background theme key. */
  theme: "meadow";

  /** The acoustic shape the cat grades this scene on (phonetic ladder). */
  pattern: AcousticPattern;
}
