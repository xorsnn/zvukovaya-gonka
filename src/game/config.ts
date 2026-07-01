/**
 * PhoneticConfig — the single source of truth for the whole phonetic layer
 * (issue #4, the foundation for Increment 2).
 *
 * It replaces two switches that were scattered after Increment 1: the
 * module-level `USE_PHONETIC` kill-switch in {@link AudioEngine} and the ad-hoc
 * `assist` slider state in `main.ts`. Every knob the caregiver can touch now
 * lives here, persists to `localStorage`, and is read live by the engine and the
 * matcher.
 *
 * The rungs are ADDITIVE refinements stacked on Rung 1 (vowel-ish vs noise):
 *   - rung1 — vowel-ish vs noise/hiss (Increment 1; shipped on).
 *   - rung2 — vowel identity (wired in #5; default off, a no-op until then).
 *   - rung3 — consonant class / a real «т» stop (wired in #6). Since #18 it also
 *     powers the two-phase «т» win on a "stop" scene and ships ON by default.
 * With rung2 off (and on a non-stop word, rung3), behavior is exactly
 * Rung-1-as-shipped. With ALL rungs off, the game is the pre-#1 loudness-only
 * engine — that is the kill-switch, and {@link anyRungOn} is its generalization
 * of `USE_PHONETIC`. That all-off identity is preserved byte-for-byte by #18.
 *
 * The store is defensive by design: a missing key, corrupt JSON, a partial or
 * older blob, private-mode storage, or a throwing/quota-full `localStorage` all
 * degrade to {@link DEFAULT_CONFIG} and NEVER throw, so a caregiver setting can
 * never wedge the game.
 */

export interface PhoneticConfig {
  /** Rung 1: grade vowel-ish vs noise/hiss (Increment 1). */
  rung1: boolean;
  /** Rung 2: vowel identity — wired in #5, a no-op until then. */
  rung2: boolean;
  /** Rung 3: consonant class / real «т» stop. Wired in #6; since #18 it also
   * drives the two-phase «т» win (the vowel arms a checkpoint, only a real «т»
   * finishes — the pause no longer wins) on a "stop" scene, and defaults ON. */
  rung3: boolean;
  /** 0..1 leniency continuum (the строго↔легче slider). */
  assist: number;
  /** Show the hidden phonetic-feature overlay (also forced on by `?debug`). */
  debug: boolean;
  /** Show the read-only live-vowel chip (#13): the argmax vowel + confidence.
   * Off by default; a caregiver/dev display that never changes how the chase
   * grades. When on it also widens the engine's formant pass so the chip works
   * even with every rung off (see `main.ts`). */
  showLetter: boolean;
}

export const DEFAULT_CONFIG: PhoneticConfig = {
  rung1: true,
  rung2: false,
  rung3: true, // #18: the two-phase «т» win is the intended default experience.
  assist: 0.5,
  debug: false,
  showLetter: false,
};

/** localStorage key. Versioned so a future schema change can migrate cleanly. */
export const STORAGE_KEY = "zg.phonetic.v1";

/**
 * Is any rung enabled? The generalization of Increment 1's `USE_PHONETIC`: when
 * false, the engine skips all spectral work and the game is the exact
 * loudness-only build (no matcher, the pounce fires on a plain loud/stop edge).
 */
export function anyRungOn(config: PhoneticConfig): boolean {
  return config.rung1 || config.rung2 || config.rung3;
}

/** The slice of the Web Storage API we use — lets tests inject a stub. */
export interface ConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the ambient `localStorage` defensively. In private mode or a sandboxed
 * iframe even *reading* the global can throw, and in Node (tests) it is absent;
 * both cases return `null` so the caller falls back to defaults.
 */
function defaultStorage(): ConfigStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Keep only known keys with the right type, falling back per-field to the
 * default. Defends against a corrupt, partial, or older-schema blob: an unknown
 * shape yields the full defaults; a missing or wrong-typed field yields just
 * that field's default. `assist` is also clamped to 0..1.
 */
function coerce(raw: unknown): PhoneticConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const o = raw as Record<string, unknown>;
  const bool = (v: unknown, d: boolean): boolean =>
    typeof v === "boolean" ? v : d;
  const unit = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.max(0, Math.min(1, v))
      : d;
  return {
    rung1: bool(o.rung1, DEFAULT_CONFIG.rung1),
    rung2: bool(o.rung2, DEFAULT_CONFIG.rung2),
    rung3: bool(o.rung3, DEFAULT_CONFIG.rung3),
    assist: unit(o.assist, DEFAULT_CONFIG.assist),
    debug: bool(o.debug, DEFAULT_CONFIG.debug),
    showLetter: bool(o.showLetter, DEFAULT_CONFIG.showLetter),
  };
}

/**
 * Load the saved config, or the defaults. NEVER throws: a missing key, corrupt
 * JSON, a partial blob, or a storage whose `getItem` throws all degrade to a
 * fresh copy of {@link DEFAULT_CONFIG}.
 */
export function loadConfig(
  storage: ConfigStorage | null = defaultStorage(),
): PhoneticConfig {
  if (!storage) return { ...DEFAULT_CONFIG };
  let json: string | null = null;
  try {
    json = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!json) return { ...DEFAULT_CONFIG };
  try {
    return coerce(JSON.parse(json));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Persist the config. NEVER throws: a full quota or a `setItem` that throws
 * (private mode) is swallowed — the in-memory config still drives this session,
 * and the defaults simply load next time.
 */
export function saveConfig(
  config: PhoneticConfig,
  storage: ConfigStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode / quota — ignore by design */
  }
}
