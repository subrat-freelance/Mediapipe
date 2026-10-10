// HTTP signalling, token check, peers. Logs go to stderr: stdout belongs to the stdout sink.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { jwtVerify, SignJWT } from "jose";
import { RTCPeerConnection, type RTCIceServer } from "werift";
import { createIngest, stdoutSink, webhookSink, type Identity, type Sink } from "./ingest";

const AUDIENCE = "xebit-vision";
const MAX_PEERS = 200;
const MAX_OFFER_BYTES = 65_536;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const CONNECT_DEADLINE_MS = 30_000;

export interface ReceiverConfig {
  port: number;
  secret: string;
  dev: boolean;
  allowedOrigins: string[];
  iceServers: RTCIceServer[];
  icePortRange?: [number, number];
  sink: Sink;
}

/** Throws when the configuration is not safe to start with. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ReceiverConfig {
  const dev = env.VISION_DEV === "1";
  const secret = env.VISION_JWT_SECRET || (dev ? randomBytes(32).toString("hex") : "");
  if (!dev && secret.length < 32) throw new Error("VISION_JWT_SECRET is missing or shorter than 32 characters");

  const range = env.VISION_ICE_PORT_RANGE ? env.VISION_ICE_PORT_RANGE.split("-").map(Number) : undefined;
  if (range && !(range.length === 2 && range.every(Number.isInteger) && range[0] < range[1]))
    throw new Error("VISION_ICE_PORT_RANGE must look like 50000-50100");

  if (env.VISION_FORWARD_URL && !env.VISION_FORWARD_SECRET)
    throw new Error("VISION_FORWARD_SECRET is required when VISION_FORWARD_URL is set");

  return {
    port: Number(env.PORT ?? 8787),
    secret,
    dev,
    allowedOrigins: (env.VISION_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    iceServers: JSON.parse(env.VISION_ICE_SERVERS ?? "[]"),
    icePortRange: range as [number, number] | undefined,
    sink: env.VISION_FORWARD_URL ? webhookSink(env.VISION_FORWARD_URL, env.VISION_FORWARD_SECRET!) : stdoutSink,
  };
}

/**
 * False for an SCTP packet holding a chunk or a parameter whose length field is under 4.
 * Never valid, and werift 0.25.0 loops on it until the process runs out of memory.
 */
function lengthsOk(buf: Buffer, pos = 12, end = buf.length, nested = false): boolean {
  while (pos + 4 <= end) {
    const type = nested ? 0 : buf[pos];
    const length = buf.readUInt16BE(pos + 2);
    if (length < 4) return false;
    // INIT and INIT ACK carry parameters after 16 fixed bytes; these others carry nothing but parameters.
    const params = type === 1 || type === 2 ? 20 : [4, 5, 6, 9, 130].includes(type) ? 4 : 0;
    if (params && !lengthsOk(buf, pos + params, Math.min(pos + length, end), true)) return false;
    pos += length + ((4 - (length % 4)) % 4);
  }
  return true;
}

async function readOffer(req: IncomingMessage): Promise<{ type: "offer"; sdp: string } | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > MAX_OFFER_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body?.type === "offer" && typeof body.sdp === "string" ? { type: "offer", sdp: body.sdp } : null;
  } catch {
    return null;
  }
}

export async function startReceiver(cfg: ReceiverConfig) {
  const key = new TextEncoder().encode(cfg.secret);
  const peers = new Set<() => void>(); // one drop function per live peer

  const originAllowed = (origin: string) =>
    cfg.allowedOrigins.includes(origin) || (cfg.dev && /^http:\/\/localhost(:\d+)?$/.test(origin));

  /** The identity in a valid token, or null. HS256 only; aud, exp, sid and pid are required. */
  async function verify(header: string | undefined): Promise<(Identity & { exp: number }) | null> {
    const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        audience: AUDIENCE,
        requiredClaims: ["exp", "sid", "pid"],
      });
      const { sid, pid, name, exp } = payload;
      if (typeof sid !== "string" || typeof pid !== "string" || typeof exp !== "number") return null;
      return { sid, pid, ...(typeof name === "string" && { name }), exp };
    } catch {
      return null;
    }
  }

  /** Answers the offer, or returns null when it cannot be used. */
  async function accept(offer: { type: "offer"; sdp: string }, { exp, ...identity }: Identity & { exp: number }) {
    const pc = new RTCPeerConnection({
      iceServers: cfg.iceServers,
      icePortRange: cfg.icePortRange,
      // werift leaves loopback out of its host candidates; a machine with no LAN address needs it.
      iceAdditionalHostAddresses: cfg.dev ? ["127.0.0.1"] : undefined,
      maxMessageSize: 65_536,
    });
    const drop = () => {
      if (!peers.delete(drop)) return;
      clearTimeout(timer);
      pc.close().catch(() => {});
    };
    peers.add(drop);
    // Thirty seconds to open the vision channel: where UDP is blocked the client retries for ever,
    // and werift never gives up on a peer whose ICE does not finish.
    let timer = setTimeout(drop, CONNECT_DEADLINE_MS);
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) drop();
    };
    const { ingest } = createIngest(identity, cfg.sink, drop); // one per peer, however many channels it opens
    pc.ondatachannel = ({ channel }) => {
      if (channel.label !== "vision") return channel.close();
      // From here on the peer lives until its token expires; the client reconnects with a fresh one.
      clearTimeout(timer);
      timer = setTimeout(drop, Math.min(exp * 1000 - Date.now(), MAX_TIMEOUT_MS));
      channel.onmessage = (e) => ingest(e.data);
      channel.onclose = drop; // the channel is the peer's only purpose
    };
    try {
      await pc.setRemoteDescription(offer);
      // werift's private path from DTLS to its SCTP parser; an offer with no data channel has none and ends here.
      const dtls = (pc.sctpTransport as any).dtlsTransport;
      const toSctp = dtls.dataReceiver;
      dtls.dataReceiver = (buf: Buffer) => lengthsOk(buf) && toSctp(buf);
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete")
        await pc.iceGatheringStateChange.watch((s) => s === "complete", 5000).catch(() => {});
      return { type: "answer", sdp: pc.localDescription!.sdp };
    } catch {
      drop();
      return null;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const allowed = !origin || originAllowed(origin); // no Origin: not a browser; the token still decides
    const cors = origin && allowed ? { "access-control-allow-origin": origin, vary: "origin" } : {};
    const reply = (status: number, body?: unknown, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...cors, ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (req.method === "GET" && path === "/healthz") return reply(200, { ok: true, peers: peers.size });
    if (req.method === "GET" && path === "/dev/token" && cfg.dev) {
      const token = await new SignJWT({ sid: "dev", pid: `dev-${randomUUID().slice(0, 8)}`, name: "demo" })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(key);
      return reply(200, { token });
    }
    if (path !== "/offer") return reply(404, { error: "not found" });
    if (!allowed) return reply(403, { error: "origin not allowed" });
    if (req.method === "OPTIONS")
      return reply(204, undefined, {
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      });
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });

    const who = await verify(req.headers.authorization);
    if (!who) return reply(401, { error: "bad or missing token" });
    const offer = await readOffer(req);
    if (!offer) return reply(400, { error: "not an offer" });
    // Checked after the last await before accept() adds the peer, so offers arriving together cannot overshoot.
    if (peers.size >= MAX_PEERS) return reply(503, { error: "too many peers" });
    const answer = await accept(offer, who);
    if (!answer) return reply(400, { error: "not an offer" });
    reply(200, answer);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`http: ${err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    close() {
      server.close();
      server.closeAllConnections();
      for (const drop of peers) drop();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = configFromEnv();
  const { port } = await startReceiver(cfg);
  // werift rejects promises nobody holds when a peer sends bytes it cannot parse. Log it; do not die.
  process.on("unhandledRejection", (err) => console.error(`unhandled: ${err}`));
  console.error(`xebit-vision receiver on :${port}${cfg.dev ? " (VISION_DEV=1: /dev/token is open)" : ""}`);
}
