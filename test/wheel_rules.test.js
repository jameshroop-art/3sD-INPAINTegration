import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve('.');
const offline = join(root, 'offline');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const python = (code, args = []) => spawnSync('python3', ['-B', '-c',
  `import sys, json; from pathlib import Path; sys.path.insert(0, ${JSON.stringify(offline)}); from common import *; from wheel_rules import *\n${code}`,
  ...args], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });

async function fixture(t, tag = 'py3-none-any') {
  const directory = await mkdtemp(join(root, '.wheel-rules-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'offline/manifests'), { recursive: true });
  await writeFile(join(directory, 'review.txt'), 'Reviewed synthetic local wheel.');
  const filename = `demo-1.0-${tag}.whl`;
  const generated = python(`import zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
 archive.writestr("demo.py", "VALUE = 42\\n")
 archive.writestr("demo-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: demo\\nVersion: 1.0\\n")
 archive.writestr("demo-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nRoot-Is-Purelib: " + ("true" if sys.argv[2].endswith("-any") else "false") + "\\nTag: " + sys.argv[2] + "\\n")
 archive.writestr("demo-1.0.dist-info/RECORD", "")`, [join(directory, filename), tag]);
  assert.equal(generated.status, 0, generated.stderr);
  const rules = JSON.parse(await readFile(join(offline, 'manifests/wheel_rules.json'), 'utf8'));
  const rule = {
    name: 'demo', version: '1.0', sha256: hash(await readFile(join(directory, filename))),
    target: 'linux-cpu', python_version: '3.12', status: 'approved',
    environment: structuredClone(rules.defaults['linux-cpu']),
    review: { path: 'review.txt', sha256: hash(await readFile(join(directory, 'review.txt'))) }
  };
  rules.rules = [rule];
  return { directory, filename, rules, rule };
}

async function check(f, rules = f.rules, target = 'linux-cpu', trustedHash) {
  const bytes = JSON.stringify(rules);
  await writeFile(join(f.directory, 'offline/manifests/wheel_rules.json'), bytes);
  return python(`run(lambda: validate_wheel(Path(sys.argv[1]) / sys.argv[2], sys.argv[3],
 load_wheel_rules(Path(sys.argv[1]), sys.argv[4], sys.argv[3])))`,
  [f.directory, f.filename, target, trustedHash ?? hash(bytes)]);
}

test('trusted reviewed rule approves only exact wheel identity with cold ZIP metadata', async t => {
  const f = await fixture(t);
  const result = await check(f);
  assert.equal(result.status, 0, result.stderr);
  for (const change of [
    { name: 'other' }, { version: '2.0' }, { sha256: '0'.repeat(64) },
    { target: 'windows-gpu-cuda' }, { python_version: '3.11' }, { status: 'blocked', review: null }
  ]) {
    const rules = structuredClone(f.rules);
    Object.assign(rules.rules[0], change);
    assert.equal((await check(f, rules)).status, 2, JSON.stringify(change));
  }
  assert.equal((await check(f, f.rules, 'linux-cpu', '0'.repeat(64))).status, 2);
  assert.equal((await check(f, f.rules, 'unknown-target')).status, 2);
});

test('wheel rules fail closed for empty, duplicate, unknown and incorrectly typed fields', async t => {
  const f = await fixture(t);
  const variants = [
    { ...f.rules, rules: [] }, { ...f.rules, rules: {} },
    { ...f.rules, schema_version: true }, { ...f.rules, schema_version: '1' },
    { ...f.rules, python_version: 3.12 }, { ...f.rules, extra: false },
    { ...f.rules, rules: [f.rule, f.rule] }
  ];
  for (const key of Object.keys(f.rules)) {
    const variant = structuredClone(f.rules);
    delete variant[key];
    variants.push(variant);
  }
  for (const change of [
    { extra: 'unknown' }, { sha256: true }, { name: 'Demo_Name' },
    { version: true }, { target: null }, { status: true }, { review: null },
    { review: { path: '../review.txt', sha256: f.rule.review.sha256 } },
    { review: { path: '/etc/passwd', sha256: f.rule.review.sha256 } },
    { review: { path: 'review.txt', sha256: '0'.repeat(64) } },
    { review: { path: 'review.txt', sha256: f.rule.review.sha256, extra: false } }
  ]) {
    variants.push({ ...f.rules, rules: [{ ...f.rule, ...change }] });
  }
  for (const variant of variants) assert.equal((await check(f, variant)).status, 2, JSON.stringify(variant));
  await writeFile(join(f.directory, 'offline/manifests/wheel_rules.json'),
    '{"schema_version":1,"schema_version":1}');
  const bytes = await readFile(join(f.directory, 'offline/manifests/wheel_rules.json'));
  assert.equal(python('run(lambda: load_wheel_rules(Path(sys.argv[1]), sys.argv[2], "linux-cpu"))',
    [f.directory, hash(bytes)]).status, 2);
});

test('all profiles and individual wheels reject network, sidecars, secrets and traversal', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(f.rule.environment).filter(key => key !== 'local_paths')) {
    for (const value of [!f.rule.environment[key], 'false', 0]) {
      for (const profile of ['rule', ...Object.keys(f.rules.defaults)]) {
        const rules = structuredClone(f.rules);
        const env = profile === 'rule' ? rules.rules[0].environment : rules.defaults[profile];
        env[key] = value;
        assert.equal((await check(f, rules)).status, 2, `${profile}:${key}:${value}`);
      }
    }
  }
  for (const change of [
    { external_sidecar: 'http://127.0.0.1' }, { env: { TOKEN: 'secret' } },
    { local_paths: { ...f.rule.environment.local_paths, models: '../models' } },
    { local_paths: { ...f.rule.environment.local_paths, work: '${HOME}/work' } },
    { local_paths: { ...f.rule.environment.local_paths, logs: 'https://example.com' } }
  ]) {
    const rules = structuredClone(f.rules);
    Object.assign(rules.rules[0].environment, change);
    assert.equal((await check(f, rules)).status, 2);
  }
});

test('conservative CPython312, pure Python, abi3 and target wheel tags', async t => {
  for (const tag of ['py3-none-any', 'py312-none-any', 'cp312-cp312-linux_x86_64',
    'cp312-none-linux_x86_64', 'cp38-abi3-linux_x86_64', 'cp312-abi3-linux_x86_64']) {
    const f = await fixture(t, tag);
    const result = await check(f);
    assert.equal(result.status, 0, `${tag}: ${result.stderr}`);
  }
  for (const tag of ['cp311-cp311-linux_x86_64', 'cp313-abi3-linux_x86_64',
    'cp31-abi3-linux_x86_64', 'cp312-cp312-win_amd64', 'cp312-cp312-linux_aarch64',
    'py2-none-any', 'cp312-cp312-any', 'py3-none-macosx_11_0_arm64',
    'cp312-cp312-musllinux_1_2_x86_64', 'cp312-cp312-manylinux_2_999_x86_64']) {
    const f = await fixture(t, tag);
    assert.equal((await check(f)).status, 2, tag);
  }
  const win = await fixture(t, 'cp312-cp312-win_amd64');
  win.rule.target = 'windows-gpu-cuda';
  assert.equal((await check(win, win.rules, 'windows-gpu-cuda')).status, 0);
  const execution = python('platform.system=lambda:"Windows"\nplatform.machine=lambda:"AMD64"\nrun(lambda: target_host("windows-gpu-cuda", isolation=True))');
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /no implemented isolation backend/);
});

test('metadata mismatch, malformed ZIP and unsafe members cannot become approved wheels', async t => {
  for (const change of ['metadata', 'tag', 'foreign', 'traversal', 'symlink', 'duplicate', 'native', 'notzip']) {
    const f = await fixture(t);
    const changed = python(`import zipfile
path = Path(sys.argv[1]); change = sys.argv[2]
if change == "notzip": path.write_bytes(b"not a wheel")
else:
 with zipfile.ZipFile(path) as archive: files = {n: archive.read(n) for n in archive.namelist()}
 if change == "metadata": files["demo-1.0.dist-info/METADATA"] = b"Name: other\\nVersion: 1.0\\n"
 if change == "tag": files["demo-1.0.dist-info/WHEEL"] = b"Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py2-none-any\\n"
 if change == "foreign": files["other-1.0.dist-info/METADATA"] = b"Name: other\\n"
 if change == "traversal": files["../escape.py"] = b"pass"
 if change == "native": files["native.so"] = b"native"
 with zipfile.ZipFile(path, "w") as archive:
  for name, data in files.items(): archive.writestr(name, data)
  if change == "symlink":
   info = zipfile.ZipInfo("link"); info.external_attr = (0o120777 << 16); archive.writestr(info, "demo.py")
  if change == "duplicate": archive.writestr("demo.py", "pass")`, [join(f.directory, f.filename), change]);
    assert.equal(changed.status, 0, changed.stderr);
    f.rule.sha256 = hash(await readFile(join(f.directory, f.filename)));
    assert.equal((await check(f)).status, 2, change);
  }
});

test('builder installer launcher enforce CPython312 before any execution', () => {
  for (const name of ['build_offline', 'install_offline', 'launch_offline']) {
    const result = python(`import ${name}
sys.version_info = (3, 11, 0)
sys.argv = ["${name}.py", "--target", "linux-cpu"]
run(${name}.main)`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CPython 3.12/);
  }
  assert.equal(python('sys.version_info=(3,12,0)\nrequire_python312()').status, 0);
});

test('both build and runtime requirements demand reviewed rules for every staged wheel', async t => {
  const f = await fixture(t);
  const generated = await readFile(join(f.directory, f.filename));
  await mkdir(join(f.directory, 'offline/wheelhouse/linux-cpu'), { recursive: true });
  await writeFile(join(f.directory, 'offline/wheelhouse/linux-cpu', f.filename), generated);
  await writeFile(join(f.directory, 'offline/wheel_rules.py'), await readFile(join(offline, 'wheel_rules.py')));
  for (const kind of ['requirements', 'build-requirements']) {
    await writeFile(join(f.directory, `offline/${kind}.linux-cpu.txt`),
      `demo==1.0 --hash=sha256:${hash(generated)}\n`);
  }
  await check(f);
  const result = python(`root=Path(sys.argv[1])
paths=["offline/wheel_rules.py", RULES_PATH, "offline/wheelhouse/linux-cpu/"+sys.argv[2],
       "offline/requirements.linux-cpu.txt", "offline/build-requirements.linux-cpu.txt"]
records={name:digest(root/name) for name in paths}
for build in (False,True): requirements(root,records,"linux-cpu",{},build=build)
rules=json.loads((root/RULES_PATH).read_text()); rules["rules"]=[]
(root/RULES_PATH).write_text(json.dumps(rules)); records[RULES_PATH]=digest(root/RULES_PATH)
for build in (False,True):
 try: requirements(root,records,"linux-cpu",{},build=build)
 except OfflineError: pass
 else: raise AssertionError("empty rules accepted")`, [f.directory, f.filename]);
  assert.equal(result.status, 0, result.stderr);
});

test('all execution is namespaced and supplied environments cannot reintroduce secrets or networking', () => {
  const result = python(`def capture(command, **kwargs):
 assert "--pid" in command and "--fork" in command and "--kill-child=SIGKILL" in command
 assert "--net" in command and "--user" in command
 payload=json.loads(kwargs["input"])
 assert payload["env"]["HF_HUB_OFFLINE"]=="1"
 assert not {"PRIVATE_TOKEN","LD_PRELOAD","HTTPS_PROXY"}.intersection(payload["env"])
 return type("Result",(),{"returncode":0,"stdout":'["local output"]'})()
subprocess.run=capture
shutil.which=lambda *a,**kw:"/usr/bin/unshare"
from build_offline import git
assert git(Path.cwd(),"rev-parse","HEAD")=="local output"
for env in ({"PRIVATE_TOKEN":"secret"},{"LD_PRELOAD":"inject.so"},{"HTTPS_PROXY":"http://example.com"},{"HF_HUB_OFFLINE":"0"}):
 try: isolated([[sys.executable,"-c","pass"]],Path.cwd(),env)
 except OfflineError: pass
 else: raise AssertionError("unsafe supplied environment accepted")`);
  assert.equal(result.status, 0, result.stderr);
});

test('build outputs include hashed SBOM and unapproved wheel environment inventory', async t => {
  const f = await fixture(t);
  const result = python('from build_offline import output_inventory\nrun(lambda: output_inventory(Path(sys.argv[1]), "linux-cpu"))',
    [f.directory]);
  assert.equal(result.status, 0, result.stderr);
  const proposals = JSON.parse(await readFile(join(f.directory, 'wheel_rules.proposed.json')));
  assert.equal(proposals.rules[0].status, 'blocked');
  assert.equal(proposals.rules[0].review, null);
  assert.equal(proposals.rules[0].python_version, '3.12');
  assert.equal(proposals.rules[0].sha256, f.rule.sha256);
  const sbom = JSON.parse(await readFile(join(f.directory, 'sbom.json')));
  assert.equal(sbom.authenticated, false);
  assert.equal(sbom.review_required, true);
  assert.equal(sbom.wheels[0].sha256, f.rule.sha256);
  assert.match(await readFile(join(f.directory, 'artifacts.sha256'), 'utf8'), new RegExp(f.rule.sha256));
  assert.equal((await check(f, proposals)).status, 2);
});
