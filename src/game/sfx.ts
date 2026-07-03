/**
 * Tiny synthesized sound effects — no audio files, so the game stays small and
 * works fully offline.
 *
 * IMPORTANT: we never play sound DURING the chase. The mic runs with echo
 * cancellation OFF (so it can hear quiet breathy sounds), which means any game
 * audio over the speakers would feed back into the chase. So celebration sound
 * only plays AFTER the pounce, once we're no longer listening for the chase.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new Ctx();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  c: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain: number,
  type: OscillatorType = "sine",
): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

/** Happy ascending arpeggio + sparkle for the catch celebration. */
export function playCelebration(): void {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // C-E-G-C major arpeggio.
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone(c, f, t + i * 0.1, 0.32, 0.25, "triangle"));
  // little sparkle on top
  tone(c, 1568, t + 0.42, 0.5, 0.12, "sine");
  tone(c, 2093, t + 0.5, 0.45, 0.08, "sine");
}

/**
 * The roar's full audible length plus a short tail (ms). Exported as the single
 * source of truth for the reactive dino toy's input lockout (issue #30): the
 * pure {@link RoarToy} uses this as `RoarToyCfg.lockoutMs`, so input is ignored
 * for at least as long as the roar sounds over the speakers. `intensity` only
 * scales the roar's gain + body length WITHIN this budget — it must never make
 * the roar outlast this window (see {@link playRoar}).
 */
export const ROAR_TOTAL_MS = 1200;

/**
 * A dinosaur roar (issue #30) — procedural, asset-free, offline. A low ~95 Hz
 * sawtooth growl with a downward pitch sweep, layered over a lowpass-filtered
 * noise buffer for the raspy breath, under a fast-attack / decay gain envelope.
 *
 * `intensity` (0..1, the utterance's peak loudness) scales the gain and the body
 * length so a louder sound gets a bigger roar — but the body is capped well under
 * {@link ROAR_TOTAL_MS} so the audible roar always finishes inside the toy's
 * input lockout. Like every SFX here it plays only AFTER we stop listening (the
 * toy locks out input for the roar's duration), so it never feeds the mic.
 */
export function playRoar(intensity = 1): void {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const amt = Math.max(0, Math.min(1, intensity));
  // Body 0.6..1.0 s and peak gain 0.30..0.5 grow with intensity; body + tail stay
  // under ROAR_TOTAL_MS (1.2 s) so the roar never outlasts the lockout.
  const body = 0.6 + 0.4 * amt;
  const peak = 0.3 + 0.2 * amt;

  // 1) Growl: a low sawtooth sweeping down, kept dark by a closing lowpass.
  const osc = c.createOscillator();
  const og = c.createGain();
  const lp = c.createBiquadFilter();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(95, t);
  osc.frequency.exponentialRampToValueAtTime(50, t + body);
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(280, t + body);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(peak, t + 0.05);
  og.gain.exponentialRampToValueAtTime(0.0001, t + body);
  osc.connect(og);
  og.connect(lp);
  lp.connect(c.destination);
  osc.start(t);
  osc.stop(t + body + 0.05);

  // 2) Breath: a short lowpass-filtered noise burst for the raspy texture.
  const dur = body + 0.1;
  const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = c.createBufferSource();
  const nf = c.createBiquadFilter();
  const ng = c.createGain();
  noise.buffer = buf;
  nf.type = "lowpass";
  nf.frequency.value = 1100;
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(peak * 0.6, t + 0.06);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + body);
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(c.destination);
  noise.start(t);
  noise.stop(t + dur);
}

/** Soft "pop" for the pounce moment itself. */
export function playPop(): void {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(800, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.18);
  g.gain.setValueAtTime(0.3, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.25);
}

/**
 * Speak the target word with the browser's Russian TTS, to model the sound for
 * the child. Best-effort: silently does nothing if no Russian voice exists.
 * Returns a promise that resolves when speaking finishes (or immediately if
 * unavailable) so callers can gate mic input during playback.
 */
export function speakWord(word: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = "ru-RU";
      u.rate = 0.8;
      u.pitch = 1.15;
      const voices = synth.getVoices();
      const ru = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("ru"));
      if (ru) u.voice = ru;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
      // Safety net: resolve even if onend never fires.
      setTimeout(resolve, 2500);
    } catch {
      resolve();
    }
  });
}
