import { DEPTH_POSE_MODES, POSE_MODES } from './analysis.js';

// Index layouts of the supported pose modes. Hands use the 21-point layout:
// 0 wrist, then four joints per finger (thumb, index, middle, ring, pinky).
const OPENPOSE18 = {
  nose: 0, neck: 1, rShoulder: 2, rElbow: 3, rWrist: 4, lShoulder: 5, lElbow: 6, lWrist: 7,
  rHip: 8, rKnee: 9, rAnkle: 10, lHip: 11, lKnee: 12, lAnkle: 13,
};
const BODY25 = {
  nose: 0, neck: 1, rShoulder: 2, rElbow: 3, rWrist: 4, lShoulder: 5, lElbow: 6, lWrist: 7,
  midHip: 8, rHip: 9, rKnee: 10, rAnkle: 11, lHip: 12, lKnee: 13, lAnkle: 14,
  lBigToe: 19, lSmallToe: 20, lHeel: 21, rBigToe: 22, rSmallToe: 23, rHeel: 24,
};
const WHOLEBODY = {
  nose: 0, lShoulder: 5, rShoulder: 6, lElbow: 7, rElbow: 8, lWrist: 9, rWrist: 10,
  lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnkle: 15, rAnkle: 16,
  lBigToe: 17, lSmallToe: 18, lHeel: 19, rBigToe: 20, rSmallToe: 21, rHeel: 22,
};
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const LIMBS = [
  ['lShoulder', 'lElbow'], ['lElbow', 'lWrist'], ['rShoulder', 'rElbow'], ['rElbow', 'rWrist'],
  ['lHip', 'lKnee'], ['lKnee', 'lAnkle'], ['rHip', 'rKnee'], ['rKnee', 'rAnkle'],
];
const FEET = [
  ['lAnkle', 'lBigToe'], ['lAnkle', 'lSmallToe'], ['lAnkle', 'lHeel'],
  ['rAnkle', 'rBigToe'], ['rAnkle', 'rSmallToe'], ['rAnkle', 'rHeel'],
];
const NECK_TORSO = [
  ['neck', 'nose'], ['neck', 'lShoulder'], ['neck', 'rShoulder'],
];

// `neck` is either a joint index or the pair of shoulder indices whose midpoint is the neck.
const LAYOUTS = Object.freeze({
  body18: { names: OPENPOSE18, bones: [...NECK_TORSO, ['neck', 'lHip'], ['neck', 'rHip'], ...LIMBS] },
  body25: {
    names: BODY25,
    bones: [...NECK_TORSO, ['neck', 'midHip'], ['midHip', 'lHip'], ['midHip', 'rHip'], ...LIMBS, ...FEET],
  },
  openposeFull: {
    names: OPENPOSE18, bones: [...NECK_TORSO, ['neck', 'lHip'], ['neck', 'rHip'], ...LIMBS],
    face: 18, hands: { left: 86, right: 107 },
  },
  wholebody: {
    names: WHOLEBODY,
    bones: [['lShoulder', 'rShoulder'], ['lHip', 'rHip'], ['lShoulder', 'lHip'], ['rShoulder', 'rHip'], ...LIMBS, ...FEET],
    face: 23, hands: { left: 91, right: 112 },
  },
});
const layoutFor = mode => LAYOUTS[mode === 'wholebody3d' ? 'wholebody' : mode];

function neckOf(joints, names) {
  if (names.neck !== undefined) return joints[names.neck];
  const [l, r] = [joints[names.lShoulder], joints[names.rShoulder]];
  if (!l || !r) return null;
  return {
    x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, z: (l.z + r.z) / 2,
    confidence: Math.min(l.confidence, r.confidence),
  };
}

/**
 * Turns validated pose keypoints into bones. Dropped (`null`) points produce no bone; nothing is
 * guessed. Only depth modes report bone `length` (xyz distance); 2D modes are screen sticks.
 * Face and hand sets are attachments: face parents to the neck, each hand to its body wrist.
 */
export function buildRig(joints, mode) {
  if (!Object.hasOwn(POSE_MODES, mode)) throw new Error(`Unknown pose mode: ${mode}`);
  if (!Array.isArray(joints) || joints.length !== POSE_MODES[mode]) {
    throw new Error(`${mode} rig requires ${POSE_MODES[mode]} indexed joints.`);
  }
  const layout = layoutFor(mode);
  const depth = DEPTH_POSE_MODES.includes(mode);
  const point = name => (name === 'neck' ? neckOf(joints, layout.names) : joints[layout.names[name]]);
  const bones = [];
  const add = (name, parent, child) => {
    if (!parent || !child) return;
    bones.push({
      name, parent, child,
      length: depth ? Math.hypot(child.x - parent.x, child.y - parent.y, child.z - parent.z) : null,
    });
  };
  for (const [a, b] of layout.bones) add(`${a}-${b}`, point(a), point(b));
  const attachments = {};
  if (layout.face !== undefined) {
    attachments.face = { start: layout.face, count: 68, parent: 'neck' };
  }
  if (layout.hands) {
    for (const [side, start] of Object.entries(layout.hands)) {
      const wrist = `${side[0]}Wrist`;
      attachments[`${side}Hand`] = { start, count: 21, parent: wrist };
      FINGERS.forEach((finger, f) => {
        let previous = joints[start];
        for (let j = 1; j <= 4; j++) {
          const current = joints[start + f * 4 + j];
          add(`${side}.${finger}.${j}`, previous, current);
          previous = current;
        }
      });
    }
  }
  return { mode, depth, bones, attachments };
}

// COCO-17 body index for each OpenPose-18 slot; slot 1 (neck) is the shoulder midpoint.
const COCO_TO_OPENPOSE = [0, null, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3];

/**
 * DWPose regroup of 133 whole-body joints into the 128-point `openposeFull` layout that the
 * ControlNet openpose_full map draws: 18 body, 68 face, 21 left hand, 21 right hand.
 * Feet are not part of that drawing. Coordinates (including any rtmw3d depth) are kept, so
 * callers project them through the camera before drawing.
 */
export function toOpenPoseFull(joints) {
  if (!Array.isArray(joints) || joints.length !== POSE_MODES.wholebody) {
    throw new Error('openpose_full regroup requires 133 whole-body joints.');
  }
  const body = COCO_TO_OPENPOSE.map(index => (index === null ? neckOf(joints, WHOLEBODY) : joints[index]));
  return [...body, ...joints.slice(23, 91), ...joints.slice(91, 133)];
}
