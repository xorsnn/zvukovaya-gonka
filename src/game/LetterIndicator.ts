/**
 * LetterIndicator — the stateful smoother + display gate behind the live vowel
 * chip (#13). It turns the engine's noisy per-frame {@link classifyVowel} argmax
 * into a steady, caregiver-facing letter that never flickers and never shows a
 * confidently-wrong glyph.
 *
 * READ-ONLY BY DESIGN: this is a pure display helper. It reads formants + level +
 * the per-child baseline and emits a {@link VowelClassification}; it feeds NOTHING
 * back into the chase's grading, hold, or catch (issue #13's read-only invariant,
 * AC#6). The matcher and this indicator share no state.
 *
 * Deterministic + unit-testable: given the same `(formants, level, voiced,
 * baseline, dtMs)` sequence it always produces the same output sequence — no
 * `Date.now()` / `Math.random()`. The baseline is passed in per frame (the same
 * `audio.getVowelBaseline()` the matcher reads), so the only state it holds is the
 * four EMA scores.
 */

import {
  classifyVowel,
  VOWELS,
  type Vowel,
  type VowelBaseline,
  type VowelClassification,
} from "../audio/PhoneticFeatures";

/** Below this `level` (or when not voiced) the input is treated as silence and
 * the letter decays out — so room noise / a quiet breath never paints a glyph. */
export const LEVEL_GATE = 0.15;
/** EMA half-life (ms): the smoothed scores cover half the gap to a steady raw
 * input in this long, so a real vowel settles in ~one half-life (~8 frames at
 * 16 ms) while a single stray frame barely moves the output (AC#3 anti-flicker). */
export const HALF_LIFE_MS = 120;
/** Display gate: the smoothed winner must reach at least this score to show a
 * letter (else «—») — a weak, ambiguous match stays silent. */
export const SCORE_MIN = 0.45;
/** Display gate: the winner must also beat the runner-up by at least this margin,
 * so a near-tie between two vowels shows «—» rather than a coin-flip glyph. */
export const MARGIN_MIN = 0.15;

const ZERO_SCORES: Record<Vowel, number> = { а: 0, о: 0, у: 0, и: 0 };

export class LetterIndicator {
  /** Per-vowel EMA of the raw match scores. The whole of the helper's state. */
  private s: Record<Vowel, number> = { ...ZERO_SCORES };

  /** Forget the smoothed state (e.g. between rounds / on screen change). */
  reset(): void {
    this.s = { ...ZERO_SCORES };
  }

  /**
   * Advance one frame and return the gated, smoothed verdict.
   *
   * @param formants per-frame F1/F2 (0/0 when the formant pass is off or silent)
   * @param level    self-scaling loudness 0..1 (the input gate's volume axis)
   * @param voiced   is sound present above the noise floor this frame
   * @param baseline her calibrated formant baseline (null → no opinion → «—»)
   * @param dtMs     ms since the last call (drives the EMA rate)
   */
  update(
    formants: { f1: number; f2: number },
    level: number,
    voiced: boolean,
    baseline: VowelBaseline | null,
    dtMs: number,
  ): VowelClassification {
    // Input gate: not voiced / too quiet → feed zeros, so the letter fades out
    // instead of freezing on the last sound.
    const raw =
      !voiced || level <= LEVEL_GATE
        ? ZERO_SCORES
        : classifyVowel(formants, baseline).scores;

    // Per-vowel EMA: s += (raw - s) * (1 - exp(-dt/τ)), τ = HALF_LIFE / ln2.
    const tau = HALF_LIFE_MS / Math.LN2;
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tau);
    for (const v of VOWELS) {
      this.s[v] += (raw[v] - this.s[v]) * alpha;
    }

    // Argmax the SMOOTHED scores, tracking the runner-up for the margin gate.
    let top: Vowel | null = null;
    let topScore = -Infinity;
    let second = -Infinity;
    for (const v of VOWELS) {
      const sc = this.s[v];
      if (sc > topScore) {
        second = topScore;
        topScore = sc;
        top = v;
      } else if (sc > second) {
        second = sc;
      }
    }

    // Display gate: strong enough AND clearly ahead of the runner-up, else «—».
    const show = topScore >= SCORE_MIN && topScore - second >= MARGIN_MIN;
    return {
      vowel: show ? top : null,
      confidence: topScore > 0 ? topScore : 0,
      scores: { ...this.s },
    };
  }
}
