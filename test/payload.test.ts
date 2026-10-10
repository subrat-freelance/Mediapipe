import { expect, test } from "vitest";
import { buildFrame, encode, type RawResult } from "../src/client/payload";
import { MAX_MESSAGE_BYTES, wireMessage } from "../src/wire";

const lm = () => ({ x: 0.123456789, y: 0.987654321, z: -0.555555555, visibility: 0.999999, presence: 0.987654 });
const list = <T>(n: number, f: () => T) => Array.from({ length: n }, f);

/** A worker answer with the real shapes: one pose, `faces` faces. */
export function canned(faces = 1): RawResult {
  const people = faces ? 1 : 0;
  return {
    ts: 1791619200123,
    w: 320,
    h: 240,
    infer_ms: 38.23456,
    landmarks: list(people, () => list(33, lm)),
    worldLandmarks: list(people, () => list(33, lm)),
    faceLandmarks: list(faces, () => list(478, lm)),
    faceBlendshapes: list(faces, () => ({
      categories: list(52, () => ({ index: 0, score: 0.000123456, categoryName: "_neutral", displayName: "" })),
      headIndex: -1,
      headName: "",
    })),
    facialTransformationMatrixes: list(faces, () => ({ rows: 4, columns: 4, data: list(16, () => 0.123456789) })),
  };
}

test("a canned worker answer gives a schema-valid message, mesh absent by default", () => {
  const json = encode(buildFrame(canned(), { seq: 7, faceMesh: false }), MAX_MESSAGE_BYTES)!;
  const msg = wireMessage.parse(JSON.parse(json));
  expect(msg).toMatchObject({ v: 1, type: "frame", seq: 7, frame: { w: 320, h: 240 } });
  expect(json).not.toContain("faceLandmarks");
  expect(json).not.toContain("truncated");
  expect(json.length).toBeLessThan(10_000);
});

test("numbers come out at 4 decimals", () => {
  const json = encode(buildFrame(canned(), { seq: 0, faceMesh: true }), MAX_MESSAGE_BYTES)!;
  expect(json).not.toMatch(/\.\d{5}/);
  expect(JSON.parse(json).pose.landmarks[0][0]).toEqual({ x: 0.1235, y: 0.9877, z: -0.5556, visibility: 1, presence: 0.9877 });
  expect(JSON.parse(json).infer_ms).toBe(38.2346);
});

test("a message over maxBytes loses the mesh and gains truncated", () => {
  const msg = buildFrame(canned(), { seq: 0, faceMesh: true });
  const full = encode(msg, MAX_MESSAGE_BYTES)!;
  expect(JSON.parse(full).face.faceLandmarks[0]).toHaveLength(478);

  const cut = JSON.parse(encode(msg, 15_000)!);
  expect(cut.truncated).toBe(true);
  expect(cut.face.faceLandmarks).toBeUndefined();
  expect(cut.face.faceBlendshapes).toHaveLength(1);
  expect(wireMessage.safeParse(cut).success).toBe(true);
});

test("one still too large returns null", () => {
  expect(encode(buildFrame(canned(), { seq: 0, faceMesh: true }), 1000)).toBeNull();
  expect(encode(buildFrame(canned(), { seq: 0, faceMesh: false }), 1000)).toBeNull();
});

test("nobody in view gives empty arrays", () => {
  const json = encode(buildFrame(canned(0), { seq: 0, faceMesh: false }), MAX_MESSAGE_BYTES)!;
  const msg = wireMessage.parse(JSON.parse(json));
  expect(msg).toMatchObject({
    pose: { landmarks: [], worldLandmarks: [] },
    face: { faceBlendshapes: [], facialTransformationMatrixes: [] },
  });
  expect(json.length).toBeLessThan(300);
});
