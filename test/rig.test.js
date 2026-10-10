import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRig, toOpenPoseFull, validateAnalysis } from '../src/index.js';
import { analysis, points } from './fixtures.js';

const at = (x, y, z = 0) => ({ x, y, z, confidence: 0.9 });

test('pose modes cover openpose_full and rtmw3d depth, rejecting depth in 2D modes', () => {
  validateAnalysis(analysis({ poseMode: 'openposeFull', bodyJoints: points(128) }));
  assert.throws(() => validateAnalysis(analysis({ poseMode: 'openposeFull', bodyJoints: points(133) })), /128/);
  const depth = [...points(132), at(1, 1, 0.5)];
  validateAnalysis(analysis({ poseMode: 'wholebody3d', bodyJoints: depth }));
  assert.throws(() => validateAnalysis(analysis({ poseMode: 'wholebody3d', bodyJoints: points(133) })), /depth/);
  assert.throws(() => validateAnalysis(analysis({ bodyJoints: depth })), /2D mode/);
});

test('3D rig turns limbs into bones with length and skips dropped joints', () => {
  const joints = Array(133).fill(null);
  joints[5] = at(0, 0, 0); joints[7] = at(0, 3, 4); joints[9] = at(0, 3, 5);
  joints[15] = at(1, 1, 1); joints[17] = at(1, 2, 1);
  const rig = buildRig(joints, 'wholebody3d');
  const bone = name => rig.bones.find(b => b.name === name);
  assert.equal(bone('lShoulder-lElbow').length, 5);
  assert.equal(bone('lElbow-lWrist').length, 1);
  assert.equal(bone('lAnkle-lBigToe').length, 1);
  assert.equal(bone('rShoulder-rElbow'), undefined);
  assert.equal(bone('lShoulder-rShoulder'), undefined);
  assert.deepEqual(rig.attachments.face, { start: 23, count: 68, parent: 'neck' });
  assert.equal(rig.attachments.leftHand.parent, 'lWrist');
  assert.equal(buildRig(joints, 'wholebody').bones[0].length, null);
});

test('each finger is a four-bone chain off the hand wrist', () => {
  const joints = Array(133).fill(null);
  for (let i = 91; i < 112; i++) joints[i] = at(i, 0);
  const rig = buildRig(joints, 'wholebody');
  const left = rig.bones.filter(b => b.name.startsWith('left.'));
  assert.equal(left.length, 20);
  assert.deepEqual(left.filter(b => b.name.startsWith('left.index.')).map(b => [b.parent.x, b.child.x]),
    [[91, 96], [96, 97], [97, 98], [98, 99]]);
  joints[97] = null;
  assert.equal(buildRig(joints, 'wholebody').bones.filter(b => b.name.startsWith('left.index.')).length, 2);
  assert.equal(rig.bones.some(b => b.name.startsWith('right.')), false);
});

test('BODY_25 parents feet to the ankle and body18 has no face or hand attachments', () => {
  const joints = points(25).map((p, i) => ({ ...p, x: i }));
  const rig = buildRig(joints, 'body25');
  assert.deepEqual(rig.bones.filter(b => b.name.startsWith('lAnkle-')).map(b => b.child.x), [19, 20, 21]);
  assert.deepEqual(buildRig(points(18), 'body18').attachments, {});
  assert.throws(() => buildRig(points(18), 'body25'), /25/);
  assert.throws(() => buildRig(points(18), 'densepose'), /Unknown/);
});

test('openpose_full regroup keeps 68 face and 42 hand points and derives the neck', () => {
  const joints = Array.from({ length: 133 }, (_, i) => ({ ...at(i, 0), confidence: 0.5 + (i % 2) / 4 }));
  const full = toOpenPoseFull(joints);
  assert.equal(full.length, 128);
  assert.deepEqual(full[1], { x: 5.5, y: 0, z: 0, confidence: 0.5 });
  assert.equal(full[2].x, 6);
  assert.equal(full[17].x, 3);
  assert.equal(full[18].x, 23);
  assert.equal(full[86].x, 91);
  assert.equal(full[127].x, 132);
  joints[6] = null;
  assert.equal(toOpenPoseFull(joints)[1], null);
  assert.throws(() => toOpenPoseFull(points(128)), /133/);
});
