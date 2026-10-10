// Puts the MediaPipe wasm and the two models under public/vision/.
// The wasm files keep their original names: MediaPipe picks SIMD or non-SIMD itself.
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";

const out = new URL("../public/vision/", import.meta.url);
const wasmSrc = new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url);

const WASM = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

const MODELS = [
  ["pose_landmarker_lite.task", 5_777_746, "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"],
  ["face_landmarker.task", 3_758_596, "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"],
];

await mkdir(new URL("wasm/", out), { recursive: true });
await mkdir(new URL("models/", out), { recursive: true });

for (const f of WASM) await copyFile(new URL(f, wasmSrc), new URL(`wasm/${f}`, out));
console.log(`wasm: copied ${WASM.length} files`);

for (const [file, bytes, url] of MODELS) {
  const dest = new URL(`models/${file}`, out);
  if ((await stat(dest).catch(() => null))?.size === bytes) {
    console.log(`${file}: present`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length !== bytes) throw new Error(`${file}: got ${body.length} bytes, expected ${bytes}`);
  await writeFile(dest, body);
  console.log(`${file}: downloaded ${bytes} bytes`);
}
