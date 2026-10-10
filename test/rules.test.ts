import { expect, test } from "vitest";
import { Detector, signals } from "../src/consumer/rules";
import type { FrameMessage } from "../src/wire";

const lm = (y: number, x = 0.5, visibility = 0.9) => ({ x, y, z: 0, visibility });

/** A frame with a pose whose wrists/eyes you place, `faces` faces, and named blendshape scores. */
function frame(opts: {
  seq?: number;
  pose?: boolean;
  wristY?: [number, number]; // own left (15), own right (16)
  faces?: number;
  yaw?: number; // degrees, + = own left; written into the matrix
  blends?: Record<string, number>;
}): FrameMessage {
  const faces = opts.faces ?? (opts.pose === false ? 0 : 1);
  const [lw, rw] = opts.wristY ?? [0.8, 0.8];
  const row: number[] = Array(33).fill(0).map(() => 0.5) as number[];
  // Build 33 landmarks; set only the ones the rules read.
  const marks = Array.from({ length: 33 }, () => lm(0.5));
  marks[0] = lm(0.45, 0.5); // nose
  marks[2] = lm(0.4); // left eye
  marks[5] = lm(0.4); // right eye
  marks[13] = lm(0.6); // left elbow
  marks[14] = lm(0.6); // right elbow
  marks[15] = lm(lw, 0.5); // left wrist
  marks[16] = lm(rw, 0.5); // right wrist
  void row;

  const yaw = ((opts.yaw ?? 0) * Math.PI) / 180;
  const matrix = { rows: 4, columns: 4, data: [Math.cos(yaw), 0, 0, 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, 0, 0, 0, 1] };
  const categories = Object.entries(opts.blends ?? {}).map(([categoryName, score]) => ({ index: 0, score, categoryName, displayName: "" }));

  return {
    v: 1,
    type: "frame",
    seq: opts.seq ?? 0,
    ts: 1_000 + (opts.seq ?? 0),
    frame: { w: 320, h: 240 },
    infer_ms: 40,
    pose: { landmarks: opts.pose === false ? [] : [marks], worldLandmarks: opts.pose === false ? [] : [marks] },
    face: {
      faceBlendshapes: Array.from({ length: faces }, () => ({ categories, headIndex: -1, headName: "" })),
      facialTransformationMatrixes: Array.from({ length: faces }, () => matrix),
    },
  };
}

test("signals read the geometry", () => {
  const up = signals(frame({ wristY: [0.2, 0.8] })); // own left wrist above the eyes
  expect(up.leftHandRaised).toBe(true);
  expect(up.rightHandRaised).toBe(false);

  const away = signals(frame({ yaw: 40 }));
  expect(Math.round(away.yaw)).toBe(40); // + = own left
  expect(away.lookingAway).toBe(true);
  expect(signals(frame({ yaw: 5 })).lookingAway).toBe(false);
});

test("a raised hand fires only after it is held, and ends after it drops", () => {
  const d = new Detector({ pid: "p1", name: "Ada" });
  const down = () => d.feed(frame({ wristY: [0.8, 0.8] }));
  const raise = (seq: number) => d.feed(frame({ seq, wristY: [0.2, 0.8] }));

  expect(raise(0)).toEqual([]); // 1 frame
  expect(raise(1)).toEqual([]); // 2
  const ev = raise(2); // 3 → hold reached
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ type: "event", event: "hand_raised", state: "start", pid: "p1", name: "Ada", detail: { hand: "left" } });

  expect(down()).toEqual([]); // 1 frame off (debounce)
  const end = down(); // 2 off → end
  expect(end).toHaveLength(1);
  expect(end[0]).toMatchObject({ event: "hand_raised", state: "end" });
});

test("absent needs 10 empty frames; two faces raise multiple_people", () => {
  const d = new Detector({ pid: "p1" });
  let started: string[] = [];
  for (let i = 0; i < 9; i++) started.push(...d.feed(frame({ seq: i, pose: false })).map((e) => e.event));
  expect(started).toEqual([]);
  expect(d.feed(frame({ seq: 9, pose: false })).map((e) => e.event)).toEqual(["absent"]);

  const d2 = new Detector({ pid: "p2" });
  let out: string[] = [];
  for (let i = 0; i < 6; i++) out = d2.feed(frame({ seq: i, faces: 2 })).map((e) => e.event);
  expect(out).toEqual(["multiple_people"]);
});

test("close() ends whatever is still firing", () => {
  const d = new Detector({ pid: "p1" });
  for (let i = 0; i < 6; i++) d.feed(frame({ seq: i, faces: 2 }));
  const ends = d.close(2000, 99);
  expect(ends).toEqual([expect.objectContaining({ event: "multiple_people", state: "end", seq: 99 })]);
});
