# Changelog

All notable changes to Гонка звуков are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic
versioning.

## [0.11.0] - 2026-07-02

**Detection-test screen** (issue #22) — a dev/caregiver-only surface for tuning
the acoustic thresholds *with the child*, answering the question the game and the
cramped `?debug` overlay never did directly: **"When she says А, does the detector
read А? When she says the «т» in кот, does the burst fire — and how often?"** It
is a diagnostic tool: it **measures** detection quality and never touches
gameplay, the matcher, or the shipped config. Reached **only** via `?test=1` or
the ⚙ panel's **[🎯 Тест звуков]** button — same gating as «отладка».

Two coexisting parts:
- **Live readout** — per-vowel а/о/у/и bars (`classifyVowel`) + the smoothed,
  gated letter (a screen-local `LetterIndicator`); F1/F2; vowelLikeness / ZCR /
  centroid / lowBand bars; the coarse consonant class (`classifyConsonant` over a
  rolling `ReleaseFrame` ring); and a STOP-BURST flash with "last burst N мс назад".
- **Target practice** — pick а/о/у/и/Т; each valid voiced burst is auto-segmented
  into one attempt and scored by what the game/chip actually act on (the modal
  gated verdict across the sustained core for a vowel; a `stopBurst` in the
  [onset, release+250 ms] window for Т). Shows a live hit rate + a confusion
  breakdown; «—» (weak / ambiguous / below-gate) is a real outcome, not an error.

Fully **additive and default-off**: with neither `?test` nor the ⚙ button used,
the shipped game path's runtime behavior is unchanged — the AC#1/AC#5 identity
guardrails (kill-switch + `strictness = 0` loudness path) stay green.

### Added
- `src/game/SoundTest.ts` — pure, DOM-free (no `Date.now()`/`Math.random()`)
  scoring logic: a `BurstAccumulator` (segments the frame stream into one attempt
  per voiced burst + a validity filter that drops clicks / room noise),
  `burstVerdict(frames, target)` (the modal-gated-core rule for vowels / the
  burst-in-window rule for Т), and a `ScoreTally` reducer (hits + confusion).
- `tests/SoundTest.test.ts` — 17 unit + canned-sequence tests (verdict picks the
  sustained vowel / excludes the attack / ties → «—»; Т burst-in-window incl. the
  post-release tail; validity filter; tally + reset; two end-to-end streams).

### Changed
- `src/main.ts` — widened `Screen` with `"test"`; added the screen markup, nav
  (`?test=1` deep-link that requests the mic if needed → routes to test on grant /
  the shared denied screen on refusal; the ⚙ button; «← назад»), the transient
  engine-flag force on enter + `applyEngineFlags()` restore on leave, the
  screen-local detectors (`LetterIndicator` / `ReleaseFrame` ring / `testBaseline`
  / accumulator / tally), and `renderSoundTest` (the only new `loop()` call site,
  so play's hot path is untouched). The inline «Подержи ААА» calibrate stores into
  the **screen-local** baseline only — `audio.getVowelBaseline()` is never touched,
  so the game's session baseline is preserved.
- `src/style.css` — an adult/neutral dark test panel (bars, big glyph, monospace
  readout, target/score controls) — deliberately not a reward surface.

### Notes
- The screen **measures**; it does not retune. Changing any detector threshold is
  the #11/#12 follow-up, done *with* this screen on a real mic with the child — the
  acoustic constants remain placeholders, not finalized by unit tests alone.
- Out of scope by design: per-consonant identity (banned ASR), frame export to
  JSON, and persisting the baseline / tally across reloads (session-only).

## [0.10.0] - 2026-07-02

**URL navigation for the two experiences** (issue #20). The active mode is now
mirrored in the address bar as `?scene=<id>` (🐱 Догонялки → `?scene=kot`,
🐰 Морковка → `?scene=vot`), so an experience is **linkable and reload-stable**:
share `…/?scene=vot` and it opens straight into Морковка; reload mid-session and
you keep the mode you picked. The default (chase / кот) stays a **clean URL** —
a fresh visit writes nothing — so choosing nothing reproduces the pre-navigation
flow byte-for-byte. Query param, not a path, because the build is served
path-relative (`base: "./"`) from GitHub Pages / any subfolder / `file://`.

### Added
- `src/game/navigation.ts` — pure `resolveSceneParam(raw, pickable, defaultId)`
  (DOM-free, unit-tested): resolves `?scene=` case-insensitively to a pickable
  scene, dropping any unknown or non-pickable token back to the default. `dom`/`kit`
  exist in `WORDS` but are not pickable, so they are not linkable.
- `tests/navigation.test.ts` — 8 unit tests for the resolver (absent, empty,
  valid id, case-insensitive, unknown, non-pickable word, always-pickable id).

### Changed
- `src/main.ts` — on load, `?scene=` preselects the matching picker card (unknown
  token → default кот, and the bad token is stripped via `replaceState`, no
  reload); tapping a card mirrors the pick to `?scene=<id>`. Existing `?debug` and
  any `#hash` are preserved (`?debug=1&scene=vot`). No `scene` param = the v0.9.0
  behavior exactly.

### Notes
- Back-button (`pushState`) history navigation between experiences is intentionally
  out of scope here (this ships `replaceState` only); it can be a later increment.

## [0.9.0] - 2026-07-01

The **two-phase «Т» win** (issue #18), the intended core experience, now shipped
**on by default** and identical across both modes (🐱 Догонялки / кот and
🐰 Морковка / вот). The child sustains the vowel → the actor advances to an
"almost there" checkpoint and **freezes** → a pause there is neutral → **only a
real «Т» finishes it**. The pause no longer wins — producing the final stop is the
therapeutic point, and now the game requires it. The строго↔легче slider is one
dial over both phases: toward легче a shorter vowel arms **and** a gentler «Т» is
accepted; toward строго a longer/cleaner vowel **and** a crisper «Т». That looser
«Т» is the new escape hatch that replaces the retired pause-win, so a struggling
child always has a gentler path — there is still no fail state.

### Changed
- `src/game/config.ts` — `DEFAULT_CONFIG.rung3` now **`true`** (was `false`): the
  «Т» detector, and with it the two-phase win, ships on. The all-rungs-off
  kill-switch (`anyRungOn === false` → `match === null`) stays **byte-for-byte** the
  pre-#1 loudness engine, so the rollback is unchanged. Flip `rung3` back to `false`
  to return to the loudness/gap-catch default (the mechanic goes inert).
- `src/game/PatternMatcher.ts` — on a Rung-3 `"stop"` scene the run-out-of-breath
  **gap catch is dropped entirely** (a pause never completes the round); the catch
  is now `holdSatisfied && armedBurst`. `BURST_REQUIRED_ASSIST` (the #12 assist
  threshold that withdrew the gap) is **retired**. Non-stop words (дом → «М») and
  the rung3-off path keep the breath-stop gap **unchanged**.
- `src/game/GameView.ts` — a `"stop"` scene's approach is now **forward-only** (new
  pure exported `strictnessFor(scene, assist)` returns `0` there, else `1 - assist`):
  the actor advances and parks at the checkpoint instead of the #12 mouse-flee, so
  it never drifts backward. `stepPlay`'s math is unchanged (AC#5 intact — it just
  receives a strictness of `0`).
- `src/audio/AudioEngine.ts` — `setAssist(assist)` feeds `burstOptsForAssist` into
  `detectStopBurst`, so the «Т» detector's sensitivity tracks the строго↔легче
  slider (cached per change, no per-frame allocation).

### Added
- `src/game/PatternMatcher.ts` — the **pause-tolerant armed «Т»**: once armed, a
  `sawSilenceSinceArm` flag lets a fresh transient after an arbitrarily long pause
  finish the round (the arming vowel is gone from the engine's fast-env window by
  then). Exported pure `armedBurst(frame, sawSilenceSinceArm)` predicate, **guarded**
  so a vowel **re-onset** never false-fires (must be non-vowel-like: high ZCR or low
  `vowelLikeness`). New `MatchState.armedForBurst`, a `requiresBurst` getter, and a
  `forceHoldSatisfied()` debug latch.
- `src/audio/PhoneticFeatures.ts` — pure exported `burstOptsForAssist(assist)`,
  monotonic toward легче on every knob (`loudRatio`↓, `dipFraction`↑, `riseFraction`↓,
  `minClosureMs`↓, `maxClosureMs`↑) — the genuine easier «Т» path.
- `src/game/GameView.ts` — a shared **"now say Т" checkpoint cue** (a gentle pulsing
  badge over the goal) shown only while parked waiting for the «Т», plus a
  `debugArmCheckpoint()` jump and an `armedForBurst` getter for the host.
- `src/main.ts` — `audio.setAssist` wired on init + slider input; a **`k` debug jump**
  (game screen + debug only) that latches the checkpoint so the next «Т» wins; an
  `⚑ARMED waiting-«Т»` line in the `?debug` overlay; and a stronger **checkpoint cue**
  on the «Т» chip (`.burst.checkpoint`).
- Tests: pause-never-wins (strict / default / easy), armed «Т» after ≥3 s silence,
  no false-fire on a vowel re-onset, «Т»-before-arm no-op, the `armedBurst` predicate,
  `burstOptsForAssist` monotonicity, and `strictnessFor` forward-only — 130 → 149.
  The AC#5 kill-switch identity, the дом gap-catch, and the #12 `stepPlay` math stay
  green untouched.

### Notes
- The «Т» thresholds and the assist→bounds mapping are **placeholders**, to be tuned
  on a real microphone **with the child** (folds into #11) — the unit tests only fix
  their shape (monotonicity, the guards), not the final feel. Use the `k` jump under
  `?debug` to drill the armed «Т» against real pauses without re-doing the vowel.

## [0.8.0] - 2026-07-01

Second play **mode** + the first scene **picker** (issue #16). The game is now
multi-mode: alongside the кот **chase**, a «Морковка» **pull** — a rabbit hauls a
carrot out of the ground and it pops free on «…Т» (= «вот!», there it is). The
start screen grows a two-card picker (🐱 Догонялки / 🐰 Морковка), default chase.
The hard part is fully reused: **zero new acoustic tuning** — вот carries кот's
exact `holdStop("о","stop","Т")`, and the pull shares the tug-of-war physics,
matcher, strictness slider, and celebration particles. Only the *picture* is new.

### Added
- `src/game/types.ts` — `SceneType` widens to `"chase" | "pull"`. `chaser`/`fleer`
  are documented as role-by-`type` (pursuer/fleer for a chase, puller/prize for a
  pull), so the content model stays two-emoji-and-text for every mode.
- `src/game/words.ts` — the `vot` **pull** scene (🐰 pulls 🥕), reusing
  `holdStop("о","stop","Т")` verbatim; and `PICKABLE_SCENES` — the two modes the
  start-screen picker surfaces, default (chase) first. дом/кит stay unsurfaced.
- `src/game/GameView.ts` — a `scene.type`-keyed render branch: `drawChase`
  (unchanged) and a new `drawPull` (soil mound, carrot-emergence geometry, rabbit
  grip → the «т» POP → the rabbit hugging the freed carrot), plus `carrotDepth` —
  a pure, strictly-monotonic emergence curve exported for unit testing. The state
  machine, `stepPlay` physics, particles, meadow, and `drawChar` are shared.
- `src/game/round.ts` — `buildSceneMatcher(scene, config, opts)`: the one pure
  decision "a round's matcher is built from the ACTIVE scene's pattern", shared by
  `main.ts` and the picker test (verifiable without a canvas).
- `src/main.ts` / `src/style.css` — the start-screen scene picker (two selectable
  cards); the chosen scene is set active before mic-check.
- `tests/scenes.test.ts` — the pull scene is well-formed and reuses кот's pattern,
  the picker rebuilds the matcher on the selected scene's pattern (and both modes
  yield equivalent matchers), and `carrotDepth` is monotonic + bounded. 121 → 130.

### Changed
- The opening flow grows a **picker step** — the first time the game is
  multi-mode. Choosing the default (chase) reproduces the pre-#16 flow; the
  acoustic layer and all 121 prior tests are untouched.

## [0.7.0] - 2026-07-01

Live vowel indicator (issue #13) — a **read-only** caregiver chip that shows
which of the four vowels («А»/«О»/«У»/«И», or «—») the held sound is most like
right now, plus a thin confidence bar. It gives the adult live, grounded
encouragement ("yes — that was an «О»!") and lets the dev validate the formant
detector on a real mic without the green `?debug` overlay. It is orthogonal to
grading — a pure display that never changes how the chase drives, holds, or
catches (so it is independent of #12's tug-of-war). Ships behind
`config.showLetter`, **off by default**; with it off the default build behaves
exactly as 0.6.0.

### Added
- **`classifyVowel` (PhoneticFeatures.ts)** — the all-vowel argmax companion to
  `vowelMatch`: scores an (F1, F2) against а/о/у/и at once in the child's own
  calibrated formant space and returns the winner + per-vowel scores. Same
  NaN-safe neutral guard as `vowelMatch`, but returns all-zero scores (not a
  meaningless 4-way `1`-tie) when there's no usable baseline/estimate. Still not
  recognition — no classifier, no gate.
- **`LetterIndicator` (src/game/LetterIndicator.ts)** — a small, deterministic,
  unit-tested smoother + display gate: per-vowel EMA (120 ms half-life) over the
  raw argmax, plus a level/voiced input gate and a score-floor + runner-up-margin
  display gate, so the chip settles in ~8 frames and a single stray frame can't
  flip the glyph. Holds no audio state beyond the four EMA scores; feeds nothing
  back into grading (the read-only invariant).
- **`showLetter` config flag + «показывать букву» ⚙ toggle** — persisted to
  `localStorage` like the other settings, default off. Turning it on widens the
  engine's spectral + formant passes (`setPhoneticEnabled`/`setRung2Enabled` are
  now driven by `anyRungOn(config) || config.showLetter` and `config.rung2 ||
  config.showLetter`) so the chip works even with every rung off. The mic-check
  vowel-baseline calibration is likewise run when the chip is on, so it has a
  per-child anchor to classify against.
- **The chip UI** — a fixed top-right pill rendered on the mic-check and game
  screens only, created lazily so it costs nothing when off. Deliberately adult,
  not a reward: a neutral gray glyph on a translucent dark pill, no animation /
  bounce / color-pop, so it never competes with the chase for the child.

### Tests
- `classifyVowel`: per-vowel argmax at each her-scaled centre, `scores[v] ===
  vowelMatch`, and the neutral guards (no baseline / half baseline / zero / NaN
  estimate). `LetterIndicator`: convergence, single-frame anti-flicker, and every
  gate branch (level, voiced, score floor, margin, no baseline). `config`:
  `showLetter` default/persist/coerce. Integration: the widened formant pass emits
  F1/F2 with rungs off, the chip settles on «О» from canned frames through the
  real engine, and — the read-only invariant — running the indicator alongside a
  rung-1 matcher leaves its `driveQuality`/`holdSatisfied`/`caught` stream
  element-for-element unchanged.

### Not yet done (deferred to real-mic tuning)
- The chip's thresholds (`HALF_LIFE_MS`, `SCORE_MIN`, `MARGIN_MIN`, `LEVEL_GATE`)
  are set from synthetic-signal reasoning; the manual E2E (hold «о»→«О», «и»→«И»,
  noise→«—»; no flicker; works with rungs off) still needs a real microphone.

## [0.6.0] - 2026-07-01

Tug-of-war chase (issue #12): the **vowel runs the cat, the «т» triggers the
pounce**, with difficulty on the single **строго ↔ легче** (assist) slider. This
supersedes the inert Rung-3 burst-catch (#11) with a real fast «т» detector and
turns the chase into a two-body race — while keeping the easy end byte-for-byte
today's leniency. Still **no ASR / word decoding** — the «т» trigger is the
*coarse stop class*, never the phoneme. The «т» stop-burst thresholds and the
default assist are placeholders pending the real-mic tuning pass with the child.

### Added
- `src/audio/PhoneticFeatures.ts` — `detectStopBurst(env, noiseFloor, dtMs)`: a
  pure detector for the «т» **closure→burst** shape over a fast-envelope window
  (a brief near-silent dip released by a transient). Cannot tell «т» from «к»/«п»
  (place of articulation, out of scope) — it only answers "did a stop release
  happen?". Unit-tested on canned envelopes (AC#4).
- `src/audio/AudioEngine.ts` — a **second, much faster envelope** over the raw RMS
  (fast attack + fast release, `FAST_ENV_*`), independent of the 120 ms-smoothed
  `voiced` path, feeding `detectStopBurst` → a new `stopBurst` field on
  `AudioFrame`. Behind the any-rung guard; `false` when the phonetic layer is off.
- `src/game/GameView.ts` — `MOUSE_FLEE_RATE` + a `strictness` argument to
  `stepPlay`: net progress is now `catDrive − mouseFlee`, allowed to decay to 0.
- `src/game/PatternMatcher.ts` — `BURST_REQUIRED_ASSIST` and
  `VOWEL_MATCH_FLOOR_STRICT`; the catch keys off `frame.stopBurst`.
- `src/game/types.ts` / `words.ts` — `release.letter` (the taught target
  consonant; кот/кит → «Т»).
- `?debug` overlay now shows `stopBurst`, the live net cat-vs-flee drive, and the
  target letter, for the real-mic tuning pass.

### Changed
- **Leniency is now ASSIST-SCALED, not absolute.** At the easy end (`assist = 1`)
  the mouse never flees and progress is monotonic — byte-for-byte today's feel
  (AC#1); a breath-stop still finishes the catch. Toward the strict end the mouse
  flees (`strictness · MOUSE_FLEE_RATE`), so a *right* vowel makes the cat gain
  while a *wrong* vowel or silence lets the mouse escape back to the start (AC#2),
  and the catch fires **only** on a real «т» burst — running out of breath no
  longer wins (AC#3). The escape hatch is the slider itself; there is still **no
  fail screen and no scold** — a child always recovers by making the right sounds.
  The default assist (0.5) stays lenient (gap finale intact).
- The Rung-2 wrong-vowel drive floor is assist-scaled (`VOWEL_MATCH_FLOOR` at
  easy → `VOWEL_MATCH_FLOOR_STRICT` at strict) so a clearly-wrong vowel can
  net-negative against the flee. The cat's *forward* drive stays positive; the
  regression comes from the flee, not a zeroed drive.
- `stepPlay` is a blend between an EASY trajectory (today's monotonic drive +
  hold-surge) and a STRICT trajectory (the tug-of-war), exact at both endpoints,
  so AC#1 (easy = byte-for-byte) and AC#5 (`match=null` kill-switch identity) both
  still hold to the float.

### Removed
- The inert `voiced`-flag burst-catch: `RUNG3_MIN_CLOSURE_MS` and the
  `sawClosure`/`onset`-based path in `PatternMatcher`. It keyed off the engine's
  smoothed `voiced` flag (~387 ms to drop) and never fired on a natural 50–150 ms
  «т» closure (#11); `detectStopBurst` replaces it. `classifyConsonant` and its
  debug label are unchanged.

### Notes / deferred
- **Real-mic tuning is the linchpin (#11/#12, AC#6):** the `STOP_BURST_*`
  thresholds, `MOUSE_FLEE_RATE`, `BURST_REQUIRED_ASSIST`, and the default assist
  were set to make the mechanic demonstrable in tests — they must be validated and
  retuned on a real microphone with the child via `?debug=1`.
- Out of scope (the planned follow-up): distinguishing «т» from «к»/«п»
  acoustically; the «дом» («м») case; replace-vs-new-mode rollout.

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
