import { defineConfig } from "vite";

// base: "./" makes the built app path-relative so it can be hosted from any
// subfolder and even opened offline from disk.
export default defineConfig({
  base: "./",
  server: {
    host: true,
  },
});
