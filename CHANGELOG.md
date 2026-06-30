# Changelog

All notable changes to Гонка звуков are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic
versioning.

## [0.5.1] - 2026-07-01

Post-merge review follow-up for Rung 3 (issue #6). No behavior change: the review
confirmed leniency, parity, and round-isolation all hold, with no production
bugs. This release closes the review's test gaps, removes dead code, and corrects
the docs to be honest about a known limitation of the «т» burst-catch.

### Fixed (tests & docs)
- **Honest docs on the «т» burst-catch.** The burst path keys off the engine's
  smoothed `voiced` flag, which takes ~387 ms of silence to drop (120 ms release
  time-constant); a natural «т» closure is 50–150 ms, so it never arms and the
  catch falls back to the final-silence gap (= Rung 1). The feature is therefore
  inert on real speech today — a faster closure detector + real-mic validation is
  deferred to the Rung-3 mic-tuning phase. README, CHANGELOG, and a
  `RUNG3_MIN_CLOSURE_MS` code note now say so instead of overclaiming.
- **Vacuous classifier test.** The "burst → reset → silence" test used a
  first-closure length equal to `CONSONANT_GAP_FRAMES`, so it returned `"stop"`
  before reaching the burst and never exercised the gap-reset branch it claimed
  to cover. Shortened the first closure below the threshold so the reset path runs.
- **New regression coverage:** rung3-on + non-stop scene adds no burst-catch (the
  `want === "stop"` guard); the burst "no-fire" path (closure < `RUNG3_MIN_CLOSURE_MS`);
  the `RUNG3_MIN_CLOSURE_MS` and fricative-`0.5` boundaries; the burst-catch is
  edge-triggered exactly once; and `reset()` clears the Rung-3 window + arm state
  between rounds (previously `reset()` had zero coverage).

### Removed
- The unused `opts` (`gapFrames`/`minVoicedFrames`) override on
  `classifyConsonant` — dead API, no caller passed it. The classifier reads its
  `CONSONANT_*` constants directly. Add it back with a test if a real need appears.

### Changed (docs only)
- Refreshed the stale `PatternMatcher` header JSDoc (the `caught` bullet now
  notes the additive Rung-3 burst path; the class scope widened to Rungs 0–3),
  reworded the classifier's "a majority" to "at least half" to match the `>= 0.5`
  knee, and noted the `classifyConsonant` terminal-silence labelling limitation
  (a held-then-released sonorant ends in silence and reads as "stop"; the label
  is debug-only and gates nothing).

## [0.5.0] - 2026-06-30

Rung 3 of the phonetic ladder — coarse consonant class & the real «т» stop
(issue #6). The chase can now tell the *release shape* apart: a **stop** («т»: a
sustained hold → a near-silence closure, optionally a burst), a **sonorant**
hum («р»/«м»: continuous low-ZCR voicing, no gap), and a **fricative** hiss
(«ш»/«с»: high-ZCR throughout, already low `vowelLikeness` in Rung 1). For a
«т»-final scene it adds an earlier, crisper burst-catch on the «т» release.
**Additive and lenient**: ships behind `config.rung3`, **off by default** until
tuned on the real mic; with it off, behavior is byte-identical to Rung 1/2. Even
with it on it only *labels* and *adds* a catch path — a genuine vowel hold + a
stop always catches, so simply running out of breath (no crisp burst) still wins,
and a lone «т» or a continuous «р» hum is never enough on its own.

### Added
- `src/audio/PhoneticFeatures.ts` — `classifyConsonant(frames)`: a pure,
  unit-tested classifier over a recent release window (`ReleaseFrame` =
  `voiced` + `zcr`) that labels the shape **stop / sonorant / fricative / none**
  by run-length analysis — no new heavy DSP. Plus the `ConsonantClass` type and
  the `CONSONANT_*` tuning constants.
- `AcousticPattern.release.want?: "stop" | "any"` — a scene's final action;
  «кот»/«кит» ask for a `"stop"`, the default `"any"` keeps today's
  any-gap finale. Tagged in `words.ts`.
- `PatternMatcher` `rung3` option: a small rolling release window driving a live
  `MatchState.consonantClass` label, and — for a `"stop"` scene — an **additive
  burst-catch** (`MatchState.burstDetected`): once a real closure
  (`RUNG3_MIN_CLOSURE_MS`) has followed the satisfied hold, a fresh onset
  completes the «т» stop a touch earlier than the plain gap. The gap-only catch,
  the hold, and the drive are all untouched (leniency).
- The `?debug` overlay shows the live consonant class + a `BURST✓` flag when
  rung3 is on; the matcher is wired to `config.rung3` in `main.ts`.
- Tests: `classifyConsonant` on canned envelopes (stop / sonorant / fricative /
  none, all separable), a lone-«т» regression (never arms the hold), Rung-3
  parity (off → no label, no early catch), and real-engine «ко-о-о(-т)»
  scenarios (gap-only and hold→closure→burst both catch; a continuous hum holds
  but never catches). Suite grows 65 → 83.

### Unchanged (leniency invariants)
- `config.rung3` off → exact Rung-1/2 behavior (catch on any near-silence gap).
- Rung 3 never blocks the catch on a real hold + stop; the burst is a bonus.
- No negative feedback for a "wrong" consonant; only the cat's speed / the pounce.
- `assist → 1` relaxes the stop gap back toward "any gap counts" (via `effGapMs`).

## [0.4.0] - 2026-06-30

Rung 2 of the phonetic ladder — coarse vowel identity (issue #5). The cat can
now tell *which* vowel is being held (а / о / у / и) and grade its speed toward
the scene's target nucleus («кот» → «о»), instead of treating every sustained
vowel alike (Rung 1). It is **graded, never gated**: a "wrong" or uncertain
vowel still drives the cat clearly and still catches — it just runs a little
slower than the right one. Ships behind `config.rung2`, **off by default** until
tuned on the real mic; with it off, behavior is byte-identical to Rung 1.

### Added
- `src/audio/PhoneticFeatures.ts` — `estimateFormants(mag, sampleRate)`: a
  robust coarse F1/F2 estimate by spectral-envelope peak-picking (silence →
  0/0). `vowelMatch(formants, target, baseline)`: a gentle 0..1 closeness to the
  target vowel, scored in the **child's own formant space** (the canonical vowel
  map is anchored to her calibration vowel and used by ratio, so a 3-yr-old's
  high/variable formants and even a "wrong" calibration vowel still preserve the
  а-vs-о ordering). Plus a `Vowel` type and the `VOWEL_FORMANTS` reference map.
- `AcousticPattern.vowel` — an optional target nucleus per scene (кот → «о»,
  кит → «и», дом → «о»).
- A bounded, assist-scaled **vowel-match factor** folded into `PatternMatcher`'s
  `driveQuality` (`VOWEL_MATCH_FLOOR` keeps the worst case well above the
  GameView `MIN_FLOOR`); `MatchState.vowelMatch` for the overlay + tests.
- F1/F2 on `AudioFrame`, computed only when rung2 is enabled and reusing a
  shared envelope buffer, so the default config (rung2 off) and the per-frame
  audio loop allocate nothing for a disabled feature; per-child F1/F2 captured
  during the mic-check and shown live in the `?debug` overlay (target + match bar).
- Robustness: `vowelMatch` treats a NaN/zero formant or a half-baseline as "no
  opinion" (neutral 1), so a degenerate estimate can never poison `driveQuality`.
- Tests: `estimateFormants` / `vowelMatch` on synthetic vowel spectra (а/о/и
  separable, speaker-relative), the four Rung-2 leniency invariants in
  `PatternMatcher` (off → parity, never-gates, graded floor, assist→irrelevant),
  and a real-engine `«о»` vs `«а»` integration drive. Suite grows 42 → 59.

### Changed
- `AudioEngine` exposes `getVowelBaseline()` and a `VowelBaseline` extended with
  optional `f1`/`f2`; `main.ts` samples her formants on the mic-check and passes
  `rung2` + the baseline into each round's matcher (live on a settings toggle).
- README core-rule + ladder sections: Rung 2 is built (still no decode/gate).

## [0.3.0] - 2026-06-30

Phonetic feature config — the foundation for Increment 2 (issue #4). The
scattered Increment-1 switches (the `USE_PHONETIC` kill-switch, the ad-hoc assist
slider state) are unified into one persisted `PhoneticConfig`, and a caregiver
settings panel drives it live. Higher rungs (#5/#6) now have an on/off switch to
hang their behavior off; both default off until tuned. No behavior change with
the default config — Rung 1 stays on and plays exactly as it shipped.

### Added
- `src/game/config.ts` — `PhoneticConfig` (per-rung `rung1`/`rung2`/`rung3`
  flags, the `assist` continuum, a `debug` flag) as the single source of truth,
  with `DEFAULT_CONFIG`, `anyRungOn()`, and a defensive `localStorage` store
  (`loadConfig`/`saveConfig`). The store never throws: a missing key, corrupt or
  partial JSON, an out-of-range value, private-mode, or a throwing/quota-full
  storage all degrade to defaults.
- A caregiver **settings panel** behind the ⚙ gear on the game screen: a toggle
  per rung (**гласные/шум**, **какая гласная**, **согласные/Т**), the existing
  **строго ↔ легче** slider, an **отладка** (debug overlay) toggle, and the mic
  **🎤 микрофон** recalibration. Hidden by default so a child can't trip it;
  every change persists and applies live, mid-session.
- Tests: a `config` store suite (round-trip, corrupt/partial/clamped/null/
  throwing storage, `anyRungOn` truth table), an all-rungs-off → loudness-only
  trajectory identity (AC#2), and a `PatternMatcher` Rung-1-gating case (AC#3).
  Suite grows from 27 to 42 tests.

### Changed
- `AudioEngine` — the `USE_PHONETIC` const is replaced by a config-driven
  `setPhoneticEnabled(anyRungOn(config))`; `sample()` runs the spectral layer iff
  any rung is enabled. Defaults on, so a directly-constructed engine is unchanged.
- `PatternMatcher` — takes an optional `rung1` flag (default on). With Rung 1 off
  the hold gate is loudness-only (Rung 0); rungs 2/3 layer additively on top.
- `main.ts` reads the config at startup and the engine, matcher, debug overlay,
  and calibration all consult it; the debug overlay is now toggleable live
  (`?debug` **or** the panel toggle) instead of URL-only.

### Removed
- The exported `USE_PHONETIC` constant (generalized to "is any rung on?").

## [0.2.0] - 2026-06-29

Phonetic discrimination ladder — Increment 1 (issue #1). The cat now grades how
vowel-like a sound is instead of running on raw loudness, which closes the two
cheats a toddler found (a continuous scream, and a single shout-and-stop) while
keeping the no-recognition promise and every leniency invariant.

### Added
- `src/audio/PhoneticFeatures.ts` — pure, unit-tested DSP: zero-crossing rate,
  spectral flatness / centroid / low-band ratio, and a `vowelLikeness` blend
  weighted toward the pitch-robust features so a 3-yr-old's high formants are not
  misread as noise; centroid is scored relative to a per-child baseline.
- `src/game/PatternMatcher.ts` — the hold → gap → stop shape state machine:
  grades chase speed, arms the pounce only after a sustained vowel-like hold
  (150 ms dropout grace), and fires the catch on a genuine stop. Two thresholds
  (a lenient "counts as trying" gate plus the graded speed) and an `assist`
  continuum keep it forgiving.
- `AcousticPattern` on `WordScene`; a Rung-1 pattern on кот/дом/кит.
- A **строго ↔ легче** (strict ↔ easy) caregiver slider that relaxes the
  phonetic grading for a noisy room, and a vowel-baseline calibration sampled on
  the mic-check screen.
- `vitest` (first test dependency) and a 27-test suite: pure DSP, the state
  machine, an AudioEngine→matcher integration via an injected analyser, plus
  guards for the graded-drive and kill-switch-identity acceptance criteria
  (`npm test`).

### Changed
- `AudioEngine` now reads the FFT spectrum and exposes the spectral features on
  `AudioFrame`, all behind a `USE_PHONETIC` kill-switch; it accepts an injectable
  analyser so the engine is testable without a microphone.
- `GameView` chase speed is `MIN_FLOOR + (1 − MIN_FLOOR)·driveQuality`, and the
  catch is gated on the matcher (a real hold + stop). Once the hold is satisfied
  the cat closes the final gap, so the pounce is reliable even from low chase
  progress. With the kill-switch off, the loudness-only path is preserved exactly.
- README core-rule section rewritten: no word/phoneme recognition or ML, but
  phonetic-feature classification is now in scope; leniency stays mandatory.

### Notes
- Fully additive and offline. `USE_PHONETIC = false` reverts to the shipped
  loudness-only engine; no schema, state, or persistence touched.

[0.2.0]: https://github.com/xorsnn/zvukovaya-gonka/releases/tag/v0.2.0
