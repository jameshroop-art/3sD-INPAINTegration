import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ASSETS, AssetLibrary, DigitalDoublePipeline, VIEW_ANGLES } from '../src/index.js';
import { analysis, points } from './fixtures.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'digital-double-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await createAssets(source);
  return { root, source, library: new AssetLibrary(join(root, 'identities')) };
}

async function createAssets(directory) {
  for (const filename of Object.values(ASSETS)) {
    await writeFile(join(directory, filename), `test fixture: ${filename}`);
  }
  await writeFile(join(directory, ASSETS.body), JSON.stringify({ asset: { version: '2.0' } }));
  await writeFile(join(directory, ASSETS.skeleton), JSON.stringify({ units: 'meters', bones: [] }));
}

function views(source) {
  return VIEW_ANGLES.map(angle => ({
    angle, plate: join(source, ASSETS.albedo), hairMask: join(source, ASSETS.scalp),
    camera: {
      intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      worldToCamera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  }));
}

test('publishes all seven files, reloads after restart and refuses overwrites', async t => {
  const { source, library } = await fixture(t);
  assert.equal(await library.load('subject'), null);
  const bundle = await library.publish('subject', source);
  assert.equal(Object.keys(bundle.paths).length, 7);
  assert.deepEqual(await library.list(), ['subject']);
  assert.equal(await readFile(bundle.paths.head, 'utf8'), `test fixture: ${ASSETS.head}`);
  assert.deepEqual((await new AssetLibrary(library.root).load('subject')).paths, bundle.paths);
  await assert.rejects(library.publish('subject', source), /already exists/);
});

test('rejects traversal and symlink identities', async t => {
  const { root, library } = await fixture(t);
  for (const id of ['../escape', '.', '', '/absolute', 'a/b', 'a\\b', 'x'.repeat(65)]) {
    await assert.rejects(library.load(id), /Identity must/);
  }
  await mkdir(library.root);
  await symlink(root, library.directory('linked'));
  await assert.rejects(library.load('linked'), /real directory/);
});

test('failed imports leave no visible or staging identity', async t => {
  const { source, library } = await fixture(t);
  await rm(join(source, ASSETS.groom));
  await assert.rejects(library.publish('incomplete', source));
  assert.equal(await library.load('incomplete'), null);
  assert.deepEqual(await readdir(library.root), []);
});

test('rejects empty files, symlink assets and non-self-contained glTF', async t => {
  const { source, library } = await fixture(t);
  await writeFile(join(source, ASSETS.head), '');
  await assert.rejects(library.publish('empty', source), /nonempty/);
  await rm(join(source, ASSETS.head));
  await symlink(join(source, ASSETS.albedo), join(source, ASSETS.head));
  await assert.rejects(library.publish('linked', source), /regular file/);
  await rm(join(source, ASSETS.head));
  await createAssets(source);
  await writeFile(join(source, ASSETS.body), JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ uri: '../outside.bin' }],
  }));
  await assert.rejects(library.publish('external', source), /embedded/);
});

test('detects corruption, bad manifests, and missing assets rather than treating them as cache misses', async t => {
  const { source, library } = await fixture(t);
  const bundle = await library.publish('subject', source);
  await writeFile(bundle.paths.head, 'corrupted');
  await assert.rejects(library.load('subject'), /integrity/);
  await writeFile(bundle.paths.head, await readFile(join(source, ASSETS.head)));
  await rm(bundle.paths.scalp);
  await assert.rejects(library.load('subject'), { code: 'ENOENT' });
  await writeFile(bundle.paths.scalp, await readFile(join(source, ASSETS.scalp)));
  await writeFile(join(bundle.directory, 'manifest.json'), '{"schemaVersion":99}');
  await assert.rejects(library.load('subject'), /manifest/);
});

test('concurrent publishers cannot overwrite a completed identity', async t => {
  const { source, library } = await fixture(t);
  const results = await Promise.allSettled([
    library.publish('subject', source), library.publish('subject', source),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(await library.load('subject'));
  assert.deepEqual(await readdir(library.root), ['subject']);
});

test('runs reconstruction stages in order once, then bypasses all backends and source input', async t => {
  const { source, library } = await fixture(t);
  const calls = [];
  let workspace;
  const reconstruction = {};
  const stages = ['analyzeViews', 'fitGeometry', 'bakeAlbedo', 'mapScalp', 'reconstructGroom', 'archiveSpatialMaps'];
  for (const stage of stages) {
    reconstruction[stage] = async context => {
      calls.push(stage);
      workspace = context.directory;
      if (stage === 'analyzeViews') return context.views.map(() => analysis());
      assert.equal(context.analyses.length, VIEW_ANGLES.length);
      assert.ok(Object.isFrozen(context.analyses));
      if (stage === 'archiveSpatialMaps') await createAssets(context.directory);
    };
  }
  const pipeline = new DigitalDoublePipeline(library, reconstruction);
  assert.equal((await pipeline.prepare('subject', views(source))).reused, false);
  assert.deepEqual(calls, stages);
  await assert.rejects(readdir(workspace), { code: 'ENOENT' });
  assert.equal((await new DigitalDoublePipeline(library).prepare('subject')).reused, true);
  assert.equal(calls.length, 6);
});

test('validates nine-perspective inputs before fitting and cleans up after backend failure', async t => {
  const { source, library } = await fixture(t);
  let workspace;
  let fitted = false;
  const reconstruction = {
    async analyzeViews({ views: input }) { return input.map(() => analysis()); },
    async fitGeometry(context) {
      fitted = true;
      workspace = context.directory;
      throw new Error('fit failed');
    },
    async bakeAlbedo() {}, async mapScalp() {}, async reconstructGroom() {}, async archiveSpatialMaps() {},
  };
  const pipeline = new DigitalDoublePipeline(library, reconstruction);
  assert.equal(VIEW_ANGLES.length, 9);
  await assert.rejects(pipeline.prepare('subject', views(source).slice(0, 8)), /At least 9/);
  const invalid = views(source);
  invalid.push({ ...invalid[0] });
  await assert.rejects(pipeline.prepare('subject', invalid), /unique angle/);
  invalid[9] = { ...invalid[0], angle: 'extra_low_front' };
  invalid[0] = { ...invalid[0], angle: 'other' };
  await assert.rejects(pipeline.prepare('subject', invalid), /Expected view front/);
  invalid[0] = { ...invalid[9], angle: 'front', camera: { ...invalid[9].camera, intrinsics: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] } };
  await assert.rejects(pipeline.prepare('subject', invalid), /matrices/);
  assert.equal(fitted, false);
  await assert.rejects(pipeline.prepare('subject', views(source)), /fit failed/);
  await assert.rejects(readdir(workspace), { code: 'ENOENT' });
  assert.equal(await library.load('subject'), null);
});

test('routes immutable assets to simulation and generated maps to diffusion', async t => {
  const { source, library } = await fixture(t);
  const bundle = await library.publish('subject', source);
  const pipeline = new DigitalDoublePipeline(library);
  const order = [];
  const adapters = {
    physics: { async simulate(input) {
      order.push('physics');
      assert.deepEqual(input.colliders, [bundle.paths.head, bundle.paths.body]);
      assert.equal(input.groom, bundle.paths.groom);
      assert.equal(input.dynamics.wind, 15);
      return 'animated curves';
    } },
    renderer: { async render(input) {
      order.push('render');
      assert.equal(input.curves, 'animated curves');
      assert.equal(input.scene.hdri, 'environment');
      return {
        baldComposite: 'bald', hairMask: 'mask', depth: 'depth', lineart: 'lines',
        parsing: 'parsing control', keypoints: 'keypoint control',
      };
    } },
    diffusion: { async inpaint(input) {
      order.push('diffusion');
      assert.equal(input.hairMask, 'mask');
      assert.equal(input.depth, 'depth');
      assert.equal(input.parsing, 'parsing control');
      assert.equal(input.keypoints, 'keypoint control');
      return 'frame';
    } },
  };
  assert.equal(await pipeline.renderFrame('subject', {
    time: 0, dynamics: { wind: 15 }, scene: { hdri: 'environment' },
  }, adapters), 'frame');
  assert.deepEqual(order, ['physics', 'render', 'diffusion']);
  await assert.rejects(pipeline.renderFrame('subject', { time: -1 }, adapters), /time/);
  adapters.renderer.render = async () => ({});
  await assert.rejects(pipeline.renderFrame('subject', {
    time: 0, dynamics: { wind: 15 },
  }, adapters), /baldComposite/);
  adapters.renderer.render = async () => ({ baldComposite: 'b', hairMask: 'm', depth: 'd', lineart: 'l' });
  await assert.rejects(pipeline.renderFrame('subject', { time: 0, dynamics: { wind: 15 } }, adapters), /parsing/);
});

test('rejects blocky or incomplete view analyses before fitting', async t => {
  const { source, library } = await fixture(t);
  const staircase = Array.from({ length: 64 }, (_, i) => {
    const side = Math.floor(i / 16), step = i % 16;
    return [[10 + step, 10], [26, 10 + step], [26 - step, 26], [10, 26 - step]][side];
  }).flat();
  const cases = [
    [analysis({ contours: [staircase] }), /subpixel/],
    [analysis({ contours: [] }), /edge contours/],
    [analysis({ contours: [[1.5, 2.25, 3.75, 4.1]] }), /at least 64/],
    [analysis({ matte: null }), /matte/],
    [analysis({ faceParsing: undefined }), /faceParsing/],
    [analysis({ faceLandmarks: { sparse: points(68), medium: points(99) } }), /medium/],
    [analysis({ faceLandmarks: { sparse: points(67), medium: points(106) } }), /sparse/],
    [analysis({ faceLandmarks: { sparse: points(68), dense: points(300) } }), /dense/],
    [analysis({ faceLandmarks: { sparse: points(68), medium: points(106), dense: points(468) } }), /one face add-on/],
    [analysis({ faceLandmarks: null }), /68-point/],
    [analysis({ bodyJoints: points(17) }), /133/],
    [analysis({ poseMode: 'body25', bodyJoints: points(133) }), /25/],
    [analysis({ poseMode: 'densepose' }), /poseMode/],
    [analysis({ bodyJoints: [...points(132), { x: 1, y: 1, z: 0, confidence: 0.3 }] }), /threshold 0.45/],
    [analysis({ bodyJoints: Array(133).fill(null) }), /no points above/],
    [analysis({ bodyJoints: [...points(132), { x: 1, y: 1, z: 0 }] }), /null \(dropped\)/],
    [analysis({ keypointThreshold: 2 }), /keypointThreshold/],
  ];
  for (const [bad, error] of cases) {
    let fitted = false;
    const pipeline = new DigitalDoublePipeline(library, {
      async analyzeViews({ views: input }) { return input.map(view => view.angle === 'front' ? bad : analysis()); },
      async fitGeometry() { fitted = true; },
      async bakeAlbedo() {}, async mapScalp() {}, async reconstructGroom() {}, async archiveSpatialMaps() {},
    });
    await assert.rejects(pipeline.prepare('subject', views(source)), error);
    assert.equal(fitted, false);
  }
  const modes = [
    analysis({ poseMode: 'body18', bodyJoints: [...points(17), null] }),
    analysis({ poseMode: 'body25', bodyJoints: points(25) }),
    analysis({ faceLandmarks: { sparse: [null, ...points(67)], dense: points(468) } }),
    analysis({ keypointThreshold: 0.2, bodyJoints: [...points(132), { x: 1, y: 1, z: 0, confidence: 0.3 }] }),
  ];
  for (const mode of modes) {
    const pipeline = new DigitalDoublePipeline(library, {
      async analyzeViews({ views: input }) { return input.map(() => mode); },
      async fitGeometry() { throw new Error('reached fitting'); },
      async bakeAlbedo() {}, async mapScalp() {}, async reconstructGroom() {}, async archiveSpatialMaps() {},
    });
    await assert.rejects(pipeline.prepare('subject', views(source)), /reached fitting/);
  }
  const rear = new DigitalDoublePipeline(library, {
    async analyzeViews({ views: input }) {
      return input.map(view => analysis(view.angle === 'back' ? { faceLandmarks: null } : {}));
    },
    async fitGeometry() { throw new Error('reached fitting'); },
    async bakeAlbedo() {}, async mapScalp() {}, async reconstructGroom() {}, async archiveSpatialMaps() {},
  });
  await assert.rejects(rear.prepare('subject', views(source)), /reached fitting/);
  const occluded = new DigitalDoublePipeline(library, {
    async analyzeViews({ views: input }) {
      return input.map(view => analysis(view.angle === 'left_three_quarter' ? { faceLandmarks: null } : {}));
    },
    async fitGeometry() { throw new Error('reached fitting'); },
    async bakeAlbedo() {}, async mapScalp() {}, async reconstructGroom() {}, async archiveSpatialMaps() {},
  });
  await assert.rejects(occluded.prepare('subject', views(source)), /68-point/);
});

test('CLI imports, inspects, lists and reports usage and missing identities', async t => {
  const { source, library } = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
  assert.equal(run('import', library.root, 'subject', source).identity, 'subject');
  assert.equal(run('inspect', library.root, 'subject').identity, 'subject');
  assert.deepEqual(run('list', library.root), ['subject']);
  assert.throws(() => run('inspect', library.root, 'missing'), /Unknown identity/);
  assert.throws(() => run('list'), /Usage/);
});
