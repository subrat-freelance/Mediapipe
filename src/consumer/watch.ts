// Reads the receiver's NDJSON (one SinkItem a line) on stdin and writes one JSON line per detected
// event to stdout, and to a file if a path is given. Keyed by participant.
//
//   $env:VISION_DEV=1; npm run dev:rx | npx tsx src/consumer/watch.ts events.ndjson
//
// The receiver's own logs go to stderr, so stdin is clean JSONL; a line that is not a frame is skipped.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Detector, type VisionEvent } from "./rules";

const file = process.argv[2];
const detectors = new Map<string, Detector>();

function emit(ev: VisionEvent) {
  const line = JSON.stringify(ev);
  process.stdout.write(line + "\n");
  if (file) {
    try {
      appendFileSync(file, line + "\n");
    } catch (err) {
      console.error(`events: cannot write ${file}: ${err}`);
    }
  }
}

createInterface({ input: process.stdin }).on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let item: { sid?: string; pid?: string; name?: string; payload?: { type: string; ts: number; seq: number } };
  try {
    item = JSON.parse(line);
  } catch {
    return; // not one of the receiver's lines
  }
  const payload = item.payload;
  const pid = item.pid ?? "unknown";
  if (!payload) return;

  if (payload.type === "frame") {
    let d = detectors.get(pid);
    if (!d) detectors.set(pid, (d = new Detector({ pid, sid: item.sid, name: item.name })));
    for (const ev of d.feed(payload as never)) emit(ev);
  } else if (payload.type === "status" && (payload as { state?: string }).state === "stopped") {
    for (const ev of detectors.get(pid)?.close(payload.ts, payload.seq) ?? []) emit(ev);
    detectors.delete(pid);
  }
});
