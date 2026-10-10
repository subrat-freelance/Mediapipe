// The wire contract. One schema, used by the receiver to validate and by the
// client for its types (type-only imports, so zod stays out of the browser).
import { z } from "zod";
import { WIRE_VERSION } from "./limits";

export * from "./limits";

// zod numbers are finite by default; z.object strips unknown keys.
const name = z.string().max(64);
// presence: MediaPipe sets it when the model outputs one. The pose model does.
const landmark = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  visibility: z.number(),
  presence: z.number().optional(),
});
const category = z.object({ index: z.number(), score: z.number(), categoryName: name, displayName: name });
const classifications = z.object({ categories: z.array(category).max(60), headIndex: z.number(), headName: name });
const matrix = z.object({ rows: z.number(), columns: z.number(), data: z.array(z.number()).length(16) });
// A detected object (a phone, a book, …). Box is normalised 0..1 to the analysed frame, like the landmarks.
const object = z.object({
  categoryName: name,
  score: z.number(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});

const envelope = { v: z.literal(WIRE_VERSION), seq: z.int().nonnegative(), ts: z.number() };

const frame = z.object({
  ...envelope,
  type: z.literal("frame"),
  frame: z.object({ w: z.int().positive(), h: z.int().positive() }),
  infer_ms: z.number(),
  pose: z.object({
    landmarks: z.array(z.array(landmark).length(33)).max(2),
    worldLandmarks: z.array(z.array(landmark).length(33)).max(2),
  }),
  face: z.object({
    faceLandmarks: z.array(z.array(landmark).length(478)).max(4).optional(),
    faceBlendshapes: z.array(classifications).max(4),
    facialTransformationMatrixes: z.array(matrix).max(4),
  }),
  // Present (possibly empty) only when object detection is on; "person" is left out (pose/face cover it).
  objects: z.array(object).max(10).optional(),
  truncated: z.literal(true).optional(),
});

const status = z.object({
  ...envelope,
  type: z.literal("status"),
  state: z.enum(["running", "paused", "failed", "stopped"]),
  reason: z.enum(["tab_hidden", "camera_off", "init_error", "worker_error"]).optional(),
  detail: z.string().max(200).optional(),
  engine: z.object({
    lib: name,
    tasks: z.array(name).max(8),
    fps: z.number(),
    width: z.number(),
    delegate: name,
    faceMesh: z.boolean(),
  }),
});

export const wireMessage = z.discriminatedUnion("type", [frame, status]);

export type FrameMessage = z.infer<typeof frame>;
export type StatusMessage = z.infer<typeof status>;
export type WireMessage = z.infer<typeof wireMessage>;
