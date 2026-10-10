// Shared per-image analysis contract for captured views and synthetic refinement frames.

export const MIN_PERSPECTIVES = 9;
export const MIN_CONTOUR_POINTS = 64;
export const KEYPOINT_THRESHOLD = 0.45;

// One body mode per pass. `wholebody` (COCO-WholeBody 133: body, feet, 68 face, 2×21 hands)
// is the default intricate OpenPose-full rig.
export const POSE_MODES = Object.freeze({ body18: 18, body25: 25, wholebody: 133 });
export const DEFAULT_POSE_MODE = 'wholebody';
export const BODY_JOINTS = POSE_MODES[DEFAULT_POSE_MODE];

// Face tiers: the 68-point set (also the ControlNet face overlay) plus at most one
// face-crop add-on per pass: 106-point landmarks or a 468/478-point mesh.
export const FACE_LANDMARK_TIERS = Object.freeze({
  sparse: Object.freeze({ min: 68, max: 68 }),
  medium: Object.freeze({ min: 100, max: Infinity }),
  dense: Object.freeze({ min: 400, max: Infinity }),
});

const HANDLES = ['matte', 'faceParsing', 'bodyParsing'];

// Indices are fixed by the model; a point below the threshold is `null` (dropped), never guessed.
export function validatePoints(points, { min, max = min }, name, threshold = KEYPOINT_THRESHOLD) {
  const count = min === max ? `${min}` : `at least ${min}`;
  if (!Array.isArray(points) || points.length < min || points.length > max) {
    throw new Error(`${name} requires ${count} indexed points.`);
  }
  let kept = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === null) continue;
    if (!point || !['x', 'y', 'z', 'confidence'].every(key => Number.isFinite(point[key])) ||
        point.confidence > 1) {
      throw new Error(`${name} points must be null (dropped) or finite XYZ with confidence in [0, 1].`);
    }
    if (point.confidence < threshold) {
      throw new Error(`${name} point ${i} is below the keypoint threshold ${threshold}; drop it as null.`);
    }
    kept++;
  }
  if (kept === 0) throw new Error(`${name} has no points above the keypoint threshold.`);
}

export function validateFaceLandmarks(landmarks, threshold = KEYPOINT_THRESHOLD) {
  if (!landmarks || typeof landmarks !== 'object') {
    throw new Error('Face landmarks require the 68-point sparse tier.');
  }
  const addOns = ['medium', 'dense'].filter(tier => landmarks[tier] != null);
  if (addOns.length > 1) {
    throw new Error('Pick one face add-on per pass: medium (106) or dense (468), not both.');
  }
  for (const tier of ['sparse', ...addOns]) {
    validatePoints(landmarks[tier], FACE_LANDMARK_TIERS[tier], `Face landmarks (${tier})`, threshold);
  }
}

function keypointThreshold(analysis) {
  const value = analysis.keypointThreshold ?? KEYPOINT_THRESHOLD;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('keypointThreshold must be in [0, 1].');
  }
  return value;
}

function validateContour(contour, width, height) {
  const flat = ArrayBuffer.isView(contour) ? Array.from(contour) : contour;
  if (!Array.isArray(flat) || flat.length % 2 !== 0 || flat.length < MIN_CONTOUR_POINTS * 2) {
    throw new Error(`Each edge contour must be a flat [x, y, ...] outline of at least ${MIN_CONTOUR_POINTS} points.`);
  }
  let area = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const [x, y] = [flat[i], flat[i + 1]];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
      throw new Error('Edge contour points must be finite and inside the image.');
    }
    const j = (i + 2) % flat.length;
    area += x * flat[j + 1] - flat[j] * y;
  }
  if (area === 0) throw new Error('Edge contours must enclose a nonzero area.');
  // Outlines traced from a binary mask snap to the pixel grid and produce blocky meshes.
  if (flat.every(value => Number.isInteger(value * 2))) {
    throw new Error('Edge contours must be subpixel traces of the soft matte, not pixel-grid staircases.');
  }
}

export function validateAnalysis(analysis, { requireFace = false } = {}) {
  if (!analysis || typeof analysis !== 'object') throw new Error('Each view requires an analysis object.');
  const { imageSize } = analysis;
  if (!imageSize || ![imageSize.width, imageSize.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Analysis requires positive integer imageSize width and height.');
  }
  for (const key of HANDLES) {
    if (analysis[key] == null) throw new Error(`Analysis must provide ${key}.`);
  }
  if (!Array.isArray(analysis.contours) || analysis.contours.length === 0) {
    throw new Error('Analysis must provide edge contours of the background-removed subject.');
  }
  for (const contour of analysis.contours) validateContour(contour, imageSize.width, imageSize.height);
  const threshold = keypointThreshold(analysis);
  if (analysis.faceLandmarks !== null || requireFace) validateFaceLandmarks(analysis.faceLandmarks, threshold);
  const mode = analysis.poseMode ?? DEFAULT_POSE_MODE;
  if (!Object.hasOwn(POSE_MODES, mode)) {
    throw new Error(`poseMode must be one of ${Object.keys(POSE_MODES).join(', ')}.`);
  }
  validatePoints(analysis.bodyJoints, { min: POSE_MODES[mode] }, `Body joints (${mode})`, threshold);
}
