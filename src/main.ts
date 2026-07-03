import "./style.css";
import { AudioEngine, type AudioFrame } from "./audio/AudioEngine";
import { MeterView } from "./game/MeterView";
import { RoarView } from "./game/RoarView";
import {
  initRoar,
  stepRoar,
  DEFAULT_ROAR_CFG,
  type RoarStateT,
  type RoarToyCfg,
} from "./game/RoarToy";
import { GameView, MIN_FLOOR, MOUSE_FLEE_RATE } from "./game/GameView";
import { PatternMatcher, MIN_HOLD_THRESHOLD } from "./game/PatternMatcher";
import { LetterIndicator } from "./game/LetterIndicator";
import {
  classifyVowel,
  classifyConsonant,
  type ReleaseFrame,
  type Vowel,
  type VowelBaseline,
} from "./audio/PhoneticFeatures";
import {
  BurstAccumulator,
  ScoreTally,
  burstVerdict,
  TEST_TARGETS,
  type TestTarget,
  type Detected,
} from "./game/SoundTest";
import {
  CLIP_VERSION,
  COARSE_LABELS,
  serializeClip,
  type CoarseLabel,
  type ClipFrame,
  type DetectionClip,
} from "./game/DetectionFixture";
import { DEFAULT_WORD, PICKABLE_SCENES } from "./game/words";
import { buildSceneMatcher } from "./game/round";
import { resolveSceneParam, SCENE_PARAM } from "./game/navigation";
import type { WordScene } from "./game/types";
import { speakWord, playRoar, ROAR_TOTAL_MS } from "./game/sfx";
import { loadConfig, saveConfig, anyRungOn } from "./game/config";

// The detection-test screen (#22) is a dev/caregiver-only tuning surface, reached
// only via `?test=1` or the ⚙ panel's [Тест звуков] button. It never touches
// gameplay, the matcher, or the shipped config.
//
// The dino toy (#30) is a no-goal, no-fail reactive screen: the child makes any
// sound and a 🦖 roars back on her pause. Like `test`, it is a standalone Screen
// with its own loop() branch and a pure DOM-free logic module (RoarToy). It uses
// NONE of the matcher / stepPlay / strictness stack — it reads only `level`.
type Screen = "start" | "check" | "denied" | "game" | "test" | "dino";

const app = document.getElementById("app")!;
const audio = new AudioEngine();
const meter = new MeterView();
const dino = new RoarView();
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
        <button class="parent-link test-open-btn" id="testOpenBtn">🎯 Тест звуков</button>
      </div>
    </div>
  </section>

  <section class="screen test" data-screen="test">
    <div class="test-panel">
      <div class="test-head">
        <button class="parent-link" id="testBackBtn">← назад</button>
        <span class="test-title">Тест распознавания</span>
      </div>
      <div class="test-letter-row">
        <span class="test-glyph" id="testGlyph">—</span>
        <div class="test-vowel-bars" id="testVowelBars"></div>
      </div>
      <p class="test-hint" id="testCalibHint">нужна калибровка</p>
      <button class="btn btn-small test-calib-btn" id="testCalibBtn">🎤 Подержи «ААА»</button>
      <pre class="test-readout" id="testReadout"></pre>
      <div class="test-score">
        <div class="test-score-head">
          <span class="test-target-label">Цель: <b id="testTarget">А</b></span>
          <button class="parent-link" id="testNextTargetBtn">следующая ▸</button>
        </div>
        <p class="test-score-line" id="testScoreLine">0 / 0 · 0%</p>
        <p class="test-confusion" id="testConfusion"></p>
        <button class="parent-link" id="testResetBtn">сбросить счёт</button>
      </div>
      <div class="test-record">
        <div class="test-record-row">
          <span class="test-record-cap">запись:</span>
          <select id="testClipLabel" class="test-clip-label" aria-label="Что записываем"></select>
          <button class="parent-link test-record-btn" id="testRecordBtn">● запись</button>
        </div>
        <p class="test-record-status" id="testRecordStatus">локально, без загрузки — для офлайн-настройки</p>
      </div>
    </div>
  </section>

  <section class="screen dino" data-screen="dino">
    <button class="parent-link dino-back" id="dinoBackBtn" aria-label="Назад">← назад</button>
    <p class="dino-hint">Скажи что-нибудь — динозаврик зарычит! 🦖</p>
    <label class="assist-control dino-assist" id="dinoAssistControl">
      <span class="assist-cap">строго</span>
      <input type="range" id="dinoAssistSlider" min="0" max="1" step="0.1" value="0.5" aria-label="Чувствительность" />
      <span class="assist-cap">легче</span>
    </label>
  </section>
`;

// mount canvases
document.getElementById("meterWrap")!.appendChild(meter.canvas);
const gameScreen = el<HTMLElement>('[data-screen="game"]');
gameScreen.insertBefore(game.canvas, gameScreen.firstChild);
const dinoScreen = el<HTMLElement>('[data-screen="dino"]');
dinoScreen.insertBefore(dino.canvas, dinoScreen.firstChild);

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
// detection-test screen refs (#22)
const testOpenBtn = el<HTMLButtonElement>("#testOpenBtn");
const testBackBtn = el<HTMLButtonElement>("#testBackBtn");
const testCalibBtn = el<HTMLButtonElement>("#testCalibBtn");
const testNextTargetBtn = el<HTMLButtonElement>("#testNextTargetBtn");
const testResetBtn = el<HTMLButtonElement>("#testResetBtn");
const testGlyph = el<HTMLElement>("#testGlyph");
const testVowelBars = el<HTMLElement>("#testVowelBars");
const testCalibHint = el<HTMLElement>("#testCalibHint");
const testReadout = el<HTMLElement>("#testReadout");
const testTargetEl = el<HTMLElement>("#testTarget");
const testScoreLine = el<HTMLElement>("#testScoreLine");
const testConfusion = el<HTMLElement>("#testConfusion");
// offline-capture refs (#24)
const testClipLabel = el<HTMLSelectElement>("#testClipLabel");
const testRecordBtn = el<HTMLButtonElement>("#testRecordBtn");
const testRecordStatus = el<HTMLElement>("#testRecordStatus");
// dino toy refs (#30)
const dinoBackBtn = el<HTMLButtonElement>("#dinoBackBtn");
const dinoAssistSlider = el<HTMLInputElement>("#dinoAssistSlider");
for (const label of COARSE_LABELS) {
  const opt = document.createElement("option");
  opt.value = label;
  opt.textContent = label;
  testClipLabel.appendChild(opt);
}

// The four vowel bars are built once; renderSoundTest paints each fill per frame.
const TEST_VOWELS: readonly Vowel[] = ["а", "о", "у", "и"];
const testBarFills: Partial<Record<Vowel, HTMLElement>> = {};
for (const v of TEST_VOWELS) {
  const row = document.createElement("div");
  row.className = "test-bar";
  const label = document.createElement("span");
  label.className = "test-bar-label";
  label.textContent = v.toUpperCase();
  const track = document.createElement("div");
  track.className = "test-bar-track";
  const fill = document.createElement("i");
  track.appendChild(fill);
  row.append(label, track);
  testVowelBars.appendChild(row);
  testBarFills[v] = fill;
}

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

/**
 * Mirror the active experience into the URL's `?scene=` param (#20) — no reload,
 * no history entry (`replaceState`). `param === null` removes it (the default is
 * a clean URL). Any other params (e.g. `?debug`) and the `#hash` are preserved,
 * so `?debug=1` becomes `?debug=1&scene=vot`.
 */
function writeSceneParam(param: string | null): void {
  const url = new URL(location.href);
  if (param === null) url.searchParams.delete(SCENE_PARAM);
  else url.searchParams.set(SCENE_PARAM, param);
  history.replaceState(history.state, "", url);
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
  card.addEventListener("click", () => {
    selectScene(scene);
    writeSceneParam(scene.id); // mirror the pick into ?scene= (#20)
  });
  scenePicker.appendChild(card);
}

// The 🦖 Динозавр card (#30) sits next to the pickable scenes but is NOT a
// WordScene — it launches the no-goal reactive toy, not a matcher round. So it is
// a plain button (role="button", not part of the radiogroup), and clicking it
// goes straight to mic-check with the dino as the pending destination (below),
// bypassing the «Начать ▶» button the scene cards wait on.
const dinoCard = document.createElement("button");
dinoCard.type = "button";
dinoCard.className = "scene-card dino-card";
dinoCard.setAttribute("role", "button");
dinoCard.innerHTML =
  `<span class="scene-emoji">🦖</span>` +
  `<span class="scene-name">Динозавр</span>`;
dinoCard.addEventListener("click", () => {
  pendingPlay = "dino";
  onMicReady = () => showScreen("check");
  beginMic();
});
scenePicker.appendChild(dinoCard);

// Deep-link (#20): the active experience is mirrored in `?scene=<id>`. On load,
// resolve the param against PICKABLE_SCENES — a valid token preselects that card,
// anything else (absent / unknown / bad case) falls back to the default кот. Then
// canonicalize the URL so a bad or upper-cased token is cleaned without a reload.
// The default stays a CLEAN URL (no param written on a fresh visit), so choosing
// nothing reproduces the pre-#16/#20 flow byte-for-byte (AC#1).
const rawScene = new URLSearchParams(location.search).get(SCENE_PARAM);
const resolved = resolveSceneParam(rawScene, PICKABLE_SCENES, DEFAULT_WORD.id);
selectScene(
  PICKABLE_SCENES.find((s) => s.id === resolved.id) ?? game.getScene(),
);
if (resolved.param !== rawScene) writeSceneParam(resolved.param);

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
dinoAssistSlider.value = String(config.assist); // the dino toy mirrors the same dial (#30)
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

// The строго↔легче dial has two mirrored sliders (the ⚙ panel's, and the dino
// toy's #30). Both write the same `config.assist`, so route them through one
// setter that updates the matcher, the «т» detector, persists, and keeps both
// slider positions in sync. Behaviour for the ⚙ slider is unchanged (AC#10).
function applyAssist(v: number): void {
  config.assist = v;
  assistSlider.value = String(v);
  dinoAssistSlider.value = String(v);
  matcher?.setAssist(config.assist);
  audio.setAssist(config.assist); // keep the «т» detector on the same dial (#18)
  saveConfig(config);
}

assistSlider.addEventListener("input", () => applyAssist(parseFloat(assistSlider.value)));

debugToggle.addEventListener("change", () => {
  config.debug = debugToggle.checked;
  setDebugVisible(urlDebug || config.debug);
  saveConfig(config);
});

// ---------- screen management ----------
let current: Screen = "start";

function showScreen(name: Screen): void {
  const wasTest = current === "test";
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
  // Entering the dino toy (#30): reset the pure state + the view, then size the
  // canvas. No matcher, no calibration — it reads only `level`.
  if (name === "dino") {
    roarState = initRoar();
    dino.reset();
    requestAnimationFrame(() => dino.resize());
  }
  // Entering/leaving the detection-test screen (#22): it forces the spectral +
  // formant passes ON (so every detector has data even under the default config),
  // then restores config-driven flags on leave (AC#8). Order matters — force
  // AFTER a restore can't fire (we only restore when we WERE on test).
  if (name === "test") enterTestScreen();
  else if (wasTest) {
    cancelTestRecording(); // drop any in-progress recording on leave (#24)
    applyEngineFlags();
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
// Where to route once the mic is granted. The normal flow goes to the mic-check;
// the `?test=1` deep-link (#22) overrides this to the detection-test screen. The
// shared retry button honours whatever destination is pending.
let onMicReady: () => void = () => showScreen("check");

// Where the mic-check's «Играть!» leads: the normal game round, or the dino toy
// (#30). The 🦖 card sets this to "dino" before mic-check; every other entry
// (Начать / scene cards) leaves it at the default "game" (AC#1, AC#10).
let pendingPlay: "game" | "dino" = "game";

startBtn.addEventListener("click", () => {
  pendingPlay = "game";
  onMicReady = () => showScreen("check");
  beginMic();
});
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
    onMicReady();
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
  // The dino toy (#30) reads only `level` — no vowel baseline needed, so skip
  // finalizeCalibration and land straight on the reactive screen (AC#1).
  if (pendingPlay === "dino") {
    showScreen("dino");
    return;
  }
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

// detection-test screen nav (#22). The ⚙ button always has a running mic (opened
// mid-game), so it goes straight to the screen; «← назад» returns to start.
testOpenBtn.addEventListener("click", () => {
  settingsPanel.toggleAttribute("hidden", true);
  gearBtn.setAttribute("aria-expanded", "false");
  showScreen("test");
});
testBackBtn.addEventListener("click", () => showScreen("start"));

// dino toy nav (#30): «← назад» returns to start; the toy's own compact slider
// mirrors the shared строго↔легче dial.
dinoBackBtn.addEventListener("click", () => showScreen("start"));
dinoAssistSlider.addEventListener("input", () =>
  applyAssist(parseFloat(dinoAssistSlider.value)),
);

testCalibBtn.addEventListener("click", () => startTestCalibration());
testNextTargetBtn.addEventListener("click", () => cycleTestTarget());
testResetBtn.addEventListener("click", () => {
  testTally.reset();
  testAccumulator.reset();
  renderTestTally();
});
// Offline capture (#24): toggle record; a second press stops + downloads.
testRecordBtn.addEventListener("click", () => {
  if (testRecording) finishTestRecording();
  else startTestRecording();
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

// ---------- detection-test screen (issue #22) ----------
// A dev/caregiver-only tuning surface: a live readout of every detector plus a
// target-practice scorer. It follows the chip's read-only invariant (#13) — its
// detectors are SCREEN-LOCAL (a private LetterIndicator, a ReleaseFrame ring, a
// screen-local vowel baseline) and share nothing with the matcher or the game's
// session baseline. The pure segmentation/verdict/tally logic lives in
// `SoundTest.ts`; here we only sample frames, feed them, and paint the DOM.
const testLetterIndicator = new LetterIndicator();
const testAccumulator = new BurstAccumulator();
const testTally = new ScoreTally();
// A rolling window of recent frames for classifyConsonant (~0.4 s at 60 fps —
// enough to hold a vowel, a 50–150 ms closure, and a burst).
const testReleaseRing: ReleaseFrame[] = [];
const TEST_RING_LEN = 24;
// Screen-local baseline: set by the inline «Подержи ААА» calibrate, fed to
// classifyVowel + the screen's LetterIndicator. It is NEVER pushed to
// audio.setVowelBaseline(), so the game's session baseline is untouched (AC#4).
let testBaseline: VowelBaseline | null = null;
let testTarget: TestTarget = "а";
// ms since the last real stop-burst (Infinity = none yet). Drives the flash +
// the "N мс назад" readout without needing a wall clock — pure dt accumulation.
let testBurstAgoMs = Infinity;
// Inline-calibration sampling state (mirrors the mic-check rule: voiced && level>0.2).
let testCalibrating = false;
let tcF1: number[] = [];
let tcF2: number[] = [];
let tcCentroid: number[] = [];
let tcElapsedMs = 0;

// Offline-capture state (#24). Recording snapshots the raw per-frame buffers into
// a clip the caregiver downloads and replays offline through the pure detectors
// (see DetectionFixture.ts). It is LOCAL-ONLY and consent-explicit — nothing is
// uploaded — and shares no state with the matcher (same read-only invariant).
let testRecording = false;
let testClipFrames: ClipFrame[] = [];
let testRecordMs = 0;
/** Hard cap on one recording (ms) so a forgotten record never grows unbounded. */
const TEST_RECORD_MAX_MS = 8000;
/** Round captured samples/dB to keep the downloaded JSON small (detection is
 * unaffected at this precision — the detectors read coarse features). */
const rTime = (x: number): number => Math.round(x * 1e5) / 1e5;
const rDb = (x: number): number => Math.round(x * 10) / 10;

/** Reset all screen-local state on entry + force the engine passes on (AC#8). */
function enterTestScreen(): void {
  // Force the spectral + formant passes ON so every detector has data even with
  // the default config (rung2 off, showLetter off). Transient — showScreen()
  // restores config-driven flags via applyEngineFlags() when we leave.
  audio.setPhoneticEnabled(true);
  audio.setRung2Enabled(true);
  testLetterIndicator.reset();
  testAccumulator.reset();
  testTally.reset();
  testReleaseRing.length = 0;
  testBaseline = null;
  testCalibrating = false;
  testTarget = "а";
  testBurstAgoMs = Infinity;
  testGlyph.textContent = "—";
  testCalibHint.textContent = "нужна калибровка";
  cancelTestRecording();
  renderTestTarget();
  renderTestTally();
}

// ---- offline capture (#24) ----
/** Start recording raw frames into a fresh clip. */
function startTestRecording(): void {
  testRecording = true;
  testClipFrames = [];
  testRecordMs = 0;
  testRecordBtn.textContent = "■ стоп";
  testRecordBtn.classList.add("recording");
}

/** Stop recording without downloading (screen leave / reset). */
function cancelTestRecording(): void {
  testRecording = false;
  testClipFrames = [];
  testRecordMs = 0;
  testRecordBtn.textContent = "● запись";
  testRecordBtn.classList.remove("recording");
  testRecordStatus.textContent = "локально, без загрузки — для офлайн-настройки";
}

/** Stop recording and offer the captured clip as a local JSON download. */
function finishTestRecording(): void {
  testRecording = false;
  testRecordBtn.textContent = "● запись";
  testRecordBtn.classList.remove("recording");
  const frames = testClipFrames;
  testClipFrames = [];
  if (frames.length === 0) {
    testRecordStatus.textContent = "нет кадров";
    return;
  }
  const label = testClipLabel.value as CoarseLabel;
  const clip: DetectionClip = {
    version: CLIP_VERSION,
    label,
    sampleRate: audio.getSampleRate(),
    fftSize: audio.getFrameSize(),
    binCount: audio.getBinCount(),
    assist: config.assist,
    baseline: testBaseline,
    frames,
  };
  downloadClip(clip);
  testRecordStatus.textContent = `готово: ${frames.length} кадров → ${clipFilename(label)}`;
}

/** Timestamped, date-upfront download name so a folder of captures sorts by time. */
function clipFilename(label: CoarseLabel): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours(),
  )}${p(d.getMinutes())}`;
  return `${stamp}_${label}.json`;
}

/** Trigger a browser download of the clip JSON (no upload; revoked after click). */
function downloadClip(clip: DetectionClip): void {
  const blob = new Blob([serializeClip(clip)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = clipFilename(clip.label);
  a.click();
  URL.revokeObjectURL(url);
}

/** Begin sampling a fresh screen-local baseline from a held «ААА». */
function startTestCalibration(): void {
  testCalibrating = true;
  tcF1 = [];
  tcF2 = [];
  tcCentroid = [];
  tcElapsedMs = 0;
  testAccumulator.reset(); // the calibration hold is not a scoring attempt
  testCalibHint.textContent = "держи «ААА»…";
}

/** Finalize calibration: store the mean into the SCREEN-LOCAL baseline only. */
function finishTestCalibration(): void {
  testCalibrating = false;
  const f1 = mean(tcF1);
  const f2 = mean(tcF2);
  if (tcF1.length >= 12 && f1 > 0 && f2 > 0) {
    testBaseline = { centroid: mean(tcCentroid), f1, f2 };
    testCalibHint.textContent = "калибровка готова ✓";
  } else {
    testBaseline = null; // too few valid samples — keep the letter at «—»
    testCalibHint.textContent = "мало данных — ещё раз";
  }
  testLetterIndicator.reset();
}

/** Cycle а→о→у→и→Т→а; switching target resets the tally + any half-burst (AC#5). */
function cycleTestTarget(): void {
  const i = TEST_TARGETS.indexOf(testTarget);
  testTarget = TEST_TARGETS[(i + 1) % TEST_TARGETS.length];
  testTally.reset();
  testAccumulator.reset();
  renderTestTarget();
  renderTestTally();
}

/** Display glyph for a target/detected label (vowels upper-cased; Т/«—» as-is). */
function testLabelGlyph(l: Detected): string {
  return l === "Т" || l === "—" ? l : l.toUpperCase();
}

/** The confusion columns to show for the current target. */
function testConfusionLabels(): Detected[] {
  return testTarget === "Т" ? ["Т", "—"] : ["а", "о", "у", "и", "—"];
}

function renderTestTarget(): void {
  testTargetEl.textContent = testLabelGlyph(testTarget);
}

function renderTestTally(): void {
  const t = testTally.snapshot();
  const pct = t.total > 0 ? Math.round((t.hits / t.total) * 100) : 0;
  testScoreLine.textContent = `${t.hits} / ${t.total} · ${pct}%`;
  testConfusion.textContent = testConfusionLabels()
    .map((l) => `${testLabelGlyph(l)}:${t.confusion[l]}`)
    .join("   ");
}

/**
 * The test screen's per-frame work (the ONLY new call site in loop(), so play's
 * hot path is untouched — AC#10). Runs every screen-local detector, feeds the
 * scorer, and paints the readout.
 */
function renderSoundTest(frame: AudioFrame, dtMs: number): void {
  const formants = { f1: frame.f1, f2: frame.f2 };

  // Inline calibration: sample her fresh F1/F2/centroid until ≥12 valid frames
  // or a 3 s cap, whichever first (mic-check's voiced && level>0.2 rule).
  if (testCalibrating) {
    tcElapsedMs += dtMs;
    if (frame.voiced && frame.level > 0.2) {
      tcCentroid.push(frame.centroid);
      if (frame.f1 > 0 && frame.f2 > 0) {
        tcF1.push(frame.f1);
        tcF2.push(frame.f2);
      }
    }
    if (tcF1.length >= 12 || tcElapsedMs >= 3000) finishTestCalibration();
  }

  // 1) live vowel bars (raw per-vowel scores) + the smoothed, gated letter.
  const cls = classifyVowel(formants, testBaseline);
  const gated = testLetterIndicator.update(
    formants,
    frame.level,
    frame.voiced,
    testBaseline,
    dtMs,
  );
  for (const v of TEST_VOWELS) {
    testBarFills[v]!.style.width = `${Math.round(cls.scores[v] * 100)}%`;
  }
  testGlyph.textContent = gated.vowel ? gated.vowel.toUpperCase() : "—";

  // 2) consonant class over the rolling ReleaseFrame ring.
  testReleaseRing.push({ voiced: frame.voiced, zcr: frame.zcr });
  if (testReleaseRing.length > TEST_RING_LEN) testReleaseRing.shift();
  const cclass = classifyConsonant(testReleaseRing);

  // 3) stop-burst flash + "last burst N мс назад" (held ~200 ms so a single-frame
  // event is visible).
  testBurstAgoMs = frame.stopBurst ? 0 : testBurstAgoMs + dtMs;
  const burstHot = testBurstAgoMs <= 200;
  const burstAgo =
    testBurstAgoMs === Infinity ? "—" : `${Math.round(testBurstAgoMs)} мс назад`;

  // 4) scalar feature readout (reuse dbgBar formatting).
  testReadout.textContent =
    `vowelLike ${frame.vowelLikeness.toFixed(2)} ${dbgBar(frame.vowelLikeness)}\n` +
    `      zcr ${frame.zcr.toFixed(2)} ${dbgBar(frame.zcr)}\n` +
    ` centroid ${Math.round(frame.centroid)} Hz ${dbgBar(Math.min(1, frame.centroid / 4000))}\n` +
    `  lowBand ${frame.lowBandRatio.toFixed(2)} ${dbgBar(frame.lowBandRatio)}\n` +
    `    F1/F2 ${Math.round(frame.f1)} / ${Math.round(frame.f2)} Hz\n` +
    `    класс ${cclass}\n` +
    `      «Т» ${burstHot ? "СТОП-ВЗРЫВ ✓" : "·"}  (${burstAgo})`;
  testReadout.classList.toggle("burst-hot", burstHot);

  // 5) scoring: feed the accumulator; a closed valid attempt is scored + tallied.
  // Skip while calibrating — the calibration hold is not an attempt.
  if (!testCalibrating) {
    const attempt = testAccumulator.push({
      dtMs,
      level: frame.level,
      voiced: frame.voiced,
      onset: frame.onset,
      release: frame.release,
      gatedVowel: gated.vowel,
      stopBurst: frame.stopBurst,
    });
    if (attempt) {
      testTally.record(testTarget, burstVerdict(attempt.frames, testTarget));
      renderTestTally();
    }
  }

  // 6) offline capture (#24): while recording, snapshot the raw buffers into the
  // clip. Off the play hot path (test screen only); auto-stops at the cap.
  if (testRecording) captureTestFrame(dtMs);
}

/** Push one raw frame onto the recording, updating the status; auto-stop + download
 * at {@link TEST_RECORD_MAX_MS}. Reads the engine buffers filled by this frame's
 * `sample()` (already called at the top of the loop), so it needs no frame arg. */
function captureTestFrame(dtMs: number): void {
  const { time, freqDb } = audio.captureRawFrame();
  testClipFrames.push({
    dtMs,
    time: Array.from(time, rTime),
    freq: Array.from(freqDb, rDb),
  });
  testRecordMs += dtMs;
  testRecordStatus.textContent =
    `● запись ${(testRecordMs / 1000).toFixed(1)}с · ${testClipFrames.length} кадров ` +
    `(${testClipLabel.value})`;
  if (testRecordMs >= TEST_RECORD_MAX_MS) finishTestRecording();
}

// ---------- dino toy (issue #30) ----------
// A no-goal, no-fail reactive screen: the child makes any sound, and on her pause
// a 🦖 roars back. All the decision logic is the pure `stepRoar`; here we only
// feed it the live `level` + dt + the shared assist dial, play the roar when it
// fires, and paint the view. The lockout inside `stepRoar` suppresses input for
// the roar's full length, so the roar's own audio over the (echo-cancellation-off)
// speakers can never start a new voicing or a second roar (AC#5, AC#9).
const roarCfg: RoarToyCfg = { ...DEFAULT_ROAR_CFG, lockoutMs: ROAR_TOTAL_MS };
let roarState: RoarStateT = initRoar();

/** The dino screen's per-frame work — the 2nd new loop() call site after
 * renderSoundTest, so play's hot path is untouched (AC#10). */
function renderDino(frame: AudioFrame, dtMs: number): void {
  const res = stepRoar(roarState, frame.level, dtMs, config.assist, roarCfg);
  roarState = res.state;
  if (res.roar) playRoar(res.intensity); // fires only in the pause, then locks out
  dino.draw(roarState, frame.level, res.roar, dtMs);
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
  } else if (current === "test") {
    renderSoundTest(frame, dt);
  } else if (current === "dino") {
    renderDino(frame, dt);
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
  if (current === "dino") dino.resize();
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

// Deep-link (#22): `?test=1` opens the detection-test screen directly. It needs a
// running mic, so if one isn't up yet we request it (routing to the test screen on
// grant, the shared denied screen on refusal) instead of the normal mic-check. It
// composes with the other params — `?test=1&scene=vot&debug=1` all coexist, since
// writeSceneParam only ever touches `scene` and this only READS `test`.
const urlTest = new URLSearchParams(location.search).has("test");
if (urlTest) {
  if (audio.isRunning) {
    showScreen("test");
  } else {
    onMicReady = () => showScreen("test");
    beginMic();
  }
}

// Deep-link (#30): `?dino=1` opens the reactive dino toy directly (mirrors the
// `?test` handling above). `test` wins if both are present. Like `?test` it only
// READS its param, so it composes with `?scene`/`?debug`.
const urlDino = new URLSearchParams(location.search).has("dino");
if (urlDino && !urlTest) {
  pendingPlay = "dino";
  if (audio.isRunning) {
    showScreen("dino");
  } else {
    onMicReady = () => showScreen("dino");
    beginMic();
  }
}

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
