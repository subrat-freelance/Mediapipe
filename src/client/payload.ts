import type { FrameMessage } from "../wire";

type Pose = FrameMessage["pose"];
type Face = Required<FrameMessage["face"]>;

/** What the worker posts back for one frame: MediaPipe's fields, picked out by name. */
export interface RawResult {
  ts: number;
  w: number;
  h: number;
  infer_ms: number;
  landmarks: Pose["landmarks"];
  worldLandmarks: Pose["worldLandmarks"];
  faceLandmarks: Face["faceLandmarks"];
  faceBlendshapes: Face["faceBlendshapes"];
  facialTransformationMatrixes: Face["facialTransformationMatrixes"];
}

export function buildFrame(raw: RawResult, opts: { seq: number; faceMesh: boolean }): FrameMessage {
  return {
    v: 1,
    type: "frame",
    seq: opts.seq,
    ts: raw.ts,
    frame: { w: raw.w, h: raw.h },
    infer_ms: raw.infer_ms,
    pose: { landmarks: raw.landmarks, worldLandmarks: raw.worldLandmarks },
    face: {
      ...(opts.faceMesh && { faceLandmarks: raw.faceLandmarks }),
      faceBlendshapes: raw.faceBlendshapes,
      facialTransformationMatrixes: raw.facialTransformationMatrixes,
    },
  };
}

// The payload is ASCII, so string length is byte length.
const round4 = (_k: string, v: unknown) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);

/** JSON for the wire, or null when the frame cannot be made to fit (drop it; seq still advances). */
export function encode(msg: FrameMessage, maxBytes: number): string | null {
  let json = JSON.stringify(msg, round4);
  if (json.length > maxBytes && msg.face.faceLandmarks) {
    const { faceLandmarks, ...face } = msg.face;
    json = JSON.stringify({ ...msg, face, truncated: true }, round4);
  }
  return json.length > maxBytes ? null : json;
}
