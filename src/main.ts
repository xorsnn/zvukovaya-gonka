import "./style.css";
import { AudioEngine, type AudioFrame } from "./audio/AudioEngine";
import { MeterView } from "./game/MeterView";
import { GameView, MIN_FLOOR, MOUSE_FLEE_RATE } from "./game/GameView";
import { PatternMatcher, MIN_HOLD_THRESHOLD } from "./game/PatternMatcher";
import { LetterIndicator } from "./game/LetterIndicator";
import { DEFAULT_WORD, PICKABLE_SCENES } from "./game/words";
import { buildSceneMatcher } from "./game/round";
import type { WordScene } from "./game/types";
import { speakWord } from "./game/sfx";
import { loadConfig, saveConfig, anyRungOn } from "./game/config";

type Screen = "start" | "check" | "denied" | "game";

const app = document.getElementById("app")!;
const audio = new AudioEngine();
const meter = new MeterView();
const game = new GameView(DEFAULT_WORD);
// Read-only live-vowel chip smoother (#13); only consulted when config.showLetter.
const letterIndicator = new LetterIndicator();

// ---------- build the DOM ----------

app.innerHTML = `
  <section class="screen start active" data-screen="start">
    <h1 class="big-title">Гонка<br/>звуков</h1>
    <div class="scene-picker" id="scenePicker" role="radiogroup" aria-label="Выбери игру"></div>
    <p class="subtitle">Выбери игру и скажи звук! 🎤</p>
    <button class="btn btn-go" id="startBtn">Начать ▶</button>
  </section>

  <section class="screen check" data-screen="check">
    <p class="subtitle">Проверим микрофон.<br/>Скажи что-нибудь! 🎤</p>
    <div class="meter-wrap" id="meterWrap"></div>
    <p class="hint-line" id="checkHint">Жду звук…</p>
    <button class="btn btn-play" id="playBtn">Играть! 🐱</button>
  </section>

  <section class="screen denied" data-screen="denied">
    <div class="card">
      <h2 id="deniedTitle">Нужен микрофон 🎤</h2>
      <p id="deniedText">
        Чтобы играть, разреши доступ к микрофону в настройках браузера, потом
        обнови страницу.
      </p>
      <button class="btn btn-go btn-small" id="retryBtn">Попробовать снова</button>
    </div>
  </section>

  <section class="screen game" data-screen="game">
    <div class="word-card" id="wordCard">
      <span class="say">Скажи:</span>
      <span class="word"><span class="sustain" id="sustainEl"></span><span class="burst" id="burstEl"></span></span>
      <span class="hint" id="hintEl"></span>
    </div>
    <button class="btn btn-small listen-btn" id="listenBtn">🔊 Послушать</button>
    <div class="celebrate" id="celebrate">
      <div class="cheer">Ура! 🎉</div>
      <button class="btn btn-go" id="againBtn">Ещё раз 🔁</button>
    </div>
    <div class="parent-controls">
      <button class="parent-link gear-btn" id="gearBtn" aria-expanded="false" aria-controls="settingsPanel" aria-label="Настройки для взрослого">⚙</button>
      <div class="settings-panel" id="settingsPanel" hidden>
        <p class="settings-title">Для взрослого</p>
        <div class="settings-rungs">
          <label><input type="checkbox" id="rung1Toggle" /> <span>гласные / шум</span></label>
          <label><input type="checkbox" id="rung2Toggle" /> <span>какая гласная</span></label>
          <label><input type="checkbox" id="rung3Toggle" /> <span>согласные / Т</span></label>
        </div>
        <label class="assist-control" id="assistControl">
          <span class="assist-cap">строго</span>
          <input type="range" id="assistSlider" min="0" max="1" step="0.1" value="0.5" aria-label="Строгость распознавания" />
          <span class="assist-cap">легче</span>
        </label>
        <label><input type="checkbox" id="letterToggle" /> <span>показывать букву</span></label>
        <div class="settings-row">
          <label><input type="checkbox" id="debugToggle" /> <span>отладка</span></label>
          <button class="parent-link" id="recalBtn">🎤 микрофон</button>
        </div>
      </div>
    </div>
  </section>
`;

// mount canvases
document.getElementById("meterWrap")!.appendChild(meter.canvas);
const gameScreen = el<HTMLElement>('[data-screen="game"]');
gameScreen.insertBefore(game.canvas, gameScreen.firstChild);

// ---------- element refs ----------
const startBtn = el<HTMLButtonElement>("#startBtn");
const playBtn = el<HTMLButtonElement>("#playBtn");
const retryBtn = el<HTMLButtonElement>("#retryBtn");
const listenBtn = el<HTMLButtonElement>("#listenBtn");
const againBtn = el<HTMLButtonElement>("#againBtn");
const recalBtn = el<HTMLButtonElement>("#recalBtn");
const gearBtn = el<HTMLButtonElement>("#gearBtn");
const settingsPanel = el<HTMLElement>("#settingsPanel");
const assistSlider = el<HTMLInputElement>("#assistSlider");
const rung1Toggle = el<HTMLInputElement>("#rung1Toggle");
const rung2Toggle = el<HTMLInputElement>("#rung2Toggle");
const rung3Toggle = el<HTMLInputElement>("#rung3Toggle");
const debugToggle = el<HTMLInputElement>("#debugToggle");
const letterToggle = el<HTMLInputElement>("#letterToggle");
const checkHint = el<HTMLElement>("#checkHint");
const celebrate = el<HTMLElement>("#celebrate");
const sustainEl = el<HTMLElement>("#sustainEl");
const burstEl = el<HTMLElement>("#burstEl");
const hintEl = el<HTMLElement>("#hintEl");
const deniedTitle = el<HTMLElement>("#deniedTitle");
const deniedText = el<HTMLElement>("#deniedText");

// ---------- scene picker (issue #16) ----------
// Two play modes on the start screen: 🐱 Догонялки (chase, кот — the default) and
// 🐰 Морковка (pull, вот). Both share the identical «т»/hold acoustic stack, so
// picking one only sets the ACTIVE scene before mic-check; startRound() rebuilds
// the matcher from game.getScene().pattern, so the rest of the flow is unchanged.
const scenePicker = el<HTMLElement>("#scenePicker");
// Mode names (a picker-only label, not part of the acoustic content model).
const SCENE_LABELS: Record<string, string> = { kot: "Догонялки", vot: "Морковка" };

/** Mirror the active scene's word into the game screen's prompt card. */
function syncWordCard(): void {
  const s = game.getScene();
  sustainEl.textContent = s.sustainPart;
  burstEl.textContent = s.burstPart;
  hintEl.textContent = s.hint;
}

/** Make `scene` the active one and reflect the choice in the picker + prompt. */
function selectScene(scene: WordScene): void {
  if (game.getScene().id !== scene.id) game.setScene(scene);
  for (const card of scenePicker.querySelectorAll<HTMLButtonElement>(".scene-card")) {
    const on = card.dataset.sceneId === scene.id;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-checked", String(on));
  }
  syncWordCard();
}

for (const scene of PICKABLE_SCENES) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "scene-card";
  card.dataset.sceneId = scene.id;
  card.setAttribute("role", "radio");
  card.innerHTML =
    `<span class="scene-emoji">${scene.chaser}${scene.fleer}</span>` +
    `<span class="scene-name">${SCENE_LABELS[scene.id] ?? scene.word}</span>`;
  card.addEventListener("click", () => selectScene(scene));
  scenePicker.appendChild(card);
}

// Default = the game's initial scene (the first pickable = chase / кот), so
// choosing nothing reproduces the pre-#16 flow byte-for-byte (AC#1).
selectScene(game.getScene());

// ---------- phonetic ladder config (issues #1, #4) ----------
// `config` is the single source of truth for the whole phonetic layer: the
// per-rung toggles, the assist continuum, and the debug overlay. It is loaded
// from localStorage at startup and re-saved on every caregiver change, so the
// settings survive a reload. With no rung enabled the game runs exactly as the
// shipped loudness-only build (the generalization of the old USE_PHONETIC).
const config = loadConfig();

/**
 * Push the current config's needs onto the engine's two spectral flags.
 *
 * The formant pass feeds two independent consumers now: Rung 2's vowel-identity
 * grading AND the read-only live-vowel chip (#13). So the flags are widened by
 * `showLetter` — with the chip on, the engine runs the spectral + formant passes
 * even when every rung is off, which is exactly what lets the chip work standalone
 * (AC#5). With the chip off and the default config, this is byte-identical to the
 * old two lines.
 */
function applyEngineFlags(): void {
  audio.setPhoneticEnabled(anyRungOn(config) || config.showLetter);
  audio.setRung2Enabled(config.rung2 || config.showLetter);
}
applyEngineFlags();
// The «т» detector's sensitivity tracks the same строго↔легче dial as the matcher
// (#18), so seed it from the loaded config and keep it in sync on every change.
audio.setAssist(config.assist);

/** Hold threshold for vowel-likeness; tightened/relaxed by mic-check calibration. */
let calibHoldThreshold = MIN_HOLD_THRESHOLD;
/** The matcher for the active round (rebuilt each round from the latest config). */
let matcher: PatternMatcher | null = null;

// Per-session vowel-baseline calibration, sampled while the child makes sound on
// the mic-check screen. A 3-yr-old's formants are high, so we score her centroid
// relative to her own voice (see the age note in #1) instead of an adult number.
let calibVowel: number[] = [];
let calibCentroid: number[] = [];
// Her formants too (Rung 2, #5), so vowel-match is scored in HER vowel space.
let calibF1: number[] = [];
let calibF2: number[] = [];

function resetCalibrationSamples(): void {
  calibVowel = [];
  calibCentroid = [];
  calibF1 = [];
  calibF2 = [];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Turn the mic-check samples into a per-child baseline + hold threshold. Needs a
 * little voiced audio; if the caregiver skipped making sound, we fall back to the
 * generous adult defaults rather than guessing.
 */
function finalizeCalibration(): void {
  // The chip (#13) needs her formant baseline too, so calibrate whenever a rung
  // OR the chip is on. With every rung off the matcher is null, so the baseline
  // is unused by grading and only feeds the read-only chip.
  if (!anyRungOn(config) && !config.showLetter) return;
  if (calibVowel.length >= 12) {
    // Carry her F1/F2 only if we gathered enough non-zero estimates; the
    // matcher treats a missing pair as "no opinion" (graded, never gated, #5).
    const f1 = mean(calibF1.filter((v) => v > 0));
    const f2 = mean(calibF2.filter((v) => v > 0));
    audio.setVowelBaseline({
      centroid: mean(calibCentroid),
      ...(f1 > 0 && f2 > 0 ? { f1, f2 } : {}),
    });
    calibHoldThreshold = Math.max(MIN_HOLD_THRESHOLD, mean(calibVowel) * 0.6);
  } else {
    audio.setVowelBaseline(null);
    calibHoldThreshold = MIN_HOLD_THRESHOLD;
  }
}

/**
 * (Re)build the matcher for the current scene; null when no rung is enabled (the
 * loudness-only path). `rung1` gates the vowel grading inside the matcher;
 * `rung2` adds the vowel-identity speed factor (#5), scored against her
 * calibrated formant baseline; `rung3` adds the consonant-class label + the
 * real-«т» stop's bonus burst-catch (#6) for a scene whose release wants a stop.
 */
function buildMatcher(): void {
  matcher = buildSceneMatcher(game.getScene(), config, {
    holdThreshold: calibHoldThreshold,
    vowelBaseline: audio.getVowelBaseline(),
  });
  game.setMatcher(matcher);
}

// ---------- caregiver settings panel (issue #4) ----------
// Reflect the loaded config into the controls, then write every change straight
// back to localStorage and apply it live (no reload). The panel hides behind the
// gear so a child can't trip the switches.
rung1Toggle.checked = config.rung1;
rung2Toggle.checked = config.rung2;
rung3Toggle.checked = config.rung3;
assistSlider.value = String(config.assist);
debugToggle.checked = config.debug;
letterToggle.checked = config.showLetter;

gearBtn.addEventListener("click", () => {
  const willOpen = settingsPanel.hasAttribute("hidden");
  settingsPanel.toggleAttribute("hidden", !willOpen);
  gearBtn.setAttribute("aria-expanded", String(willOpen));
});

// A rung toggle flips the spectral layer on/off and rebuilds the matcher so the
// change takes effect instantly, mid-session — the config's rollback path.
function onRungChange(): void {
  config.rung1 = rung1Toggle.checked;
  config.rung2 = rung2Toggle.checked;
  config.rung3 = rung3Toggle.checked;
  applyEngineFlags();
  buildMatcher();
  saveConfig(config);
}
rung1Toggle.addEventListener("change", onRungChange);
rung2Toggle.addEventListener("change", onRungChange);
rung3Toggle.addEventListener("change", onRungChange);

// The chip is read-only: flipping it only widens the engine's formant pass and
// shows/hides the chip. It never rebuilds the matcher, so grading is untouched
// (issue #13's read-only invariant, AC#6).
letterToggle.addEventListener("change", () => {
  config.showLetter = letterToggle.checked;
  applyEngineFlags();
  letterIndicator.reset();
  updateLetterChipVisibility();
  saveConfig(config);
});

assistSlider.addEventListener("input", () => {
  config.assist = parseFloat(assistSlider.value);
  matcher?.setAssist(config.assist);
  audio.setAssist(config.assist); // keep the «т» detector on the same dial (#18)
  saveConfig(config);
});

debugToggle.addEventListener("change", () => {
  config.debug = debugToggle.checked;
  setDebugVisible(urlDebug || config.debug);
  saveConfig(config);
});

// ---------- screen management ----------
let current: Screen = "start";

function showScreen(name: Screen): void {
  current = name;
  for (const s of document.querySelectorAll<HTMLElement>(".screen")) {
    s.classList.toggle("active", s.dataset.screen === name);
  }
  if (name === "check") {
    requestAnimationFrame(() => meter.resize());
  }
  if (name === "game") {
    requestAnimationFrame(() => {
      game.resize();
      startRound();
    });
  }
  // Reflect the read-only chip: reset its smoother on any screen change and
  // show it only on the listening screens (AC#7). It holds no game state.
  letterIndicator.reset();
  updateLetterChipVisibility();
}

// ---------- game round helpers ----------
function startRound(): void {
  // Build the matcher first so game.reset() (which resets it) sees the right one.
  buildMatcher();
  game.reset();
  celebrate.classList.remove("show");
  // Model the target word, muting chase input so the TTS doesn't move the cat.
  modelWord();
}

function modelWord(): void {
  game.inputEnabled = false;
  speakWord(game.getScene().word).then(() => {
    // brief grace period so trailing speaker audio doesn't trigger the chase
    setTimeout(() => {
      game.inputEnabled = true;
    }, 250);
  });
}

game.onCatch = () => {
  celebrate.classList.add("show");
};

// ---------- buttons ----------
startBtn.addEventListener("click", () => beginMic());
retryBtn.addEventListener("click", () => beginMic());

async function beginMic(): Promise<void> {
  startBtn.disabled = true;
  retryBtn.disabled = true;
  const ok = await audio.init();
  startBtn.disabled = false;
  retryBtn.disabled = false;
  if (ok) {
    audio.recalibrate();
    resetCalibrationSamples();
    showScreen("check");
  } else if (audio.status === "denied") {
    deniedTitle.textContent = "Нужен микрофон 🎤";
    deniedText.textContent =
      "Чтобы играть, разреши доступ к микрофону в настройках браузера, потом нажми «Попробовать снова».";
    showScreen("denied");
  } else {
    deniedTitle.textContent = "Ой, что-то не так 😅";
    deniedText.textContent =
      "Не получилось включить микрофон. Проверь, что игра открыта по https и микрофон подключён. " +
      (audio.errorMessage || "");
    showScreen("denied");
  }
}

playBtn.addEventListener("click", () => {
  // Lock in her vowel baseline from the mic-check before the chase begins.
  finalizeCalibration();
  showScreen("game");
});
againBtn.addEventListener("click", () => startRound());
listenBtn.addEventListener("click", () => modelWord());
recalBtn.addEventListener("click", () => {
  audio.recalibrate();
  resetCalibrationSamples();
  checkHint.textContent = "Настраиваю…";
  showScreen("check");
});

// ---------- debug overlay (?debug=1 in the URL OR the «отладка» toggle) ----------
// A hidden tuning aid: shows the live phonetic features + matcher state so we can
// see WHY a sound does or doesn't count as a vowel. Created lazily and shown only
// when the URL carries ?debug or the caregiver flips the toggle, so it never
// touches normal play. Works on the mic-check screen (read the features for «ооо»
// vs «шшш») and during the game.
const urlDebug = new URLSearchParams(location.search).has("debug");
let dbgEl: HTMLPreElement | null = null;
let dbgVisible = false;

function setDebugVisible(on: boolean): void {
  dbgVisible = on;
  if (on && !dbgEl) {
    dbgEl = document.createElement("pre");
    dbgEl.style.cssText =
      "position:fixed;top:6px;left:6px;z-index:9;margin:0;padding:8px 10px;" +
      "font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre;" +
      "color:#27e07a;background:rgba(0,0,0,0.72);border-radius:8px;" +
      "pointer-events:none;letter-spacing:0.3px;";
    document.body.appendChild(dbgEl);
  }
  if (dbgEl) dbgEl.style.display = on ? "block" : "none";
}
setDebugVisible(urlDebug || config.debug);

// Debug jump (#18): «k» (checkpoint) latches the round into the armed/parked state
// so the next «т» wins — tune the pause-tolerant armed «т» against real pauses
// without re-doing the vowel each time. Ignored unless debug is on AND we're on
// the game screen, so normal play never sees it.
window.addEventListener("keydown", (e) => {
  if (e.key === "k" && (urlDebug || config.debug) && current === "game") {
    game.debugArmCheckpoint();
  }
});

function dbgBar(x: number, n = 10): string {
  const k = Math.max(0, Math.min(n, Math.round(x * n)));
  return "█".repeat(k) + "·".repeat(n - k);
}

function renderDebug(frame: AudioFrame): void {
  if (!dbgEl) return;
  const m = game.debugMatch;
  const effHold = calibHoldThreshold * (1 - config.assist * 0.7);
  const effMin = game.getScene().pattern.sustain.minMs * (1 - config.assist * 0.6);
  const f = (x: number, d = 2) => x.toFixed(d);
  const target = game.getScene().pattern.vowel;
  const letter = game.getScene().pattern.release.letter;
  const vm = m?.vowelMatch ?? 1;
  // Live tug-of-war drive (#12): the cat's forward drive vs the mouse's flee, the
  // same arithmetic GameView.stepPlay nets each frame, so a tuner can watch the
  // balance tip at a given assist. flee = strictness·MOUSE_FLEE_RATE.
  const catDrive = m && frame.voiced ? MIN_FLOOR + (1 - MIN_FLOOR) * m.driveQuality : 0;
  const flee = m ? (1 - config.assist) * MOUSE_FLEE_RATE : 0;
  const net = catDrive - flee;
  dbgEl.textContent =
    `vowelLike ${f(frame.vowelLikeness)} ${dbgBar(frame.vowelLikeness)}\n` +
    ` flatness ${f(frame.flatness)} ${dbgBar(frame.flatness)}\n` +
    `      zcr ${f(frame.zcr)} ${dbgBar(frame.zcr)}\n` +
    `  lowBand ${f(frame.lowBandRatio)} ${dbgBar(frame.lowBandRatio)}\n` +
    ` centroid ${Math.round(frame.centroid)} Hz\n` +
    `   F1/F2 ${Math.round(frame.f1)}/${Math.round(frame.f2)} Hz` +
    `${config.rung2 && target ? `  →«${target}» ${f(vm)} ${dbgBar(vm)}` : ""}\n` +
    `    level ${f(frame.level)}  ${frame.voiced ? "●voiced" : "·quiet"}\n` +
    `    drive cat ${f(catDrive)} − flee ${f(flee)} = ${net >= 0 ? "+" : ""}${f(net)}\n` +
    `${config.rung3 ? `    class ${m?.consonantClass ?? "none"}${letter ? ` →«${letter}»` : ""}${frame.stopBurst ? "  STOP-BURST✓" : ""}${m?.burstDetected ? "  CAUGHT-BURST✓" : ""}\n` : ""}` +
    `── hold ${m ? Math.round(m.sustainHeldMs) : 0}/${Math.round(effMin)}ms` +
    `  thr ${f(effHold)}  assist ${f(config.assist, 1)}\n` +
    `   ${m?.holdSatisfied ? "HOLD✓" : "hold·"}   ${m?.caught ? "CATCH✓" : "catch·"}` +
    `${m?.armedForBurst ? "   ⚑ARMED waiting-«Т» (k=jump)" : ""}`;
}

// ---------- live-vowel chip (issue #13) ----------
// A read-only caregiver display: the most-likely vowel (А/О/У/И or «—») plus a
// thin confidence bar. Deliberately adult, not a reward — no bounce, no
// color-pop. Created lazily (like the debug overlay) so it costs nothing when
// off, shown ONLY on the check + game screens (AC#7), behind the default-off
// «показывать букву» toggle. It NEVER touches the matcher — read-only (AC#6).
let letterChipEl: HTMLElement | null = null;
let letterGlyphEl: HTMLElement | null = null;
let letterBarEl: HTMLElement | null = null;

function ensureLetterChip(): void {
  if (letterChipEl) return;
  letterChipEl = document.createElement("div");
  letterChipEl.id = "letterChip";
  letterChipEl.className = "letter-chip";
  letterGlyphEl = document.createElement("span");
  letterGlyphEl.className = "letter";
  letterGlyphEl.textContent = "—";
  const bar = document.createElement("div");
  bar.className = "conf-bar";
  letterBarEl = document.createElement("i");
  bar.appendChild(letterBarEl);
  letterChipEl.append(letterGlyphEl, bar);
  document.body.appendChild(letterChipEl);
}

/** Should the chip be visible right now? On, and on a listening screen (AC#7). */
function letterChipActive(): boolean {
  return config.showLetter && (current === "check" || current === "game");
}

function updateLetterChipVisibility(): void {
  if (letterChipActive()) {
    ensureLetterChip();
    letterChipEl!.style.display = "flex";
  } else if (letterChipEl) {
    letterChipEl.style.display = "none";
  }
}

/** Feed one frame through the smoother and paint the glyph + confidence bar. */
function renderLetterChip(frame: AudioFrame, dtMs: number): void {
  ensureLetterChip();
  const cls = letterIndicator.update(
    { f1: frame.f1, f2: frame.f2 },
    frame.level,
    frame.voiced,
    audio.getVowelBaseline(),
    dtMs,
  );
  // Lowercase union → uppercase glyph is display-only (а→А, о→О, у→У, и→И).
  letterGlyphEl!.textContent = cls.vowel ? cls.vowel.toUpperCase() : "—";
  // «—» always shows an empty bar; a real letter shows its smoothed confidence.
  const conf = cls.vowel ? Math.max(0, Math.min(1, cls.confidence)) : 0;
  letterBarEl!.style.width = `${Math.round(conf * 100)}%`;
}

// ---------- master loop ----------
let last = performance.now();
function loop(now: number): void {
  const dt = now - last;
  last = now;
  const frame = audio.sample(now);

  if (current === "check") {
    meter.draw(frame, now);
    if (meter.hasHeard) {
      checkHint.textContent = "Слышу тебя! 👍";
    } else if (!audio.isRunning) {
      checkHint.textContent = "Жду звук…";
    }
    // Sample her sustained-vowel baseline while she makes sound (issue #1) —
    // including F1/F2 for the Rung-2 vowel-match space (#5).
    if (anyRungOn(config) && frame.voiced && frame.level > 0.2) {
      calibVowel.push(frame.vowelLikeness);
      calibCentroid.push(frame.centroid);
      calibF1.push(frame.f1);
      calibF2.push(frame.f2);
      // Cap so a long mic-check can't grow these unbounded.
      if (calibVowel.length > 240) {
        calibVowel.shift();
        calibCentroid.shift();
        calibF1.shift();
        calibF2.shift();
      }
    }
  } else if (current === "game") {
    game.step(frame, now, dt);
    updateWordHighlight(frame);
  }

  if (dbgVisible && (current === "check" || current === "game")) renderDebug(frame);
  if (letterChipActive()) renderLetterChip(frame, dt);

  requestAnimationFrame(loop);
}

function updateWordHighlight(frame: { voiced: boolean }): void {
  if (game.state === "play") {
    sustainEl.classList.toggle("active", frame.voiced && game.inputEnabled);
    burstEl.classList.toggle("hot", game.nearPounce);
    // At the two-phase checkpoint (#18) the «т» is now the only way to finish, so
    // it gets a stronger, unmistakable "now say Т" cue on top of the hot pulse.
    burstEl.classList.toggle("checkpoint", game.armedForBurst);
  } else {
    sustainEl.classList.remove("active");
    burstEl.classList.remove("hot");
    burstEl.classList.remove("checkpoint");
  }
}

// ---------- resize + lifecycle ----------
function onResize(): void {
  if (current === "check") meter.resize();
  if (current === "game") game.resize();
}
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () =>
  setTimeout(onResize, 200),
);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) audio.resume();
});

// warm up TTS voice list (some browsers populate it lazily)
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () =>
    window.speechSynthesis.getVoices();
}

requestAnimationFrame(loop);

// ---------- dev-only hook for visual testing without a live mic ----------
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__dev = {
    audio,
    game,
    meter,
    showScreen,
    startRound,
  };
}

// ---------- tiny helper ----------
function el<T extends Element>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
}
