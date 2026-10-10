import { beforeEach, expect, test, vi } from "vitest";
import { buildFrame, encode } from "../src/client/payload";
import { createIngest, type SinkItem } from "../src/receiver/ingest";
import { MAX_MESSAGE_BYTES } from "../src/wire";
import { canned } from "./payload.test";

const identity = { sid: "s1", pid: "p1", name: "Ada" };
const frame = (seq = 0) => JSON.parse(encode(buildFrame(canned(), { seq, faceMesh: false }), MAX_MESSAGE_BYTES)!);

function setup() {
  const items: SinkItem[] = [];
  const close = vi.fn();
  return { items, close, ...createIngest(identity, (item) => items.push(item), close) };
}

beforeEach(() => {
  vi.useFakeTimers(); // freezes Date.now: no rate-limit refill mid-test
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("a valid frame reaches the sink with the token's identity", () => {
  const { ingest, items, drops } = setup();
  ingest(JSON.stringify(frame(3)));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ sid: "s1", pid: "p1", name: "Ada", payload: { type: "frame", seq: 3 } });
  expect(items[0].rx_ts).toBe(Date.now());
  expect(items[0].payload).toHaveProperty("pose.landmarks[0][0].presence", 0.9877); // MediaPipe's own field, kept
  expect(drops).toEqual({});
});

test.each([
  ["binary data", Buffer.from("{}"), "not_string"],
  ["too long", JSON.stringify({ ...frame(), pad: "x".repeat(MAX_MESSAGE_BYTES) }), "too_long"],
  ["not JSON", "{nope", "not_json"],
  ["wrong v", JSON.stringify({ ...frame(), v: 2 }), "schema"],
  ["unknown type", JSON.stringify({ ...frame(), type: "event" }), "schema"],
  ["34 pose landmarks", JSON.stringify({ ...frame(), pose: { landmarks: [Array(34).fill({ x: 0, y: 0, z: 0, visibility: 0 })], worldLandmarks: [] } }), "schema"],
  ["a null where a number belongs", JSON.stringify({ ...frame(), infer_ms: null }), "schema"],
  ["a number that is not finite", JSON.stringify(frame()).replace('"infer_ms":38.2346', '"infer_ms":1e999'), "schema"],
])("%s is dropped and counted, and does not throw", (_name, data, reason) => {
  const { ingest, items, drops } = setup();
  expect(() => ingest(data)).not.toThrow();
  expect(items).toHaveLength(0);
  expect(drops).toEqual({ [reason]: 1 });
});

test("the 21st message in a burst is dropped; the bucket refills with time", () => {
  const { ingest, items, drops } = setup();
  const json = JSON.stringify(frame());
  for (let i = 0; i < 21; i++) ingest(json);
  expect(items).toHaveLength(20);
  expect(drops).toEqual({ rate: 1 });
  vi.advanceTimersByTime(100);
  ingest(json);
  expect(items).toHaveLength(21);
});

test("a message carrying its own sid reaches the sink without it", () => {
  const { ingest, items } = setup();
  ingest(JSON.stringify({ ...frame(), sid: "forged", pid: "forged", name: "Mallory" }));
  expect(items[0]).toMatchObject(identity);
  expect(items[0].payload).not.toHaveProperty("sid");
  expect(items[0].payload).not.toHaveProperty("pid");
  expect(items[0].payload).not.toHaveProperty("name");
});

test("fifty bad messages in a row close the peer; a good one in between resets the count", () => {
  const { ingest, close } = setup();
  for (let i = 0; i < 49; i++) ingest(i);
  ingest(JSON.stringify(frame()));
  for (let i = 0; i < 49; i++) ingest(i);
  expect(close).not.toHaveBeenCalled();
  ingest(0);
  expect(close).toHaveBeenCalledOnce();
});

test("a sink that throws does not make ingest throw", () => {
  const { ingest, drops } = createIngest(identity, () => { throw new Error("boom"); }, () => {});
  expect(() => ingest(JSON.stringify(frame()))).not.toThrow();
  expect(drops).toEqual({ sink_error: 1 });
});
