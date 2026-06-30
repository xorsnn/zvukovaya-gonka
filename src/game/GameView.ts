import type { AudioFrame } from "../audio/AudioEngine";
import type { WordScene } from "./types";
import type { MatchState, PatternMatcher } from "./PatternMatcher";
import { playCelebration, playPop } from "./sfx";

type GameState = "play" | "pounce" | "celebrate";

interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  size: number;
  color: string;
  shape: 0 | 1; // 0 = rect, 1 = circle
}

interface Heart {
  x: number;
  y: number;
  vy: number;
  life: number;
  size: number;
}

const CONFETTI_COLORS = [
  "#ff5d73",
  "#ffd23f",
  "#3ad6a0",
  "#4aa8ff",
  "#b66dff",
  "#ff9f4a",
];

// --- chase tuning ---
const PRECHASE_CAP = 0.9; // cat closes most of the gap on sustain...
const POUNCE_READY = 0.8; // ...and once this close, any burst/stop catches.
const CHASE_RATE = 1.0; // progress per second at full loudness
const MIN_VOICED_DRIVE = 0.25; // (loudness path) any voicing moves the cat ≥ this
/** (phonetic path) the cat ALWAYS runs at least this fast on genuine voicing —
 * leniency invariant #1. A clearer vowel adds the rest up to full speed. */
export const MIN_FLOOR = 0.15;
/** (phonetic path) once the vowel hold is satisfied, how fast the cat closes the
 * last of the gap so the pounce always leaps from right behind the mouse. */
const HOLD_CLOSE_RATE = 3.0;

/**
 * One step of the "play" state, factored out as a pure function so the drive +
 * pounce-gating logic is unit-testable without a canvas (node env).
 *
 * - With a `match` (phonetic path): speed = `MIN_FLOOR + (1-MIN_FLOOR)*driveQuality`.
 *   The catch gate is `match.caught` (a real vowel hold + a genuine stop) — NOT
 *   chase proximity, because a 600 ms hold may not have pushed `progress` to
 *   `POUNCE_READY` yet, and `caught` is a one-shot edge. Instead, once the hold
 *   is satisfied the cat surges to `PRECHASE_CAP`, so by the time the stop fires
 *   it is already poised behind the mouse. This is what makes AC#3 reliable.
 * - With `match === null` (no rung enabled, or a scene with no matcher): the
 *   EXACT pre-#1 behavior — speed = `max(MIN_VOICED_DRIVE, level)`, catch on any
 *   `onset || release` once `progress >= POUNCE_READY`. This identity is what
 *   makes the kill-switch a true rollback (AC#5).
 */
export interface PlayStep {
  progress: number;
  pounce: boolean;
}

export function stepPlay(
  prev: number,
  frame: AudioFrame,
  dts: number,
  match: MatchState | null,
  inputEnabled: boolean,
): PlayStep {
  let progress = prev;
  if (inputEnabled && frame.voiced) {
    const drive = match
      ? MIN_FLOOR + (1 - MIN_FLOOR) * match.driveQuality
      : Math.max(MIN_VOICED_DRIVE, frame.level);
    progress = Math.min(PRECHASE_CAP, prev + drive * CHASE_RATE * dts);
  }
  // Hold satisfied → cat closes in and poises (continues even through the final
  // silent gap, so the pounce leaps from close regardless of how loud she was).
  if (match && inputEnabled && match.holdSatisfied) {
    progress = Math.max(progress, Math.min(PRECHASE_CAP, prev + HOLD_CLOSE_RATE * dts));
  }
  let pounce = false;
  if (inputEnabled) {
    pounce = match
      ? match.caught
      : progress >= POUNCE_READY && (frame.onset || frame.release);
  }
  return { progress, pounce };
}

/**
 * GameView renders one chase scene to a canvas and drives it entirely from the
 * audio loudness envelope.
 *
 * The loop:
 *   1. play     — child voices → cat chases mouse (gap closes with sustain).
 *   2. pounce   — once close, a burst ("Т") OR simply stopping triggers a leap.
 *   3. celebrate— cat & mouse become friends: hearts, confetti, happy sound.
 *
 * There is no fail state. Pauses don't lose progress. Any acoustic event near
 * the end finishes the catch. Leniency is the whole point.
 */
export class GameView {
  readonly canvas: HTMLCanvasElement;
  state: GameState = "play";
  /** Set by the host to react when the catch celebration begins. */
  onCatch: (() => void) | null = null;
  /** When false, voiced input is ignored (e.g. while TTS is modelling word). */
  inputEnabled = true;

  private ctx: CanvasRenderingContext2D;
  private scene: WordScene;

  /** Phonetic shape matcher for the active round; null = loudness-only path. */
  private matcher: PatternMatcher | null = null;
  /** Latest matcher verdict (for the prompt highlight); null on loudness path. */
  private lastMatch: MatchState | null = null;

  private progress = 0; // 0..1 chase progress
  private displayProgress = 0; // smoothed for rendering
  private moving = 0; // 0..1 how "running" the cat looks right now

  private pounceElapsed = 0;
  private pounceFromX = 0;
  private celebrateElapsed = 0;

  private confetti: Confetti[] = [];
  private hearts: Heart[] = [];

  // cached layout (CSS px)
  private w = 0;
  private h = 0;

  constructor(scene: WordScene) {
    this.scene = scene;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "game-canvas";
    this.ctx = this.canvas.getContext("2d")!;
  }

  setScene(scene: WordScene): void {
    this.scene = scene;
    this.reset();
  }

  getScene(): WordScene {
    return this.scene;
  }

  /**
   * Install (or clear) the phonetic matcher for this round. Pass `null` to use
   * the loudness-only path (no rung enabled, or a scene without a matcher).
   */
  setMatcher(matcher: PatternMatcher | null): void {
    this.matcher = matcher;
    this.lastMatch = null;
  }

  /** Latest matcher verdict, for the debug overlay (null on the loudness path). */
  get debugMatch(): MatchState | null {
    return this.lastMatch;
  }

  /** Smoothed chase progress 0..1, for host UI (prompt highlight). */
  get chaseProgress(): number {
    return this.displayProgress;
  }

  /**
   * True once the catch is imminent, for the "say Т / now stop" hint. On the
   * phonetic path this means the vowel hold is satisfied (a stop will now
   * catch); on the loudness path it falls back to chase proximity.
   */
  get nearPounce(): boolean {
    if (this.matcher) return this.lastMatch?.holdSatisfied ?? false;
    return this.displayProgress >= POUNCE_READY - 0.08;
  }

  reset(): void {
    this.state = "play";
    this.progress = 0;
    this.displayProgress = 0;
    this.moving = 0;
    this.pounceElapsed = 0;
    this.celebrateElapsed = 0;
    this.confetti = [];
    this.hearts = [];
    this.matcher?.reset();
    this.lastMatch = null;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Advance + draw one frame. dt in ms. */
  step(frame: AudioFrame, now: number, dt: number): void {
    const dts = Math.min(0.05, dt / 1000);

    if (this.state === "play") this.updatePlay(frame, dts);
    else if (this.state === "pounce") this.updatePounce(dt);
    else this.updateCelebrate(dt);

    this.displayProgress += (this.progress - this.displayProgress) * 0.25;
    this.draw(now);
  }

  // ---- state updates ----

  private updatePlay(frame: AudioFrame, dts: number): void {
    // Advance the matcher only while we're actually listening, so the modelled
    // word (TTS) can't accumulate a hold. Null match → loudness-only path.
    const match =
      this.matcher && this.inputEnabled
        ? this.matcher.update(frame, dts * 1000)
        : null;
    this.lastMatch = match;

    const res = stepPlay(this.progress, frame, dts, match, this.inputEnabled);
    this.progress = res.progress;

    // Cosmetic running animation tracks whether the child is driving the cat.
    const driving = this.inputEnabled && frame.voiced;
    this.moving = driving
      ? Math.min(1, this.moving + dts * 6)
      : Math.max(0, this.moving - dts * 4);

    if (res.pounce) this.startPounce();
  }

  private startPounce(): void {
    this.state = "pounce";
    this.pounceElapsed = 0;
    this.pounceFromX = this.catX(this.displayProgress);
    playPop();
  }

  private updatePounce(dt: number): void {
    this.pounceElapsed += dt;
    if (this.pounceElapsed >= 480) {
      this.state = "celebrate";
      this.celebrateElapsed = 0;
      this.spawnConfetti();
      playCelebration();
      if (this.onCatch) this.onCatch();
    }
  }

  private updateCelebrate(dt: number): void {
    this.celebrateElapsed += dt;
    // physics for confetti + hearts
    for (const p of this.confetti) {
      p.vy += 0.4;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.vx *= 0.99;
    }
    this.confetti = this.confetti.filter((p) => p.y < this.h + 40);
    for (const ht of this.hearts) {
      ht.y += ht.vy;
      ht.life -= dt;
    }
    this.hearts = this.hearts.filter((ht) => ht.life > 0);
    // periodically emit a heart from the happy pair
    if (this.celebrateElapsed % 360 < dt) this.spawnHeart();
  }

  private spawnConfetti(): void {
    const cx = this.w * 0.6;
    const cy = this.h * 0.45;
    for (let i = 0; i < 140; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 11;
      this.confetti.push({
        x: cx + (Math.random() - 0.5) * 60,
        y: cy + (Math.random() - 0.5) * 40,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 6,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.4,
        size: 7 + Math.random() * 9,
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        shape: Math.random() > 0.5 ? 1 : 0,
      });
    }
  }

  private spawnHeart(): void {
    const x = this.w * (0.55 + Math.random() * 0.12);
    this.hearts.push({
      x,
      y: this.h * 0.5,
      vy: -1.4 - Math.random(),
      life: 1400,
      size: 22 + Math.random() * 16,
    });
  }

  // ---- geometry ----

  private get groundY(): number {
    return this.h * 0.72;
  }

  private catX(p: number): number {
    return this.w * (0.13 + 0.47 * p);
  }

  private mouseX(p: number): number {
    const gap = 0.26 - 0.2 * p; // gap shrinks as cat closes in
    return this.catX(p) + this.w * gap;
  }

  // ---- drawing ----

  private draw(now: number): void {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    this.drawMeadow(now);

    const p = this.displayProgress;
    const charSize = Math.min(h * 0.2, w * 0.16);

    let catDrawX = this.catX(p);
    let catDrawY = this.groundY;
    const mouseDrawX = this.mouseX(p);
    let mouseDrawY = this.groundY;
    let caught = false;

    if (this.state === "pounce") {
      const t = Math.min(1, this.pounceElapsed / 480);
      const ease = t * t * (3 - 2 * t);
      catDrawX = this.pounceFromX + (mouseDrawX - this.pounceFromX) * ease;
      catDrawY = this.groundY - Math.sin(Math.PI * t) * h * 0.22;
    } else if (this.state === "celebrate") {
      caught = true;
      const bob = Math.sin(now / 140) * h * 0.03;
      const bob2 = Math.sin(now / 140 + 1) * h * 0.03;
      catDrawX = mouseDrawX - charSize * 0.55;
      catDrawY = this.groundY + bob;
      mouseDrawY = this.groundY + bob2;
    }

    // shadows
    this.drawShadow(catDrawX, this.groundY, charSize);
    if (!caught) this.drawShadow(mouseDrawX, this.groundY, charSize * 0.7);

    // dust/motion behind the running cat
    if (this.moving > 0.1 && this.state === "play") {
      this.drawDust(catDrawX, this.groundY, charSize, now, this.moving);
    }

    // the fleer (mouse) — only while not yet caught
    if (!caught) {
      const flee = this.moving * (this.state === "play" ? 1 : 0);
      const bob = Math.sin(now / 90) * charSize * 0.05 * (0.5 + flee);
      this.drawChar(this.scene.fleer, mouseDrawX, mouseDrawY - bob, charSize * 0.72, {
        lean: -0.12 * flee,
        squash: 0,
        flip: false,
      });
    }

    // the chaser (cat)
    if (this.state === "celebrate") {
      this.drawChar(this.scene.chaser, catDrawX, catDrawY, charSize, {
        lean: 0,
        squash: 0,
        flip: false,
      });
      // the friendly caught mouse, snuggled next to the cat
      this.drawChar(this.scene.fleer, mouseDrawX + charSize * 0.15, mouseDrawY, charSize * 0.6, {
        lean: 0,
        squash: 0,
        flip: true,
      });
    } else {
      const lean = (this.moving + (this.state === "pounce" ? 1 : 0)) * 0.18;
      const bob = Math.sin(now / 80) * charSize * 0.05 * this.moving;
      const squash = this.state === "pounce" ? 0.1 : 0;
      this.drawChar(this.scene.chaser, catDrawX, catDrawY - bob, charSize, {
        lean,
        squash,
        flip: false,
      });
    }

    // celebration extras
    this.drawConfetti();
    this.drawHearts();
  }

  private drawMeadow(now: number): void {
    const { ctx, w, h } = this;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#aee6ff");
    sky.addColorStop(0.7, "#d8f4ff");
    sky.addColorStop(1, "#eafff0");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // sun
    ctx.fillStyle = "#fff1a8";
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 0.16, Math.min(w, h) * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,241,168,0.35)";
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 0.16, Math.min(w, h) * 0.13, 0, Math.PI * 2);
    ctx.fill();

    // drifting clouds
    this.drawCloud(w * 0.2 + ((now / 90) % (w + 200)) - 100, h * 0.2, Math.min(w, h) * 0.05);
    this.drawCloud(w * 0.6 + ((now / 130) % (w + 200)) - 100, h * 0.13, Math.min(w, h) * 0.04);

    // ground
    const gy = this.groundY + Math.min(w, h) * 0.06;
    const ground = ctx.createLinearGradient(0, gy - 40, 0, h);
    ground.addColorStop(0, "#9be86a");
    ground.addColorStop(1, "#5bbf45");
    ctx.fillStyle = ground;
    ctx.fillRect(0, gy, w, h - gy);

    // little flowers along the ground for cheer
    ctx.font = `${Math.round(Math.min(w, h) * 0.045)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 6; i++) {
      const fx = ((i * 0.17 + 0.06) * w);
      ctx.fillText(i % 2 ? "🌼" : "🌸", fx, gy + (h - gy) * 0.45);
    }
  }

  private drawCloud(x: number, y: number, r: number): void {
    const { ctx } = this;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r, y + r * 0.2, r * 0.8, 0, Math.PI * 2);
    ctx.arc(x - r, y + r * 0.2, r * 0.8, 0, Math.PI * 2);
    ctx.arc(x + r * 0.4, y - r * 0.4, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawShadow(x: number, groundY: number, size: number): void {
    const { ctx } = this;
    ctx.fillStyle = "rgba(40,80,30,0.18)";
    ctx.beginPath();
    ctx.ellipse(x, groundY + size * 0.42, size * 0.4, size * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawDust(x: number, groundY: number, size: number, now: number, intensity: number): void {
    const { ctx } = this;
    ctx.fillStyle = `rgba(180,150,90,${0.25 * intensity})`;
    for (let i = 0; i < 3; i++) {
      const t = (now / 120 + i * 0.5) % 1;
      const dx = -size * (0.3 + t * 0.5);
      const r = size * 0.12 * (1 - t) * intensity;
      if (r <= 0) continue;
      ctx.beginPath();
      ctx.arc(x + dx, groundY + size * 0.35 - t * size * 0.2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawChar(
    glyph: string,
    x: number,
    y: number,
    size: number,
    opts: { lean: number; squash: number; flip: boolean },
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(opts.lean);
    const sx = (opts.flip ? -1 : 1) * (1 + opts.squash);
    const sy = 1 - opts.squash;
    ctx.scale(sx, sy);
    // Color emoji honour the fillStyle's alpha on some platforms (e.g. Linux
    // Chrome). Without this, the glyph inherits the translucent rgba left over
    // from drawShadow/drawDust and renders as a ghost. Force opaque.
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.font = `${Math.round(size)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(glyph, 0, size * 0.36);
    ctx.restore();
  }

  private drawConfetti(): void {
    const { ctx } = this;
    for (const p of this.confetti) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 1) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size * 0.5, -p.size * 0.3, p.size, p.size * 0.6);
      }
      ctx.restore();
    }
  }

  private drawHearts(): void {
    const { ctx } = this;
    for (const ht of this.hearts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, ht.life / 1400));
      ctx.font = `${Math.round(ht.size)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("❤️", ht.x, ht.y);
    }
    ctx.globalAlpha = 1;
  }
}
