// Demo page: the only place that calls getUserMedia. ?autostart=1&rx=<url> starts without a click.
import { DrawingUtils, FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { connectReceiver, startVision, type FrameMessage, type WireMessage } from "../client/index";
import { Detector, signals, type Signals, type VisionEvent } from "../consumer/rules";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const query = new URLSearchParams(location.search);

const preview = $<HTMLVideoElement>("preview");
const overlay = $<HTMLCanvasElement>("overlay");
const toggle = $<HTMLButtonElement>("toggle");
const drawBox = $<HTMLInputElement>("draw");
const meshBox = $<HTMLInputElement>("mesh");
const objectsBox = $<HTMLInputElement>("objects");
const rxInput = $<HTMLInputElement>("rx");
const ctx = overlay.getContext("2d")!;
const pen = new DrawingUtils(ctx);

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

// ---- Dashboard: one tile per event, driven by the same rules the receiver log uses. -------------
// label + the instantaneous signal (lights the tile at once) + optional detail text.
const topPhone = (m: FrameMessage) =>
  (m.objects ?? []).filter((o) => o.categoryName === "cell phone").map((o) => o.score).sort((a, b) => b - a)[0];
const TILES: { ev: string; label: string; live: (s: Signals) => boolean; detail?: (s: Signals, m: FrameMessage) => string }[] = [
  { ev: "hand_raised", label: "Hand raised", live: (s) => s.leftHandRaised || s.rightHandRaised, detail: (s) => (s.leftHandRaised && s.rightHandRaised ? "both" : s.leftHandRaised ? "left" : "right") },
  { ev: "phone", label: "Phone", live: (s) => s.phone, detail: (_s, m) => { const p = topPhone(m); return p ? p.toFixed(2) : ""; } },
  { ev: "multiple_people", label: "Multiple people", live: (s) => s.faces >= 2 },
  { ev: "looking_away", label: "Looking away", live: (s) => s.lookingAway, detail: (s) => `yaw ${Math.round(s.yaw)}°` },
  { ev: "looking_down", label: "Looking down", live: (s) => s.gazeDown },
  { ev: "hand_to_face", label: "Hand to face", live: (s) => s.handToFace },
  { ev: "eyes_closed", label: "Eyes closed", live: (s) => s.eyesClosed },
  { ev: "talking", label: "Talking", live: (s) => s.talking },
  { ev: "absent", label: "Nobody there", live: (s) => !s.present && !s.body },
];

const tilesEl = $("tiles");
const feedEl = $("feed");
for (const t of TILES) {
  const el = document.createElement("div");
  el.className = "tile";
  el.id = `tile-${t.ev}`;
  el.innerHTML = `<div class="label"><span class="dot"></span>${t.label}</div><div class="detail"></div>`;
  tilesEl.appendChild(el);
}

let detector = new Detector({ pid: "demo" });
const active = new Set<string>(); // events currently firing (held long enough) — matches the log
let eventCount = 0;

function resetDashboard() {
  detector = new Detector({ pid: "demo" });
  active.clear();
  eventCount = 0;
  $("feed-count").textContent = "0";
  feedEl.innerHTML = `<li class="empty">No events yet. Start, then raise a hand or hold up a phone.</li>`;
  $("people-count").textContent = "—";
  renderTiles(null, null);
}

function addFeed(ev: VisionEvent) {
  if (eventCount === 0) feedEl.innerHTML = "";
  eventCount++;
  $("feed-count").textContent = String(eventCount);
  const li = document.createElement("li");
  const time = new Date(ev.ts).toLocaleTimeString();
  const detail = ev.detail ? Object.entries(ev.detail).map(([k, v]) => `${k} ${v}`).join(", ") : "";
  li.innerHTML = `<span class="t">${time}</span><span class="s-${ev.state}">${ev.event} ${ev.state}</span><span>${detail}</span>`;
  feedEl.prepend(li);
  while (feedEl.children.length > 40) feedEl.lastChild!.remove();
}

/** Paint every tile: amber fill = confirmed event, amber outline = signal live but not held yet. */
function renderTiles(s: Signals | null, m: FrameMessage | null) {
  for (const t of TILES) {
    const el = $(`tile-${t.ev}`);
    const on = active.has(t.ev);
    const live = !!s && t.live(s);
    el.classList.toggle("on", on);
    el.classList.toggle("live", live && !on);
    const text = s && m && (live || on) && t.detail ? t.detail(s, m) : "";
    el.querySelector<HTMLElement>(".detail")!.textContent = [text, on ? "held" : ""].filter(Boolean).join(" · ");
  }
}

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
  // Object boxes (normalised → pixels of the preview). A phone is highlighted.
  for (const o of msg.objects ?? []) {
    const phone = o.categoryName === "cell phone";
    ctx.strokeStyle = phone ? "#ff3b3b" : "#8affc1";
    ctx.lineWidth = phone ? 3 : 2;
    ctx.strokeRect(o.box.x * overlay.width, o.box.y * overlay.height, o.box.w * overlay.width, o.box.h * overlay.height);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "14px system-ui";
    ctx.fillText(`${o.categoryName} ${o.score.toFixed(2)}`, o.box.x * overlay.width + 2, o.box.y * overlay.height - 4);
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
    $("state").textContent = msg.state;
    $("status-extra").textContent = [msg.reason, msg.detail].filter(Boolean).join(" — ");
    if (msg.state === "stopped") {
      for (const ev of detector.close(msg.ts, msg.seq)) (active.delete(ev.event), addFeed(ev));
      renderTiles(null, null);
    }
  } else {
    $("state").textContent = "running";
    $("status-extra").textContent = "";
    $("infer").textContent = `${msg.infer_ms} ms`;
    $("poses").textContent = `${msg.pose.landmarks.length} / ${msg.face.faceBlendshapes.length}`;
    $("objects-out").textContent = msg.objects
      ? msg.objects.map((o) => `${o.categoryName} ${o.score.toFixed(2)}`).join(", ") || "none"
      : "off";
    paint(msg);

    // Dashboard: feed the detector (confirmed events) and show the live signals.
    for (const ev of detector.feed(msg)) (ev.state === "start" ? active.add(ev.event) : active.delete(ev.event), addFeed(ev));
    const s = signals(msg);
    $("people-count").textContent = String(msg.face.faceBlendshapes.length);
    $("tile-people").classList.toggle("on", msg.face.faceBlendshapes.length >= 2);
    renderTiles(s, msg);
  }
}

async function start() {
  const undo: (() => void)[] = [];
  sent = dropped = 0;
  recent = [];
  resetDashboard();
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
      objects: objectsBox.checked,
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
// Both are start-time options, so a change restarts the engine.
const restart = async () => {
  if (!stop) return;
  await onToggle();
  await onToggle();
};
meshBox.onchange = restart;
objectsBox.onchange = restart;
if (query.get("autostart") === "1") void onToggle();
