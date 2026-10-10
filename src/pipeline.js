import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_PERSPECTIVES, validateAnalysis } from './analysis.js';
import { ASSETS } from './assets.js';
import { refineSequence, validateCamera } from './refinement.js';

// Nine required perspectives: an eight-way ring at 45° steps plus an elevated crown view.
export const VIEW_ANGLES = Object.freeze([
  'front', 'right_three_quarter', 'right_profile', 'right_rear',
  'back', 'left_rear', 'left_profile', 'left_three_quarter', 'crown',
]);

const STAGES = Object.freeze([
  'analyzeViews', 'fitGeometry', 'bakeAlbedo', 'mapScalp', 'reconstructGroom', 'archiveSpatialMaps',
]);

const FACE_VISIBLE = Object.freeze(new Set(['front', 'right_three_quarter', 'left_three_quarter']));

const RENDER_MAPS = Object.freeze(['baldComposite', 'hairMask', 'depth', 'lineart', 'parsing', 'keypoints']);

async function validateViews(views) {
  if (!Array.isArray(views) || views.length < MIN_PERSPECTIVES) {
    throw new Error(`At least ${MIN_PERSPECTIVES} calibrated perspectives are required.`);
  }
  const angles = new Set();
  for (const view of views) {
    if (typeof view?.angle !== 'string' || view.angle === '' || angles.has(view.angle)) {
      throw new Error('Each view requires a unique angle name.');
    }
    angles.add(view.angle);
    validateCamera(view.camera);
    for (const key of ['plate', 'hairMask']) {
      if (typeof view[key] !== 'string') throw new Error(`Missing ${key} path.`);
      const stat = await lstat(view[key]);
      if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid ${key} file.`);
    }
  }
  for (const angle of VIEW_ANGLES) {
    if (!angles.has(angle)) throw new Error(`Expected view ${angle}.`);
  }
}

function validateAnalyses(analyses, views) {
  if (!Array.isArray(analyses) || analyses.length !== views.length) {
    throw new Error('analyzeViews must return one analysis per view, in view order.');
  }
  for (const [index, analysis] of analyses.entries()) {
    validateAnalysis(analysis, { requireFace: FACE_VISIBLE.has(views[index].angle) });
  }
  return Object.freeze([...analyses]);
}

function requireMethods(backend, methods) {
  for (const name of methods) {
    if (typeof backend?.[name] !== 'function') throw new Error(`Backend must implement ${name}().`);
  }
}

async function composePrompt(prompter, input) {
  requireMethods(prompter, ['compose']);
  const result = await prompter.compose(input);
  if (typeof result?.prompt !== 'string' || result.prompt.trim() === '' ||
      (result.negativePrompt !== undefined && typeof result.negativePrompt !== 'string')) {
    throw new Error('Prompter must return a nonempty prompt string and optional negativePrompt string.');
  }
  return { prompt: result.prompt, ...(result.negativePrompt !== undefined ? { negativePrompt: result.negativePrompt } : {}) };
}

async function render(bundle, request, { physics, renderer, diffusion, prompter }, feedback) {
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
  for (const key of RENDER_MAPS) {
    if (maps?.[key] == null) throw new Error(`Renderer must provide ${key}.`);
  }
  // Optional local LLM/VLM (for example llama.cpp) writes the sd-cli prompt from the maps.
  const prompts = prompter === undefined ? {} : await composePrompt(prompter, {
    identity: bundle.identity, time, pose, scene, camera, yaw, maps,
  });
  return diffusion.inpaint({
    ...maps, ...prompts, identity: bundle.identity, time,
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
      const [analyze, ...stages] = STAGES;
      // Mattes, contours, parsing and landmarks are validated before any mesh fitting.
      context.analyses = validateAnalyses(await this.reconstruction[analyze](context), views);
      for (const stage of stages) await this.reconstruction[stage](context);
      return { bundle: await this.library.publish(identity, directory), reused: false };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async renderFrame(identity, request, { physics, renderer, diffusion, prompter }) {
    const bundle = await this.library.load(identity);
    if (!bundle) throw new Error(`Unknown identity: ${identity}`);
    return render(bundle, request, { physics, renderer, diffusion, prompter });
  }

  async refineSequence(sourceIdentity, targetIdentity, requests, adapters) {
    return refineSequence(this.library, sourceIdentity, targetIdentity, requests, adapters, render);
  }
}
