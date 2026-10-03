import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const ASSETS = Object.freeze({
  head: 'mesh_head.obj',
  body: 'mesh_body.gltf',
  albedo: 'uv_skin_albedo.png',
  scalp: 'uv_scalp_junction.png',
  groom: 'hair_physics.abc',
  spatial: 'multi_angle_pose.mask',
  skeleton: 'skeleton_profile.json',
});

export function validateIdentity(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error('Identity must be 1–64 ASCII letters, digits, underscores or hyphens.');
  }
  return id;
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Expected a nonempty regular file: ${path}`);
  return stat;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateJsonAssets(directory) {
  const body = JSON.parse(await readFile(join(directory, ASSETS.body), 'utf8'));
  if (body.asset?.version !== '2.0') throw new Error('Body must be a glTF 2.0 document.');
  for (const resource of [...(body.buffers ?? []), ...(body.images ?? [])]) {
    if (resource.uri !== undefined && !resource.uri.startsWith('data:')) {
      throw new Error('Body glTF resources must be embedded, not external references.');
    }
  }
  const skeleton = JSON.parse(await readFile(join(directory, ASSETS.skeleton), 'utf8'));
  if (!skeleton || typeof skeleton !== 'object' || Array.isArray(skeleton)) {
    throw new Error('Skeleton profile must be a JSON object.');
  }
}

export class AssetLibrary {
  constructor(root = 'assets/identities') {
    this.root = resolve(root);
  }

  directory(id) {
    return join(this.root, validateIdentity(id));
  }

  async load(id) {
    const directory = this.directory(id);
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Identity must be a real directory.');
    await regularFile(join(directory, 'manifest.json'));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.identity !== id) {
      throw new Error('Unsupported or mismatched identity manifest.');
    }
    const paths = {};
    for (const [key, filename] of Object.entries(ASSETS)) {
      const path = join(directory, filename);
      const file = await regularFile(path);
      const record = manifest.assets?.[key];
      if (record?.filename !== filename || record.bytes !== file.size ||
          record.sha256 !== await digest(path)) {
        throw new Error(`Asset integrity check failed: ${filename}`);
      }
      paths[key] = path;
    }
    await validateJsonAssets(directory);
    return Object.freeze({ identity: id, directory, paths: Object.freeze(paths), manifest });
  }

  async publish(id, sourceDirectory) {
    const destination = this.directory(id);
    await mkdir(this.root, { recursive: true });
    const existing = await this.load(id);
    if (existing) throw new Error(`Identity already exists: ${id}`);
    const staging = join(this.root, `.staging-${randomUUID()}`);
    await mkdir(staging);
    try {
      const records = {};
      for (const [key, filename] of Object.entries(ASSETS)) {
        const source = join(resolve(sourceDirectory), filename);
        await regularFile(source);
        const target = join(staging, filename);
        await copyFile(source, target);
        const file = await regularFile(target);
        records[key] = { filename, bytes: file.size, sha256: await digest(target) };
      }
      await validateJsonAssets(staging);
      const manifest = { schemaVersion: 1, identity: id, assets: records };
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      // A complete directory becomes visible at once; existing identities are never updated.
      await rename(staging, destination);
      return await this.load(id);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name))
      .map(entry => entry.name).sort();
  }
}
