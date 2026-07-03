/**
 * DetectionFixture.test.ts — unit tests for the offline capture/replay harness
 * (issue #24): the fixture loader round-trips, {@link ClipAnalyser} plays a clip
 * back exactly as a live AnalyserNode would, {@link replayClip} reproduces the
 * live engine's per-frame output (parity with both a FakeAnalyser run AND a
 * direct pure-function call), and the outcome classifier obeys its rules.
 */
import { describe, it, expect } from "vitest";
import {
  CLIP_VERSION,
  COARSE_LABELS,
  ClipAnalyser,
  serializeClip,
  parseClip,
  validateClip,
  replayClip,
  clipVerdict,
  sweepAssist,
  type DetectionClip,
  type ClipFrame,
  type ReplayResult,
} from "../src/game/DetectionFixture";
import { AudioEngine, type AudioFrame } from "../src/audio/AudioEngine";
import {
  spectralFlatness,
  spectralCentroid,
  lowBandRatio,
  zeroCrossingRate,
  vowelLikeness,
} from "../src/audio/PhoneticFeatures";
import {
  FakeAnalyser,
  makeFrame,
  sineTime,
  noiseTime,
  vowelSpectrumDb,
  flatSpectrumDb,
  silentSpectrumDb,
} from "./_helpers";

const SR = 44100;
const FFT = 256;
const BINS = 128;

/** Build a well-formed clip from parallel time/dB frame arrays. */
function clipOf(
  label: DetectionClip["label"],
  frames: { time: Float32Array; freq: Float32Array }[],
  extra: Partial<DetectionClip> = {},
): DetectionClip {
  return {
    version: CLIP_VERSION,
    label,
    sampleRate: SR,
    fftSize: FFT,
    binCount: BINS,
    assist: 0.5,
    frames: frames.map((f) => ({
      dtMs: 16,
      time: Array.from(f.time),
      freq: Array.from(f.freq),
    })),
    ...extra,
  };
}

describe("serializeClip / parseClip round-trip", () => {
  it("round-trips a clip byte-for-byte", () => {
    const clip = clipOf("bare-a", [
      { time: sineTime(300, 0.2, FFT, SR), freq: vowelSpectrumDb(700, 1300, SR, BINS) },
      { time: sineTime(300, 0.2, FFT, SR), freq: vowelSpectrumDb(700, 1300, SR, BINS) },
    ]);
    const back = parseClip(serializeClip(clip));
    expect(back).toEqual(clip);
  });

  it("keeps a null baseline and an optional note", () => {
    const clip = clipOf("silence", [], { baseline: null, note: "quiet room" });
    const back = parseClip(serializeClip(clip));
    expect(back.baseline).toBeNull();
    expect(back.note).toBe("quiet room");
  });
});

describe("validateClip rejects malformed input", () => {
  const good = clipOf("hiss", [
    { time: noiseTime(0.1, FFT), freq: flatSpectrumDb(-20, BINS) },
  ]);

  it("accepts a good clip", () => {
    expect(() => validateClip(good)).not.toThrow();
  });
  it("rejects a wrong version", () => {
    expect(() => validateClip({ ...good, version: 99 })).toThrow(/version/);
  });
  it("rejects an unknown label", () => {
    expect(() => validateClip({ ...good, label: "shrek" })).toThrow(/label/);
  });
  it("rejects a bad sampleRate", () => {
    expect(() => validateClip({ ...good, sampleRate: 0 })).toThrow(/sampleRate/);
  });
  it("rejects a non-array frames", () => {
    expect(() => validateClip({ ...good, frames: {} })).toThrow(/frames/);
  });
  it("rejects a frame missing its time buffer", () => {
    expect(() => validateClip({ ...good, frames: [{ dtMs: 16 }] })).toThrow(/time/);
  });
  it("rejects a frame with a non-finite dtMs", () => {
    expect(() =>
      validateClip({ ...good, frames: [{ dtMs: NaN, time: [0] }] }),
    ).toThrow(/dtMs/);
  });
  it("every COARSE_LABELS entry validates", () => {
    for (const label of COARSE_LABELS) {
      expect(() => validateClip({ ...good, label })).not.toThrow();
    }
  });
});

describe("ClipAnalyser plays a clip back into the engine's buffers", () => {
  it("fills time + dB from the current frame, pads short arrays, and defaults a missing spectrum to silence", () => {
    const clip = clipOf("bare-a", []);
    const a = new ClipAnalyser(clip);
    expect(a.fftSize).toBe(FFT);
    expect(a.frequencyBinCount).toBe(BINS);

    const shortFrame: ClipFrame = { dtMs: 16, time: [0.5, -0.5] }; // no freq
    a.setFrame(shortFrame);
    const t = new Float32Array(FFT);
    a.getFloatTimeDomainData(t);
    expect(t[0]).toBeCloseTo(0.5);
    expect(t[1]).toBeCloseTo(-0.5);
    expect(t[2]).toBe(0); // padded

    const f = new Float32Array(BINS);
    a.getFloatFrequencyData(f);
    expect(f.every((v) => v === -140)).toBe(true); // silent default
  });
});

describe("replayClip parity with a live FakeAnalyser run", () => {
  it("reproduces the engine's per-frame output exactly (same buffers, same result)", () => {
    // A scripted vowel → silence sequence, held as parallel time/dB arrays.
    const seq = [
      { time: sineTime(300, 0.2, FFT, SR), freq: vowelSpectrumDb(700, 1300, SR, BINS) },
      { time: sineTime(300, 0.2, FFT, SR), freq: vowelSpectrumDb(700, 1300, SR, BINS) },
      { time: sineTime(300, 0.2, FFT, SR), freq: vowelSpectrumDb(700, 1300, SR, BINS) },
      { time: new Float32Array(FFT), freq: silentSpectrumDb(BINS) },
      { time: new Float32Array(FFT), freq: silentSpectrumDb(BINS) },
    ];

    // (a) live path: a FakeAnalyser fed frame-by-frame, engine sampled per frame.
    const fake = new FakeAnalyser();
    fake.fftSize = FFT;
    fake.frequencyBinCount = BINS;
    const live = new AudioEngine({ analyser: fake, sampleRate: SR });
    live.setPhoneticEnabled(true);
    live.setRung2Enabled(true);
    live.setAssist(0.5);
    const liveFrames: AudioFrame[] = [];
    let now = 0;
    for (const s of seq) {
      fake.time = s.time;
      fake.freqDb = s.freq;
      now += 16;
      liveFrames.push(live.sample(now));
    }

    // (b) replay path: the same buffers as a clip through ClipAnalyser.
    const clip = clipOf("bare-a", seq);
    const replay = replayClip(clip, { assist: 0.5, baseline: null });

    expect(replay.frames).toHaveLength(liveFrames.length);
    for (let i = 0; i < liveFrames.length; i++) {
      // dB round-trips through the clip (linear→dB→linear), so compare closely.
      expect(replay.frames[i].vowelLikeness).toBeCloseTo(liveFrames[i].vowelLikeness, 6);
      expect(replay.frames[i].centroid).toBeCloseTo(liveFrames[i].centroid, 3);
      expect(replay.frames[i].zcr).toBeCloseTo(liveFrames[i].zcr, 6);
      expect(replay.frames[i].level).toBeCloseTo(liveFrames[i].level, 6);
      expect(replay.frames[i].voiced).toBe(liveFrames[i].voiced);
      expect(replay.frames[i].stopBurst).toBe(liveFrames[i].stopBurst);
    }
  });

  it("a replayed vowel frame's vowelLikeness equals a direct pure-function call", () => {
    const time = sineTime(300, 0.2, FFT, SR);
    const freqDb = vowelSpectrumDb(700, 1300, SR, BINS);
    const clip = clipOf("bare-a", [{ time, freq: freqDb }], { baseline: null });
    const { frames } = replayClip(clip, { baseline: null });

    // Reconstruct the linear magnitude exactly as the engine does (10^(dB/20)).
    const mag = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) mag[i] = Math.pow(10, freqDb[i] / 20);
    const direct = vowelLikeness(
      {
        flatness: spectralFlatness(mag),
        centroid: spectralCentroid(mag, SR),
        lowBandRatio: lowBandRatio(mag, SR),
        zcr: zeroCrossingRate(time),
      },
      null,
    );
    expect(frames[0].vowelLikeness).toBeCloseTo(direct, 6);
  });
});

describe("clipVerdict / classifyClipOutcome rules", () => {
  /** Build a ReplayResult from hand-made AudioFrames (no engine needed). */
  function resultOf(frames: AudioFrame[]): ReplayResult {
    const clip = clipOf(
      "silence",
      frames.map(() => ({ time: new Float32Array(1), freq: new Float32Array(1) })),
    );
    return { clip, frames, assist: 0.5, baseline: null };
  }

  it("reads an all-quiet clip as silence", () => {
    const v = clipVerdict(resultOf([makeFrame(), makeFrame(), makeFrame()]));
    expect(v.outcome).toBe("silence");
  });

  it("reads a loud vowel-like core as a vowel", () => {
    const frames = Array.from({ length: 6 }, () =>
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.8, zcr: 0.05 }),
    );
    expect(clipVerdict(resultOf(frames)).outcome).toBe("vowel");
  });

  it("reads a loud but not-vowel-like voiced core as a hiss", () => {
    const frames = Array.from({ length: 6 }, () =>
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.2, zcr: 0.05 }),
    );
    expect(clipVerdict(resultOf(frames)).outcome).toBe("hiss");
  });

  it("reads a high-ZCR voiced core (fricative) as a hiss even if vowelLikeness is mid", () => {
    const frames = Array.from({ length: 6 }, () =>
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.6, zcr: 0.5 }),
    );
    expect(clipVerdict(resultOf(frames)).outcome).toBe("hiss");
  });

  it("a stop-burst anywhere makes the outcome a stop (decisive)", () => {
    const frames = [
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.8 }),
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.8, stopBurst: true }),
      makeFrame({ level: 0.9, voiced: true, vowelLikeness: 0.8 }),
    ];
    const v = clipVerdict(resultOf(frames));
    expect(v.outcome).toBe("stop");
    expect(v.stopBurstCount).toBe(1);
    expect(v.firstBurstMs).not.toBeNull();
  });
});

describe("sweepAssist basic shape", () => {
  it("returns one row per assist and picks a best", () => {
    const vowel = clipOf(
      "bare-a",
      Array.from({ length: 12 }, () => ({
        time: sineTime(300, 0.2, FFT, SR),
        freq: vowelSpectrumDb(700, 1300, SR, BINS),
      })),
      { baseline: { centroid: 900, f1: 700, f2: 1300 } },
    );
    const report = sweepAssist([vowel], [0, 0.5, 1]);
    expect(report.rows).toHaveLength(3);
    expect(report.best).not.toBeNull();
  });
});
