/**
 * RoarToy — the pure state machine behind the reactive dinosaur toy (issue #30).
 *
 * This is the cheapest feature in the codebase and sits fully inside the core
 * rule: it reads ONLY the loudness envelope (`AudioFrame.level`) — no word /
 * phoneme decoding, no ML, no matcher. It is a no-goal, no-fail cause-and-effect
 * loop for a pre-verbal / babbling child: she makes *any* sound, and when she
 * pauses, a dinosaur roars back. The therapeutic point is turn-taking — she
 * sounds, the dino answers, she sounds again.
 *
 * DOM-free, no `Date.now()`, no `Math.random()`, so it is unit-testable in plain
 * Node exactly like {@link SoundTest}/{@link PatternMatcher}. The only time source
 * is the caller's `dtMs`, so a canned level sequence replays deterministically.
 *
 * Why turn-taking and not live: the mic runs with echo cancellation OFF (so it
 * can hear quiet breaths, see `sfx.ts`), so any speaker audio feeds back into
 * detection. The roar therefore fires during her PAUSE, not while she vocalizes,
 * and input is locked out for the roar's full length so the roar's own audio
 * can never be mistaken for her voice (see {@link RoarToyCfg.lockoutMs}).
 */

/** Tunables for the toy. Every number is a placeholder to be tuned live with the
 * child (per the repo convention), biased for a pre-verbal child at authoring. */
export interface RoarToyCfg {
  /** Base loudness (0..1) that counts as "vocalizing", BEFORE the assist scaling.
   * Biased low so a faint babble still registers. */
  triggerLevel: number;
  /** Continuous quiet (ms) after voicing that fires the roar (~300). */
  pauseMs: number;
  /** Minimum voicing (ms, cumulative within an utterance) before a pause may fire
   * — debounces a cough / single click into "not an utterance" (~150). */
  minVoiceMs: number;
  /** Ignore input for this long once a roar starts (ms). Wired from
   * `ROAR_TOTAL_MS` in `sfx.ts` so the lockout always covers the roar's own audio
   * over the speakers (echo cancellation is off). */
  lockoutMs: number;
  /** Threshold-scaling gain for the assist slider, mirrors the matcher's
   * `effHold` pattern in `main.ts` (~0.7): легче lowers the effective threshold. */
  assistK: number;
}

/**
 * Defaults, biased for a pre-verbal child (faint sounds should still roar).
 * `lockoutMs` is a placeholder — `main.ts` overrides it with `ROAR_TOTAL_MS`
 * from `sfx.ts` so the single source of truth for the roar's length lives with
 * the sound, and the lockout always covers the actual audible roar.
 */
export const DEFAULT_ROAR_CFG: RoarToyCfg = {
  triggerLevel: 0.12,
  pauseMs: 300,
  minVoiceMs: 150,
  lockoutMs: 1200,
  assistK: 0.7,
};

/**
 * The three phases of the loop:
 *   - "listening" — quiet, waiting for her to start.
 *   - "voicing"   — she is above threshold (with brief dips tolerated); a long
 *     enough voicing followed by a long enough pause fires the roar.
 *   - "roaring"   — the roar is playing; input is IGNORED for `lockoutMs` so the
 *     roar's own audio can't start a new voicing or a second roar.
 */
export type RoarPhase = "listening" | "voicing" | "roaring";

export interface RoarStateT {
  phase: RoarPhase;
  /** Cumulative voicing this utterance (ms); brief dips within the pause window
   * do not reset it, so a wobbly hold still counts. */
  voiceMs: number;
  /** Continuous quiet since voicing dipped (ms); reset the moment she is loud
   * again. Reaching `pauseMs` (with enough `voiceMs`) fires the roar. */
  silenceMs: number;
  /** Remaining lockout while "roaring" (ms), counted down by `dtMs`. */
  lockoutMs: number;
  /** Peak level seen this utterance, 0..1 — scales the roar's loudness/size. */
  intensity: number;
}

/** A fresh listening state. */
export function initRoar(): RoarStateT {
  return { phase: "listening", voiceMs: 0, silenceMs: 0, lockoutMs: 0, intensity: 0 };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The effective loudness threshold after the assist slider. Higher `assist`
 * (легче) lowers the bar so a fainter sound counts as vocalizing — the same
 * "escape hatch is the slider" principle the matcher uses (#18). Exported so the
 * view/debug can show the live bar and tests can assert the mapping directly.
 */
export function effectiveThreshold(cfg: RoarToyCfg, assist: number): number {
  return cfg.triggerLevel * (1 - clamp01(assist) * cfg.assistK);
}

/**
 * Advance the toy one frame. Pure: `prev state + current level + dt + assist +
 * cfg` → `next state`, plus `roar` (true on exactly the frame the roar fires)
 * and `intensity` (this utterance's peak level, scaling the roar).
 *
 * The one-roar-per-cycle rule (AC#2): a roar fires iff `level ≥ threshold` for a
 * cumulative `≥ minVoiceMs`, THEN `level < threshold` continuously for `≥
 * pauseMs`. Pure silence never fires (AC#3); a sub-`minVoiceMs` blip never fires
 * (AC#4). During "roaring" the level is ignored entirely (AC#5).
 */
export function stepRoar(
  s: RoarStateT,
  level: number,
  dtMs: number,
  assist: number,
  cfg: RoarToyCfg,
): { state: RoarStateT; roar: boolean; intensity: number } {
  // Roaring: ignore input, just run the lockout down. When it expires, return to
  // a fresh listening state (the next loud frame starts a new utterance).
  if (s.phase === "roaring") {
    const lockoutMs = s.lockoutMs - dtMs;
    if (lockoutMs > 0) {
      return { state: { ...s, lockoutMs }, roar: false, intensity: s.intensity };
    }
    return { state: initRoar(), roar: false, intensity: 0 };
  }

  const loud = level >= effectiveThreshold(cfg, assist);

  // Listening: wait for her to start. A loud frame begins the utterance.
  if (s.phase === "listening") {
    if (!loud) return { state: s, roar: false, intensity: 0 };
    const intensity = clamp01(level);
    return {
      state: { phase: "voicing", voiceMs: dtMs, silenceMs: 0, lockoutMs: 0, intensity },
      roar: false,
      intensity,
    };
  }

  // Voicing.
  if (loud) {
    // Still (or again) voicing: accumulate voice time, reset the pause, track the
    // running peak that scales the roar.
    const intensity = Math.max(s.intensity, clamp01(level));
    return {
      state: { phase: "voicing", voiceMs: s.voiceMs + dtMs, silenceMs: 0, lockoutMs: 0, intensity },
      roar: false,
      intensity,
    };
  }

  // Quiet during voicing: grow the pause.
  const silenceMs = s.silenceMs + dtMs;
  if (silenceMs >= cfg.pauseMs) {
    // A long enough pause closes the utterance.
    if (s.voiceMs >= cfg.minVoiceMs) {
      // Real utterance → ROAR, and lock out input for the roar's length.
      return {
        state: { phase: "roaring", voiceMs: 0, silenceMs: 0, lockoutMs: cfg.lockoutMs, intensity: s.intensity },
        roar: true,
        intensity: s.intensity,
      };
    }
    // Too short to be an utterance (a cough/blip) → discard, listen afresh.
    return { state: initRoar(), roar: false, intensity: 0 };
  }
  // Still within the pause window: hold voiceMs (a brief mid-utterance dip must
  // not erase progress toward minVoiceMs), just grow the silence.
  return {
    state: { phase: "voicing", voiceMs: s.voiceMs, silenceMs, lockoutMs: 0, intensity: s.intensity },
    roar: false,
    intensity: s.intensity,
  };
}
