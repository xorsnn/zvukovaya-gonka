import { defineConfig } from "vitest/config";

// base: "./" makes the built app path-relative so it can be hosted from any
// subfolder and even opened offline from disk.
export default defineConfig({
  base: "./",
  server: {
    host: true,
  },
  // The phonetic DSP and the shape state machine are pure (and the AudioEngine
  // accepts an injected fake analyser), so the whole test suite runs in plain
  // Node — no jsdom, no microphone.
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
