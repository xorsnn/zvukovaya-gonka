import type { AudioFrame } from "../audio/AudioEngine";

/**
 * The "I can hear you" indicator for the mic-check screen. A big friendly
 * pulsing ear/circle that grows and brightens with the child's voice, so a
 * caregiver can confirm the mic works before involving the child.
 */
export class MeterView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pulse = 0;
  private heardEver = false;
  private heardAt = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "meter-canvas";
    this.ctx = this.canvas.getContext("2d")!;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** True once any real voiced sound has been detected. */
  get hasHeard(): boolean {
    return this.heardEver;
  }

  draw(frame: AudioFrame, now: number): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.26;

    // Smooth the displayed pulse toward the live level.
    this.pulse += (frame.level - this.pulse) * 0.3;
    if (frame.voiced && frame.level > 0.12) {
      if (!this.heardEver) this.heardEver = true;
      this.heardAt = now;
    }
    const recentlyHeard = now - this.heardAt < 450;

    // Concentric "sound rings" that bloom outward with loudness.
    for (let i = 3; i >= 1; i--) {
      const r = base * (1 + i * 0.4 * (0.3 + this.pulse));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.12 * this.pulse * (1 / i)})`;
      ctx.lineWidth = 6;
      ctx.stroke();
    }

    // The main circle.
    const r = base * (1 + this.pulse * 0.5);
    const grad = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
    if (recentlyHeard) {
      grad.addColorStop(0, "#fff6a8");
      grad.addColorStop(1, "#ffb43d");
    } else {
      grad.addColorStop(0, "#dff3ff");
      grad.addColorStop(1, "#8fd0f5");
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Ear / microphone glyph in the middle.
    ctx.font = `${Math.round(base * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(recentlyHeard ? "😊" : "👂", cx, cy + base * 0.05);
  }
}
