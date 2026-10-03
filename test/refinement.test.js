import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSETS, OPTIONAL_ASSETS, AssetLibrary, ConfidenceAtlas, DigitalDoublePipeline,
} from '../src/index.js';

function requests(count = 2) {
  return Array.from({ length: count }, (_, time) => ({
    time, yaw: time * 15,
    camera: {
      intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      worldToCamera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  }));
}

function observations() {
  const points = length => Array.from({ length }, () => ({ x: 0, y: 0, z: 0, confidence: 0.8 }));
  return {
    faceLandmarks: points(468), bodyJoints: points(133),
    skin: 'skin buffer', bodyTexture: 'body texture buffer', bodyMask: 'body mask buffer',
    hairMask: 'raw hair mask', strandDirections: 'direction field buffer',
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'refinement-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  for (const filename of Object.values(ASSETS)) {
    await writeFile(join(source, filename), `original ${filename}`);
  }
  await writeFile(join(source, ASSETS.body), '{"asset":{"version":"2.0"}}');
  await writeFile(join(source, ASSETS.skeleton), '{"bones":[]}');
  const library = new AssetLibrary(join(root, 'identities'));
  const original = await library.publish('original', source);
  const calls = [];
  let workspace;
  const state = { revision: 0 };
  const adapters = {
    physics: { async simulate(input) {
      calls.push(`physics:${input.state.revision}`);
      assert.notEqual(input.colliders[0], original.paths.head);
      return 'curves';
    } },
    renderer: { async render(input) {
      calls.push(`render:${input.state.revision}`);
      assert.equal(input.camera, frames[input.time].camera);
      return { baldComposite: 'bald', hairMask: 'rendered mask', depth: 'head depth', lineart: 'lines' };
    } },
    diffusion: { async inpaint(input) {
      calls.push(`diffusion:${input.time}`);
      assert.deepEqual(input.identityEmbedding, [1, 0]);
      assert.ok(Object.isFrozen(input.identityEmbedding));
      assert.equal(input.controlDepth, 'head depth');
      return { buffer: Buffer.from(`frame ${input.time}`), time: input.time };
    } },
    feedback: {
      async initialize({ bundle }) {
        workspace = bundle.directory;
        assert.equal(await readFile(bundle.paths.head, 'utf8'), 'original mesh_head.obj');
        calls.push('initialize');
        return { state, identityEmbedding: new Float32Array([1, 0]) };
      },
      async extract({ frame }) {
        assert.ok(Buffer.isBuffer(frame.buffer));
        calls.push(`extract:${frame.time}`);
        return observations();
      },
      async checkIdentity({ request }) { calls.push(`guard:${request.time}`); return true; },
      async smoothHair({ previous, request }) {
        calls.push(`smooth:${request.time}`);
        assert.equal(previous?.request.time ?? null, request.time === 0 ? null : request.time - 1);
        return 'smoothed hair mask';
      },
      async updateAlbedo({ observations: data }) {
        assert.equal(data.hairMask, 'smoothed hair mask');
        calls.push('albedo');
      },
      async refineGeometry() { calls.push('geometry'); },
      async recalibrateSkeleton() { calls.push('skeleton'); },
      async refineHair() { calls.push('hair'); state.revision++; },
      async finalize({ directory, acceptedFrames, assets }) {
        calls.push('finalize');
        assert.equal(state.revision, acceptedFrames);
        await writeFile(join(directory, assets.head), `refined ${state.revision}`);
        await writeFile(join(directory, assets.bodyAlbedo), 'test body albedo');
      },
    },
  };
  const frames = requests(24);
  return {
    library, original, calls, state, adapters, frames,
    pipeline: new DigitalDoublePipeline(library),
    workspace: () => workspace,
  };
}

test('confidence atlas replaces stretched texels only with better visible samples', () => {
  const atlas = new ConfidenceAtlas(2, 1);
  const sample = (confidence, rgb = [10, 20, 30], visible = true) => ({ index: 0, confidence, rgb, visible });
  assert.equal(atlas.coverage, 0);
  assert.equal(atlas.update([sample(0.3)]), 1);
  assert.equal(atlas.coverage, 0.5);
  assert.equal(atlas.update([sample(0.2), sample(1, [255, 255, 255], false)]), 0);
  assert.equal(atlas.update([sample(0.9, [40, 50, 60])]), 1);
  assert.deepEqual([...atlas.pixels.slice(0, 3)], [40, 50, 60]);
  assert.equal(atlas.update([sample(0.9, [1, 2, 3])]), 0);
  assert.equal(atlas.update([{ index: 1, confidence: 1, rgb: [0, 0, 0] }]), 1);
  assert.equal(atlas.coverage, 1);
});

test('confidence atlas validates whole batches without partial writes', () => {
  const atlas = new ConfidenceAtlas(1, 1);
  for (const bad of [
    { index: 1, confidence: 1, rgb: [1, 2, 3] },
    { index: 0, confidence: NaN, rgb: [1, 2, 3] },
    { index: 0, confidence: 1.1, rgb: [1, 2, 3] },
    { index: 0, confidence: 1, rgb: [1, 2, 256] },
    { index: 0, confidence: 1, rgb: [1, 2, 3], visible: 'yes' },
    null,
  ]) {
    assert.throws(() => atlas.update([{ index: 0, confidence: 1, rgb: [1, 2, 3] }, bad]), /Invalid/);
    assert.equal(atlas.coverage, 0);
  }
  assert.throws(() => new ConfidenceAtlas(4097), /dimensions/);
  assert.throws(() => new ConfidenceAtlas(1.5), /dimensions/);
  const defaultAtlas = new ConfidenceAtlas();
  assert.equal(defaultAtlas.width, 4096);
  assert.equal(defaultAtlas.height, 4096);
});

test('each frame uses previous refinements, guards before updates and publishes eight assets', async t => {
  const f = await fixture(t);
  const result = await f.pipeline.refineSequence('original', 'refined', f.frames.slice(0, 2), f.adapters);
  assert.equal(result.acceptedFrames, 2);
  assert.equal(result.rejectedFrames, 0);
  assert.deepEqual(f.calls, [
    'initialize', 'physics:0', 'render:0', 'diffusion:0', 'extract:0', 'guard:0', 'smooth:0',
    'albedo', 'geometry', 'skeleton', 'hair',
    'physics:1', 'render:1', 'diffusion:1', 'extract:1', 'guard:1', 'smooth:1',
    'albedo', 'geometry', 'skeleton', 'hair', 'finalize',
  ]);
  assert.equal(await readFile(result.bundle.paths.head, 'utf8'), 'refined 2');
  assert.equal(await readFile(result.bundle.paths.bodyAlbedo, 'utf8'), 'test body albedo');
  assert.deepEqual((await f.library.load('original')).manifest, f.original.manifest);
  assert.equal(await readFile(f.original.paths.head, 'utf8'), 'original mesh_head.obj');
  assert.equal(Object.keys((await new AssetLibrary(f.library.root).load('refined')).paths).length, 8);
  await assert.rejects(readdir(f.workspace()), { code: 'ENOENT' });
  assert.equal((await f.pipeline.prepare('refined')).reused, true);
  await writeFile(result.bundle.paths.bodyAlbedo, 'corrupt');
  await assert.rejects(f.library.load('refined'), /integrity/);
});

test('24-view loop keeps frames in memory and streams results after each update', async t => {
  const f = await fixture(t);
  const output = [];
  f.adapters.onFrame = async ({ frame, index, accepted }) => {
    assert.equal(f.state.revision, index + 1);
    assert.equal(accepted, true);
    output.push(frame.time);
  };
  const result = await f.pipeline.refineSequence('original', 'rotation', f.frames, f.adapters);
  assert.equal(result.acceptedFrames, 24);
  assert.deepEqual(output, Array.from({ length: 24 }, (_, i) => i));
});

test('rejected frames do not update state or become smoothing references', async t => {
  const f = await fixture(t);
  f.adapters.feedback.checkIdentity = async ({ request }) => request.time !== 1;
  f.adapters.feedback.smoothHair = async ({ previous, request }) => {
    assert.equal(previous?.request.time ?? null, request.time === 0 ? null : 0);
    return 'smoothed hair mask';
  };
  const streamed = [];
  f.adapters.onFrame = async frame => streamed.push(frame.accepted);
  const result = await f.pipeline.refineSequence('original', 'refined', f.frames.slice(0, 3), f.adapters);
  assert.equal(result.acceptedFrames, 2);
  assert.equal(result.rejectedFrames, 1);
  assert.deepEqual(streamed, [true, false, true]);
  assert.equal(f.calls.filter(call => call === 'albedo').length, 2);
});

test('all-rejected frames fail without finalizing or publishing', async t => {
  const f = await fixture(t);
  f.adapters.feedback.checkIdentity = async () => false;
  await assert.rejects(f.pipeline.refineSequence('original', 'refined', f.frames.slice(0, 1), f.adapters), /No frames/);
  assert.equal(f.calls.includes('finalize'), false);
  assert.equal(await f.library.load('refined'), null);
  await assert.rejects(readdir(f.workspace()), { code: 'ENOENT' });
});

test('invalid requests or target identities fail before initializing', async t => {
  const f = await fixture(t);
  const refine = frames => f.pipeline.refineSequence('original', 'refined', frames, f.adapters);
  await assert.rejects(refine([]), /nonempty/);
  for (const frames of [
    [{ ...f.frames[0], yaw: 360 }],
    [{ ...f.frames[0], time: -1 }],
    [f.frames[1], f.frames[0]],
    [f.frames[0], f.frames[0]],
    [{ ...f.frames[0], camera: { intrinsics: Array(9), worldToCamera: Array(16) } }],
  ]) await assert.rejects(refine(frames));
  await assert.rejects(f.pipeline.refineSequence('original', 'original', f.frames, f.adapters), /new target/);
  await assert.rejects(f.pipeline.refineSequence('original', '../escape', f.frames, f.adapters), /Identity must/);
  await assert.rejects(f.pipeline.refineSequence('missing', 'refined', f.frames, f.adapters), /Unknown identity/);
  assert.deepEqual(f.calls, []);
});

test('bad extraction, identity guards and backend failures abort without publication', async t => {
  const cases = [
    { method: 'extract', implementation: async () => ({ ...observations(), faceLandmarks: [] }), error: /468/ },
    { method: 'extract', implementation: async () => ({ ...observations(), bodyJoints: Array(133) }), error: /133/ },
    { method: 'extract', implementation: async () => ({ ...observations(), hairMask: null }), error: /hairMask/ },
    { method: 'checkIdentity', implementation: async () => 1, error: /boolean/ },
    { method: 'smoothHair', implementation: async () => null, error: /hair mask/ },
    { method: 'refineGeometry', implementation: async () => { throw new Error('fit failed'); }, error: /fit failed/ },
    { method: 'finalize', implementation: async () => {}, error: /ENOENT/ },
  ];
  for (const { method, implementation, error } of cases) {
    await t.test(method, async child => {
      const f = await fixture(child);
      f.adapters.feedback[method] = implementation;
      await assert.rejects(f.pipeline.refineSequence('original', 'refined', f.frames.slice(0, 1), f.adapters), error);
      assert.equal(await f.library.load('refined'), null);
      assert.ok(await f.library.load('original'));
      await assert.rejects(readdir(f.workspace()), { code: 'ENOENT' });
    });
  }
});

test('requires a finite locked source embedding and complete adapters', async t => {
  const f = await fixture(t);
  f.adapters.feedback.initialize = async ({ bundle }) => {
    f.state.directory = bundle.directory;
    return { state: {}, identityEmbedding: [NaN] };
  };
  await assert.rejects(f.pipeline.refineSequence('original', 'refined', f.frames, f.adapters), /embedding/);
  await assert.rejects(readdir(f.state.directory), { code: 'ENOENT' });
  delete f.adapters.feedback.smoothHair;
  await assert.rejects(f.pipeline.refineSequence('original', 'refined', f.frames, f.adapters), /smoothHair/);
  assert.equal(await f.library.load('refined'), null);
});

test('optional body albedo is not required by legacy bundles', async t => {
  const f = await fixture(t);
  assert.equal(f.original.paths.bodyAlbedo, undefined);
  assert.equal(OPTIONAL_ASSETS.bodyAlbedo, 'uv_body_albedo.png');
});
