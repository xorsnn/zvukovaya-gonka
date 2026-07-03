# Гонка звуков — project conventions

Voice-driven speech-delay game. Read `README.md` for the full architecture; this
file records the conventions a change is most likely to trip over.

## The core rule (never break it)

**No ASR / word decoding / phoneme recognition, no ML.** The game reads cheap
acoustic *features* (loudness envelope + `vowelLikeness`, formants, a stop-burst
*shape*) — never *which word/phoneme* was said. Telling «т» from «к»/«п» (place of
articulation) is banned; the «т» trigger is the coarse **stop class**, not the
letter. There is **no fail state** and no scold — a child always recovers by
making the right sounds; difficulty lives only on the **строго ↔ легче** assist
slider. Any change that would gate on word identity is out of scope by design.

**The two-phase «Т» win (issue #18, default on).** On a `release.want === "stop"`
scene the vowel hold ARMS a checkpoint (the actor parks, `strictnessFor` → forward-
only) and from there **only a real «Т» finishes** — the run-out-of-breath *pause no
longer wins* (producing the stop is the therapeutic point). "No fail state" is
preserved by the slider, NOT by a pause-win: toward легче the required «Т» gets
looser (`burstOptsForAssist`) so a struggling child always has a gentler stop to
reach for. The pause-tolerant armed «Т» (`armedBurst`) must stay **guarded** against
a vowel *re-onset* (non-vowel-like only), and non-stop words (дом → «М») keep the
generous gap-catch untouched. Do not re-introduce a pause-win on a stop scene.

## Scenes and modes — the two axes of content (issue #16)

A `WordScene` (`src/game/types.ts`) is one unit of content. Two things can vary,
and they cost differently — know which you're doing before you start:

- **A new WORD on an existing `SceneType` is DATA-ONLY.** Add a `WordScene` object
  to `src/game/words.ts` (a `[sustainable vowel/sonorant] + [stop]` word, built
  with the `holdStop(...)` helper) and you're done — no new code. кот / дом / кит
  all reskin the one chase render path.
- **A new MODE (a new `SceneType`) needs CODE.** A mode is a different *picture*,
  so it needs a matching **render branch in `GameView.draw()`** (keyed on
  `scene.type`) plus a **picker entry**. The acoustic stack — `AcousticPattern`,
  `PatternMatcher`, `stepPlay` physics, the assist/strictness dial (`strictnessFor`:
  forward-only two-phase for a stop scene, the #12 tug-of-war otherwise), and the
  particle/meadow/`drawChar` helpers — is **reused verbatim across modes**; only
  the drawing branches. Modes built: `"chase"` (кот) and `"pull"` (вот); both are
  stop scenes, so both share the two-phase «Т» win identically.

When adding a mode:

1. Widen `SceneType` in `types.ts`. The two actor emoji (`chaser`/`fleer`) are
   **reused, role-by-`type`** (pursuer/fleer for a chase; puller/prize for a
   pull) — do NOT add mode-specific emoji fields; keep the model two-emoji-and-text.
2. Add the scene(s) to `words.ts`. Reuse an existing `pattern` if the acoustic
   word is the same (вот reuses кот's `holdStop("о","stop","Т")` verbatim — **zero
   new acoustic tuning**). Add it to `PICKABLE_SCENES` to surface it in the picker.
3. Add a `drawXxx(now)` branch in `GameView` next to `drawChase`/`drawPull`. Share
   the state machine (`play → pounce → celebrate`), `stepPlay`, and the shared
   helpers; put ONLY the geometry/animation in the branch. Any pure geometry helper
   (e.g. `carrotDepth`) goes at **module scope, exported**, so it is unit-testable
   without a canvas (the class needs a real `<canvas>`; module-level functions and
   `stepPlay` do not).

## Start-screen picker convention

The start screen offers one card per `PICKABLE_SCENES` entry (built in `main.ts`),
**default = the first entry** (chase / кот), so choosing nothing reproduces the
pre-picker flow byte-for-byte. Selecting a card sets the scene active
(`game.setScene`) before mic-check; `startRound()` rebuilds the round's matcher
from `game.getScene().pattern` via `buildSceneMatcher` (`src/game/round.ts`), so a
selection is all that's needed — the rest of the flow is scene-agnostic. Card
labels (Догонялки / Морковка) are a picker-only UI concern and live in `main.ts`,
not in the `WordScene` content model.

**URL reflection (#20).** The active pickable scene is mirrored to `?scene=<id>`
(a query param, since the build is served path-relative — `base: "./"` — so a path
route would 404 on GitHub Pages). The pure `resolveSceneParam` (`src/game/navigation.ts`)
maps a raw `?scene=` value to a pickable scene; `main.ts` preselects it on load and
writes it on card-select via `replaceState`. **The default is the ABSENCE of the
param** (a fresh visit is a clean URL), preserving the byte-for-byte pre-picker
identity above — so an unknown or non-pickable token (e.g. `dom`/`kit`) resolves to
the default AND is stripped from the URL. Only *pickable* scenes are linkable; a new
pickable scene is deep-linkable for free (no per-scene URL code).

## Detection-test screen (#22)

A dev/caregiver-only tuning surface reached **only** via `?test=1` or the ⚙ panel's
`[🎯 Тест звуков]` button — the matcher-independent way to *measure* detection
quality (per-vowel bars, gated letter, consonant class, «т» burst + a target-practice
hit-rate/confusion). Like the live chip (#13) it is **default-off and additive**, and
**read-only** — it shares no state with the matcher and its inline calibrate stores a
**screen-local** baseline (never `audio.setVowelBaseline()`). Pure segmentation +
verdict + tally logic lives in `src/game/SoundTest.ts` (unit-tested, DOM-free); the
screen/DOM wiring lives in `main.ts` (`renderSoundTest`, the sole new `loop()` call
site). It forces the spectral + formant passes on while active and restores
config-driven flags via `applyEngineFlags()` on leave. It **measures, never retunes** —
threshold changes are the #11/#12 follow-ups, done live with the child.

## Offline detection fixtures (#24)

Reproducible acoustic tuning: **capture** real frames on the #22 screen, **replay**
them offline through the exact pure stack, **lock** a good read as a test. The «запись»
control (test screen only) records raw per-frame buffers via
`audio.captureRawFrame()` and downloads a `DetectionClip` JSON — **local-only, with
consent, no upload**; the label is a COARSE content class (`kot`/`hiss`/`bare-a`/…) the
tuner already produced, **never a transcript** (still inside the core rule — it scores
the EXISTING detectors, trains nothing).

- **Replay through the real engine.** `src/game/DetectionFixture.ts` (pure, DOM-free)
  runs a clip through the real `AudioEngine` fed by a `ClipAnalyser` (a
  `SpectralAnalyserLike` that plays the buffers back), so every stateful path (noise
  floor, `level`, the fast «т» envelope) is reproduced **exactly, not re-implemented**.
  The scorer reuses the screen's own `LetterIndicator`/`BurstAccumulator`/`burstVerdict`
  — the offline verdict IS the on-screen verdict. Never hand-roll the per-frame envelope
  math in the harness; drive the engine.
- **Clip = data.** `tests/fixtures/*.json` is one clip per coarse class; drop a real
  capture in and `tests/detection-fixtures.test.ts` scores it. The committed seeds are
  **synthetic** (no mic at authoring time), regenerated by
  `scripts/gen-detection-fixtures.mjs` (`npm run gen-fixtures`, deterministic — LCG, no
  `Math.random`). A fixture regression asserts the **coarse outcome** (silence/vowel/
  hiss/stop) + the «т» path; vowel *identity* is **reported, not asserted** (coarse
  formants are rough — #25/#27).
- **Sweep the SHIPPED tunable.** `sweepAssist` grids the строго↔легче assist (already
  parameterised into the «т» bounds via `burstOptsForAssist`) — no detector signature
  changes. This issue delivers the ability to sweep; the actual retune rides #11 and the
  feature follow-ups, still done live with the child using this harness.

## Reactive dino toy (#30) — a no-goal screen, NOT a mode

A no-fail toy for a **pre-verbal** child: she makes any sound, and on her pause a 🦖
roars back (cause-and-effect + turn-taking, the pull into vocalizing at all). It reads
**only** `AudioFrame.level` — no word, no «Т», no matcher, no `stepPlay`/`strictnessFor` —
so it is the **cheapest** feature and squarely inside the core rule.

- **It is NOT a `SceneType` mode.** A mode (кот/вот) reuses `PatternMatcher` + `stepPlay` +
  `strictnessFor` with a new render branch; the dino uses none of that, so forcing it into
  the `WordScene`/matcher model would be wrong. It follows the **detection-test screen**
  shape instead: a standalone `Screen` value, its own `loop()` branch, and a **pure,
  DOM-free logic module**. When a future feature reads only the envelope with no word goal,
  copy THIS shape, not the mode shape.
- **Pure logic in `src/game/RoarToy.ts`** (`stepRoar`, unit-tested like `SoundTest.ts`): a
  voicing `≥ minVoiceMs` then a pause `≥ pauseMs` fires **exactly one** roar; pure silence
  and a sub-`minVoiceMs` blip never fire; `intensity` = the utterance's peak. The view
  (`RoarView.ts`, needs a canvas) only smooths + paints — keep decisions in the pure module.
- **Roar on the PAUSE, never live, + a lockout.** Echo cancellation is off, so any speaker
  audio feeds the mic — the roar must play only while she's silent, and input is ignored for
  the roar's whole length. The single source of truth for that length is `ROAR_TOTAL_MS`
  (exported from `sfx.ts`), wired into `RoarToyCfg.lockoutMs`; `playRoar`'s `intensity` only
  scales gain/body WITHIN that budget, never past it. Do not reintroduce a live roar.
- **Additive + assist-scaled, like everything else.** New `Screen`, new `loop()` branch, a
  hand-built 🦖 card (NOT a `WordScene`; not in `PICKABLE_SCENES`), `?dino=1` deep-link. The
  строго↔легче dial (`config.assist`) lowers the trigger toward легче — same "escape hatch
  is the slider" principle as #18; there is no fail state to design around. The `check`/`game`
  branches, matcher, and `stepPlay` stay untouched, so the all-rungs-off identity still holds.

## Testing

- `npm test` (vitest) runs in plain Node — **no jsdom, no mic**. Keep logic pure
  and testable: DSP in `PhoneticFeatures.ts`, the state machine in
  `PatternMatcher.ts`, `stepPlay`/`carrotDepth` exported from `GameView.ts`,
  matcher wiring in `round.ts`. Do NOT reach for the DOM/canvas in a test.
- Guardrails that MUST stay green: **AC#1/AC#5 identities** — the easy end
  (`stepPlay` at `strictness = 0`) and the kill-switch (`match = null`, all rungs
  off) reproduce the pre-#1 loudness path *byte-for-byte*; #18's two-phase change
  lives in the matcher's catch + `strictnessFor`, NOT in `stepPlay`'s math, so these
  stay untouched. The **stop-scene pause-never-wins** invariant (#18) is now itself a
  guardrail (`PatternMatcher`/integration): a satisfied hold + only silence must
  never catch on a `"stop"` scene.
- New rungs/modes ship **behind a flag or additively**. Note the exception #18 set:
  a rung's DEFAULT can flip on (`rung3: true`) once the behavior is the intended one
  — but the all-rungs-off kill-switch must still be a byte-for-byte rollback.

## Working cadence (hard rules for this repo)

- **Implement plans in a git worktree**, never the primary checkout; land each
  increment as its own PR from the worktree branch. A fresh worktree has no
  `node_modules` — run `npm ci` before building/testing.
- **Version + docs move together with the code**: bump `package.json` (semver),
  add a `CHANGELOG.md` entry, and update `README.md` in the same PR.
- **No AI/Claude attribution** in commit messages or PR descriptions — write them
  as the author would.
- Real-mic tuning of acoustic thresholds (#11/#12 tails) is done *with the child*,
  not blind; such constants are marked as placeholders in code and are not
  finalized by passing unit tests alone.
