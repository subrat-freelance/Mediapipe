const RETRY_S = [1, 2, 5, 10, 30]; // then every 30 s
const MAX_BUFFERED = 256_000;
const GATHER_MS = 2000;

export interface ReceiverOptions {
  /** The receiver's base URL. */
  url: string;
  /** Called on every connect and reconnect. */
  getToken: () => string | Promise<string>;
  iceServers?: RTCIceServer[];
  /** Called when the data channel opens (true) and when it is lost (false). */
  onState?: (open: boolean) => void;
}

/** Returns straight away and connects in the background. Frames sent while disconnected are dropped. */
export function connectReceiver(opts: ReceiverOptions): { send(json: string): boolean; close(): void } {
  let pc: RTCPeerConnection | undefined;
  let dc: RTCDataChannel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const connect = async () => {
    const peer = (pc = new RTCPeerConnection({ iceServers: opts.iceServers }));
    const channel = (dc = peer.createDataChannel("vision")); // ordered, reliable

    const lost = () => {
      if (pc !== peer) return; // already handled
      pc = dc = undefined;
      peer.close();
      opts.onState?.(false);
      if (closed) return;
      timer = setTimeout(connect, RETRY_S[Math.min(attempt++, RETRY_S.length - 1)] * 1000);
    };
    channel.onopen = () => {
      attempt = 0;
      opts.onState?.(true);
    };
    channel.onclose = lost;
    // "disconnected" counts as lost: a 2 fps reading that arrives late is worth nothing.
    peer.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) lost();
    };

    try {
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve) => {
        peer.onicegatheringstatechange = () => peer.iceGatheringState === "complete" && resolve();
        setTimeout(resolve, GATHER_MS);
      });
      const res = await fetch(`${opts.url}/offer`, {
        method: "POST",
        headers: { authorization: `Bearer ${await opts.getToken()}`, "content-type": "application/json" },
        body: JSON.stringify(peer.localDescription),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`offer: HTTP ${res.status}`);
      await peer.setRemoteDescription(await res.json());
    } catch {
      lost();
    }
  };
  void connect();

  return {
    send(json) {
      if (dc?.readyState !== "open" || dc.bufferedAmount > MAX_BUFFERED) return false;
      try {
        dc.send(json); // throws when larger than the receiver said it accepts
        return true;
      } catch {
        return false;
      }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      const peer = pc;
      dc?.close(); // closes after what is buffered has gone out, e.g. the final "stopped"
      pc = dc = undefined;
      setTimeout(() => peer?.close(), 500);
    },
  };
}
