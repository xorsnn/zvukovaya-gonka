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
 * the cat's own FORWARD drive never drops below this. Its NET progress, though,
 * is now assist-scaled (#12): at the strict end the mouse can flee faster than
 * the floor, so the cat can still lose ground. A clearer vowel adds the rest up
 * to full speed. */
export const MIN_FLOOR = 0.15;
/** (phonetic path) once the vowel hold is satisfied, how fast the cat closes the
 * last of the gap so the pounce leaps from right behind the mouse. Lives only on
 * the EASY trajectory (#12): at the strict end the tug-of-war governs instead, so
 * the sustained right vowel itself has to have driven the cat in. */
const HOLD_CLOSE_RATE = 3.0;
/** (phonetic path, #12) how fast the mouse flees, at full strictness, in
 * progress/sec. The net drive is `catDrive − strictness·MOUSE_FLEE_RATE`. Sits
 * between a wrong-vowel/silence drive and a right-vowel drive, so at strict the
 * right vowel gains while a wrong vowel or silence loses. Placeholder pending the
 * real-mic tuning pass (#12, AC#6) — set with the child, not blind. */
export const MOUSE_FLEE_RATE = 0.4;

/**
 * One step of the "play" state, factored out as a pure function so the drive +
 * pounce-gating logic is unit-testable without a canvas (node env).
 *
 * Tug-of-war (#12): the cat's speed is `MIN_FLOOR + (1-MIN_FLOOR)·driveQuality`;
 * the catch gate is `match.caught` (a real vowel hold + a genuine stop/burst), a
 * one-shot edge. Difficulty is the single `assist` knob, expressed here as
 * `strictness = 1 - assist`, and implemented as a blend between two trajectories
 * whose endpoints are BOTH exact:
 * - the EASY trajectory — today's monotonic drive + the full `HOLD_CLOSE_RATE`
 *   hold-surge, no flee. At `strictness = 0` the result IS this, byte-for-byte
 *   (AC#1), and it is also the only path when `match === null` (the kill-switch).
 * - the STRICT trajectory — net `catDrive − MOUSE_FLEE_RATE`, clamped to
 *   `[0, PRECHASE_CAP]` and ALLOWED TO DECAY to 0 (the mouse escapes back to the
 *   start), with NO hold-surge floor, so a wrong vowel or silence lets the mouse
 *   gain even after the hold and sustained wrong input returns progress to 0 (AC#2).
 * `progress = lerp(easy, strict, strictness)`, so the slider's middle is a smooth
 * mix and the catch is gated on the «т» burst by the matcher toward strict (AC#3).
 *
 * With `match === null` (no rung enabled, or a scene with no matcher) only the
 * easy trajectory runs and there is no flee — the EXACT pre-#1 behavior: speed =
 * `max(MIN_VOICED_DRIVE, level)`, catch on any `onset || release` once
 * `progress >= POUNCE_READY`. That identity makes the kill-switch a true
 * rollback (AC#5).
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
  /** 0 = easy (no flee, monotonic) … 1 = strict (full tug-of-war). Derived from
   * the matcher's `assist` (`1 - assist`); 0 on the loudness path so AC#5 holds. */
  strictness = 0,
): PlayStep {
  let progress = prev;
  if (inputEnabled) {
    const catDrive = frame.voiced
      ? match
        ? MIN_FLOOR + (1 - MIN_FLOOR) * match.driveQuality
        : Math.max(MIN_VOICED_DRIVE, frame.level)
      : 0; // silence drives nothing — at strict the mouse then nets a gain

    // EASY trajectory: today's monotonic drive + the hold-surge that closes the
    // cat in and poises it (even through the final silent gap). This is what
    // strictness=0 yields VERBATIM (AC#1), and the only path on the loudness path
    // (match=null), so the kill-switch stays byte-for-byte the pre-#1 engine (AC#5).
    let easyProg = prev;
    if (frame.voiced) {
      easyProg = Math.min(PRECHASE_CAP, prev + catDrive * CHASE_RATE * dts);
    }
    if (match && match.holdSatisfied) {
      easyProg = Math.max(easyProg, Math.min(PRECHASE_CAP, prev + HOLD_CLOSE_RATE * dts));
    }

    if (!match) {
      progress = easyProg;
    } else {
      // STRICT trajectory: net = catDrive − MOUSE_FLEE_RATE, allowed to DECAY to 0
      // (the mouse escapes back to the start) and with NO hold-surge floor, so
      // silence/wrong input lets the mouse gain even after the hold (AC#2).
      const strictProg = Math.max(
        0,
        Math.min(PRECHASE_CAP, prev + (catDrive * CHASE_RATE - MOUSE_FLEE_RATE) * dts),
      );
      // The one assist knob slides between the two: easy at strictness 0, full
      // tug-of-war at 1, a smooth blend between. Both endpoints are exact.
      progress = easyProg + (strictProg - easyProg) * strictness;
    }
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
 * Pull mode (#16): how far the carrot has risen out of the soil, as a pure,
 * strictly-monotonic function of chase `progress` — 0 = buried (only the leaves
 * peek), 1 = free. Chase progress and carrot emergence are the SAME physics
 * (`stepPlay`), drawn differently; this only maps one to the other. The ease-out
 * `p·(2−p)` lurches the carrot up early then slows as it clears the ground, and
 * is strictly increasing on `[0, 1)` so more progress always shows more carrot
 * (unit-tested for monotonicity). Exported (like `stepPlay`) so it is testable
 * without a canvas.
 */
export function carrotDepth(progress: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return p * (2 - p);
}

/**
 * strictnessFor — the tug-of-war strictness (#18) for a scene's approach phase.
 *
 * A `release.want === "stop"` scene (кот/вот/кит) is now **forward-only**: since
 * the two-phase win makes the pause matter directly (only a real «т» finishes —
 * see {@link PatternMatcher}), the #12 mouse-flee is retired for it, so the actor
 * advances and then PARKS at the checkpoint waiting for the «т» — it never drifts
 * backward. Returns `0` there. Every other scene keeps the #12 tug-of-war,
 * `1 - assist`. Pure + exported so the forward-only guarantee (AC#6) is unit-
 * testable without a canvas. `stepPlay`'s math is unchanged — this only feeds it a
 * `strictness` of 0 for stop scenes, which is exactly its byte-for-byte easy path.
 */
export function strictnessFor(scene: WordScene, assist: number): number {
  return scene.pattern.release.want === "stop" ? 0 : 1 - assist;
}

/**
 * GameView renders one scene to a canvas — a chase (кот) or a pull (вот, #16) —
 * and drives it entirely from the audio loudness/phonetic envelope.
 *
 * The state machine, physics (`stepPlay`), particles, and the meadow/`drawChar`
 * helpers are shared across modes; only the `draw()` branch differs (`scene.type`):
 *   1. play     — child voices → the actor advances (cat closes on the mouse /
 *                 the rabbit raises the carrot) as the vowel sustains.
 *   2. pounce   — once armed, a burst ("Т") OR simply stopping triggers the beat:
 *                 the cat leaps / the carrot pops free.
 *   3. celebrate— the happy ending: cat & mouse become friends / the rabbit hugs
 *                 the freed carrot — hearts, confetti, happy sound.
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

  /**
   * True while parked at the two-phase checkpoint (#18) — a satisfied hold on a
   * Rung-3 "stop" scene, waiting for the «т». Drives the stronger "now say Т" cue
   * (host chip); false on non-stop / rung3-off / loudness paths.
   */
  get armedForBurst(): boolean {
    return this.lastMatch?.armedForBurst ?? false;
  }

  /**
   * Debug jump (#18): land the round in the armed/parked checkpoint so the next
   * «т» wins — lets the armed «т» be tuned against real pauses without re-doing the
   * vowel each attempt. No-op unless we're mid-play with a matcher; the host binds
   * it to the `k` key behind the debug flag only.
   */
  debugArmCheckpoint(): void {
    if (this.state !== "play" || !this.matcher) return;
    this.matcher.forceHoldSatisfied();
    this.progress = Math.max(this.progress, PRECHASE_CAP);
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

    // Strictness sets the mouse's flee speed (#12). Per-scene now (#18):
    // `strictnessFor` returns 0 for a "stop" scene (forward-only — the actor parks
    // at the checkpoint and waits for the «т» instead of fleeing), else 1 - assist.
    // Still 0 with no matcher (loudness path) so AC#5's byte-for-byte holds.
    const strictness = this.matcher ? strictnessFor(this.scene, this.matcher.assist) : 0;
    const res = stepPlay(this.progress, frame, dts, match, this.inputEnabled, strictness);
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

    // Shared shell → mode-specific actors (#16). The state machine, physics,
    // particles, meadow, and drawChar helpers are common to every scene; only the
    // picture branches on `scene.type`.
    if (this.scene.type === "pull") this.drawPull(now);
    else this.drawChase(now);

    // Two-phase checkpoint cue (#18): once armed and parked, a shared "now say Т"
    // badge lights over the goal — the visible "you're almost there" moment. Only
    // while waiting for the «т» (armedForBurst), so дом / non-stop scenes never see it.
    if (this.state === "play" && this.armedForBurst) this.drawWaitCue(now);

    // celebration extras (shared across modes)
    this.drawConfetti();
    this.drawHearts();
  }

  /**
   * The "now say Т" checkpoint cue (#18): a gentle pulsing badge carrying the
   * scene's target letter, over the goal (the mouse / the carrot) — where the «т»
   * lands. Purely cosmetic; it drives nothing (the win is still `match.caught`).
   * Warm and encouraging, never a countdown or a scold (no fail state).
   */
  private drawWaitCue(now: number): void {
    const { ctx, w, h } = this;
    const letter = this.scene.burstPart || "!";
    const charSize = Math.min(h * 0.2, w * 0.16);
    // Anchor over the goal: the fleeing mouse for a chase, the planted carrot for a pull.
    const gx = this.scene.type === "pull" ? w * 0.56 : this.mouseX(this.displayProgress);
    const gy = this.groundY - charSize * 0.95;
    const pulse = 0.5 + 0.5 * Math.sin(now / 240);
    const r = Math.min(w, h) * 0.05 * (1 + 0.12 * pulse);

    ctx.save();
    // soft halo
    ctx.fillStyle = `rgba(255,210,90,${0.22 + 0.16 * pulse})`;
    ctx.beginPath();
    ctx.arc(gx, gy, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    // badge
    ctx.fillStyle = "#ff8a3d";
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
    // the target letter
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, gx, gy + r * 0.06);
    ctx.restore();
  }

  /** Chase render path (кот): the cat closes on the mouse, leaps, then befriends it. */
  private drawChase(now: number): void {
    const { w, h } = this;
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
  }

  /**
   * Pull render path (вот, #16): a rabbit hauls a carrot out of a soil mound.
   * `carrotDepth(progress)` reads the SAME chase progress as how far the carrot
   * has risen — the mound (drawn opaque, over the carrot) occludes the buried
   * part, so a rising `progress` looks like the carrot emerging. The `pounce`
   * beat becomes the POP (the carrot leaps free, the rabbit tumbles back) and
   * `celebrate` is the rabbit hugging the freed carrot — reusing the shared
   * confetti/hearts verbatim.
   */
  private drawPull(now: number): void {
    const { w, h } = this;
    const size = Math.min(h * 0.2, w * 0.16);
    const cx = w * 0.56; // where the carrot is planted
    const soilY = this.groundY; // the surface it emerges through
    const e = carrotDepth(this.displayProgress);

    // carrot centre: buried (only the leaves peek above the low mound crest) →
    // free (fully out). The travel is large so a rising `progress` visibly hauls
    // the carrot clear of the soil rather than staying swallowed by the mound.
    const buriedY = soilY + size * 0.22;
    const freeY = soilY - size * 0.58;

    let carrotY = buriedY + (freeY - buriedY) * e;
    let carrotRot = 0;
    let rabbitX = cx - size * 0.66;
    let rabbitY = soilY;
    // the rabbit leans back harder the further the carrot has risen (straining)
    let rabbitLean = -0.14 - 0.28 * e;
    let planted = true; // carrot still in the mound → occlude its buried part
    let caught = false;

    if (this.state === "pounce") {
      // the POP: the carrot leaps free, the rabbit tumbles back
      const t = Math.min(1, this.pounceElapsed / 480);
      const ease = t * t * (3 - 2 * t);
      carrotY = freeY - Math.sin(Math.PI * t) * h * 0.3; // arcs up and settles
      carrotRot = ease * 0.7;
      rabbitLean = -0.14 - ease * 0.9;
      rabbitX = cx - size * 0.66 - ease * size * 0.55;
      rabbitY = soilY + ease * size * 0.16;
    } else if (this.state === "celebrate") {
      caught = true;
      const bob = Math.sin(now / 140) * h * 0.03;
      const bob2 = Math.sin(now / 140 + 1) * h * 0.03;
      carrotY = soilY - size * 0.3 + bob2; // held up, out of the ground
      rabbitX = cx - size * 0.5;
      rabbitY = soilY + bob;
      rabbitLean = 0;
      planted = false;
    } else {
      // straining wobble while the child sustains the vowel
      carrotY += Math.sin(now / 70) * size * 0.02 * this.moving;
      rabbitY += Math.sin(now / 80) * size * 0.04 * this.moving;
    }

    // the carrot first; the mound then paints over whatever is still buried
    this.drawChar(this.scene.fleer, cx, carrotY, size, {
      lean: carrotRot,
      squash: 0,
      flip: false,
    });

    // the dirt mound it's planted in — opaque, so its domed top IS the soil line
    if (planted) this.drawSoilMound(cx, soilY, size);

    // shadows for the above-ground actors (in front of the mound)
    this.drawShadow(rabbitX, soilY, size * 0.9);
    if (caught) this.drawShadow(cx, soilY, size * 0.7);

    // effort crumbs kicking up while the child strains
    if (this.moving > 0.1 && this.state === "play") {
      this.drawDust(cx - size * 0.2, soilY, size, now, this.moving);
    }

    // the rabbit, gripping in front of the mound
    this.drawChar(this.scene.chaser, rabbitX, rabbitY, size, {
      lean: rabbitLean,
      squash: 0,
      flip: false,
    });
  }

  /** The soil mound a pull-scene carrot is planted in (its domed top = the soil line). */
  private drawSoilMound(cx: number, soilY: number, size: number): void {
    const { ctx } = this;
    const rx = size * 0.82;
    // A LOW crest (so it occludes only the buried lower carrot, not the risen
    // body) over a deep base (so a buried carrot's tip never pokes out beneath it).
    const moundH = size * 0.05;
    const base = soilY + size * 0.9;
    const g = ctx.createLinearGradient(0, soilY - moundH, 0, base);
    g.addColorStop(0, "#b07a45");
    g.addColorStop(1, "#6f4423");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - rx, base);
    ctx.lineTo(cx - rx, soilY);
    ctx.quadraticCurveTo(cx, soilY - moundH * 2, cx + rx, soilY);
    ctx.lineTo(cx + rx, base);
    ctx.closePath();
    ctx.fill();
    // a soft crumbly rim across the dome for texture
    ctx.fillStyle = "rgba(60,38,18,0.28)";
    ctx.beginPath();
    ctx.moveTo(cx - rx, soilY);
    ctx.quadraticCurveTo(cx, soilY - moundH * 2, cx + rx, soilY);
    ctx.quadraticCurveTo(cx, soilY - moundH * 1.2, cx - rx, soilY);
    ctx.closePath();
    ctx.fill();
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
