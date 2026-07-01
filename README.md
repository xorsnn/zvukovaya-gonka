# Гонка звуков 🐱

A voice-driven game that helps kids with speech delay start vocalizing. The
child is shown a word as a little scene (e.g. **кот** — a cat and a mouse). While
the child makes sound, the cat chases the mouse; a final burst makes the cat
pounce and a happy celebration plays. The child's own voice drives the fun.

UI and content are in Russian.

## The core rule: no word recognition, but phonetic-feature sensing

There is still **no ASR / word matching / phoneme *decoding*** anywhere, and no
ML. We never *decode or gate on* which word was said — that is unreliable for
young kids, especially kids with speech delay, and turns the game into a
punishment machine.

What we *do* read, on top of the loudness envelope, is a handful of cheap
**acoustic features** (spectral flatness, centroid, low-band ratio,
zero-crossing rate) blended into one 0..1 `vowelLikeness`. That lets the cat
tell a sustained «о-о-о» from a flat shriek **without** asking which sound it
was. This is the first rung of a *phonetic discrimination ladder*
(issue #1): the MVP drove purely off RMS loudness, so any noise won — a toddler
found the exploit (scream, or shout-and-stop). The feature layer closes that
while keeping the no-recognition promise.

**Rung 2 (#5)** adds a *coarse* vowel-identity nudge: a robust F1/F2 formant
estimate scores how close the held sound sits to the scene's target vowel
(«кот» → «о»), **relative to the child's own calibrated vowel space**. This is
still not recognition — there is no classifier and no gate. It only *grades
chase speed toward the target*: a "wrong" vowel is gently slowed (never below a
bounded floor) but still chases clearly and still catches, so the closer-to-
target vowel is the faster one. It ships behind `config.rung2`,
**off by default** until tuned on the real mic; with it off, behavior is exactly
Rung 1.

**Rung 3 (#6/#12)** tells the *release shape* apart — a **stop** («т»: a sustained
hold → a near-silence closure → a burst), a **sonorant** hum («р»/«м»: continuous
low-ZCR voicing, no gap), and a **fricative** hiss («ш»/«с»). A pure
`classifyConsonant` *labels* the recent window (debug/teaching), and a real fast
**«т» stop-burst detector** (`detectStopBurst`, #12) reads a brief energy
**dip (closure) → transient burst** off a dedicated fast envelope — independent of
the 120 ms-smoothed `voiced` path, so a natural 50–150 ms «т» closure actually
fires (the original burst-catch keyed off `voiced`, which needs ~387 ms of silence
to drop, and was inert on real speech; #12 replaces it). The detector is still not
recognition — it reads the envelope *shape*, never the phoneme, and can't tell «т»
from «к»/«п» (place of articulation). It ships behind `config.rung3`, **off by
default**; with it off behavior is exactly Rung 1/2.

**The chase is now a tug-of-war (#12).** The vowel runs the cat; the final «т»
triggers the pounce. Net progress is `catDrive − mouseFlee`, with the mouse's
flee speed scaled by the one **строго ↔ легче** (strict ↔ easy) slider, so the same
build serves a child who just needs to vocalize and one ready to drill the «т»:

- At the **easy** end the mouse never flees (progress is monotonic, exactly as
  before) and simply running out of breath still finishes the catch.
- At the **strict** end the right vowel makes the cat gain while a wrong vowel or
  silence lets the mouse escape back toward the start, and the catch fires **only**
  on a real «т» burst — running out of breath no longer wins. The escape hatch is
  the slider itself, not a fail screen.

**Live vowel indicator (#13)** — a **read-only** caregiver chip (top-right) that
shows which of the four vowels («А»/«О»/«У»/«И», or «—») the held sound is most
like right now, plus a thin confidence bar. It reuses the Rung-2 formant layer:
`classifyVowel` scores the frame against *all four* vowels at once (the argmax
companion to `vowelMatch`), and a small `LetterIndicator` EMA-smooths + gates the
result so it never flickers or shows a confidently-wrong glyph. It is orthogonal
to grading — a pure display that **never** changes how the chase drives, holds,
or catches — so it works with any rungs on or off. It ships behind
`config.showLetter`, **off by default**; when on it widens the engine's formant
pass so the chip works even standalone.

Everything is driven from the Web Audio API `AnalyserNode`
(`getFloatTimeDomainData` → RMS + ZCR; `getFloatFrequencyData` → the spectral
features):

- **Any** voiced sound above the noise floor still makes the cat run; a clearer,
  steadier vowel just makes it run **faster** (graded by `vowelLikeness`, never
  punished). This rewards _vocalizing at all_ — the therapeutic goal — while
  nudging toward the target sound. Toward the strict end the mouse also flees, so
  the *right* vowel is what keeps the cat gaining (the tug-of-war, #12).
- The **pounce** arms only after a real sustained vowel-like **hold**, and the
  catch needs a genuine **stop** — a near-silence gap (the lenient
  run-out-of-breath finale) or, toward strict, the real **«т» burst** — which a
  continuous scream never produces and a single short shout never reaches.

### Leniency is mandatory (the whole reason ASR was banned)

These are invariants, not nice-to-haves. As of #12 leniency is **assist-scaled**,
not absolute: lenient at the easy end (the default-safe behavior), a real
tug-of-war at the strict end — but never a fail screen and never a scold.

1. The cat's **forward** drive never yields zero on genuine voicing — it always
   moves at least `MIN_FLOOR`. At the **easy** end its *net* progress is monotonic
   too (the mouse never flees), exactly as before; toward the **strict** end the
   mouse may flee faster than the floor, so the cat can lose ground — but a child
   always recovers by making the right sounds (the progress can climb straight
   back). This is the one behaviour #12 made assist-scaled.
2. **No** negative feedback for a "wrong" sound: no buzzer, no red, no
   stop-and-scold. The only signal is cat speed — slower, or the mouse pulling
   ahead, never a punishment.
3. The per-rung config (`src/game/config.ts`) is the rollback: flip every rung
   off — or flip a single misbehaving one off, live, mid-session — and the game
   reverts to the exact shipped loudness-only engine.
4. The **строго ↔ легче** (strict ↔ easy) `assist` slider is the single difficulty
   dial. At the easy end it is as forgiving as the old loudness-only feel (no
   flee, a breath-stop still wins) — for a noisy room, a detector miss, or a child
   who just needs to vocalize. Toward strict it raises the bar (the mouse flees,
   the «т» burst is required). It relaxes or tightens the gate continuously; it
   never silently bypasses it.

There is no timer, no score, no fail state. A child can never lose.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (use https or localhost for mic access)
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build
```

Needs a microphone. Browsers only allow mic access over `https://` or
`http://localhost`, so deploy over HTTPS. Works offline once loaded (no backend,
no external assets — sounds are synthesized, art is emoji + canvas).

## How it works

```
Mic ─ getUserMedia ─ AnalyserNode ─► AudioEngine.sample() ─► AudioFrame
        │  getFloatTimeDomainData → RMS, ZCR                  { level, voiced,
        └─ getFloatFrequencyData  → flatness, centroid,         onset, release,
                                    low-band, vowelLikeness     vowelLikeness, … }
                                                                    │
        ┌───────────────────────────────────────────────────────────┤
        ▼                                                             ▼
   MeterView (mic check)                                  PatternMatcher → GameView
   pulsing "I hear you" circle                            hold→gap→stop shape, graded
   + samples the vowel baseline                           chase speed, pounce, party
```

- **`src/audio/PhoneticFeatures.ts`** — pure, unit-tested DSP: zero-crossing
  rate, spectral flatness / centroid / low-band ratio, the `vowelLikeness`
  blend, (Rung 2, #5) `estimateFormants` + `vowelMatch` — a coarse F1/F2
  estimate scored against the target vowel in the child's own formant space,
  (Rung 3, #6) `classifyConsonant` — a coarse stop / sonorant / fricative label
  over a recent release window, (Rung 3, #12) `detectStopBurst` — the real fast
  «т» detector, a pure dip→burst shape test over a fast-envelope window — and
  (#13) `classifyVowel`, the all-vowel argmax that backs the read-only live-vowel
  chip. No state, no Web Audio — just `Float32Array` in, number/label out.
- **`src/audio/AudioEngine.ts`** — mic capture, the loudness envelope, **and**
  the spectral feature layer (gated by `setPhoneticEnabled`, driven from the
  config's "is any rung on?" flag). RMS with
  fast-attack/slow-release smoothing; automatic noise-floor calibration; a
  self-scaling `level`; voiced detection with hysteresis; onset/release edges;
  per-frame `vowelLikeness` scored against an optional per-child baseline,
  (Rung 2) the F1/F2 formant estimate, and (Rung 3, #12) a **second, much faster
  envelope** over the raw RMS feeding `detectStopBurst` → the `stopBurst` frame
  signal (the «т» closure→burst, invisible to the 120 ms-smoothed path).
  Browser-side AGC, noise suppression and echo cancellation are all **disabled**
  — AGC would flatten the loudness dynamics, and the others gate quiet breathy
  sounds and would corrupt the spectrum. Accepts an injectable analyser so the
  whole chain is testable without a mic.
- **`src/game/PatternMatcher.ts`** — the hold → stop state machine. Grades chase
  speed (`driveQuality`), decides when a vowel hold is long enough to arm the
  pounce, and fires the catch on a genuine stop. With Rung 2 on it folds a bounded
  vowel-match factor into the speed (a closer vowel runs faster; its floor is
  assist-scaled, #12) — but never into the hold. With Rung 3 on it labels the
  release (`consonantClass`) and, for a `"stop"` scene, fires the catch on the real
  `frame.stopBurst` (`burstDetected`). Which stop evidence is required is
  **assist-scaled** (#12): toward easy a breath-stop gap still wins, toward strict
  only the «т» burst does. A lenient "counts as trying" gate + the graded speed +
  the `assist` knob keep it forgiving. Pure and deterministic.
- **`src/game/GameView.ts`** — the canvas chase. The drive is a tug-of-war (#12):
  net progress = `catDrive − mouseFlee`, with `mouseFlee = strictness·MOUSE_FLEE_RATE`,
  clamped to `[0, PRECHASE_CAP]`. At the easy end the mouse never flees and
  progress is monotonic (today's feel, byte-for-byte); toward strict it can decay
  to 0. Cat speed = `MIN_FLOOR + (1−MIN_FLOOR)·driveQuality`, the catch gated on a
  real hold + stop; with the matcher off it is the exact pre-#1 loudness path
  (`stepPlay(match=null)`, no flee). The cat and mouse become friends at the end
  (hearts, not a kill).
- **`src/game/MeterView.ts`** — the "I can hear you" indicator for the mic-check
  screen, so a caregiver can confirm the mic before involving the child. The
  mic-check doubles as the vowel-baseline calibration window.
- **`src/game/LetterIndicator.ts`** — the read-only live-vowel chip's smoother
  (#13): EMA-smooths `classifyVowel`'s per-frame argmax and gates it (level,
  voiced, a score floor, and a runner-up margin) so the caregiver sees a steady
  letter, never a flicker. Pure and deterministic; feeds nothing back into
  grading (the read-only invariant).
- **`src/game/sfx.ts`** — synthesized celebration sounds + best-effort Russian
  TTS to model the target word. Sound only plays _after_ the pounce, never
  during the chase (with echo cancellation off, speaker audio would otherwise
  feed back into the chase).
- **`src/game/words.ts` / `types.ts`** — the content model. A `WordScene` is the
  unit of content and now carries an `AcousticPattern` (which ladder rung, how
  long to hold, the required stop gap, an optional target `vowel` for Rung 2, an
  optional `release.want: "stop"` for Rung 3, and the target `release.letter` it
  teaches — «кот»/«кит» ask for a real «т»). The acoustic trigger is the letter's
  coarse *class* (a stop burst), never the letter itself (telling «т» from «к»/«п»
  is the banned ASR territory). The chase mechanic is generic, so adding a
  `[hold]+[stop]` word (дом, кит, …) is just adding data.
- **`src/game/config.ts`** — the `PhoneticConfig` single source of truth (issue
  #4): per-rung flags (`rung1`/`rung2`/`rung3`), the `assist` continuum, a
  `debug` flag, and the read-only `showLetter` chip flag (#13), plus a tiny
  `localStorage`-backed store. The store never throws — corrupt/partial/
  private-mode storage all degrade to `DEFAULT_CONFIG`. The engine reads
  `anyRungOn(config)` (widened by `showLetter` for the formant pass); the matcher
  reads `assist` + `rung1` + `rung2` (with the per-child formant baseline) + `rung3`.
- **`src/main.ts`** — screen flow (start → mic check → game), the single master
  render loop, mic-permission handling, the graceful denied/error fallback,
  the per-round matcher wiring, the caregiver settings panel (per-rung toggles +
  assist + the read-only live-vowel chip toggle + debug, persisted live), the
  live-vowel chip render on the check/game screens, and the vowel-baseline
  calibration sampled on the mic-check screen.

## Caregiver affordances

Small, kid-ignorable controls at the bottom of the game screen.
**🔊 Послушать** hears the word modelled by TTS. A **⚙** gear opens a caregiver
settings panel — hidden by default so a 3-yr-old can't trip it — holding a
per-rung toggle (**гласные/шум**, **какая гласная**, **согласные/Т**), the
**строго ↔ легче** (strict ↔ easy) slider that relaxes the phonetic grading for a
noisy room, a **показывать букву** toggle (the read-only live-vowel chip, #13),
an **отладка** (debug) toggle, and **🎤 микрофон** (re-run the mic
check / recalibration). Every change is saved to `localStorage` and applied live,
so a misbehaving rung can be switched off mid-session and the setting survives a
reload. The **показывать букву** chip is a caregiver/dev display only: it shows
the most-likely vowel live (great for a "yes — that was an «О»!" or for
validating the detector on a real mic) but never changes how the chase grades.

## Tests

```bash
npm test           # vitest: pure DSP (incl. the `detectStopBurst` shape test),
                   # the PatternMatcher state machine, the GameView tug-of-war
                   # drive, an AudioEngine→matcher integration via an injected
                   # analyser, plus the AC#1 (easy = byte-for-byte) and AC#5
                   # (kill-switch identity) guards
```

The DSP and the state machine are pure, and `AudioEngine` accepts an injected
fake analyser, so the suite runs in plain Node — no jsdom, no microphone.

## Extending — the word bank & phonetic ladder

`src/game/words.ts` already contains extra scenes (дом, кит) ready to surface;
they grade on **Rung 1** (vowel-ish vs noise) and each tags a target `vowel` for
**Rung 2** when it is switched on. The design space:

- More `[sustainable vowel/sonorant] + [stop]` words: дом, мяч, кит, гусь.
- Onomatopoeia (gold here): мууу, ааам, бууух — these would add a new
  `SceneType` beyond `"chase"`.
- The **phonetic discrimination ladder** (issue #1): Rung 0 = hold→gap→stop
  shape · Rung 1 = vowel vs noise (built) · Rung 2 = which vowel (formants,
  built — #5, default off) · Rung 3 = consonant class / real «т» stop (built —
  #6, default off) · Rung 4 = syllable. Each new rung is a finer
  `AcousticPattern` + (for ≥2) new features in `PhoneticFeatures.ts`.
- Knobs: `MIN_FLOOR` / `CHASE_RATE` / `POUNCE_READY` / `MOUSE_FLEE_RATE` in
  `GameView.ts`, the `VOWEL_WEIGHTS` blend and the `STOP_BURST_*` detector bounds
  in `PhoneticFeatures.ts`, `BURST_REQUIRED_ASSIST` / `VOWEL_MATCH_FLOOR(_STRICT)`
  in `PatternMatcher.ts`, and the per-scene `AcousticPattern` (`minMs`,
  `requireGapMs`) in `words.ts`.

## Tuning notes

If the cat reacts too eagerly or too sluggishly in a particular room, reach for
the **строго ↔ легче** slider first (it sets both the mouse's flee speed and how
strictly the «т» is required). Beyond that, the relevant constants are the
noise-floor multipliers and the `FAST_ENV_*` time constants in `AudioEngine.ts`,
the chase constants at the top of `GameView.ts` (`MIN_FLOOR`, `CHASE_RATE`,
`POUNCE_READY`, `MOUSE_FLEE_RATE`), the `STOP_BURST_*` detector bounds +
`VOWEL_WEIGHTS` blend in `PhoneticFeatures.ts`, and `BURST_REQUIRED_ASSIST` in
`PatternMatcher.ts`. The **«т» stop-burst thresholds and the default assist are
placeholders** — they were chosen to make the mechanic demonstrable in tests and
**must be set on a real microphone with the child** (turn on `?debug=1`: it shows
the live `stopBurst`, the net cat-vs-flee drive, and the target letter). If the
spectral layer ever misbehaves on real hardware, flip the offending rung off in
the ⚙ settings panel (or turn every rung off) to revert to the shipped
loudness-only engine instantly, mid-session — no reload, no rebuild. The mechanic
lives or dies on how immediately the cat reacts to the child's voice.
