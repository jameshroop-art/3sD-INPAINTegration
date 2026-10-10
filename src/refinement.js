import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_PERSPECTIVES, validateAnalysis } from './analysis.js';
import { ASSETS, OPTIONAL_ASSETS } from './assets.js';

const METHODS = [
  'initialize', 'extract', 'checkIdentity', 'smoothHair',
  'updateAlbedo', 'refineGeometry', 'recalibrateSkeleton', 'refineHair', 'finalize',
];

export function validateCamera(camera) {
  if (!camera || !['intrinsics', 'worldToCamera'].every(key =>
    Array.isArray(camera[key]) && camera[key].length === (key === 'intrinsics' ? 9 : 16) &&
    Array.from(camera[key]).every(Number.isFinite))) {
    throw new Error('Each view requires finite 3×3 intrinsics and 4×4 worldToCamera matrices.');
  }
}

function validateObservations(observations) {
  validateAnalysis(observations);
  for (const key of ['skin', 'bodyTexture', 'bodyMask', 'hairMask', 'strandDirections']) {
    if (observations[key] == null) throw new Error(`Extractor must provide ${key}.`);
  }
}

export async function refineSequence(library, sourceIdentity, targetIdentity, requests,
  { feedback, onFrame, ...renderAdapters }, render) {
  library.directory(targetIdentity);
  if (sourceIdentity === targetIdentity) throw new Error('Refinement requires a new target identity.');
  const original = await library.load(sourceIdentity);
  if (!original) throw new Error(`Unknown identity: ${sourceIdentity}`);
  if (await library.load(targetIdentity)) throw new Error(`Identity already exists: ${targetIdentity}`);
  if (!Array.isArray(requests) || requests.length === 0) throw new Error('A nonempty frame sequence is required.');
  if (onFrame !== undefined && typeof onFrame !== 'function') throw new Error('onFrame must be a function.');
  let lastTime = -1;
  for (const request of requests) {
    if (!request || !Number.isFinite(request.time) || request.time < 0 || request.time <= lastTime ||
        !Number.isFinite(request.yaw) || request.yaw < 0 || request.yaw >= 360) {
      throw new Error('Frames require increasing nonnegative times and yaw in [0, 360).');
    }
    validateCamera(request.camera);
    lastTime = request.time;
  }
  if (new Set(requests.map(request => request.yaw)).size < MIN_PERSPECTIVES) {
    throw new Error(`Refinement requires at least ${MIN_PERSPECTIVES} distinct yaw perspectives.`);
  }
  for (const method of METHODS) {
    if (typeof feedback?.[method] !== 'function') throw new Error(`Feedback backend must implement ${method}().`);
  }
  for (const [key, method] of [['physics', 'simulate'], ['renderer', 'render'], ['diffusion', 'inpaint']]) {
    if (typeof renderAdapters[key]?.[method] !== 'function') throw new Error(`Backend must implement ${method}().`);
  }
  if (renderAdapters.prompter !== undefined && typeof renderAdapters.prompter?.compose !== 'function') {
    throw new Error('Backend must implement compose().');
  }
  const directory = await mkdtemp(join(tmpdir(), 'digital-double-refine-'));
  try {
    const paths = {};
    for (const [key, source] of Object.entries(original.paths)) {
      paths[key] = join(directory, { ...ASSETS, ...OPTIONAL_ASSETS }[key]);
      await copyFile(source, paths[key]);
    }
    const bundle = { identity: sourceIdentity, directory, paths };
    const initialized = await feedback.initialize({ bundle });
    const state = initialized?.state;
    const embedding = initialized?.identityEmbedding;
    if (state == null || !(Array.isArray(embedding) || embedding instanceof Float32Array) ||
        embedding.length === 0 || !Array.from(embedding).every(Number.isFinite)) {
      throw new Error('Initialize must provide state and a finite source identity embedding.');
    }
    const identityEmbedding = Object.freeze(Array.from(embedding));
    let previous = null;
    let acceptedFrames = 0;
    const acceptedYaws = new Set();
    let rejectedFrames = 0;
    for (const [index, request] of requests.entries()) {
      const frame = await render(bundle, request, renderAdapters, { state, identityEmbedding });
      const extracted = await feedback.extract({ frame, request });
      validateObservations(extracted);
      const accepted = await feedback.checkIdentity({ frame, observations: extracted, identityEmbedding, request });
      if (typeof accepted !== 'boolean') throw new Error('checkIdentity must return a boolean.');
      if (accepted) {
        const hairMask = await feedback.smoothHair({
          frame, observations: extracted, previous, request,
        });
        if (hairMask == null) throw new Error('smoothHair must return a hair mask.');
        const observations = { ...extracted, hairMask };
        const context = { state, observations, request, identityEmbedding };
        for (const method of ['updateAlbedo', 'refineGeometry', 'recalibrateSkeleton', 'refineHair']) {
          await feedback[method](context);
        }
        previous = { frame, hairMask, request };
        acceptedFrames++;
        acceptedYaws.add(request.yaw);
      } else {
        rejectedFrames++;
      }
      if (onFrame) await onFrame({ frame, index, accepted });
    }
    if (acceptedFrames === 0) throw new Error('No frames passed the identity guard; no refined asset published.');
    if (acceptedYaws.size < MIN_PERSPECTIVES) {
      throw new Error(`Only ${acceptedYaws.size} accepted perspectives; at least ${MIN_PERSPECTIVES} are required.`);
    }
    // Require a fresh body-texture export even when the source already has one.
    await rm(join(directory, OPTIONAL_ASSETS.bodyAlbedo), { force: true });
    await feedback.finalize({
      state, bundle, directory, assets: { ...ASSETS, ...OPTIONAL_ASSETS },
      acceptedFrames, rejectedFrames,
    });
    const bodyAlbedo = await lstat(join(directory, OPTIONAL_ASSETS.bodyAlbedo));
    if (!bodyAlbedo.isFile() || bodyAlbedo.size === 0) throw new Error('Refinement must export body albedo.');
    return {
      bundle: await library.publish(targetIdentity, directory),
      acceptedFrames, rejectedFrames,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
