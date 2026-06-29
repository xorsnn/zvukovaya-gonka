import "./style.css";
import { AudioEngine, USE_PHONETIC } from "./audio/AudioEngine";
import { MeterView } from "./game/MeterView";
import { GameView } from "./game/GameView";
import { PatternMatcher, MIN_HOLD_THRESHOLD } from "./game/PatternMatcher";
import { DEFAULT_WORD } from "./game/words";
import { speakWord } from "./game/sfx";

type Screen = "start" | "check" | "denied" | "game";

const app = document.getElementById("app")!;
const audio = new AudioEngine();
const meter = new MeterView();
const game = new GameView(DEFAULT_WORD);

// ---------- build the DOM ----------

app.innerHTML = `
  <section class="screen start active" data-screen="start">
    <h1 class="big-title">Гонка<br/>звуков</h1>
    <div class="emoji-row"><span class="chase">🐱</span><span class="flee">🐭</span></div>
    <p class="subtitle">Скажи звук — и котик побежит! 🎤</p>
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
      <label class="assist-control" id="assistControl">
        <span class="assist-cap">строго</span>
        <input type="range" id="assistSlider" min="0" max="1" step="0.1" value="0.5" aria-label="Строгость распознавания" />
        <span class="assist-cap">легче</span>
      </label>
      <button class="parent-link" id="recalBtn">⚙ микрофон</button>
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
const assistControl = el<HTMLElement>("#assistControl");
const assistSlider = el<HTMLInputElement>("#assistSlider");
const checkHint = el<HTMLElement>("#checkHint");
const celebrate = el<HTMLElement>("#celebrate");
const sustainEl = el<HTMLElement>("#sustainEl");
const burstEl = el<HTMLElement>("#burstEl");
const hintEl = el<HTMLElement>("#hintEl");
const deniedTitle = el<HTMLElement>("#deniedTitle");
const deniedText = el<HTMLElement>("#deniedText");

// fill in word content
sustainEl.textContent = game.getScene().sustainPart;
burstEl.textContent = game.getScene().burstPart;
hintEl.textContent = game.getScene().hint;

// ---------- phonetic ladder (issue #1) ----------
// The whole layer hides behind USE_PHONETIC: off → no matcher, no slider, and
// the game runs exactly as the shipped loudness-only build.

/** 0 = strict grading, 1 = easy (close to today's loudness-only feel). */
let assist = 0.5;
/** Hold threshold for vowel-likeness; tightened/relaxed by mic-check calibration. */
let calibHoldThreshold = MIN_HOLD_THRESHOLD;
/** The matcher for the active round (rebuilt each round from the latest config). */
let matcher: PatternMatcher | null = null;

// Per-session vowel-baseline calibration, sampled while the child makes sound on
// the mic-check screen. A 3-yr-old's formants are high, so we score her centroid
// relative to her own voice (see the age note in #1) instead of an adult number.
let calibVowel: number[] = [];
let calibCentroid: number[] = [];

function resetCalibrationSamples(): void {
  calibVowel = [];
  calibCentroid = [];
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
  if (!USE_PHONETIC) return;
  if (calibVowel.length >= 12) {
    audio.setVowelBaseline({ centroid: mean(calibCentroid) });
    calibHoldThreshold = Math.max(MIN_HOLD_THRESHOLD, mean(calibVowel) * 0.6);
  } else {
    audio.setVowelBaseline(null);
    calibHoldThreshold = MIN_HOLD_THRESHOLD;
  }
}

/** (Re)build the matcher for the current scene; null when phonetics are off. */
function buildMatcher(): void {
  if (!USE_PHONETIC) {
    matcher = null;
    game.setMatcher(null);
    return;
  }
  matcher = new PatternMatcher(game.getScene().pattern, {
    assist,
    holdThreshold: calibHoldThreshold,
  });
  game.setMatcher(matcher);
}

// The assist slider is meaningless without the phonetic layer — hide it then.
if (!USE_PHONETIC) assistControl.style.display = "none";
assistSlider.addEventListener("input", () => {
  assist = parseFloat(assistSlider.value);
  matcher?.setAssist(assist);
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
    // Sample her sustained-vowel baseline while she makes sound (issue #1).
    if (USE_PHONETIC && frame.voiced && frame.level > 0.2) {
      calibVowel.push(frame.vowelLikeness);
      calibCentroid.push(frame.centroid);
      // Cap so a long mic-check can't grow these unbounded.
      if (calibVowel.length > 240) {
        calibVowel.shift();
        calibCentroid.shift();
      }
    }
  } else if (current === "game") {
    game.step(frame, now, dt);
    updateWordHighlight(frame);
  }

  requestAnimationFrame(loop);
}

function updateWordHighlight(frame: { voiced: boolean }): void {
  if (game.state === "play") {
    sustainEl.classList.toggle("active", frame.voiced && game.inputEnabled);
    burstEl.classList.toggle("hot", game.nearPounce);
  } else {
    sustainEl.classList.remove("active");
    burstEl.classList.remove("hot");
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
