import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve('.');
const offline = join(root, 'offline');
const sha = content => createHash('sha256').update(content).digest('hex');
const modelConfig = value => ({
  model_root: 'models',
  detection: { person_detector: value },
  pose: { wholebody_fallback: value, wholebody_3d: value },
  segmentation: { sam2_checkpoint: value, birefnet_package: value },
  face: { insightface_root: value, face_landmarker: value, face_parser: value },
  llm: { text_model: value, vision_model: value, vision_projector: value },
  inpaint: { checkpoint: value, openpose_control: value, depth_control: value, hair_lineart_control: value }
});
const python = (code, args = []) => spawnSync('python3', ['-B', '-c',
  `import sys; sys.path.insert(0, ${JSON.stringify(offline)}); from common import *\n${code}`, ...args],
{ encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });

async function fixture(t) {
  const directory = await mkdtemp(join(root, '.offline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'offline'));
  return directory;
}

async function bundle(t) {
  const directory = await fixture(t);
  const policy = await readFile(join(offline, 'policy.json'));
  await writeFile(join(directory, 'offline/policy.json'), policy);
  return { directory, policy, records: { 'offline/policy.json': sha(policy) } };
}

async function readyBundle(t) {
  const b = await bundle(t);
  for (const name of ['common.py', 'verify_offline.py', 'launch_offline.py', 'install_offline.py', 'build_offline.py']) {
    await artifact(b, `offline/${name}`, await readFile(join(offline, name)));
  }
  const path = 'models/demo.bin';
  await artifact(b, path, 'local model');
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [{
    id: 'demo', group: 'model', source_url: null, destination: 'demo.bin',
    extraction: null, license: 'fixture', required: true, status: 'ready',
    sha256: sha('local model'), size_bytes: Buffer.byteLength('local model')
  }] }));
  await artifact(b, 'config/model_paths.json', JSON.stringify(modelConfig('demo.bin')));
  await mkdir(join(b.directory, 'offline/runtime'), { recursive: true });
  await seal(b);
  return b;
}

async function artifact(bundle, path, content) {
  await mkdir(join(bundle.directory, path, '..'), { recursive: true });
  await writeFile(join(bundle.directory, path), content);
  bundle.records[path] = sha(content);
}

async function seal(bundle) {
  await writeFile(join(bundle.directory, 'offline/artifacts.sha256'),
    Object.entries(bundle.records).map(([path, hash]) => `${hash}  ${path}\n`).join(''));
}

test('offline policy requires exactly typed fail-closed fields', async t => {
  const b = await bundle(t);
  assert.equal(python('policy(Path(sys.argv[1]))', [b.directory]).status, 0);
  const original = JSON.parse(b.policy);
  const replacements = [
    { ...original, extra: 1 }, { ...original, offline_required: 'true' },
    { ...original, policy_version: true }, { ...original, model_root: '../models' }
  ];
  for (const [key, value] of Object.entries(original)) {
    const changed = { ...original };
    delete changed[key];
    replacements.push(changed);
    replacements.push({ ...original, [key]: typeof value === 'boolean' ? !value : null });
  }
  for (const replacement of replacements) {
    await writeFile(join(b.directory, 'offline/policy.json'), JSON.stringify(replacement));
    assert.notEqual(python('run(lambda: policy(Path(sys.argv[1])))', [b.directory]).status, 0);
  }
  await writeFile(join(b.directory, 'offline/policy.json'), '{"offline_required":true,"offline_required":false}');
  assert.notEqual(python('run(lambda: policy(Path(sys.argv[1])))', [b.directory]).status, 0);
});

test('local paths refuse traversal, absolute paths, symlinks and symlink ancestors', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'file'), 'safe');
  await symlink('file', join(directory, 'link'));
  await symlink(directory, join(directory, 'alias'));
  assert.equal(python('local(Path(sys.argv[1]), "file")', [directory]).status, 0);
  for (const path of ['../file', '/etc/passwd', 'a//b', './file', 'a/../file', 'a\\b', 'C:/file', 'link']) {
    assert.notEqual(python('run(lambda: local(Path(sys.argv[1]), sys.argv[2]))', [directory, path]).status, 0);
  }
  assert.notEqual(python('run(lambda: local(Path(sys.argv[1]), "file"))', [join(directory, 'alias')]).status, 0);
});

test('trusted artifact records strictly parse and validate every artifact', async t => {
  const b = await bundle(t);
  await seal(b);
  assert.equal(python('hashes(Path(sys.argv[1]))', [b.directory]).status, 0);
  const hash = b.records['offline/policy.json'];
  for (const text of [
    '', `${hash} offline/policy.json\n`, `${hash.toUpperCase()}  offline/policy.json\n`,
    `${hash}  ../policy.json\n`, `${hash}  offline/policy.json\n${hash}  offline/policy.json\n`,
    `${'0'.repeat(64)}  offline/policy.json\n`, `${hash}  offline/artifacts.sha256\n`
  ]) {
    await writeFile(join(b.directory, 'offline/artifacts.sha256'), text);
    assert.notEqual(python('run(lambda: hashes(Path(sys.argv[1])))', [b.directory]).status, 0);
  }
});

test('installer accepts only pinned hashed local wheels and rejects pip escape hatches', async t => {
  const b = await bundle(t);
  const wheel = 'trusted-wheel-fixture';
  await artifact(b, 'offline/wheelhouse/linux-cpu/demo-1.0-py3-none-any.whl', wheel);
  const requirement = `demo==1.0 --hash=sha256:${sha(wheel)}\n`;
  await artifact(b, 'offline/requirements.linux-cpu.txt', requirement);
  await seal(b);
  const check = 'run(lambda: requirements(Path(sys.argv[1]), hashes(Path(sys.argv[1])), "linux-cpu", policy(Path(sys.argv[1]))))';
  assert.equal(python(check, [b.directory]).status, 0);
  for (const bad of [
    'https://example.com/a.whl', '-e ./package', 'git+https://example.com/a',
    './package', 'demo @ file:///a.whl', '--extra-index-url https://example.com',
    '--find-links .', '--index-url https://example.com', 'demo==1.0', 'demo>=1',
    `demo==1.0 --hash=sha256:${'0'.repeat(64)}`, requirement + requirement
  ]) {
    await artifact(b, 'offline/requirements.linux-cpu.txt', bad);
    await seal(b);
    assert.notEqual(python(check, [b.directory]).status, 0, bad);
  }
  await artifact(b, 'offline/requirements.linux-cpu.txt', requirement);
  await artifact(b, 'offline/wheelhouse/linux-cpu/source.tar.gz', 'source distribution');
  await seal(b);
  assert.notEqual(python(check, [b.directory]).status, 0);
});

test('real standard-library ZIP wheel installs with pip only in verified isolation', async t => {
  const b = await readyBundle(t);
  const wheelPath = 'offline/wheelhouse/linux-cpu/offline_demo-1.0-py3-none-any.whl';
  await mkdir(join(b.directory, 'offline/wheelhouse/linux-cpu'), { recursive: true });
  const generated = python(`import base64, csv, io, zipfile
files = {
 "offline_demo.py": b"VALUE = 42\\n",
 "offline_demo-1.0.dist-info/METADATA": b"Metadata-Version: 2.1\\nName: offline-demo\\nVersion: 1.0\\n",
 "offline_demo-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\\nGenerator: stdlib-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
}
rows = []
for name, data in files.items():
 rows.append([name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), str(len(data))])
rows.append(["offline_demo-1.0.dist-info/RECORD", "", ""])
record = io.StringIO()
csv.writer(record, lineterminator="\\n").writerows(rows)
files["offline_demo-1.0.dist-info/RECORD"] = record.getvalue().encode()
with zipfile.ZipFile(sys.argv[1], "w") as archive:
 for name, data in files.items(): archive.writestr(name, data)`,
  [join(b.directory, wheelPath)]);
  assert.equal(generated.status, 0, generated.stderr);
  const wheel = await readFile(join(b.directory, wheelPath));
  b.records[wheelPath] = sha(wheel);
  await artifact(b, 'offline/requirements.linux-cpu.txt', `offline-demo==1.0 --hash=sha256:${sha(wheel)}\n`);
  await seal(b);
  const capability = python('run(lambda: isolated([[sys.executable, "-I", "-c", "pass"]], Path(sys.argv[1])))',
    [b.directory]);
  if (capability.status !== 0) {
    assert.equal(capability.status, 2);
    assert.match(capability.stderr, /Isolated execution failed|No verified isolation|Install unshare/);
    t.skip('Linux namespace unavailable: actual pip installation is not verified on this runner.');
    return;
  }
  const installed = spawnSync('python3', ['-B', join(offline, 'install_offline.py'),
    '--root', b.directory, '--target', 'linux-cpu'], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const checked = python(`run(lambda: isolated([[str(Path(sys.argv[1]) / "offline/runtime/venv-linux-cpu/bin/python"),
 "-I", "-c", "import offline_demo; assert offline_demo.VALUE == 42"]], Path(sys.argv[1])))`, [b.directory]);
  assert.equal(checked.status, 0, checked.stderr);
});

test('cold verification refuses blocked or missing assets and resolves model_root plus relative values', async t => {
  const b = await bundle(t);
  const path = 'models/demo.bin';
  const asset = { id: 'demo', group: 'model', source_url: null, destination: 'demo.bin',
    extraction: null, license: 'fixture', required: true, status: 'ready',
    sha256: sha('local model'), size_bytes: Buffer.byteLength('local model') };
  await artifact(b, path, 'local model');
  await artifact(b, 'config/model_paths.json', JSON.stringify(modelConfig('demo.bin')));
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [asset] }));
  await seal(b);
  const check = 'run(lambda: assets(Path(sys.argv[1]), hashes(Path(sys.argv[1])), policy(Path(sys.argv[1]))))';
  assert.equal(python(check, [b.directory]).status, 0);
  await artifact(b, 'models/manifest.json', JSON.stringify({
    schema_version: 1, comment: 'Additional provenance metadata is allowed.',
    models: [{ ...asset, reason: 'reviewed local fixture', acquisition: 'manual' }]
  }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 0);
  for (const change of [
    { ...asset, status: 'blocked', sha256: null, size_bytes: null, license: null },
    { ...asset, size_bytes: true }, { ...asset, destination: '../model.bin' },
    { ...asset, destination: 'missing.bin' }
  ]) {
    await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [change] }));
    await seal(b);
    assert.notEqual(python(check, [b.directory]).status, 0);
  }
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [asset] }));
  await artifact(b, 'config/model_paths.json', JSON.stringify(modelConfig('../demo.bin')));
  await seal(b);
  assert.notEqual(python(check, [b.directory]).status, 0);
});

test('archive-only assets are blocked; model packages require individually hashed ready members', async t => {
  const b = await bundle(t);
  const members = [
    { id: 'weights', group: 'package', source_url: null, destination: 'package/weights.bin',
      extraction: { type: 'none' }, license: 'fixture', required: true, status: 'ready',
      sha256: sha('weights'), size_bytes: 7 },
    { id: 'config', group: 'package', source_url: null, destination: 'package/config.json',
      extraction: { type: 'none' }, license: 'fixture', required: true, status: 'ready',
      sha256: sha('{}'), size_bytes: 2 }
  ];
  await artifact(b, 'models/package/weights.bin', 'weights');
  await artifact(b, 'models/package/config.json', '{}');
  await artifact(b, 'config/model_paths.json', JSON.stringify(modelConfig('package')));
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: members }));
  await seal(b);
  const check = 'run(lambda: assets(Path(sys.argv[1]), hashes(Path(sys.argv[1])), policy(Path(sys.argv[1]))))';
  assert.equal(python(check, [b.directory]).status, 0);
  await artifact(b, 'models/package/unreviewed.py', 'pass');
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 2);
  await rm(join(b.directory, 'models/package/unreviewed.py'));
  delete b.records['models/package/unreviewed.py'];
  const packageAsset = {
    ...members[0], destination: 'package',
    extraction: { type: 'zip', members: ['weights.bin', 'config.json'], max_size_bytes: 100,
      member_sha256: { 'weights.bin': sha('weights'), 'config.json': sha('{}') } }
  };
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [packageAsset] }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 0, 'extracted package member hashes are verified independently from archive bytes');
  packageAsset.extraction.member_sha256['weights.bin'] = '0'.repeat(64);
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [packageAsset] }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 2);
  await artifact(b, 'models/manifest.json', JSON.stringify({ schema_version: 1, models: [{
    ...members[0], destination: 'package', extraction: { type: 'zip', members: ['weights.bin', 'config.json'], max_size_bytes: 100 }
  }] }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 2);
});

test('isolation probe requires a genuinely new network namespace', () => {
  const result = python('run(lambda: isolation_probe(os.readlink("/proc/self/ns/net")))');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Network namespace was not created/);
});

test('Linux isolation either proves loopback-only blocking or refuses without fallback', async t => {
  const directory = await fixture(t);
  const marker = join(directory, 'executed');
  const result = python('run(lambda: isolated([[sys.executable, "-I", "-c", "from pathlib import Path; Path(\'executed\').write_text(\'yes\')"]], Path(sys.argv[1])))',
    [directory]);
  if (result.status === 0) {
    assert.equal(await readFile(marker, 'utf8'), 'yes');
  } else {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Isolated execution failed|No verified isolation|Install unshare/);
    await assert.rejects(readFile(marker));
  }
});

test('non-Linux isolation and fake cross-targets are refused', () => {
  const result = python('platform.system = lambda: "Darwin"\nplatform.machine = lambda: "arm64"\nrun(lambda: target_host("macos-m1", isolation=True))');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no implemented isolation backend/);
  assert.equal(python('run(lambda: target_host("not-a-target"))').status, 2);
  assert.equal(python('platform.system = lambda: "Linux"\nplatform.machine = lambda: "x86_64"\nrun(lambda: target_host("macos-m1"))').status, 2);
});

test('audit contains only nonsensitive action target outcome', async t => {
  const b = await bundle(t);
  assert.equal(python('audit(Path(sys.argv[1]), policy(Path(sys.argv[1])), "verify", "linux-cpu", "verified")',
    [b.directory]).status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(b.directory, 'offline/logs/audit.jsonl'), 'utf8')),
    { action: 'verify', target: 'linux-cpu', outcome: 'verified' });
  await chmod(join(b.directory, 'offline/logs/audit.jsonl'), 0o666);
  await chmod(join(b.directory, 'offline/logs'), 0o777);
  assert.equal(python('audit(Path(sys.argv[1]), policy(Path(sys.argv[1])), "verify", "linux-cpu", "verified")',
    [b.directory]).status, 0);
  assert.equal((await stat(join(b.directory, 'offline/logs/audit.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(b.directory, 'offline/logs'))).mode & 0o777, 0o700);
});

test('unshare worker and commands receive sanitized environments before execution', () => {
  const result = python(`os.environ.update(LD_PRELOAD="/private/inject.so", PYTHONPATH="/private/code", HTTPS_PROXY="http://private", PRIVATE_TOKEN="secret")
def capture(command, **kwargs):
    forbidden = {"LD_PRELOAD", "PYTHONPATH", "HTTPS_PROXY", "PRIVATE_TOKEN"}
    assert not forbidden.intersection(kwargs["env"])
    payload = json.loads(kwargs["input"])
    assert not forbidden.intersection(payload["env"])
    assert payload["env"]["HF_HUB_OFFLINE"] == "1"
    return type("Result", (), {"returncode": 0})()
subprocess.run = capture
shutil.which = lambda *args, **kwargs: "/usr/bin/unshare"
isolated([[sys.executable, "-I", "-c", "pass"]], Path.cwd())`);
  assert.equal(result.status, 0, result.stderr);
});

test('audit refuses named pipes without hanging', async t => {
  const b = await bundle(t);
  await mkdir(join(b.directory, 'offline/logs'));
  execFileSync('mkfifo', [join(b.directory, 'offline/logs/audit.jsonl')]);
  const result = python('run(lambda: audit(Path(sys.argv[1]), policy(Path(sys.argv[1])), "verify", "linux-cpu", "verified"))',
    [b.directory]);
  assert.equal(result.status, 2);
});

test('all offline CLIs support help and sanitize missing-bundle errors', async t => {
  const directory = await fixture(t);
  for (const name of ['build_offline.py', 'install_offline.py', 'verify_offline.py', 'launch_offline.py']) {
    const help = spawnSync('python3', ['-B', join(offline, name), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--target/);
    const result = spawnSync('python3', ['-B', join(offline, name), '--root', directory, '--target', 'linux-cpu'],
      { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Blocked:/);
    assert.doesNotMatch(result.stderr, /Traceback|\.offline-test-/);
  }
});

test('locked sources refuse blocked metadata, invalid commits and unlisted overrides', async t => {
  const b = await bundle(t);
  const check = 'from build_offline import sources\nrun(lambda: sources(Path(sys.argv[1]), hashes(Path(sys.argv[1])), sys.argv[2:], ["demo"]))';
  for (const source of [
    { repo: 'example/demo', commit: null, license: null, status: 'blocked' },
    { repo: 'example/demo', commit: 'main', license: 'MIT', status: 'ready' },
    { repo: 'example/demo', commit: '0'.repeat(40), license: null, status: 'ready' },
    { repo: null, commit: null, license: null, status: 'blocked' },
    { repo: 'example/demo', commit: '0'.repeat(40), license: 'MIT', status: 'ready' }
  ]) {
    await artifact(b, 'offline/manifests/sources.lock.json', JSON.stringify({ schema_version: 1, sources: [{ id: 'demo', ...source }] }));
    await seal(b);
    assert.equal(python(check, [b.directory]).status, 2);
  }
  assert.equal(python(check, [b.directory, 'unknown=../clone']).status, 2);
  assert.equal(python(check, [b.directory, 'invalid']).status, 2);
});

test('Git source configuration refuses hooks, filters and includes before invoking Git', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, '.git'));
  const base = '[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nlogallrefupdates = true\n';
  const check = 'from build_offline import source_config\nrun(lambda: source_config(Path(sys.argv[1])))';
  await writeFile(join(directory, '.git/config'), base);
  assert.equal(python(check, [directory]).status, 0);
  for (const extra of [
    'hooksPath = dangerous\n', '[filter "custom"]\nclean = dangerous\n',
    '[include]\npath = dangerous\n', '[extensions]\nworktreeConfig = true\n'
  ]) {
    await writeFile(join(directory, '.git/config'), base + extra);
    assert.equal(python(check, [directory]).status, 2);
  }
});

test('source checkout must match pinned clean commit before immutable vendor copy', async t => {
  const b = await bundle(t);
  const checkout = join(b.directory, 'offline/sources/demo');
  await mkdir(checkout, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim();
  git('init', '--quiet');
  await artifact(b, 'offline/sources/demo/main.py', 'print("local")\n');
  git('add', 'main.py');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  await artifact(b, 'offline/manifests/sources.lock.json', JSON.stringify({ schema_version: 1, sources: [{
    id: 'demo', repo: 'example/demo', commit, license: 'fixture', status: 'ready'
  }] }));
  await seal(b);
  const check = 'from build_offline import sources\nrun(lambda: sources(Path(sys.argv[1]), hashes(Path(sys.argv[1])), [], ["demo"]))';
  const valid = python(check, [b.directory]);
  assert.equal(valid.status, 0, valid.stderr);
  const selected = { id: 'demo', repo: 'example/demo', commit, license: 'fixture', status: 'ready' };
  await artifact(b, 'offline/manifests/sources.lock.json', JSON.stringify({
    schema_version: 1, sources: [selected, { id: 'blocked-model', repo: null, commit: null, license: null, status: 'blocked' }]
  }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 0, 'unselected blocked model metadata must not block source selection');
  await mkdir(join(b.directory, 'external'), { recursive: true });
  await rename(checkout, join(b.directory, 'external/demo'));
  b.records['external/demo/main.py'] = b.records['offline/sources/demo/main.py'];
  delete b.records['offline/sources/demo/main.py'];
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 0, 'external implementation ID checkout must be discovered');
  await rename(join(b.directory, 'external/demo'), checkout);
  b.records['offline/sources/demo/main.py'] = b.records['external/demo/main.py'];
  delete b.records['external/demo/main.py'];
  await seal(b);
  await writeFile(join(checkout, 'untracked'), 'unexpected');
  assert.equal(python(check, [b.directory]).status, 2);
  await rm(join(checkout, 'untracked'));
  await artifact(b, 'offline/manifests/sources.lock.json', JSON.stringify({ schema_version: 1, sources: [{
    id: 'demo', repo: 'example/demo', commit: '0'.repeat(40), license: 'fixture', status: 'ready'
  }] }));
  await seal(b);
  assert.equal(python(check, [b.directory]).status, 2);
});

test('actual Git safe patch application rejects traversal and applies local change', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'sources/demo'), { recursive: true });
  await writeFile(join(directory, 'sources/demo/main.txt'), 'before\n');
  const patch = 'diff --git a/main.txt b/main.txt\n--- a/main.txt\n+++ b/main.txt\n@@ -1 +1 @@\n-before\n+after\n';
  await writeFile(join(directory, 'reviewed.patch'), patch);
  const apply = () => spawnSync('git', ['apply', '--no-unsafe-paths', '--directory=sources/demo',
    join(directory, 'reviewed.patch')], { cwd: directory, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: root } });
  const valid = apply();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(await readFile(join(directory, 'sources/demo/main.txt'), 'utf8'), 'after\n');
  await writeFile(join(directory, 'reviewed.patch'),
    'diff --git a/../../escape b/../../escape\n--- /dev/null\n+++ b/../../escape\n@@ -0,0 +1 @@\n+unsafe\n');
  assert.notEqual(apply().status, 0);
});

test('build outputs produce deterministic unauthenticated wheel hash inventory and block missing wheels', async t => {
  const directory = await fixture(t);
  const check = 'from build_offline import output_inventory\nrun(lambda: output_inventory(Path(sys.argv[1]), "linux-cpu"))';
  assert.equal(python(check, [directory]).status, 2);
  await mkdir(join(directory, 'dist'));
  const wheel = 'local output fixture';
  await writeFile(join(directory, 'dist/demo-1.0-py3-none-any.whl'), wheel);
  const valid = python(check, [directory]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(await readFile(join(directory, 'artifacts.sha256'), 'utf8'),
    `${sha(wheel)}  dist/demo-1.0-py3-none-any.whl\n`);
  const sbom = JSON.parse(await readFile(join(directory, 'sbom.json'), 'utf8'));
  assert.equal(sbom.authenticated, false);
  assert.equal(sbom.review_required, true);
  assert.equal(sbom.wheels[0].size_bytes, Buffer.byteLength(wheel));
  assert.equal(python(check, [directory]).status, 2);
});

test('valid assets verify cold, but launcher refuses missing adapter and installer missing wheel recipe', async t => {
  const b = await readyBundle(t);
  const invoke = (name, ...extra) => spawnSync('python3', ['-B', join(offline, name), '--root', b.directory,
    '--target', 'linux-cpu', ...extra], { encoding: 'utf8' });
  const verified = invoke('verify_offline.py');
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /execution\/isolation has not been asserted/);
  const launched = invoke('launch_offline.py');
  assert.equal(launched.status, 2);
  assert.match(launched.stderr, /No integration adapter/);
  const traversal = invoke('launch_offline.py', '--adapter', '../outside');
  assert.equal(traversal.status, 2);
  assert.match(traversal.stderr, /path traversal/);
  const installed = invoke('install_offline.py');
  assert.equal(installed.status, 2);
  assert.match(installed.stderr, /required local file is missing/);
  await artifact(b, 'offline/runtime/adapter', 'untrusted');
  delete b.records['offline/runtime/adapter'];
  await seal(b);
  const untrusted = invoke('launch_offline.py', '--adapter', 'adapter');
  assert.equal(untrusted.status, 2);
  assert.match(untrusted.stderr, /matching trusted hash/);
});
