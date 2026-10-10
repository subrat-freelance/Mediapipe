// Demo dev server, client library build (ESM), and the vitest settings.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("src/demo"),
  publicDir: r("public"), // public/vision is what a host serves at assetsUrl; the build copies it to dist/vision
  define: { __MP_VERSION__: JSON.stringify(pkg.dependencies["@mediapipe/tasks-vision"]) },
  build: {
    outDir: r("dist"),
    emptyOutDir: true,
    lib: { entry: r("src/client/index.ts"), formats: ["es"], fileName: "index" },
  },
  test: { root: r("."), dir: r("test"), testTimeout: 60_000 },
});
