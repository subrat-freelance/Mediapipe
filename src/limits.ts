// Limits of the wire contract. Kept apart from wire.ts so the browser can import
// the values without pulling zod into its bundle; wire.ts re-exports them.
export const WIRE_VERSION = 1;
export const MAX_MESSAGE_BYTES = 60_000;
export const MAX_FPS = 5;
export const MAX_MSGS_PER_SEC = 10;
export const MAX_MSGS_BURST = 20;
