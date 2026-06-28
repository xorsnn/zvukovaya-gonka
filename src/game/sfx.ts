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
