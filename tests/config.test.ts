import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  STORAGE_KEY,
  anyRungOn,
  loadConfig,
  saveConfig,
  type ConfigStorage,
  type PhoneticConfig,
} from "../src/game/config";
import { stepPlay } from "../src/game/GameView";
import { makeFrame } from "./_helpers";

/** An in-memory Web Storage stub — no browser, no localStorage. */
class MemoryStorage implements ConfigStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

/** A storage whose every access throws — private mode / quota full. */
const throwingStorage: ConfigStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("quota");
  },
};

describe("config store (loadConfig / saveConfig)", () => {
  it("round-trips a full config through storage", () => {
    const s = new MemoryStorage();
    const cfg: PhoneticConfig = {
      rung1: false,
      rung2: true,
      rung3: true,
      assist: 0.8,
      debug: true,
      showLetter: true,
    };
    saveConfig(cfg, s);
    expect(loadConfig(s)).toEqual(cfg);
  });

  it("returns defaults when the key is missing", () => {
    expect(loadConfig(new MemoryStorage())).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults (never throws) on corrupt JSON", () => {
    const s = new MemoryStorage();
    s.map.set(STORAGE_KEY, "{not json");
    expect(loadConfig(s)).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial blob with defaults (older / partial schema)", () => {
    const s = new MemoryStorage();
    s.map.set(STORAGE_KEY, JSON.stringify({ rung2: true }));
    expect(loadConfig(s)).toEqual({ ...DEFAULT_CONFIG, rung2: true });
  });

  it("clamps and type-guards bad fields", () => {
    const s = new MemoryStorage();
    s.map.set(
      STORAGE_KEY,
      JSON.stringify({ rung1: "yes", assist: 5, debug: 1 }),
    );
    const cfg = loadConfig(s);
    expect(cfg.rung1).toBe(DEFAULT_CONFIG.rung1); // non-boolean → default
    expect(cfg.assist).toBe(1); // out of range → clamped to 0..1
    expect(cfg.debug).toBe(DEFAULT_CONFIG.debug); // non-boolean → default
  });

  it("degrades to defaults when storage is unavailable (null)", () => {
    expect(loadConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(() => saveConfig(DEFAULT_CONFIG, null)).not.toThrow();
  });

  it("swallows a throwing storage on both load and save", () => {
    expect(loadConfig(throwingStorage)).toEqual(DEFAULT_CONFIG);
    expect(() => saveConfig(DEFAULT_CONFIG, throwingStorage)).not.toThrow();
  });

  it("does not alias DEFAULT_CONFIG (callers can mutate safely)", () => {
    const a = loadConfig(new MemoryStorage());
    a.assist = 0.1;
    expect(DEFAULT_CONFIG.assist).toBe(0.5);
  });

  it("#13: showLetter defaults off and round-trips through storage", () => {
    expect(DEFAULT_CONFIG.showLetter).toBe(false);
    expect(loadConfig(new MemoryStorage()).showLetter).toBe(false);
    const s = new MemoryStorage();
    saveConfig({ ...DEFAULT_CONFIG, showLetter: true }, s);
    expect(loadConfig(s).showLetter).toBe(true);
  });

  it("#13: coerces a bad showLetter to its default and keeps a partial blob's other keys", () => {
    const s = new MemoryStorage();
    s.map.set(STORAGE_KEY, JSON.stringify({ showLetter: "yes" }));
    expect(loadConfig(s).showLetter).toBe(DEFAULT_CONFIG.showLetter); // non-boolean → default
    const s2 = new MemoryStorage();
    s2.map.set(STORAGE_KEY, JSON.stringify({ showLetter: true }));
    expect(loadConfig(s2)).toEqual({ ...DEFAULT_CONFIG, showLetter: true }); // merges with defaults
  });

  it("#18: rung3 defaults ON (the two-phase «т» win is the shipped default)", () => {
    expect(DEFAULT_CONFIG.rung3).toBe(true);
    expect(loadConfig(new MemoryStorage()).rung3).toBe(true);
    // A caregiver can still turn it OFF, and that choice round-trips (the rollback).
    const s = new MemoryStorage();
    saveConfig({ ...DEFAULT_CONFIG, rung3: false }, s);
    expect(loadConfig(s).rung3).toBe(false);
  });
});

describe("anyRungOn", () => {
  const base = { assist: 0.5, debug: false };
  it("is false only when every rung is off (the kill-switch)", () => {
    expect(
      anyRungOn({ ...base, rung1: false, rung2: false, rung3: false }),
    ).toBe(false);
  });
  it("is true if any single rung is on", () => {
    expect(anyRungOn({ ...base, rung1: true, rung2: false, rung3: false })).toBe(true);
    expect(anyRungOn({ ...base, rung1: false, rung2: true, rung3: false })).toBe(true);
    expect(anyRungOn({ ...base, rung1: false, rung2: false, rung3: true })).toBe(true);
  });
  it("the default config has the phonetic layer on (Rung 1)", () => {
    expect(anyRungOn(DEFAULT_CONFIG)).toBe(true);
  });
});

describe("AC#2: all rungs off reproduces the loudness-only trajectory", () => {
  // The pre-#1 loudness-only play step, inlined as the reference oracle (same
  // approach as the USE_PHONETIC identity test in GameViewDrive).
  function oldStep(
    prev: number,
    frame: ReturnType<typeof makeFrame>,
    dts: number,
    inputEnabled: boolean,
  ) {
    let progress = prev;
    if (inputEnabled && frame.voiced) {
      const drive = Math.max(0.25, frame.level); // MIN_VOICED_DRIVE
      progress = Math.min(0.9, prev + drive * 1.0 * dts); // PRECHASE_CAP, CHASE_RATE
    }
    let pounce = false;
    if (inputEnabled && progress >= 0.8) pounce = frame.onset || frame.release;
    return { progress, pounce };
  }

  it("an all-off config yields no matcher → the loudness oracle, frame for frame", () => {
    const allOff: PhoneticConfig = {
      rung1: false,
      rung2: false,
      rung3: false,
      assist: 0.5,
      debug: false,
      showLetter: false,
    };
    // This is exactly the decision `buildMatcher()` makes in main.ts.
    const match = anyRungOn(allOff) ? ({} as never) : null;
    expect(match).toBeNull();

    const dts = 0.05;
    const seq: Array<{ f: ReturnType<typeof makeFrame>; en: boolean }> = [
      { f: makeFrame({ voiced: true, level: 0.5 }), en: true },
      { f: makeFrame({ voiced: true, level: 1.0, onset: true }), en: true },
      { f: makeFrame({ voiced: true, level: 1.0 }), en: false },
      { f: makeFrame({ voiced: false, level: 0, release: true }), en: true },
      { f: makeFrame({ voiced: true, level: 1.0 }), en: true },
      { f: makeFrame({ voiced: true, level: 0.2 }), en: true },
    ];

    let pNew = 0.78;
    let pOld = 0.78;
    for (const { f, en } of seq) {
      const a = stepPlay(pNew, f, dts, match, en);
      const b = oldStep(pOld, f, dts, en);
      expect(a).toEqual(b);
      pNew = a.progress;
      pOld = b.progress;
    }
  });
});
