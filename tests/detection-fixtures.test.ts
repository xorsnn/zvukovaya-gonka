/**
 * detection-fixtures.test.ts — the REGRESSION LOCK for issue #24.
 *
 * Loads every committed clip under tests/fixtures/, replays it through the REAL
 * detector stack (AudioEngine ← ClipAnalyser), and asserts the COARSE outcome the
 * detectors read matches the clip's label. A future change to any detector that
 * breaks a clip's real-audio read fails here — "tuned live, hope it sticks"
 * becomes "tuned once, locked by a test".
 *
 * WHAT IS LOCKED vs REPORTED. The hard lock is the coarse outcome
 * (silence/vowel/hiss/stop, the four things the game acts on) plus the «т» path
 * (кот fires a stop-burst and scores «Т»; no non-stop clip fires a false «т»).
 * WHICH vowel a bare-vowel clip reads as is *reported*, not asserted — coarse
 * formant identity is deliberately rough (issues #25/#27 sharpen it), and
 * surfacing that confusion offline is exactly what this harness is for.
 *
 * The committed clips are synthetic SEEDS today (no mic at authoring time); real
 * captures downloaded from the #22 «запись» control drop into the same folder and
 * this test scores them identically.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseClip,
  replayClip,
  clipVerdict,
  scoreClip,
  sweepAssist,
  LABEL_OUTCOME,
  LABEL_TARGET,
  type DetectionClip,
} from "../src/game/DetectionFixture";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixtures(): { name: string; clip: DetectionClip }[] {
  return readdirSync(FIX_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, clip: parseClip(readFileSync(join(FIX_DIR, f), "utf8")) }));
}

describe("detection fixtures — coarse outcome matches the label (hard lock)", () => {
  const fixtures = loadFixtures();

  it("has at least one committed clip per coarse class the issue calls out", () => {
    const labels = new Set(fixtures.map((f) => f.clip.label));
    for (const need of ["silence", "hiss", "kot"] as const) {
      expect(labels.has(need)).toBe(true);
    }
    expect([...labels].some((l) => l.startsWith("bare-"))).toBe(true);
  });

  for (const { name, clip } of fixtures) {
    it(`${name} (${clip.label}) reads as ${LABEL_OUTCOME[clip.label]}`, () => {
      const verdict = clipVerdict(replayClip(clip));
      expect(verdict.outcome).toBe(LABEL_OUTCOME[clip.label]);
    });
  }
});

describe("detection fixtures — the «т» path (hard lock)", () => {
  const fixtures = loadFixtures();

  it("кот fires a stop-burst and scores «Т» on the target-practice scorer", () => {
    const kot = fixtures.find((f) => f.clip.label === "kot");
    expect(kot).toBeTruthy();
    const { detected, result } = scoreClip(kot!.clip, "Т");
    expect(result.frames.some((fr) => fr.stopBurst)).toBe(true);
    expect(detected[0]).toBe("Т");
  });

  for (const { name, clip } of fixtures) {
    if (LABEL_OUTCOME[clip.label] === "stop") continue;
    it(`${name} fires no false «т»`, () => {
      const { frames } = replayClip(clip);
      expect(frames.some((f) => f.stopBurst)).toBe(false);
    });
  }
});

describe("detection fixtures — vowel identity (reported; path works)", () => {
  const fixtures = loadFixtures();
  const bare = fixtures.filter((f) => f.clip.label.startsWith("bare-"));

  it("every bare vowel closes a vowel attempt (never a false «Т», never empty)", () => {
    const rows: string[] = [];
    let exactHits = 0;
    for (const { clip } of bare) {
      const target = LABEL_TARGET[clip.label]!;
      const { detected } = scoreClip(clip, target);
      expect(detected.length).toBeGreaterThanOrEqual(1);
      expect(detected[0]).not.toBe("Т");
      if (detected[0] === target) exactHits++;
      rows.push(`${clip.label} → ${detected[0]}${detected[0] === target ? " ✓" : ""}`);
    }
    // eslint-disable-next-line no-console
    console.log("\n[#24 bare-vowel identity]\n" + rows.join("\n") + "\n");
    // The vowel-ID path demonstrably works end-to-end on at least one clean vowel.
    expect(exactHits).toBeGreaterThanOrEqual(1);
  });
});

describe("assist sweep over the fixtures (printed report)", () => {
  it("runs the sweep, finds a best assist, and prints the table", () => {
    const clips = loadFixtures().map((f) => f.clip);
    const assists = [0, 0.25, 0.5, 0.75, 1];
    const report = sweepAssist(clips, assists);

    const lines = report.rows.map(
      (r) =>
        `assist ${r.assist.toFixed(2)}  hits ${r.hits}/${r.scored} (${Math.round(
          r.rate * 100,
        )}%)  falseТ ${Math.round(r.falseStopRate * 100)}%`,
    );
    // eslint-disable-next-line no-console
    console.log(
      "\n[#24 assist sweep]\n" +
        lines.join("\n") +
        `\nbest = assist ${report.best!.assist.toFixed(2)}\n`,
    );

    expect(report.rows).toHaveLength(assists.length);
    expect(report.best).not.toBeNull();
    expect(report.best!.rate).toBeGreaterThan(0);
  });
});
