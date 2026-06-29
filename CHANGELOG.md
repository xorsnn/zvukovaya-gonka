# Changelog

All notable changes to Гонка звуков are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic
versioning.

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
