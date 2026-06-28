# Гонка звуков 🐱

A voice-driven game that helps kids with speech delay start vocalizing. The
child is shown a word as a little scene (e.g. **кот** — a cat and a mouse). While
the child makes sound, the cat chases the mouse; a final burst makes the cat
pounce and a happy celebration plays. The child's own voice drives the fun.

UI and content are in Russian.

## The core rule: no speech recognition

There is **no ASR / phoneme recognition / word matching** anywhere. That is
unreliable for young kids — and especially for kids with speech delay — and
turns the game into a punishment machine.

Everything is driven by the microphone **loudness envelope** (Web Audio API
`AnalyserNode` → RMS amplitude in real time):

- **Any** voiced sound above the noise floor makes the cat run. Sustained sound
  keeps it chasing. This rewards _vocalizing at all_ — the actual therapeutic
  goal (sustained phonation = breath support).
- The **pounce** triggers on a simple acoustic event once the cat is close: a
  fresh burst (the final "т") **or** simply running out of breath and stopping.
  We never verify it was really a /т/. Be generous — reward the attempt.

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
                                                              { level, voiced,
                                                                onset, release }
                                                                    │
        ┌───────────────────────────────────────────────────────────┤
        ▼                                                             ▼
   MeterView (mic check)                                      GameView (the chase)
   pulsing "I hear you" circle                                cat chases mouse,
                                                              pounce, celebration
```

- **`src/audio/AudioEngine.ts`** — mic capture and the loudness envelope. RMS
  with fast-attack/slow-release smoothing; automatic noise-floor calibration
  that keeps adapting to room noise; a self-scaling `level` so even a quiet
  child fills the meter and can "win"; voiced detection with hysteresis; onset /
  release edge detection used as the generous "burst". Browser-side AGC, noise
  suppression and echo cancellation are all **disabled** — AGC would flatten the
  loudness dynamics the whole game depends on, and the others can gate a child's
  quiet, breathy sounds.
- **`src/game/GameView.ts`** — the canvas chase. Progress accumulates while
  voiced (and never decays on a pause, so breathing is fine). Once the cat is
  close (`POUNCE_READY`), any onset or release finishes the catch. The cat and
  mouse become friends at the end (hearts, not a kill).
- **`src/game/MeterView.ts`** — the "I can hear you" indicator for the mic-check
  screen, so a caregiver can confirm the mic before involving the child.
- **`src/game/sfx.ts`** — synthesized celebration sounds + best-effort Russian
  TTS to model the target word. Sound only plays _after_ the pounce, never
  during the chase (with echo cancellation off, speaker audio would otherwise
  feed back into the chase).
- **`src/game/words.ts` / `types.ts`** — the content model. A `WordScene` is the
  unit of content; the chase mechanic is generic, so adding a `[hold]+[stop]`
  word (дом, кит, …) is just adding data.
- **`src/main.ts`** — screen flow (start → mic check → game), the single master
  render loop, mic-permission handling and the graceful denied/error fallback.

## Caregiver affordances

Small, kid-ignorable controls: **🔊 Послушать** (hear the word modelled by TTS)
and **⚙ микрофон** (re-run the mic check / recalibration).

## Extending — the word bank & difficulty ladder

`src/game/words.ts` already contains extra scenes (дом, кит) ready to surface.
The design space from the brief:

- More `[sustainable vowel/sonorant] + [stop]` words: дом, мяч, кит, гусь.
- Onomatopoeia (gold here): мууу, ааам, бууух — these would add a new
  `SceneType` beyond `"chase"`.
- A difficulty ladder: "any noise → thing happens" → "hold longer" → two-part
  words. The chase tuning constants in `GameView.ts` (`CHASE_RATE`,
  `POUNCE_READY`, `MIN_VOICED_DRIVE`) are the knobs.

## Tuning notes

If the cat reacts too eagerly or too sluggishly in a particular room, the
relevant constants are the noise-floor multipliers in `AudioEngine.ts` and the
chase constants at the top of `GameView.ts`. The mechanic lives or dies on how
immediately the cat reacts to the child's voice.
