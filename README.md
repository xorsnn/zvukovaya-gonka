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

**Rung 3 (#6)** tells the *release shape* apart — a **stop** («т»: a sustained
hold → a near-silence closure, optionally a burst), a **sonorant** hum («р»/«м»:
continuous low-ZCR voicing, no gap), and a **fricative** hiss («ш»/«с»). Still
no recognition and no gate: a pure `classifyConsonant` only *labels* the recent
window, and for a «т»-final scene the matcher *adds* an earlier burst-catch on
the «т» release. It ships behind `config.rung3`, **off by default**; with it off
behavior is exactly Rung 1/2, and even on, a real vowel hold + a stop always
catches — running out of breath (no crisp burst) still wins, and a lone «т» or a
continuous «р» hum is never enough on its own. **Caveat (pending real-mic
tuning):** the burst-catch keys off the engine's smoothed `voiced` flag, which
takes ~387 ms of silence to drop, so a natural «т» closure (50–150 ms) currently
falls through to the plain final-silence gap (= Rung 1) rather than firing on the
burst. Making the «т» release genuinely fire needs a faster closure detector and
real-mic validation — see the note on `RUNG3_MIN_CLOSURE_MS` in `PatternMatcher.ts`.

Everything is driven from the Web Audio API `AnalyserNode`
(`getFloatTimeDomainData` → RMS + ZCR; `getFloatFrequencyData` → the spectral
features):

- **Any** voiced sound above the noise floor still makes the cat run; a clearer,
  steadier vowel just makes it run **faster** (graded by `vowelLikeness`, never
  punished). This rewards _vocalizing at all_ — the therapeutic goal — while
  nudging toward the target sound.
- The **pounce** arms only after a real sustained vowel-like **hold**, and the
  catch needs a genuine **stop** (a near-silence gap) — which a continuous
  scream never produces and a single short shout never reaches. Simply running
  out of breath and stopping is the generous, expected finale.

### Leniency is mandatory (the whole reason ASR was banned)

These are invariants, not nice-to-haves:

1. Genuine voicing **never** yields zero drive — the cat always moves at least
   `MIN_FLOOR`.
2. **No** negative feedback for a "wrong" sound: no buzzer, no red, no
   stop-and-scold. The only signal is cat speed.
3. The per-rung config (`src/game/config.ts`) is the rollback: flip every rung
   off — or flip a single misbehaving one off, live, mid-session — and the game
   reverts to the exact shipped loudness-only engine.
4. A **строго ↔ легче** (strict ↔ easy) `assist` slider relaxes every threshold
   continuously — at the easy end it is as forgiving as the old loudness-only
   feel, for a noisy room or a detector miss. It relaxes the gate; it never
   silently bypasses it.

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
  estimate scored against the target vowel in the child's own formant space —
  and (Rung 3, #6) `classifyConsonant` — a coarse stop / sonorant / fricative
  label over a recent release window. No state, no Web Audio — just
  `Float32Array` in, number/label out.
- **`src/audio/AudioEngine.ts`** — mic capture, the loudness envelope, **and**
  the spectral feature layer (gated by `setPhoneticEnabled`, driven from the
  config's "is any rung on?" flag). RMS with
  fast-attack/slow-release smoothing; automatic noise-floor calibration; a
  self-scaling `level`; voiced detection with hysteresis; onset/release edges;
  per-frame `vowelLikeness` scored against an optional per-child baseline, and
  (Rung 2) the F1/F2 formant estimate on each frame.
  Browser-side AGC, noise suppression and echo cancellation are all **disabled**
  — AGC would flatten the loudness dynamics, and the others gate quiet breathy
  sounds and would corrupt the spectrum. Accepts an injectable analyser so the
  whole chain is testable without a mic.
- **`src/game/PatternMatcher.ts`** — the hold → gap → stop state machine. Grades
  chase speed (`driveQuality`), decides when a vowel hold is long enough to arm
  the pounce, and fires the catch on a genuine stop. With Rung 2 on it folds a
  bounded vowel-match factor into the speed (a closer vowel runs faster) — but
  never into the hold or the catch. With Rung 3 on it labels the release
  (`consonantClass`) and, for a `"stop"` scene, adds an earlier burst-catch on
  the «т» release (`burstDetected`) — additive only; the gap-only catch still
  wins. Two thresholds (a lenient "counts as trying" gate + the graded speed)
  and an `assist` knob keep it forgiving. Pure and deterministic.
- **`src/game/GameView.ts`** — the canvas chase. Progress accumulates while
  voiced (and never decays on a pause). With the matcher, speed = `MIN_FLOOR +
  (1−MIN_FLOOR)·driveQuality` and the catch is gated on a real hold + stop; with
  the matcher off it is the exact pre-#1 loudness path (`stepPlay(match=null)`).
  The cat and mouse become friends at the end (hearts, not a kill).
- **`src/game/MeterView.ts`** — the "I can hear you" indicator for the mic-check
  screen, so a caregiver can confirm the mic before involving the child. The
  mic-check doubles as the vowel-baseline calibration window.
- **`src/game/sfx.ts`** — synthesized celebration sounds + best-effort Russian
  TTS to model the target word. Sound only plays _after_ the pounce, never
  during the chase (with echo cancellation off, speaker audio would otherwise
  feed back into the chase).
- **`src/game/words.ts` / `types.ts`** — the content model. A `WordScene` is the
  unit of content and now carries an `AcousticPattern` (which ladder rung, how
  long to hold, the required stop gap, an optional target `vowel` for Rung 2, and
  an optional `release.want: "stop"` for Rung 3 — «кот»/«кит» ask for a real
  «т»). The chase mechanic is generic, so adding a `[hold]+[stop]` word (дом, кит,
  …) is just adding data.
- **`src/game/config.ts`** — the `PhoneticConfig` single source of truth (issue
  #4): per-rung flags (`rung1`/`rung2`/`rung3`), the `assist` continuum, and a
  `debug` flag, plus a tiny `localStorage`-backed store. The store never throws —
  corrupt/partial/private-mode storage all degrade to `DEFAULT_CONFIG`. The
  engine reads `anyRungOn(config)`; the matcher reads `assist` + `rung1` +
  `rung2` (with the per-child formant baseline) + `rung3`.
- **`src/main.ts`** — screen flow (start → mic check → game), the single master
  render loop, mic-permission handling, the graceful denied/error fallback,
  the per-round matcher wiring, the caregiver settings panel (per-rung toggles +
  assist + debug, persisted live), and the vowel-baseline calibration sampled on
  the mic-check screen.

## Caregiver affordances

Small, kid-ignorable controls at the bottom of the game screen.
**🔊 Послушать** hears the word modelled by TTS. A **⚙** gear opens a caregiver
settings panel — hidden by default so a 3-yr-old can't trip it — holding a
per-rung toggle (**гласные/шум**, **какая гласная**, **согласные/Т**), the
**строго ↔ легче** (strict ↔ easy) slider that relaxes the phonetic grading for a
noisy room, an **отладка** (debug) toggle, and **🎤 микрофон** (re-run the mic
check / recalibration). Every change is saved to `localStorage` and applied live,
so a misbehaving rung can be switched off mid-session and the setting survives a
reload.

## Tests

```bash
npm test           # vitest: pure DSP, the PatternMatcher state machine,
                   # an AudioEngine→matcher integration via an injected analyser,
                   # plus the AC#4 (graded) and AC#5 (kill-switch identity) guards
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
- Knobs: `MIN_FLOOR` / `CHASE_RATE` / `POUNCE_READY` in `GameView.ts`, the
  `VOWEL_WEIGHTS` blend in `PhoneticFeatures.ts`, and the per-scene
  `AcousticPattern` (`minMs`, `requireGapMs`) in `words.ts`.

## Tuning notes

If the cat reacts too eagerly or too sluggishly in a particular room, reach for
the **строго ↔ легче** slider first (it relaxes every phonetic threshold at
once). Beyond that, the relevant constants are the noise-floor multipliers in
`AudioEngine.ts`, the chase constants at the top of `GameView.ts`
(`MIN_FLOOR`, `CHASE_RATE`, `POUNCE_READY`), and the `VOWEL_WEIGHTS` blend in
`PhoneticFeatures.ts`. If the spectral layer ever misbehaves on real hardware,
flip the offending rung off in the ⚙ settings panel (or turn every rung off) to
revert to the shipped loudness-only engine instantly, mid-session — no reload,
no rebuild. The mechanic lives or dies on how immediately the cat reacts to the
child's voice.
