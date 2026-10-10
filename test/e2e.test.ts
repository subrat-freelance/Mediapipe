// Proves the pipe: fake camera → worker → data channel → receiver → sink.
// The fake camera shows no person, so the arrays are empty. That is expected.
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { SinkItem } from "../src/receiver/ingest";
import { startReceiver } from "../src/receiver/server";
import { wireMessage } from "../src/wire";

const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const items: SinkItem[] = [];
let rx: Awaited<ReturnType<typeof startReceiver>>;
let web: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  rx = await startReceiver({
    port: 0,
    secret: "e2e-secret-e2e-secret-e2e-secret!",
    dev: true,
    allowedOrigins: [],
    iceServers: [],
    sink: (item) => items.push(item),
  });
  web = await createServer({ server: { port: 5183 }, logLevel: "error" });
  await web.listen();
  // Playwright's own browser if it is installed, the machine's Chrome if not.
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await web?.close();
  rx?.close();
});

const until = async (what: string, done: () => boolean, ms = 30_000) => {
  for (const end = Date.now() + ms; !done(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("2 fps of schema-valid messages reach the receiver", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${web.resolvedUrls!.local[0]}?autostart=1&rx=http://localhost:${rx.port}`);

  await until("the first frame", () => items.some((i) => i.payload.type === "frame"));
  const first = items.findIndex((i) => i.payload.type === "frame");
  await new Promise((r) => setTimeout(r, 5000));
  const got = [...items];
  await page.close();

  expect(errors).toEqual([]);
  expect(got[0].payload).toMatchObject({ type: "status", state: "running", seq: 0 });
  expect(got[0]).toMatchObject({ sid: "dev", name: "demo" });

  const frames = got.slice(first + 1).filter((i) => i.payload.type === "frame");
  expect(frames.length).toBeGreaterThanOrEqual(8);
  expect(frames.length).toBeLessThanOrEqual(12);

  const seqs = got.map((i) => i.payload.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);

  for (const { payload } of got) {
    expect(wireMessage.safeParse(payload).success).toBe(true);
    if (payload.type === "frame") {
      expect(payload.frame).toEqual({ w: 320, h: 240 });
      expect(payload.pose.landmarks).toEqual([]);
      expect(payload.face.faceBlendshapes).toEqual([]);
    }
  }
});
