// Validation, rate limit and sinks. Nothing here interprets landmarks, and nothing
// here logs a message body: they are measurements of a person's face and body.
import { createHmac } from "node:crypto";
import { MAX_MESSAGE_BYTES, MAX_MSGS_BURST, MAX_MSGS_PER_SEC, wireMessage, type WireMessage } from "../wire";

/** Who is sending. Comes from the token at connect time, never from a message. */
export interface Identity {
  sid: string;
  pid: string;
  name?: string;
}
export interface SinkItem extends Identity {
  rx_ts: number;
  payload: WireMessage;
}
export type Sink = (item: SinkItem) => void;
export type DropReason = "not_string" | "too_long" | "rate" | "not_json" | "schema" | "sink_error";

const MAX_INVALID_IN_A_ROW = 50;
const LOG_EVERY_MS = 60_000;

/** One per connection. `ingest` runs for every message and never throws. */
export function createIngest(identity: Identity, sink: Sink, close: () => void) {
  const drops: Partial<Record<DropReason, number>> = {};
  const lastLog: Partial<Record<DropReason, number>> = {};
  let tokens = MAX_MSGS_BURST;
  let refilled = Date.now();
  let invalid = 0;

  const drop = (reason: DropReason) => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    const now = Date.now();
    if (now - (lastLog[reason] ?? -Infinity) >= LOG_EVERY_MS) {
      lastLog[reason] = now;
      console.error(`drop sid=${identity.sid} pid=${identity.pid} reason=${reason} count=${drops[reason]}`);
    }
    // Rate drops are not counted here: an eager client is not a broken one.
    if (reason !== "rate" && ++invalid === MAX_INVALID_IN_A_ROW) close();
  };

  const ingest = (data: unknown): void => {
    try {
      if (typeof data !== "string") return drop("not_string");
      if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return drop("too_long");

      const now = Date.now();
      tokens = Math.min(MAX_MSGS_BURST, tokens + ((now - refilled) / 1000) * MAX_MSGS_PER_SEC);
      refilled = now;
      if (tokens < 1) return drop("rate");
      tokens -= 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return drop("not_json");
      }
      const result = wireMessage.safeParse(parsed); // strips unknown keys, sid/pid/name among them
      if (!result.success) return drop("schema");

      invalid = 0;
      sink({ ...identity, rx_ts: now, payload: result.data });
    } catch {
      drop("sink_error");
    }
  };

  return { ingest, drops };
}

/** One JSON line per message. */
export const stdoutSink: Sink = (item) => void process.stdout.write(JSON.stringify(item) + "\n");

/** Collects, and once a second POSTs {"items": [...]} signed with HMAC-SHA256. */
export function webhookSink(url: string, secret: string): Sink {
  const MAX_BUFFER = 2000;
  let buffer: SinkItem[] = [];

  setInterval(async () => {
    if (!buffer.length) return;
    const items = buffer;
    buffer = [];
    const body = JSON.stringify({ items });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vision-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      void res.body?.cancel();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Not retried: a 2 fps reading that arrives late is worth nothing.
      console.error(`webhook: ${items.length} items dropped: ${err}`);
    }
  }, 1000);

  return (item) => {
    buffer.push(item);
    if (buffer.length > MAX_BUFFER) buffer.shift(); // drop the oldest
  };
}
