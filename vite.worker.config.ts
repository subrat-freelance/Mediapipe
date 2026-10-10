// The worker as one self-contained classic script beside the wasm and the models.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "public/vision",
    emptyOutDir: false, // wasm/ and models/ live here too
    lib: {
      entry: "src/client/worker.ts",
      formats: ["iife"],
      name: "XebitVisionWorker",
      fileName: () => "vision-worker.js",
    },
  },
});
