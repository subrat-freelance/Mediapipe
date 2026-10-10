// Built as one classic script, vision-worker.js, that sits beside wasm/ and models/.
// A classic worker has importScripts, which is MediaPipe's plain loading path.
// (Typed against the DOM lib: `self` is the worker scope at run time.)
import { FaceLandmarker, FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

const base = self.location.href.replace(/\/[^/]*$/, "");
let pose: PoseLandmarker;
let face: FaceLandmarker;
let objectDet: ObjectDetector | undefined; // only when the objects task is on

async function init(delegate: "CPU" | "GPU", objects: boolean) {
  const files = await FilesetResolver.forVisionTasks(`${base}/wasm`);
  // Trap 6: VIDEO mode tracks from the previous frame. If landmarks lag at 2 fps,
  // switch to runningMode "IMAGE" and detect().
  pose = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${base}/models/pose_landmarker_lite.task`, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  face = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${base}/models/face_landmarker.task`, delegate },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  // EfficientDet-Lite2 on COCO: finds a "cell phone" (and books, laptops, …). score 0.3 is low on purpose —
  // a hand-held phone is small and scores ~0.3–0.8; the rules layer holds it over several frames.
  if (objects)
    objectDet = await ObjectDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}/models/efficientdet_lite2_int8.tflite`, delegate },
      runningMode: "VIDEO",
      scoreThreshold: 0.3,
      maxResults: 10,
    });
}

function analyse(bitmap: ImageBitmap, t: number, ts: number) {
  try {
    const t0 = performance.now();
    const p = pose.detectForVideo(bitmap, t);
    const f = face.detectForVideo(bitmap, t);
    const o = objectDet?.detectForVideo(bitmap, t);
    const infer_ms = performance.now() - t0;
    // Normalise boxes 0..1 and drop "person" (pose/face already cover people).
    const objects = o?.detections
      .filter((d) => d.boundingBox && d.categories[0]?.categoryName !== "person")
      .map((d) => ({
        categoryName: d.categories[0].categoryName,
        score: d.categories[0].score,
        box: {
          x: d.boundingBox!.originX / bitmap.width,
          y: d.boundingBox!.originY / bitmap.height,
          w: d.boundingBox!.width / bitmap.width,
          h: d.boundingBox!.height / bitmap.height,
        },
      }))
      .slice(0, 10);
    // Fields picked out by name: the results are class instances and may hold masks.
    return {
      type: "result",
      ts,
      w: bitmap.width,
      h: bitmap.height,
      infer_ms,
      landmarks: p.landmarks,
      worldLandmarks: p.worldLandmarks,
      faceLandmarks: f.faceLandmarks,
      faceBlendshapes: f.faceBlendshapes,
      facialTransformationMatrixes: f.facialTransformationMatrixes.map((m) => ({
        rows: m.rows,
        columns: m.columns,
        data: Array.from(m.data),
      })),
      ...(objects && { objects }),
    };
  } finally {
    bitmap.close();
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await init(m.delegate, m.objects);
      self.postMessage({ type: "ready" });
    } else if (m.type === "frame") {
      self.postMessage(analyse(m.bitmap, m.t, m.ts));
    }
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
};
