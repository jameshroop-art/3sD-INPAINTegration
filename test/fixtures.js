import { BODY_JOINTS, MIN_CONTOUR_POINTS } from '../src/index.js';

export const points = length => Array.from({ length }, () => ({ x: 0, y: 0, z: 0, confidence: 0.8 }));

export function subpixelContour(count = MIN_CONTOUR_POINTS) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return [50 + 40.3 * Math.cos(angle), 50 + 40.3 * Math.sin(angle)];
  }).flat();
}

export function analysis(overrides = {}) {
  return {
    imageSize: { width: 100, height: 100 },
    matte: 'soft alpha matte', faceParsing: 'bisenet face parsing', bodyParsing: 'body part parsing',
    contours: [subpixelContour()],
    faceLandmarks: { sparse: points(68), medium: points(106) },
    bodyJoints: points(BODY_JOINTS),
    ...overrides,
  };
}
