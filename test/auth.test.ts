import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFromEnv, startReceiver } from "../src/receiver/server";

const secret = "0123456789abcdef0123456789abcdef";
const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

const sign = (claims: Record<string, unknown>, key = secret) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(enc(key));
const good = () => ({ aud: "xebit-vision", sid: "s1", pid: "p1", exp: now() + 60 });

let rx: Awaited<ReturnType<typeof startReceiver>>;
beforeAll(async () => {
  rx = await startReceiver({ port: 0, secret, dev: false, allowedOrigins: ["https://app.example"], iceServers: [], sink: () => {} });
});
afterAll(() => rx.close());

const offer = (token?: string, headers: Record<string, string> = {}, body = "{}") =>
  fetch(`http://localhost:${rx.port}/offer`, {
    method: "POST",
    headers: { ...(token !== undefined && { authorization: `Bearer ${token}` }), ...headers },
    body,
  });

test.each<[string, () => Promise<string | undefined> | string | undefined]>([
  ["missing", () => undefined],
  ["garbage", () => "not.a.jwt"],
  ["expired", () => sign({ ...good(), exp: now() - 60 })],
  ["wrong secret", () => sign(good(), "another-secret-of-32-characters!!")],
  ["wrong audience", () => sign({ ...good(), aud: "someone-else" })],
  ["no exp", () => sign({ aud: "xebit-vision", sid: "s1", pid: "p1" })],
  ["no pid", () => sign({ aud: "xebit-vision", sid: "s1", exp: now() + 60 })],
  ["alg: none", () => `${b64({ alg: "none", typ: "JWT" })}.${b64(good())}.`],
])("%s token gives 401", async (_name, make) => {
  expect((await offer(await make())).status).toBe(401);
});

test("a good token gets past the token check: 400 for a body that is not an offer", async () => {
  expect((await offer(await sign(good()))).status).toBe(400);
});

test("origin: unknown gives 403, allowed gets CORS headers on the preflight", async () => {
  expect((await offer(await sign(good()), { origin: "https://evil.example" })).status).toBe(403);
  const pre = await fetch(`http://localhost:${rx.port}/offer`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
  expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
});

test("/dev/token does not exist outside dev", async () => {
  expect((await fetch(`http://localhost:${rx.port}/dev/token`)).status).toBe(404);
});

test("refuses to start without a 32-character secret, unless VISION_DEV=1", () => {
  expect(() => configFromEnv({})).toThrow(/VISION_JWT_SECRET/);
  expect(() => configFromEnv({ VISION_JWT_SECRET: "short" })).toThrow(/VISION_JWT_SECRET/);
  expect(configFromEnv({ VISION_JWT_SECRET: secret }).dev).toBe(false);
  expect(configFromEnv({ VISION_DEV: "1" }).secret.length).toBeGreaterThanOrEqual(32);
});
