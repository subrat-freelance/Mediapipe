// Demo page: the only place that calls getUserMedia. ?autostart=1&rx=<url> starts without a click.
import { DrawingUtils, FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { connectReceiver, startVision, type FrameMessage, type WireMessage } from "../client/index";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const query = new URLSearchParams(location.search);

const preview = $<HTMLVideoElement>("preview");
const overlay = $<HTMLCanvasElement>("overlay");
const toggle = $<HTMLButtonElement>("toggle");
const drawBox = $<HTMLInputElement>("draw");
const meshBox = $<HTMLInputElement>("mesh");
const rxInput = $<HTMLInputElement>("rx");
const pen = new DrawingUtils(overlay.getContext("2d")!);

const WINDOW_MS = 5000;
let stop: (() => void) | undefined;
let sent = 0;
let dropped = 0;
let startedAt = 0;
let recent: { t: number; bytes: number; frame: boolean }[] = [];

rxInput.value = query.get("rx") ?? "";
preview.onloadedmetadata = () => {
  preview.parentElement!.style.aspectRatio = `${preview.videoWidth} / ${preview.videoHeight}`;
};

// Long arrays collapsed; the 16 matrix numbers stay readable.
const collapse = (_k: string, v: unknown) =>
  Array.isArray(v) && v.length > 16 ? [v[0], `… ${v.length - 1} more`] : v;

function paint(msg: FrameMessage) {
  overlay.width = preview.videoWidth; // also clears
  overlay.height = preview.videoHeight;
  if (!drawBox.checked) return;
  // Not mirrored, like the analysed frame: the person's left is on the right of the picture.
  for (const lm of msg.face.faceLandmarks ?? [])
    pen.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#ffffff70", lineWidth: 0.5 });
  for (const lm of msg.pose.landmarks) {
    pen.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#00e0ff", lineWidth: 2 });
    pen.drawLandmarks(lm, { color: "#ffcc00", radius: 3 });
  }
}

/** Everything shown comes from the JSON string handed to send: it is what goes on the wire. */
function show(json: string, ok: boolean) {
  if (ok) sent++;
  else dropped++;
  const msg: WireMessage = JSON.parse(json);
  const now = performance.now();
  recent.push({ t: now, bytes: json.length, frame: msg.type === "frame" });
  recent = recent.filter((r) => now - r.t <= WINDOW_MS);
  const secs = Math.max(Math.min(now - startedAt, WINDOW_MS), 1000) / 1000;

  $("counts").textContent = `${sent} / ${dropped}`;
  $("bytes").textContent = `${json.length} bytes (${msg.type})`;
  $("bps").textContent = Math.round(recent.reduce((n, r) => n + r.bytes, 0) / secs).toLocaleString();
  $("fps").textContent = (recent.filter((r) => r.frame).length / secs).toFixed(1);
  $("json").textContent = JSON.stringify(msg, collapse, 2);

  if (msg.type === "status") {
    $("state").textContent = [msg.state, msg.reason, msg.detail].filter(Boolean).join(" — ");
  } else {
    $("infer").textContent = `${msg.infer_ms} ms`;
    $("people").textContent = `${msg.pose.landmarks.length} / ${msg.face.faceBlendshapes.length}`;
    paint(msg);
  }
}

async function start() {
  const undo: (() => void)[] = [];
  sent = dropped = 0;
  recent = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    undo.push(() => stream.getTracks().forEach((t) => t.stop()));
    preview.srcObject = stream;
    await preview.play();

    const url = rxInput.value.trim().replace(/\/$/, "");
    let rx: ReturnType<typeof connectReceiver> | undefined;
    if (url) {
      $("link").textContent = "connecting";
      const opened = new Promise<void>((resolve) => {
        rx = connectReceiver({
          url,
          getToken: async () => (await (await fetch(`${url}/dev/token`)).json()).token,
          onState: (open) => {
            $("link").textContent = open ? "connected" : "not connected, retrying";
            if (open) resolve();
          },
        });
      });
      undo.push(() => rx?.close());
      // Give the channel a moment so the first status is not lost; start regardless.
      await Promise.race([opened, new Promise((r) => setTimeout(r, 3000))]);
    } else {
      $("link").textContent = "none — counting only";
    }

    startedAt = performance.now();
    const vision = await startVision({
      track: stream.getVideoTracks()[0],
      send: (json) => {
        const ok = rx ? rx.send(json) : true;
        show(json, ok);
        return ok;
      },
      assetsUrl: "/vision",
      faceMesh: meshBox.checked,
    });
    undo.push(vision.stop);
    stop = () => undo.reverse().forEach((f) => f());
  } catch (err) {
    undo.reverse().forEach((f) => f());
    $("state").textContent = `failed — ${err}`;
  }
}

async function onToggle() {
  toggle.disabled = true;
  if (stop) {
    stop();
    stop = undefined;
  } else {
    await start();
  }
  toggle.textContent = stop ? "Stop" : "Start";
  toggle.disabled = false;
}

toggle.onclick = onToggle;
meshBox.onchange = async () => {
  if (!stop) return;
  await onToggle(); // the mesh is a start option: restart
  await onToggle();
};
if (query.get("autostart") === "1") void onToggle();
