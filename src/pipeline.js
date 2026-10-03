import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSETS } from './assets.js';
import { refineSequence, validateCamera } from './refinement.js';

export const VIEW_ANGLES = Object.freeze([
  'left_profile', 'left_three_quarter', 'front', 'right_three_quarter', 'right_profile',
]);

const STAGES = Object.freeze([
  'fitGeometry', 'bakeAlbedo', 'mapScalp', 'reconstructGroom', 'archiveSpatialMaps',
]);

async function validateViews(views) {
  if (!Array.isArray(views) || views.length !== VIEW_ANGLES.length) {
    throw new Error('Exactly five ordered, calibrated views are required.');
  }
  for (const [index, view] of views.entries()) {
    if (view.angle !== VIEW_ANGLES[index]) throw new Error(`Expected view ${VIEW_ANGLES[index]}.`);
    validateCamera(view.camera);
    for (const key of ['plate', 'hairMask']) {
      if (typeof view[key] !== 'string') throw new Error(`Missing ${key} path.`);
      const stat = await lstat(view[key]);
      if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid ${key} file.`);
    }
  }
}

function requireMethods(backend, methods) {
  for (const name of methods) {
    if (typeof backend?.[name] !== 'function') throw new Error(`Backend must implement ${name}().`);
  }
}

async function render(bundle, request, { physics, renderer, diffusion }, feedback) {
  requireMethods(physics, ['simulate']);
  requireMethods(renderer, ['render']);
  requireMethods(diffusion, ['inpaint']);
  const { time, dynamics, scene, pose, camera, yaw } = request;
  if (!Number.isFinite(time) || time < 0) throw new Error('Frame time must be finite and nonnegative.');
  const curves = await physics.simulate({
    groom: bundle.paths.groom,
    colliders: [bundle.paths.head, bundle.paths.body],
    scalp: bundle.paths.scalp,
    skeleton: bundle.paths.skeleton,
    time, dynamics, pose,
    ...(feedback ? { state: feedback.state } : {}),
  });
  const maps = await renderer.render({
    bundle, curves, scene, pose, time, camera, yaw,
    ...(feedback ? { state: feedback.state } : {}),
  });
  for (const key of ['baldComposite', 'hairMask', 'depth', 'lineart']) {
    if (maps?.[key] == null) throw new Error(`Renderer must provide ${key}.`);
  }
  return diffusion.inpaint({
    ...maps, identity: bundle.identity, time,
    ...(feedback ? { camera, yaw, identityEmbedding: feedback.identityEmbedding, controlDepth: maps.depth } : {}),
  });
}

export class DigitalDoublePipeline {
  constructor(library, reconstruction) {
    this.library = library;
    this.reconstruction = reconstruction;
  }

  async prepare(identity, views) {
    const cached = await this.library.load(identity);
    if (cached) return { bundle: cached, reused: true };
    // Validation and all reconstruction work occur only on a cache miss.
    requireMethods(this.reconstruction, STAGES);
    await validateViews(views);
    const directory = await mkdtemp(join(tmpdir(), 'digital-double-'));
    try {
      const context = { identity, views, directory, assets: ASSETS };
      for (const stage of STAGES) await this.reconstruction[stage](context);
      return { bundle: await this.library.publish(identity, directory), reused: false };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async renderFrame(identity, request, { physics, renderer, diffusion }) {
    const bundle = await this.library.load(identity);
    if (!bundle) throw new Error(`Unknown identity: ${identity}`);
    return render(bundle, request, { physics, renderer, diffusion });
  }

  async refineSequence(sourceIdentity, targetIdentity, requests, adapters) {
    return refineSequence(this.library, sourceIdentity, targetIdentity, requests, adapters, render);
  }
}
