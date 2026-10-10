// Shared per-image analysis contract for captured views and synthetic refinement frames.

export const MIN_PERSPECTIVES = 9;
export const BODY_JOINTS = 133;
export const MIN_CONTOUR_POINTS = 64;

// Face landmark tiers: iBUG-style 68 points, a 100+ point model (for example
// 106-point 2D landmarks), and a 400+ point dense mesh (for example 468/478).
export const FACE_LANDMARK_TIERS = Object.freeze({
  sparse: Object.freeze({ min: 68, max: 68 }),
  medium: Object.freeze({ min: 100, max: Infinity }),
  dense: Object.freeze({ min: 400, max: Infinity }),
});

const HANDLES = ['matte', 'faceParsing', 'bodyParsing'];

export function validatePoints(points, { min, max = min }, name) {
  if (!Array.isArray(points) || points.length < min || points.length > max ||
      !Array.from(points).every(point => point && ['x', 'y', 'z', 'confidence'].every(key =>
        Number.isFinite(point[key])) && point.confidence >= 0 && point.confidence <= 1)) {
    const count = min === max ? `${min}` : `at least ${min}`;
    throw new Error(`${name} requires ${count} indexed XYZ points with confidence in [0, 1].`);
  }
}

export function validateFaceLandmarks(landmarks) {
  if (!landmarks || typeof landmarks !== 'object') {
    throw new Error('Face landmarks require sparse (68), medium (100+) and dense (400+) tiers.');
  }
  for (const [tier, range] of Object.entries(FACE_LANDMARK_TIERS)) {
    validatePoints(landmarks[tier], range, `Face landmarks (${tier})`);
  }
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
  if (analysis.faceLandmarks !== null || requireFace) validateFaceLandmarks(analysis.faceLandmarks);
  validatePoints(analysis.bodyJoints, { min: BODY_JOINTS }, 'Body joints');
}
