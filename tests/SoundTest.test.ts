import { describe, it, expect } from "vitest";
import {
  BurstAccumulator,
  ScoreTally,
  burstVerdict,
  type Attempt,
  type AttemptFrame,
  type TestFrame,
  type TestTarget,
} from "../src/game/SoundTest";

// ---- tiny frame builders ------------------------------------------------

/** One live frame with sensible voiced-vowel defaults; override per case. */
function frame(over: Partial<TestFrame> = {}): TestFrame {
  return {
    dtMs: 16,
    level: 0.6,
    voiced: true,
    onset: false,
    release: false,
    gatedVowel: null,
    stopBurst: false,
    ...over,
  };
}

/** One collected attempt-frame (post-attack, loud) for the verdict tests. */
function af(over: Partial<AttemptFrame> = {}): AttemptFrame {
  return { tMs: 120, level: 0.6, gatedVowel: null, stopBurst: false, ...over };
}

/**
 * A clean voiced-vowel burst: onset, `coreFrames` sustained frames all gated to
 * `vowel`, a release, then enough quiet tail frames to close the attempt.
 */
function vowelBurst(
  vowel: "а" | "о" | "у" | "и",
  { coreFrames = 12, level = 0.6 } = {},
): TestFrame[] {
  const out: TestFrame[] = [
    frame({ onset: true, level, gatedVowel: vowel }),
  ];
  for (let i = 1; i < coreFrames; i++) out.push(frame({ level, gatedVowel: vowel }));
  out.push(frame({ release: true, voiced: false, level: 0.05 }));
  for (let i = 0; i < 20; i++) out.push(frame({ voiced: false, level: 0 }));
  return out;
}

/** Push a whole stream through one accumulator, collecting every closed attempt. */
function collectAttempts(acc: BurstAccumulator, frames: TestFrame[]): Attempt[] {
  const out: Attempt[] = [];
  for (const f of frames) {
    const a = acc.push(f);
    if (a) out.push(a);
  }
  return out;
}

// =========================================================================
// burstVerdict — vowel targets (modal gated core)
// =========================================================================

describe("burstVerdict — vowel targets (#22)", () => {
  it("picks the sustained vowel from the modal gated core", () => {
    const frames: AttemptFrame[] = [];
    for (let t = 80; t <= 240; t += 16) frames.push(af({ tMs: t, gatedVowel: "а" }));
    expect(burstVerdict(frames, "а")).toBe("а");
  });

  it("excludes the attack: a stray vowel only in the first 80 ms doesn't win", () => {
    const frames: AttemptFrame[] = [
      // attack window (tMs < 80): a strong-but-transient «о» while the EMA settles
      af({ tMs: 0, gatedVowel: "о" }),
      af({ tMs: 16, gatedVowel: "о" }),
      af({ tMs: 32, gatedVowel: "о" }),
      af({ tMs: 48, gatedVowel: "о" }),
      af({ tMs: 64, gatedVowel: "о" }),
      // sustained core (tMs >= 80): a steady «а»
      af({ tMs: 80, gatedVowel: "а" }),
      af({ tMs: 96, gatedVowel: "а" }),
      af({ tMs: 112, gatedVowel: "а" }),
      af({ tMs: 128, gatedVowel: "а" }),
    ];
    expect(burstVerdict(frames, "а")).toBe("а");
  });

  it("a tie between two vowels in the core → «—»", () => {
    const frames: AttemptFrame[] = [
      af({ tMs: 80, gatedVowel: "а" }),
      af({ tMs: 96, gatedVowel: "а" }),
      af({ tMs: 112, gatedVowel: "о" }),
      af({ tMs: 128, gatedVowel: "о" }),
    ];
    expect(burstVerdict(frames, "а")).toBe("—");
  });

  it("a weak/below-gate core (all «—» or too quiet) → «—»", () => {
    // The peak is 0.8, so the gate is 0.4; the quiet 0.2 ramps never qualify, and
    // the one loud frame reads «—» (no gated letter), so the mode is «—».
    const frames: AttemptFrame[] = [
      af({ tMs: 80, level: 0.2, gatedVowel: "а" }),
      af({ tMs: 96, level: 0.2, gatedVowel: "а" }),
      af({ tMs: 112, level: 0.8, gatedVowel: null }),
    ];
    expect(burstVerdict(frames, "а")).toBe("—");
  });
});

// =========================================================================
// burstVerdict — target Т (stop-burst in window)
// =========================================================================

describe("burstVerdict — target Т (#22)", () => {
  it("a stop-burst anywhere in the window → Т", () => {
    const frames: AttemptFrame[] = [
      af({ tMs: 80, gatedVowel: "о" }),
      af({ tMs: 200, stopBurst: true }),
    ];
    expect(burstVerdict(frames, "Т")).toBe("Т");
  });

  it("a sustained vowel / breath-stop with no burst → «—», never a false Т", () => {
    const frames: AttemptFrame[] = [];
    for (let t = 0; t <= 240; t += 16) frames.push(af({ tMs: t, gatedVowel: "о" }));
    expect(burstVerdict(frames, "Т")).toBe("—");
  });

  it("the tail catches a burst that fires after the voiced release", () => {
    const acc = new BurstAccumulator();
    const stream: TestFrame[] = [
      frame({ onset: true, gatedVowel: "о" }),
    ];
    for (let i = 1; i < 10; i++) stream.push(frame({ gatedVowel: "о" }));
    stream.push(frame({ release: true, voiced: false, level: 0.1 }));
    stream.push(frame({ voiced: false, level: 0.05 }));
    // the terminal «т» transient — after the release, no fresh onset
    stream.push(frame({ voiced: true, level: 0.5, stopBurst: true }));
    for (let i = 0; i < 18; i++) stream.push(frame({ voiced: false, level: 0 }));

    const attempts = collectAttempts(acc, stream);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].frames.some((f) => f.stopBurst)).toBe(true);
    expect(burstVerdict(attempts[0].frames, "Т")).toBe("Т");
  });
});

// =========================================================================
// BurstAccumulator — segmentation + validity filter
// =========================================================================

describe("BurstAccumulator (#22)", () => {
  it("segments a single onset→release burst into exactly one attempt", () => {
    const acc = new BurstAccumulator();
    const attempts = collectAttempts(acc, vowelBurst("а"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].durMs).toBeGreaterThanOrEqual(120);
    expect(attempts[0].peakLevel).toBeCloseTo(0.6, 5);
  });

  it("rejects a too-short burst (core < 120 ms)", () => {
    const acc = new BurstAccumulator();
    const stream: TestFrame[] = [
      frame({ onset: true, gatedVowel: "а" }), // tMs 0
      frame({ gatedVowel: "а" }), // 16
      frame({ gatedVowel: "а" }), // 32
      frame({ release: true, voiced: false, level: 0.05 }), // tMs 48 → core 48 ms
    ];
    for (let i = 0; i < 20; i++) stream.push(frame({ voiced: false, level: 0 }));
    expect(collectAttempts(acc, stream)).toHaveLength(0);
  });

  it("rejects a too-quiet burst (peak level < 0.3)", () => {
    const acc = new BurstAccumulator();
    // Long enough core, but every frame is barely above the floor.
    const attempts = collectAttempts(acc, vowelBurst("а", { level: 0.2 }));
    expect(attempts).toHaveLength(0);
  });

  it("a new onset during the tail closes one attempt and opens the next", () => {
    const acc = new BurstAccumulator();
    const stream = [...vowelBurst("а", { coreFrames: 12 })];
    // Trim the long trailing silence to a couple of tail frames, then re-onset.
    stream.length = 14; // onset + 11 core + release + 1 tail frame
    stream.push(frame({ onset: true, gatedVowel: "о" }));
    for (let i = 1; i < 12; i++) stream.push(frame({ gatedVowel: "о" }));
    stream.push(frame({ release: true, voiced: false, level: 0.05 }));
    for (let i = 0; i < 20; i++) stream.push(frame({ voiced: false, level: 0 }));

    const attempts = collectAttempts(acc, stream);
    expect(attempts).toHaveLength(2);
    expect(burstVerdict(attempts[0].frames, "а")).toBe("а");
    expect(burstVerdict(attempts[1].frames, "а")).toBe("о");
  });

  it("reset() drops an in-progress burst", () => {
    const acc = new BurstAccumulator();
    acc.push(frame({ onset: true, gatedVowel: "а" }));
    acc.push(frame({ gatedVowel: "а" }));
    acc.reset();
    // With the core dropped, the release alone can't close a valid attempt.
    const after = acc.push(frame({ release: true, voiced: false, level: 0.05 }));
    expect(after).toBeNull();
  });
});

// =========================================================================
// ScoreTally
// =========================================================================

describe("ScoreTally (#22)", () => {
  it("records totals, hits, and the confusion breakdown", () => {
    const tally = new ScoreTally();
    tally.record("а", "а"); // hit
    tally.record("а", "о"); // confused as о
    tally.record("а", "—"); // below gate
    tally.record("а", "а"); // hit
    expect(tally.total).toBe(4);
    expect(tally.hits).toBe(2);
    const c = tally.confusion;
    expect(c["а"]).toBe(2);
    expect(c["о"]).toBe(1);
    expect(c["—"]).toBe(1);
    expect(c["у"]).toBe(0);
    expect(c["Т"]).toBe(0);
  });

  it("computes the hit rate (0 when empty)", () => {
    const tally = new ScoreTally();
    expect(tally.rate).toBe(0);
    tally.record("Т", "Т");
    tally.record("Т", "—");
    expect(tally.rate).toBeCloseTo(0.5, 5);
  });

  it("reset() zeroes the tally (as the host does on a target switch)", () => {
    const tally = new ScoreTally();
    tally.record("о", "о");
    tally.record("о", "у");
    tally.reset();
    expect(tally.total).toBe(0);
    expect(tally.hits).toBe(0);
    expect(tally.confusion["о"]).toBe(0);
    expect(tally.confusion["у"]).toBe(0);
  });
});

// =========================================================================
// Integration — canned streams through accumulator + verdict + tally
// =========================================================================

describe("SoundTest integration (#22)", () => {
  it("scores a clean «а» then an «а→о» confusion against target а", () => {
    const acc = new BurstAccumulator();
    const tally = new ScoreTally();
    const target: TestTarget = "а";

    // 1) a clean «а» hold → detected а (hit)
    const clean = vowelBurst("а");
    // 2) an attempt that drifts to «о» in the sustained core → detected о (miss)
    const confused: TestFrame[] = [frame({ onset: true, gatedVowel: "а" })];
    for (let i = 1; i < 6; i++) confused.push(frame({ gatedVowel: "а" })); // attack + early core
    for (let i = 0; i < 8; i++) confused.push(frame({ gatedVowel: "о" })); // sustained «о»
    confused.push(frame({ release: true, voiced: false, level: 0.05 }));
    for (let i = 0; i < 20; i++) confused.push(frame({ voiced: false, level: 0 }));

    for (const f of [...clean, ...confused]) {
      const a = acc.push(f);
      if (a) tally.record(target, burstVerdict(a.frames, target));
    }

    expect(tally.total).toBe(2);
    expect(tally.hits).toBe(1);
    expect(tally.confusion["а"]).toBe(1);
    expect(tally.confusion["о"]).toBe(1);
  });

  it("scores a «т» closure-burst as a hit and a plain vowel as «—» against target Т", () => {
    const acc = new BurstAccumulator();
    const tally = new ScoreTally();
    const target: TestTarget = "Т";

    // 1) a кот-like «о…т»: voiced hold, release, then a post-release burst.
    const kot: TestFrame[] = [frame({ onset: true, gatedVowel: "о" })];
    for (let i = 1; i < 10; i++) kot.push(frame({ gatedVowel: "о" }));
    kot.push(frame({ release: true, voiced: false, level: 0.1 }));
    kot.push(frame({ voiced: false, level: 0.05 }));
    kot.push(frame({ voiced: true, level: 0.5, stopBurst: true }));
    for (let i = 0; i < 18; i++) kot.push(frame({ voiced: false, level: 0 }));

    // 2) a sustained vowel with no closure → no burst → «—» (not a false Т).
    const plain = vowelBurst("о");

    for (const f of [...kot, ...plain]) {
      const a = acc.push(f);
      if (a) tally.record(target, burstVerdict(a.frames, target));
    }

    expect(tally.total).toBe(2);
    expect(tally.hits).toBe(1); // only the «т» attempt
    expect(tally.confusion["Т"]).toBe(1);
    expect(tally.confusion["—"]).toBe(1);
  });
});
