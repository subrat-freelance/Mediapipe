import { MAX_FPS, MAX_MESSAGE_BYTES } from "../limits";
import type { StatusMessage, WireMessage } from "../wire";
import { buildFrame, encode, type RawResult } from "./payload";

export { connectReceiver } from "./rtc";
export type { ReceiverOptions } from "./rtc";
export type { FrameMessage, StatusMessage, WireMessage } from "../wire";

declare const __MP_VERSION__: string; // set by vite.config.ts from package.json

const STATUS_EVERY_MS = 5000;

export interface VisionOptions {
  /** A camera track the host already has. It is sampled, never constrained or changed. */
  track: MediaStreamTrack;
  /** Returns false when the message was not sent. */
  send: (json: string) => boolean;
  /** Where vision-worker.js, wasm/ and models/ are served, same origin. */
  assetsUrl: string;
  fps?: number;
  /** Width of the analysed image; height follows the camera's aspect ratio. */
  width?: number;
  faceMesh?: boolean;
  maxBytes?: number;
  delegate?: "CPU" | "GPU";
  /** Local tap: every message, as an object, before rounding. */
  onPayload?: (msg: WireMessage) => void;
}

export async function startVision(opts: VisionOptions): Promise<{ stop(): void }> {
  const { track, send, onPayload } = opts;
  const fps = Math.min(Math.max(opts.fps ?? 2, 0.1), MAX_FPS);
  const width = opts.width ?? 320;
  const faceMesh = opts.faceMesh ?? false;
  const maxBytes = opts.maxBytes ?? MAX_MESSAGE_BYTES;
  const delegate = opts.delegate ?? "CPU";
  const engine = { lib: __MP_VERSION__, tasks: ["pose", "face"], fps, width, delegate, faceMesh };

  let seq = 0;
  let state: StatusMessage["state"] = "running";
  let reason: StatusMessage["reason"];
  let detail: string | undefined;
  let busy = false;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const listeners = new AbortController();

  const sendStatus = () => {
    const msg: StatusMessage = {
      v: 1,
      type: "status",
      seq: seq++,
      ts: Date.now(),
      state,
      ...(reason && { reason }),
      ...(detail && { detail }),
      engine,
    };
    onPayload?.(msg);
    send(JSON.stringify(msg));
  };

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]); // wraps the track; does not clone or change it

  const worker = new Worker(`${opts.assetsUrl}/vision-worker.js`); // classic worker

  /** Ends analysis. "stopped" also ends the status timer; "failed" keeps it until stop(). */
  const end = (next: "failed" | "stopped", why?: StatusMessage["reason"], error?: unknown) => {
    if (state === "stopped" || state === next) return;
    state = next;
    reason = why;
    detail = error === undefined ? undefined : String(error).slice(0, 200);
    clearInterval(sampler);
    if (next === "stopped") clearInterval(heartbeat);
    listeners.abort();
    worker.terminate();
    video.srcObject = null;
    sendStatus();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e) => (e.data.type === "ready" ? resolve() : reject(new Error(e.data.error)));
      worker.onerror = (e) => reject(new Error(e.message || "worker failed to load"));
      worker.postMessage({ type: "init", delegate });
    });
  } catch (err) {
    end("failed", "init_error", err);
    throw err;
  }
  // Not awaited: play() stays pending while the track is muted, and that is "paused", not a hang.
  video.play().catch((err) => end("failed", "init_error", err));

  worker.onerror = (e) => end("failed", "worker_error", e.message);
  worker.onmessage = (e) => {
    busy = false;
    if (state === "stopped" || state === "failed") return;
    if (e.data.type !== "result") return end("failed", "worker_error", e.data.error);
    const msg = buildFrame(e.data as RawResult, { seq: seq++, faceMesh });
    onPayload?.(msg);
    const json = encode(msg, maxBytes);
    if (json) send(json);
  };

  // paused follows the page and the track. track.enabled has no event, so the sampler checks it too.
  const refresh = () => {
    if (state !== "running" && state !== "paused") return;
    const why =
      document.visibilityState === "hidden" ? "tab_hidden" : track.muted || !track.enabled ? "camera_off" : undefined;
    if (why === reason) return;
    state = why ? "paused" : "running";
    reason = why;
    sendStatus();
  };
  document.addEventListener("visibilitychange", refresh, { signal: listeners.signal });
  track.addEventListener("mute", refresh, { signal: listeners.signal });
  track.addEventListener("unmute", refresh, { signal: listeners.signal });
  track.addEventListener("ended", () => end("stopped"), { signal: listeners.signal });

  sendStatus(); // running
  refresh(); // or paused, if the page is already hidden
  heartbeat = setInterval(sendStatus, STATUS_EVERY_MS);

  // busy is the whole of the backpressure: at most one frame is ever in the worker.
  sampler = setInterval(async () => {
    refresh();
    if (busy || state !== "running" || video.readyState < 2) return; // drop the tick, never queue
    busy = true;
    const t = performance.now(); // detectForVideo needs timestamps that only increase
    const ts = Date.now();
    try {
      const h = Math.round((width * video.videoHeight) / video.videoWidth);
      const bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: h, resizeQuality: "low" });
      if (state !== "running") {
        bitmap.close();
        busy = false;
        return;
      }
      worker.postMessage({ type: "frame", bitmap, t, ts }, [bitmap]);
    } catch {
      busy = false;
    }
  }, 1000 / fps);

  return { stop: () => end("stopped") };
}
