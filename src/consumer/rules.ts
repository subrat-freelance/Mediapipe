// The rules layer: turns the per-frame MediaPipe JSON into events. This is the "consumer" the
// receiver deliberately does not run (plan §2, §13) — pure, so a host can import it or run watch.ts.
//
// What is reliable here: presence, number of people, a raised hand, head direction, gaze down,
// eyes closed, talking. What is NOT: a phone. This build has no object detector and no hand/finger
// landmarks, so "looking_down" + "hand_to_face" are the nearest proxy and also fire for reading,
// writing or a chin resting on a hand. Real phone detection = a third MediaPipe task (plan §6.3).
import type { FrameMessage } from "../wire";

// Geometry and blendshape thresholds. Measured-reasonable defaults; a real camera and distance
// need tuning. ponytail: fixed thresholds, make them options only if a deployment proves it needs to.
const YAW_AWAY_DEG = 25; // head turned off-centre, + = toward the person's own left
const PITCH_AWAY_DEG = 20; // head tilted up or down off-centre
const HAND_TO_FACE = 0.17; // wrist-to-nose distance, fraction of frame, for a hand at the face
const GAZE_DOWN = 0.5; // eyeLookDown blendshape, averaged over both eyes
const EYES_CLOSED = 0.5; // eyeBlink blendshape
const JAW_OPEN = 0.4; // mouth open on this frame (one frame of speech)
const PHONE_SCORE = 0.35; // object-detector score for a "cell phone" (hand-held phones score ~0.3–0.8)

const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const blend = (face: FrameMessage["face"], name: string): number =>
  face.faceBlendshapes[0]?.categories.find((c) => c.categoryName === name)?.score ?? 0;

export interface Signals {
  present: boolean; // a face is visible
  body: boolean; // a pose is visible (a person facing away or far has a body but no face)
  faces: number;
  leftHandRaised: boolean; // the person's own left hand, wrist above the eyes
  rightHandRaised: boolean;
  handToFace: boolean; // a wrist up at the face (phone-to-ear, hand on chin)
  yaw: number; // head yaw in degrees, + = turned to the person's own left
  pitch: number; // head pitch in degrees
  lookingAway: boolean; // head turned or tilted away from the camera
  gazeDown: boolean; // eyes looking down (proxy for a phone or notes in the lap)
  eyesClosed: boolean;
  talking: boolean;
  phone: boolean; // a phone was actually detected (needs the objects task on)
}

/** Everything one frame says about one person. Pure, no history. */
export function signals(msg: FrameMessage): Signals {
  const pose = msg.pose.landmarks[0];
  const faces = msg.face.faceBlendshapes.length;
  const m = msg.face.facialTransformationMatrixes[0]?.data;

  const vis = (i: number) => !!pose && pose[i].visibility > 0.5;
  // Own left: wrist 15, elbow 13, eye 2. Own right: wrist 16, elbow 14, eye 5. (plan §13)
  const raised = (wrist: number, elbow: number, eye: number) =>
    vis(wrist) && pose![wrist].y < pose![eye].y && pose![wrist].y < pose![elbow].y;
  const nearNose = (wrist: number) =>
    vis(wrist) && Math.hypot(pose![wrist].x - pose![0].x, pose![wrist].y - pose![0].y) < HAND_TO_FACE;

  const yaw = m ? deg(Math.atan2(m[8], m[10])) : 0;
  const pitch = m ? deg(Math.asin(clamp(-m[9], -1, 1))) : 0;
  const gazeDown = (blend(msg.face, "eyeLookDownLeft") + blend(msg.face, "eyeLookDownRight")) / 2 > GAZE_DOWN;
  const eyesClosed = (blend(msg.face, "eyeBlinkLeft") + blend(msg.face, "eyeBlinkRight")) / 2 > EYES_CLOSED;

  return {
    present: faces > 0,
    body: !!pose,
    faces,
    leftHandRaised: raised(15, 13, 2),
    rightHandRaised: raised(16, 14, 5),
    handToFace: nearNose(15) || nearNose(16),
    yaw,
    pitch,
    lookingAway: faces > 0 && (Math.abs(yaw) > YAW_AWAY_DEG || Math.abs(pitch) > PITCH_AWAY_DEG),
    gazeDown: faces > 0 && gazeDown,
    eyesClosed: faces > 0 && eyesClosed,
    talking: faces > 0 && blend(msg.face, "jawOpen") > JAW_OPEN,
    phone: (msg.objects ?? []).some((o) => o.categoryName === "cell phone" && o.score > PHONE_SCORE),
  };
}

export interface VisionEvent {
  type: "event";
  event: string;
  state: "start" | "end";
  pid: string;
  sid?: string;
  name?: string;
  ts: number; // the frame's capture time, from the payload
  seq: number;
  detail?: Record<string, unknown>;
}

// hold = frames a condition must last before it counts (2 fps, so one frame is half a second; plan §13).
interface Cond {
  name: string;
  on: (s: Signals) => boolean;
  hold: number;
  detail?: (s: Signals) => Record<string, unknown>;
}

const CONDS: Cond[] = [
  {
    name: "hand_raised",
    on: (s) => s.leftHandRaised || s.rightHandRaised,
    hold: 3,
    detail: (s) => ({ hand: s.leftHandRaised && s.rightHandRaised ? "both" : s.leftHandRaised ? "left" : "right" }),
  },
  { name: "phone", on: (s) => s.phone, hold: 4 }, // a phone actually detected (objects task on)
  { name: "hand_to_face", on: (s) => s.handToFace, hold: 4 },
  { name: "absent", on: (s) => !s.present && !s.body, hold: 10 }, // no face and no body
  { name: "multiple_people", on: (s) => s.faces >= 2, hold: 6, detail: (s) => ({ faces: s.faces }) },
  {
    name: "looking_away",
    on: (s) => s.lookingAway,
    hold: 12,
    detail: (s) => ({ yaw: Math.round(s.yaw), pitch: Math.round(s.pitch) }),
  },
  { name: "looking_down", on: (s) => s.gazeDown, hold: 6 }, // proxy: phone or notes in the lap
  { name: "eyes_closed", on: (s) => s.eyesClosed, hold: 6 },
  { name: "talking", on: (s) => s.talking, hold: 2 },
];

const OFF_HOLD = 2; // frames a condition must be false before the event ends (debounce)

/** One per participant. feed() a frame payload, get the events that started or ended on it. */
export class Detector {
  private firing = new Map<string, boolean>();
  private run = new Map<string, number>(); // consecutive frames the condition held
  private gap = new Map<string, number>(); // consecutive frames it was false while firing

  constructor(private who: { pid: string; sid?: string; name?: string }) {}

  feed(msg: FrameMessage): VisionEvent[] {
    const s = signals(msg);
    const out: VisionEvent[] = [];
    for (const c of CONDS) {
      if (c.on(s)) {
        this.gap.set(c.name, 0);
        const r = (this.run.get(c.name) ?? 0) + 1;
        this.run.set(c.name, r);
        if (r >= c.hold && !this.firing.get(c.name)) {
          this.firing.set(c.name, true);
          out.push(this.ev(c.name, "start", msg.ts, msg.seq, c.detail?.(s)));
        }
      } else {
        this.run.set(c.name, 0);
        if (this.firing.get(c.name) && (this.gap.get(c.name) ?? 0) + 1 >= OFF_HOLD) {
          this.firing.set(c.name, false);
          out.push(this.ev(c.name, "end", msg.ts, msg.seq));
        } else if (this.firing.get(c.name)) {
          this.gap.set(c.name, (this.gap.get(c.name) ?? 0) + 1);
        }
      }
    }
    return out;
  }

  /** End every still-firing event, e.g. when the stream stops. */
  close(ts: number, seq: number): VisionEvent[] {
    const out: VisionEvent[] = [];
    for (const [name, on] of this.firing) if (on) out.push(this.ev(name, "end", ts, seq));
    this.firing.clear();
    return out;
  }

  private ev(event: string, state: "start" | "end", ts: number, seq: number, detail?: Record<string, unknown>): VisionEvent {
    return {
      type: "event",
      event,
      state,
      pid: this.who.pid,
      ...(this.who.sid && { sid: this.who.sid }),
      ...(this.who.name && { name: this.who.name }),
      ts,
      seq,
      ...(detail && { detail }),
    };
  }
}
