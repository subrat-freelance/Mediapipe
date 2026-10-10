# xebit-vision

A person's camera is analysed **in their own browser** with MediaPipe, two frames a second.
For every analysed frame the browser sends one JSON message holding MediaPipe's result over a
WebRTC data channel. No video leaves the device.

Three parts, one package:

- **Client library** (`src/client`) — samples a camera `MediaStreamTrack` at 2 fps, runs MediaPipe
  in a Web Worker, hands each result to a `send` function as a JSON string.
- **Receiver** (`src/receiver`) — a Node service. Checks who connects, validates every message,
  passes it on to stdout or a webhook. It keeps nothing and does not interpret landmarks.
- **Demo page** (`src/demo`) — camera preview, the live JSON and the numbers that matter.

## Run it

Node 22 or newer.

```sh
npm install
npm run assets        # wasm from node_modules + the two models → public/vision/
```

Two terminals:

```sh
VISION_DEV=1 npm run dev:rx      # receiver on :8787   (PowerShell: $env:VISION_DEV=1; npm run dev:rx)
npm run dev:web                  # builds the worker, then the demo on http://localhost:5173
```

Open the demo, type `http://localhost:8787` in the Receiver field, press Start. The receiver prints
two JSON lines a second. With the field empty the demo only counts and sends nowhere.
`?autostart=1&rx=http://localhost:8787` starts without a click.

| Script | Does |
|---|---|
| `npm run assets` | Copies the wasm and downloads the models. Safe to repeat. |
| `npm run build:worker` | `src/client/worker.ts` → `public/vision/vision-worker.js`. Run again after editing the worker. |
| `npm run dev:web` / `dev:rx` | Demo / receiver, with reload. |
| `npm run build` | `dist/index.js` (the library, 5 KB), `dist/types/`, and `dist/vision/` (what a host serves). |
| `npm test` | Unit tests: payload, ingest, auth. |
| `npm run e2e` | Chrome with a fake camera → worker → data channel → receiver. |
| `npm run typecheck` | `tsc --noEmit`. |

## Embedding the client

```ts
import { startVision, connectReceiver } from "xebit-vision";

const rx = connectReceiver({
  url: "https://vision.example.com",          // the receiver
  getToken: () => fetchTokenFromMyBackend(),  // called on every connect and reconnect
  iceServers: [],                             // optional
  onState: (open) => {},                      // optional: data channel opened / lost
});

const vision = await startVision({
  track,                    // a camera MediaStreamTrack the host already has
  send: rx.send,            // (json: string) => boolean
  assetsUrl: "/vision",     // where the worker, wasm and models are served, same origin
  fps: 2,                   // default 2, at most 5
  width: 320,               // default 320, height follows the camera's aspect ratio
  faceMesh: false,          // default false
  maxBytes: 60_000,         // default
  delegate: "CPU",          // default
  onPayload: (msg) => {},   // optional local tap: every message, as an object
});

vision.stop();              // sends status "stopped"
rx.close();                 // lets that last message out, then closes
```

- **Assets.** Copy `dist/vision/` (or `public/vision/` after `npm run assets && npm run build:worker`)
  to the host's static files, at `assetsUrl`. Keep the file names and the folder shape: the worker
  finds `wasm/` and `models/` beside itself, and MediaPipe picks the SIMD or non-SIMD wasm by name.
  `.wasm` must be served as `application/wasm`.
- **The library never calls `getUserMedia` and never constrains the track.** The host asks for the
  camera and for consent.
- **`send` is replaceable.** The library does not know the receiver exists. A host with its own data
  channel passes its own function, e.g. in a LiveKit room (use `maxBytes: 15_000`, mesh off):
  `send: (json) => { room.localParticipant.publishData(new TextEncoder().encode(json), { reliable: true, topic: "vision" }); return true; }`
- **`startVision`** resolves when the engine is ready. If it cannot start it sends
  `status: failed / init_error` and rejects.
- **`connectReceiver`** returns at once and connects in the background. `send` returns `false`, and
  sends nothing, while the channel is not open or is backed up. It reconnects after 1, 2, 5, 10 and
  then every 30 s, asking for a fresh token each time. Nothing is queued: a 2 fps reading that
  arrives late is worth nothing.
- **Content-Security-Policy**, if the host has one: `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`.
- **HTTPS.** A page on HTTPS can only call an HTTPS receiver.

## Receiver

```sh
VISION_JWT_SECRET=<32+ characters> npx tsx src/receiver/server.ts
```

| Route | Behaviour |
|---|---|
| `POST /offer` | Body `{type: "offer", sdp}`, header `Authorization: Bearer <token>`. Answers with `{type: "answer", sdp}`. `401` bad or missing token · `403` origin not allowed · `503` at 200 peers · `400` not an offer. |
| `OPTIONS /offer` | CORS preflight for the allowed origins. |
| `GET /healthz` | `{ok: true, peers: n}`. |
| `GET /dev/token` | Only with `VISION_DEV=1`. Mints a token for the demo page. |

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port. |
| `VISION_JWT_SECRET` | — | Required outside dev; the process refuses to start if it is missing or shorter than 32 characters. |
| `VISION_DEV` | unset | `1` turns on `/dev/token`, allows `http://localhost:*` origins, and adds `127.0.0.1` to the ICE host addresses. Never in production. |
| `VISION_ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call `/offer`. |
| `VISION_ICE_SERVERS` | `[]` | JSON array in the `RTCIceServer` shape. |
| `VISION_ICE_PORT_RANGE` | unset | `50000-50100`. The UDP ports to open in the firewall. |
| `VISION_FORWARD_URL` | unset | Turns the webhook sink on. |
| `VISION_FORWARD_SECRET` | — | Required when the URL is set. |

**Token.** A JWT signed HS256 with `VISION_JWT_SECRET`. Claims: `aud: "xebit-vision"`, `sid` (session),
`pid` (participant), optional `name`, and `exp` (required). The connection is closed when `exp`
passes and the client reconnects with a fresh token. Who is sending always comes from the token,
never from a message. In Python:

```python
jwt.encode({"aud": "xebit-vision", "sid": session_id, "pid": identity, "name": name,
            "exp": int(time.time()) + 3600}, secret, algorithm="HS256")
```

**Sinks.** Each accepted message becomes `{sid, pid, name, rx_ts, payload}`.

- **stdout** (default): one JSON line per message. Logs go to stderr.
- **webhook** (`VISION_FORWARD_URL`): once a second, `POST {"items": [...]}` with
  `X-Vision-Signature: sha256=<hex HMAC-SHA256 of the body, key VISION_FORWARD_SECRET>`. Timeout 5 s.
  A failed batch is logged and dropped, not retried. The buffer holds 2,000 items and drops the oldest.

**Every message** goes through, in this order: size → rate limit → JSON → schema → sink. A message
that fails is dropped, counted per connection and reason, and logged at most once a minute (never its
body). Fifty invalid messages in a row close the connection.

**In production:** put it behind a TLS proxy; open the UDP port range; on a cloud machine give it a
STUN server in `VISION_ICE_SERVERS` so it learns its public address (not verified yet, see below).
There is no TURN server: on a network that blocks UDP the channel never opens, the client keeps
retrying and `send` keeps returning `false`.

## Wire contract

`src/wire.ts` is the contract: one zod schema, with the types inferred from it. Every message is a
UTF-8 JSON string. Numbers are rounded to 4 decimals. Unknown keys are stripped by the receiver.

### `frame` — one per analysed frame, also when nobody is in view (empty arrays)

```json
{
  "v": 1,
  "type": "frame",
  "seq": 418,
  "ts": 1791619200123,
  "frame": { "w": 320, "h": 240 },
  "infer_ms": 38.2,
  "pose": {
    "landmarks":      [[ { "x": 0.4986, "y": 0.2297, "z": -0.753, "visibility": 0.9985, "presence": 0.996 } ]],
    "worldLandmarks": [[ { "x": -0.0011, "y": -0.5995, "z": -0.2595, "visibility": 0.9985, "presence": 0.996 } ]]
  },
  "face": {
    "faceBlendshapes": [ { "categories": [ { "index": 0, "score": 0, "categoryName": "_neutral", "displayName": "" } ], "headIndex": -1, "headName": "" } ],
    "facialTransformationMatrixes": [ { "rows": 4, "columns": 4, "data": [0.9994, 0.0142, -0.0329, 0, -0.0102, 0.9929, 0.1185, 0, 0.0343, -0.1181, 0.9924, 0, -0.5295, 23.3537, -66.9828, 1] } ]
  }
}
```

(Shortened: a real pose has 33 landmarks in each list and a real face has 52 categories.)

| Field | Meaning |
|---|---|
| `v` | Contract version, `1`. A receiver drops any other value. |
| `seq` | Integer, +1 for every message since `startVision`, across both kinds. A gap is a message the client dropped. |
| `ts` | `Date.now()` when the frame was captured. The client's clock; do not trust it for ordering across people. |
| `frame` | Size of the image MediaPipe saw. Normalised `x`, `y` are relative to it. |
| `infer_ms` | MediaPipe time for this frame, both tasks. |
| `pose` | `PoseLandmarkerResult` without `segmentationMasks`. At most one pose. |
| `face` | `FaceLandmarkerResult`, at most two faces. `faceLandmarks` (478 points a face) is present only when the mesh is on. |
| `truncated` | `true` when `faceLandmarks` was dropped to fit `maxBytes`. Absent otherwise. |

The number of faces is `face.faceBlendshapes.length`, with the mesh on or off.

### `status` — on every change of state, and every 5 s in any state

```json
{ "v": 1, "type": "status", "seq": 419, "ts": 1791619200623,
  "state": "paused", "reason": "tab_hidden",
  "engine": { "lib": "1.1.0", "tasks": ["pose", "face"], "fps": 2, "width": 320, "delegate": "CPU", "faceMesh": false } }
```

| `state` | `reason` | When |
|---|---|---|
| `running` | — | Frames are being analysed. |
| `paused` | `tab_hidden` | The page is hidden. |
| `paused` | `camera_off` | The track is muted or disabled. |
| `failed` | `init_error`, `worker_error` | The engine could not start, or died. `detail` carries the error text, cut to 200 characters. Analysis does not resume; start again. |
| `stopped` | — | `stop()` was called, or the track ended. Last message. |

Silence therefore always means a fault. Timers slow down in hidden tabs, so a "no message" alarm
should allow at least 60 s.

### Limits (`src/limits.ts`, re-exported by `wire.ts`)

| Constant | Value | Enforced by |
|---|---|---|
| `MAX_MESSAGE_BYTES` | 60,000 | client (drops the mesh, then the message) and receiver (drops the message) |
| `MAX_FPS` | 5 | client clamps `fps` |
| `MAX_MSGS_PER_SEC` | 10, burst 20 | receiver, per connection |
| poses per frame | at most 2, each exactly 33 landmarks | receiver schema |
| faces per frame | at most 4; a mesh is exactly 478 landmarks; at most 60 categories; a matrix is exactly 16 numbers | receiver schema |

Every number must be finite.

## Reading the payload

Normalised `x` and `y` run 0 to 1 across the analysed frame, `y` growing downward. `visibility` and
`presence` are 0 to 1. The frame is not mirrored: left and right are the person's own.

Pose landmark indices that matter: 0 nose · 2 left eye · 5 right eye · 11 left shoulder ·
12 right shoulder · 13 left elbow · 14 right elbow · 15 left wrist · 16 right wrist.

At 2 fps one frame is half a second, so a hold time becomes a frame count:

| Signal | From the payload | Hold |
|---|---|---|
| Hand raised | A wrist with `visibility > 0.5` whose `y` is less than the eye's and less than its own elbow's | 3 frames |
| Nobody there | `face.faceBlendshapes.length === 0` | 10 frames |
| More than one person | `face.faceBlendshapes.length >= 2` | 6 frames |
| Looking away | Head rotation from `facialTransformationMatrixes[0]`, or the `eyeLook*` blendshape scores | 12 frames |
| Tab switched, camera off | `status` messages | — |

**The 16 matrix numbers are column-first:** `m[row][col] = data[col * 4 + row]`. The translation is
`data[12], data[13], data[14]` and `data[3], data[7], data[11], data[15]` are `0, 0, 0, 1` (see the
example above, from a face looking straight at the camera).
The sign of each rotation angle has not been checked by turning a head in front of a camera.

## Measured

On an Intel i5-10300H laptop, Windows 11, Chrome 154 (headless), CPU delegate, 320×240 analysed frame,
with still images of a person fed in as the camera. **Not yet measured on a live camera.**

| What | Value |
|---|---|
| `infer_ms`, first frame | 330–490 ms (warm-up) |
| `infer_ms` after that, a body and no face | about 40 ms |
| `infer_ms` after that, a body and one face | 65–80 ms |
| Frames per second achieved | 2.0 |
| Worker CPU | Not profiled. From `infer_ms`: 80–160 ms of work a second, so roughly 8–16 % of one core. |
| Page load to first frame, local dev server | about 3 s |
| Message, nobody in view | 0.2 KB |
| Message, a body and no face | 4.9 KB |
| Message, a body and one face (the default) | **9.2 KB**, about 18 KB a second |
| The same plus one face mesh | 33.2 KB |
| Reconnect after the receiver came back (it was down 4 s) | 5 s |
| Receiver forgets a peer: clean stop / tab closed without one | 3 ms / 29 s |

Download, once, then cached:

| File | Bytes | gzip |
|---|---|---|
| `vision-worker.js` | 154,927 | 45 KB |
| `wasm/vision_wasm_internal.js` | 335,393 | 81 KB |
| `wasm/vision_wasm_internal.wasm` (the browser takes this or the non-SIMD one) | 12,997,248 | 3.9 MB |
| `models/pose_landmarker_lite.task` | 5,777,746 | 5.0 MB |
| `models/face_landmarker.task` | 3,758,596 | 3.3 MB |
| **Total** | **23.0 MB** | **12.3 MB** |
| The library itself, `dist/index.js` | 5,111 | 2.2 KB |

## Tested, and not

Checked by running it (Chrome 154 on Windows, headless, fake camera):

- `npm test`, `npm run typecheck`, `npm run e2e`.
- A person image as the camera gives one pose of 33 landmarks, one face with 52 blendshapes and one
  matrix, and the overlay sits on the body and the face. With the mesh on, 478 points.
- A hidden page (simulated) sends `paused / tab_hidden`, then `running`. `track.enabled = false`
  sends `paused / camera_off`.
- The receiver as a real process prints two lines a second; a bad token gets `401` and the client
  keeps retrying; an expired token closes the connection and the client comes back with a new one;
  the client reconnects by itself after a receiver restart.
- The webhook delivers one correctly signed batch a second.

Still to do by a person with a camera:

- Raise a hand: wrist (15 or 16) `y` goes below the nose (0) `y`. A second person: two faces.
  Hide the real tab.
- **`runningMode: "VIDEO"` at 2 fps.** Video mode follows the body from the previous frame, and half
  a second is a long gap. If the landmarks lag behind a fast move, switch the task in `worker.ts` to
  `runningMode: "IMAGE"` with `detect()`.
- Firefox, Safari and Edge are untested. `createImageBitmap` with resize options is the part to
  check first.
- The receiver on a cloud machine (STUN, or its public address in the ICE host addresses).

## Differences from the plan

- **Pose landmarks carry `presence`.** MediaPipe 1.1.0 sets it next to `visibility`; the plan's
  field list did not have it. It is kept (the payload is MediaPipe's own object) and the schema
  allows it, so the default message is 9.2 KB, not the estimated 8.1 KB.
- `src/limits.ts` holds the limit constants so the browser can import them without zod.
  `wire.ts` re-exports them.
- `connectReceiver` has an `onState` option and `startVision` a `delegate` option.
- The receiver's ingest is made per connection, `createIngest(identity, sink, close)`, because the
  rate limit and the counters are per connection.
- A connection in the ICE state `disconnected` is treated as lost on both sides, not only `failed`.
- `@types/node` is a development dependency (Node types for the receiver).
