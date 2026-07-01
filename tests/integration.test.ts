import { describe, it, expect } from "vitest";
import { AudioEngine } from "../src/audio/AudioEngine";
import { PatternMatcher } from "../src/game/PatternMatcher";
import { LetterIndicator } from "../src/game/LetterIndicator";
import type { AcousticPattern } from "../src/game/types";
import {
  FakeAnalyser,
  sineTime,
  noiseTime,
  tonalSpectrumDb,
  flatSpectrumDb,
  silentSpectrumDb,
  vowelSpectrumDb,
} from "./_helpers";

const PATTERN: AcousticPattern = {
  rung: 1,
  sustain: { minMs: 600, want: "vowel" },
  release: { requireGapMs: 120 },
};

const SR = 44100;
const STEP = 16; // ms/frame

/**
 * Drive a canned sound through the *real* AudioEngine (spectral analysis, noise
 * floor, voiced hysteresis) and the *real* PatternMatcher, the way the game does
 * each frame. Returns whether the hold satisfied and whether the catch fired.
 */
function runScenario(
  hold: { time: Float32Array; freqDb: Float32Array },
  holdFrames: number,
  gapFrames: number,
): { holdSatisfied: boolean; caught: boolean } {
  const analyser = new FakeAnalyser();
  const engine = new AudioEngine({ analyser, sampleRate: SR });
  const matcher = new PatternMatcher(PATTERN, { assist: 0 });

  let t = 0;
  let holdSatisfied = false;
  let caught = false;

  // 1) ambient quiet so the noise floor calibrates low (~1.5s of silence).
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }

  // 2) the held sound.
  analyser.time = hold.time;
  analyser.freqDb = hold.freqDb;
  for (let i = 0; i < holdFrames; i++) {
    const m = matcher.update(engine.sample(t), STEP);
    if (m.holdSatisfied) holdSatisfied = true;
    if (m.caught) caught = true;
    t += STEP;
  }

  // 3) the stop (silence) — long enough for the smoothed RMS to fall and the gap
  //    to be recognised.
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < gapFrames; i++) {
    const m = matcher.update(engine.sample(t), STEP);
    if (m.caught) caught = true;
    t += STEP;
  }

  return { holdSatisfied, caught };
}

describe("AudioEngine → PatternMatcher integration", () => {
  it("«о-о-о» (≈300 Hz) held then stopped catches the mouse (AC#3)", () => {
    const r = runScenario(
      { time: sineTime(300, 0.3), freqDb: tonalSpectrumDb(7) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("«а-а-а» (≈440 Hz) held then stopped also catches", () => {
    const r = runScenario(
      { time: sineTime(440, 0.3), freqDb: tonalSpectrumDb(10) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("a continuous shriek then a stop never catches (AC#1)", () => {
    const r = runScenario(
      { time: noiseTime(0.3), freqDb: flatSpectrumDb(-40) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(false);
    expect(r.caught).toBe(false);
  });

  it("a short shout (<600ms) then a stop never arms the pounce (AC#2)", () => {
    const r = runScenario(
      { time: sineTime(300, 0.3), freqDb: tonalSpectrumDb(7) },
      18,
      60,
    );
    expect(r.holdSatisfied).toBe(false);
    expect(r.caught).toBe(false);
  });
});

// --- Rung 2 (#5): canned «о» vs «а» through the REAL engine + matcher --------

const O_PATTERN: AcousticPattern = { ...PATTERN, vowel: "о" };
// Her calibration vowel «а» (high, child-ish formants) anchors her vowel space.
const BASE_A = { centroid: 1100, f1: 850, f2: 1400 };
// Equal loudness (same sine amplitude → same RMS), differing only in formants.
const HELD_O = { time: sineTime(280, 0.3), freqDb: vowelSpectrumDb(560, 950) };
const HELD_A = { time: sineTime(440, 0.3), freqDb: vowelSpectrumDb(850, 1400) };

/**
 * Drive a held vowel through the real AudioEngine (which estimates F1/F2) into a
 * real matcher, and return the settled chase-drive after the hold. Ambient quiet
 * first, so the noise floor + level scaling match between runs.
 */
function settledDrive(
  hold: { time: Float32Array; freqDb: Float32Array },
  opts: ConstructorParameters<typeof PatternMatcher>[1],
  holdFrames = 40,
): number {
  const analyser = new FakeAnalyser();
  const engine = new AudioEngine({ analyser, sampleRate: SR });
  const matcher = new PatternMatcher(O_PATTERN, opts);
  let t = 0;
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }
  analyser.time = hold.time;
  analyser.freqDb = hold.freqDb;
  let drive = 0;
  for (let i = 0; i < holdFrames; i++) {
    drive = matcher.update(engine.sample(t), STEP).driveQuality;
    t += STEP;
  }
  return drive;
}

describe("AudioEngine → PatternMatcher Rung 2 integration (#5)", () => {
  it("AC#2: a held «о» drives faster than «а», both non-zero, gap exceeds Rung 1's", () => {
    const on = { assist: 0, rung2: true, vowelBaseline: BASE_A };
    const off = { assist: 0 }; // rung2 off → Rung 1
    const oOn = settledDrive(HELD_O, on);
    const aOn = settledDrive(HELD_A, on);
    const oOff = settledDrive(HELD_O, off);
    const aOff = settledDrive(HELD_A, off);

    expect(oOn).toBeGreaterThan(aOn); // «о» is faster
    expect(aOn).toBeGreaterThan(0); // but «а» still clearly moves (leniency)
    // Rung 2 ADDS vowel-identity separation on top of the Rung-1 vowelLikeness gap.
    expect(oOn - aOn).toBeGreaterThan(oOff - aOff);
  });
});

// --- Rung 3 (#6/#12): the real «т» stop through the REAL engine + matcher -----

const STOP_PATTERN: AcousticPattern = {
  ...PATTERN,
  release: { requireGapMs: 120, want: "stop", letter: "Т" },
};

/**
 * Drive a held vowel, then a scripted tail (closures / bursts), through the real
 * AudioEngine + a Rung-3 matcher the way the game does — so the «т» burst is
 * detected by the engine's FAST envelope, not faked on the frame. Returns whether
 * the hold satisfied, whether the catch fired, and whether the engine ever
 * surfaced a `stopBurst` during the tail.
 */
function runRung3(
  hold: { time: Float32Array; freqDb: Float32Array },
  holdFrames: number,
  tail: Array<{ time: Float32Array; freqDb: Float32Array; frames: number }>,
  assist = 0,
): { holdSatisfied: boolean; caught: boolean; sawStopBurst: boolean } {
  const analyser = new FakeAnalyser();
  const engine = new AudioEngine({ analyser, sampleRate: SR });
  const matcher = new PatternMatcher(STOP_PATTERN, { assist, rung3: true });

  let t = 0;
  let holdSatisfied = false;
  let caught = false;
  let sawStopBurst = false;
  const step = (frames: number, watchBurst = false) => {
    for (let i = 0; i < frames; i++) {
      const frame = engine.sample(t);
      if (watchBurst && frame.stopBurst) sawStopBurst = true;
      const m = matcher.update(frame, STEP);
      if (m.holdSatisfied) holdSatisfied = true;
      if (m.caught) caught = true;
      t += STEP;
    }
  };

  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }
  analyser.time = hold.time;
  analyser.freqDb = hold.freqDb;
  step(holdFrames);
  for (const ph of tail) {
    analyser.time = ph.time;
    analyser.freqDb = ph.freqDb;
    step(ph.frames, true);
  }
  return { holdSatisfied, caught, sawStopBurst };
}

const O_HOLD = { time: sineTime(300, 0.3), freqDb: tonalSpectrumDb(7) };
const SILENCE = { time: new Float32Array(1024), freqDb: silentSpectrumDb(), frames: 60 };
// A SHORT «т» closure (≈96 ms) — within the 50–150 ms the fast detector expects,
// unlike a full run-out-of-breath gap.
const CLOSURE = { time: new Float32Array(1024), freqDb: silentSpectrumDb(), frames: 6 };
const BURST = { time: noiseTime(0.3), freqDb: flatSpectrumDb(-40), frames: 4 };
// «ко-о-о-т»: hold → a brief closure → the «т» release burst → the word ends.
const KOT_TAIL = [CLOSURE, BURST, { ...SILENCE, frames: 30 }];

describe("AudioEngine → PatternMatcher Rung 3 integration (#6/#12)", () => {
  it("«ко-о-о-т» (hold → closure → burst) fires a real stopBurst and catches at STRICT", () => {
    const r = runRung3(O_HOLD, 60, KOT_TAIL, 0); // strict: the «т» is required
    expect(r.holdSatisfied).toBe(true);
    expect(r.sawStopBurst).toBe(true); // the engine's fast detector actually fired
    expect(r.caught).toBe(true); // and the «т» release won the catch
  });

  it("AC#3: «ко-о-о» then just stopping (no «т») does NOT catch at STRICT", () => {
    const r = runRung3(O_HOLD, 60, [SILENCE], 0);
    expect(r.holdSatisfied).toBe(true);
    expect(r.sawStopBurst).toBe(false); // no burst — just a long silence
    expect(r.caught).toBe(false); // no «т» at strict = no win
  });

  it("AC#1 (#18): «ко-о-о» then just stopping (no «т») does NOT catch — even at EASY", () => {
    // Two-phase win (#18): the run-out-of-breath pause no longer wins at ANY slider
    // position — the child must produce the «т». At easy the «т» is just easier to
    // detect (looser burstOptsForAssist), not optional.
    const r = runRung3(O_HOLD, 60, [SILENCE], 1);
    expect(r.holdSatisfied).toBe(true);
    expect(r.sawStopBurst).toBe(false); // just silence — no «т» ever fired
    expect(r.caught).toBe(false); // and so the round never completes on a pause
  });

  it("AC#2 (#18): «ко-о-о-т» catches at EASY too — the real «т» is the only finish", () => {
    const r = runRung3(O_HOLD, 60, KOT_TAIL, 1);
    expect(r.holdSatisfied).toBe(true);
    expect(r.sawStopBurst).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("AC#3: a continuous «о» hum with no stop holds but never catches", () => {
    const r = runRung3(O_HOLD, 150, [], 0); // long hold, no closure/burst at all
    expect(r.holdSatisfied).toBe(true);
    expect(r.caught).toBe(false);
  });
});

// --- #13: the live-vowel chip is read-only, and widens the formant pass -------

/** Ambient-quiet warmup so the noise floor calibrates low; returns the next `t`. */
function warmup(engine: AudioEngine, analyser: FakeAnalyser): number {
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  let t = 0;
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }
  return t;
}

describe("live-vowel chip wiring (#13)", () => {
  it("AC#5: chip on + all rungs off (rung2Enabled widened) still emits F1/F2 on a voiced vowel", () => {
    // applyEngineFlags with all rungs off but showLetter on → both flags true.
    const analyser = new FakeAnalyser();
    const engine = new AudioEngine({ analyser, sampleRate: SR });
    engine.setPhoneticEnabled(true);
    engine.setRung2Enabled(true);
    let t = warmup(engine, analyser);
    analyser.time = sineTime(280, 0.3);
    analyser.freqDb = vowelSpectrumDb(560, 950);
    let f = engine.sample(t);
    for (let i = 0; i < 20; i++) {
      t += STEP;
      f = engine.sample(t);
    }
    expect(f.voiced).toBe(true);
    expect(f.f1).toBeGreaterThan(0);
    expect(f.f2).toBeGreaterThan(0);

    // Chip off (and rungs off) → the formant pass is skipped, F1/F2 stay 0.
    const a2 = new FakeAnalyser();
    const e2 = new AudioEngine({ analyser: a2, sampleRate: SR });
    e2.setPhoneticEnabled(true);
    e2.setRung2Enabled(false);
    let t2 = warmup(e2, a2);
    a2.time = sineTime(280, 0.3);
    a2.freqDb = vowelSpectrumDb(560, 950);
    let f2 = e2.sample(t2);
    for (let i = 0; i < 20; i++) {
      t2 += STEP;
      f2 = e2.sample(t2);
    }
    expect(f2.f1).toBe(0);
    expect(f2.f2).toBe(0);
  });

  it("AC#6: running the chip's indicator never changes the matcher's verdicts", () => {
    // Drive one identical canned «о»→silence sequence through the REAL engine +
    // a rung1 matcher twice: once with the chip's formant pass ON and the
    // LetterIndicator updated each frame ("show on"), once without ("show off").
    // The chip reads only frame fields the matcher ignores at rung1 (f1/f2) and
    // shares no state with it, so the verdict stream is element-for-element equal.
    type V = { driveQuality: number; holdSatisfied: boolean; caught: boolean };
    const runs: V[][] = [];
    for (const showOn of [true, false]) {
      const analyser = new FakeAnalyser();
      const engine = new AudioEngine({ analyser, sampleRate: SR });
      engine.setVowelBaseline(BASE_A);
      engine.setPhoneticEnabled(true);
      engine.setRung2Enabled(showOn); // the only engine difference the toggle makes
      const matcher = new PatternMatcher(PATTERN, { assist: 0, rung1: true });
      const li = showOn ? new LetterIndicator() : null;
      const out: V[] = [];
      let t = warmup(engine, analyser);
      const drive = (time: Float32Array, freqDb: Float32Array, frames: number) => {
        analyser.time = time;
        analyser.freqDb = freqDb;
        for (let i = 0; i < frames; i++) {
          const frame = engine.sample(t);
          li?.update(
            { f1: frame.f1, f2: frame.f2 },
            frame.level,
            frame.voiced,
            engine.getVowelBaseline(),
            STEP,
          );
          const m = matcher.update(frame, STEP);
          out.push({ driveQuality: m.driveQuality, holdSatisfied: m.holdSatisfied, caught: m.caught });
          t += STEP;
        }
      };
      drive(sineTime(300, 0.3), tonalSpectrumDb(7), 60); // «о-о-о» hold
      drive(new Float32Array(1024), silentSpectrumDb(), 60); // the stop
      runs.push(out);
    }
    expect(runs[0]).toEqual(runs[1]); // read-only: identical, frame for frame
    // Guard against a vacuous all-equal-because-all-zero pass: the run really
    // held and caught, so the equality above is meaningful.
    expect(runs[0].some((v) => v.holdSatisfied)).toBe(true);
    expect(runs[0].some((v) => v.caught)).toBe(true);
  });

  it("chip text updates from canned frames: a held «о» settles the chip on «О»", () => {
    const analyser = new FakeAnalyser();
    const engine = new AudioEngine({ analyser, sampleRate: SR });
    engine.setVowelBaseline(BASE_A);
    engine.setPhoneticEnabled(true);
    engine.setRung2Enabled(true);
    const li = new LetterIndicator();
    let t = warmup(engine, analyser);
    analyser.time = HELD_O.time;
    analyser.freqDb = HELD_O.freqDb;
    let verdict = li.update({ f1: 0, f2: 0 }, 0, false, BASE_A, STEP);
    for (let i = 0; i < 40; i++) {
      const frame = engine.sample(t);
      verdict = li.update(
        { f1: frame.f1, f2: frame.f2 },
        frame.level,
        frame.voiced,
        engine.getVowelBaseline(),
        STEP,
      );
      t += STEP;
    }
    expect(verdict.vowel).toBe("о");
  });
});
