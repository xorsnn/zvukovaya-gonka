import type { RoarStateT } from "./RoarToy";

/**
 * RoarView — the canvas for the reactive dinosaur toy (issue #30). Emoji + motion
 * only; no new art, no audio-file assets.
 *
 * It draws a 🦖 centered on the screen. While the child vocalizes the dino
 * **grows and leans in** live with her loudness (safe — video never feeds the
 * mic). When {@link RoarToy} fires a roar, the dino **pops open + shakes**, a
 * particle burst radiates, and a big «Р-Р-Р!» flashes; it all settles back to a
 * gentle idle bob.
 *
 * Like {@link MeterView}/{@link GameView} the class needs a real `<canvas>`, so it
 * is not unit-tested; the toy's decision logic lives in the DOM-free
 * {@link RoarToy} (`stepRoar`), which is. This view only smooths + paints.
 */

interface RoarParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number; // ms remaining
  max: number; // ms total
  color: string;
}

const BURST_COLORS = ["#ff7a59", "#ffd166", "#ff5d5d", "#f4a259", "#ffe08a"];
/** Idle dino size as a fraction of the smaller viewport edge. */
const IDLE_FRACTION = 0.3;
/** How much the live level can grow the dino above idle (fraction of edge). */
const LEVEL_GROWTH = 0.16;
/** Extra pop added to the size on a roar (fraction of edge), decays away. */
const ROAR_POP = 0.14;

export class RoarView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  private sizeFrac = IDLE_FRACTION; // smoothed dino size fraction
  private pop = 0; // roar size pop, 0..1, decays
  private shake = 0; // shake amplitude px, decays
  private roarText = 0; // «Р-Р-Р!» life 0..1, decays
  private bob = 0; // idle bob phase (accumulated ms)
  private particles: RoarParticle[] = [];

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "dino-canvas";
    this.ctx = this.canvas.getContext("2d")!;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Drop all transient motion (screen enter). */
  reset(): void {
    this.sizeFrac = IDLE_FRACTION;
    this.pop = 0;
    this.shake = 0;
    this.roarText = 0;
    this.bob = 0;
    this.particles = [];
  }

  /**
   * Paint one frame. `state` comes from {@link stepRoar}; `level` is the live
   * loudness (drives the grow-before-roar, AC#8); `roarFired` is true on the
   * frame the roar starts (spawns the burst); `dtMs` advances the decays/physics.
   */
  draw(state: RoarStateT, level: number, roarFired: boolean, dtMs: number): void {
    const { ctx } = this;
    const w = this.w || this.canvas.clientWidth;
    const h = this.h || this.canvas.clientHeight;
    const edge = Math.min(w, h);
    this.bob += dtMs;

    if (roarFired) this.startRoar(state.intensity, w, h);

    // Target size: idle, plus a live grow while she's voicing (AC#8), plus the
    // decaying roar pop. Roaring holds the pop; listening settles to idle.
    const voicing = state.phase === "voicing";
    const grow = voicing ? Math.max(0, Math.min(1, level)) * LEVEL_GROWTH : 0;
    const targetFrac = IDLE_FRACTION + grow + this.pop * ROAR_POP;
    this.sizeFrac += (targetFrac - this.sizeFrac) * Math.min(1, dtMs / 90);

    // Decay the roar transients.
    this.pop = Math.max(0, this.pop - dtMs / 260);
    this.shake = Math.max(0, this.shake - dtMs / 220);
    this.roarText = Math.max(0, this.roarText - dtMs / 700);
    this.stepParticles(dtMs);

    ctx.clearRect(0, 0, w, h);

    // Backdrop: a soft radial glow that flares warm on a roar.
    const cx = w / 2;
    const cy = h * 0.54;
    const glow = ctx.createRadialGradient(cx, cy, edge * 0.05, cx, cy, edge * 0.7);
    const hot = this.pop;
    glow.addColorStop(0, `rgba(255, ${Math.round(200 - hot * 90)}, ${Math.round(150 - hot * 90)}, ${0.22 + hot * 0.3})`);
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    this.drawParticles();

    // The dino, shaken + a gentle idle bob + a forward lean scaled by the roar.
    const size = this.sizeFrac * edge;
    const shakeX = this.shake * Math.sin(this.bob / 18) * 6;
    const shakeY = this.shake * Math.cos(this.bob / 13) * 4;
    const idleBob = Math.sin(this.bob / 480) * edge * 0.012;
    const lean = this.pop * -0.12 + (voicing ? Math.min(1, level) * -0.04 : 0);
    ctx.save();
    ctx.translate(cx + shakeX, cy + shakeY + idleBob);
    ctx.rotate(lean);
    // A roar squashes taller (mouth-open feel) via a vertical stretch.
    const stretch = 1 + this.pop * 0.18;
    ctx.scale(1, stretch);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.font = `${Math.round(size)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🦖", 0, size * 0.02);
    ctx.restore();

    // «Р-Р-Р!» flashing above the dino on a roar.
    if (this.roarText > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.roarText * 1.4);
      ctx.fillStyle = "#e23b2e";
      const ts = edge * (0.11 + (1 - this.roarText) * 0.05);
      ctx.font = `900 ${Math.round(ts)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Р-Р-Р!", cx, cy - size * 0.62);
      ctx.restore();
    }
  }

  /** Kick off the roar visuals: pop, shake, «Р-Р-Р!», and a radial particle burst. */
  private startRoar(intensity: number, w: number, h: number): void {
    const amt = Math.max(0.2, Math.min(1, intensity));
    this.pop = 1;
    this.shake = 1;
    this.roarText = 1;
    const cx = w / 2;
    const cy = h * 0.5;
    const edge = Math.min(w, h);
    const n = Math.round(18 + amt * 22);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = (2 + Math.random() * 5) * (0.6 + amt);
      this.particles.push({
        x: cx + (Math.random() - 0.5) * edge * 0.2,
        y: cy + (Math.random() - 0.5) * edge * 0.15,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 1.5,
        size: (edge * 0.012) * (1 + Math.random() * 1.4),
        life: 500 + Math.random() * 500,
        max: 1000,
        color: BURST_COLORS[(Math.random() * BURST_COLORS.length) | 0],
      });
    }
  }

  private stepParticles(dtMs: number): void {
    const f = dtMs / 16.67; // normalize velocities to ~60fps steps
    for (const p of this.particles) {
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vy += 0.22 * f; // gravity
      p.vx *= 0.99;
      p.life -= dtMs;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
