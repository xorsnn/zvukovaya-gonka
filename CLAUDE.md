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
