// Release tooling for the signed update channel. The README's "Releasing" section describes the flow.
//
//   node scripts/release.mjs verify          run every plugin's verify.mjs
//   node scripts/release.mjs check           check every update manifest; list the plugins awaiting release
//   node scripts/release.mjs sign            sign the plugins awaiting release
//   node scripts/release.mjs publish         commit the signed manifests to main and tag them (CI only)
//   node scripts/release.mjs setup <key.pem> create the signing environment and store the key in it
//
// `sign` never imports a plugin. It runs with the private key in reach, and executing plugin code
// there would hand that code the key.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENVIRONMENT = 'plugin-signing';
const TYPE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const inActions = process.env.GITHUB_ACTIONS === 'true';

const sourcePath = (type) => `indexers/${type}/index.mjs`;
const manifestPath = (type) => join(root, 'updates', `${type}.json`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const publicKey = (x) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitBytes = (ref, path) =>
  execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

let failures = 0;
function report(level, message) {
  if (level === 'error') failures += 1;
  console.log(inActions ? `::${level}::${message}` : `${level}: ${message}`);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function compareVersions(a, b) {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

// Read from the source text rather than by importing it, so that signing never runs plugin code.
const publicKeyIn = (bytes) => /\bed25519PublicKey:\s*['"]([A-Za-z0-9_-]{43})['"]/.exec(bytes.toString('utf8'))?.[1] ?? null;
const versionIn = (bytes) => /^\s*version:\s*['"]([^'"]+)['"]/m.exec(bytes.toString('utf8'))?.[1] ?? null;

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = git('remote', 'get-url', 'origin');
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error(`cannot read the repository from the origin remote "${remote}"`);
  return match[1];
}

function pluginTypes() {
  return readdirSync(join(root, 'indexers'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, sourcePath(entry.name))))
    .map((entry) => entry.name)
    .sort();
}

function readManifest(type) {
  if (!existsSync(manifestPath(type))) return null;
  const manifest = JSON.parse(readFileSync(manifestPath(type), 'utf8'));
  const wellFormed =
    manifest.schemaVersion === 1 &&
    manifest.type === type &&
    VERSION.test(manifest.version ?? '') &&
    typeof manifest.sourceUrl === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') &&
    typeof manifest.signature === 'string';
  if (!wellFormed) throw new Error(`updates/${type}.json is malformed`);
  return manifest;
}

/** The exact bytes a published manifest signed, which is what installed copies hold. */
function releasedSource(type, manifest, slug) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(manifest.sourceUrl);
  if (!match || match[1].toLowerCase() !== slug.toLowerCase() || match[3] !== sourcePath(type)) {
    throw new Error(`updates/${type}.json does not point at ${sourcePath(type)} in ${slug}`);
  }
  const ref = match[2];
  if (COMMIT.test(ref)) {
    let bytes;
    try {
      bytes = gitBytes(ref, sourcePath(type));
    } catch {
      throw new Error(`updates/${type}.json pins commit ${ref.slice(0, 12)}, which is not in this clone (fetch the full history)`);
    }
    if (sha256(bytes) !== manifest.sha256) throw new Error(`updates/${type}.json does not match the source it pins`);
    return bytes;
  }
  // A manifest signed before releases were pinned to a commit points at a branch, so the bytes it
  // signed are found by their digest instead.
  const candidates = [() => readFileSync(join(root, sourcePath(type)))];
  for (const commit of git('log', '--format=%H', '--', sourcePath(type)).split('\n').filter(Boolean)) {
    candidates.push(() => gitBytes(commit, sourcePath(type)));
  }
  for (const read of candidates) {
    let bytes;
    try {
      bytes = read();
    } catch {
      continue;
    }
    if (sha256(bytes) === manifest.sha256) return bytes;
  }
  throw new Error(`no committed version of ${sourcePath(type)} matches updates/${type}.json`);
}

/** The newest committed manifest, or the newest older than `version`: what installed copies update from. */
function committedManifest(type, version) {
  const path = `updates/${type}.json`;
  for (const commit of git('log', '--format=%H', '--', path).split('\n').filter(Boolean)) {
    let manifest;
    try {
      manifest = JSON.parse(gitBytes(commit, path).toString('utf8'));
    } catch {
      continue;
    }
    if (VERSION.test(manifest.version ?? '') && (!version || compareVersions(manifest.version, version) < 0)) return manifest;
  }
  return null;
}

function verifyAll() {
  for (const type of pluginTypes()) {
    const directory = join(root, 'indexers', type);
    if (!existsSync(join(directory, 'verify.mjs'))) {
      report('error', `${type}: has no verify.mjs`);
      continue;
    }
    console.log(`\n# ${type}`);
    const run = spawnSync(process.execPath, ['verify.mjs'], { cwd: directory, stdio: 'inherit' });
    if (run.status !== 0) report('error', `${type}: verify.mjs failed`);
  }
}

async function checkPlugin(type, slug) {
  const path = join(root, sourcePath(type));
  const plugin = (await import(`${pathToFileURL(path).href}?check=${Date.now()}`)).default;
  if (plugin?.type !== type) throw new Error(`index.mjs declares type "${plugin?.type}"`);
  if (!VERSION.test(plugin.version ?? '')) throw new Error(`version "${plugin.version}" is not MAJOR.MINOR.PATCH`);
  if (versionIn(readFileSync(path)) !== plugin.version) throw new Error('the version must be a plain string literal on the plugin object');
  const manifestUrl = `https://raw.githubusercontent.com/${slug}/main/updates/${type}.json`;
  if (plugin.update?.manifestUrl !== manifestUrl) throw new Error(`update.manifestUrl must be ${manifestUrl}`);
  if (!PUBLIC_KEY.test(plugin.update.ed25519PublicKey ?? '')) throw new Error('update.ed25519PublicKey is not an Ed25519 public key');
  if (publicKeyIn(readFileSync(path)) !== plugin.update.ed25519PublicKey) {
    throw new Error('update.ed25519PublicKey must be a plain string literal on the plugin object');
  }

  const manifest = readManifest(type);
  if (!manifest) {
    if (committedManifest(type)) throw new Error(`updates/${type}.json is gone, and installed copies read it; restore it`);
    report('notice', `${type} ${plugin.version}: first release, awaiting signing`);
    return { type, version: plugin.version };
  }
  const released = releasedSource(type, manifest, slug);
  const trusted = publicKeyIn(released);
  // Installed copies check a release against the key the release before it pinned. The two differ
  // only for the release that rotated the key.
  const previous = committedManifest(type, manifest.version);
  const signer = previous ? publicKeyIn(releasedSource(type, previous, slug)) : trusted;
  if (!signer || !verify(null, released, publicKey(signer), Buffer.from(manifest.signature, 'base64'))) {
    throw new Error(`the ${manifest.version} signature does not verify against the key ${previous ? previous.version : 'it'} pins`);
  }

  const order = compareVersions(plugin.version, manifest.version);
  if (order < 0) throw new Error(`version ${plugin.version} is older than the published ${manifest.version}`);
  if (order === 0) {
    if (sha256(readFileSync(path)) !== manifest.sha256) {
      throw new Error(`index.mjs changed since ${manifest.version} was published; bump its version to ship the change`);
    }
    console.log(`${type} ${plugin.version}: published`);
    return null;
  }
  if (plugin.update.ed25519PublicKey !== trusted) {
    report('warning', `${type} ${plugin.version} pins a new public key; it is signed with the old one, which installed copies trust`);
  }
  report('notice', `${type} ${plugin.version}: awaiting signing (published: ${manifest.version})`);
  return { type, version: plugin.version };
}

async function checkAll() {
  const slug = repoSlug();
  const pending = [];
  for (const type of pluginTypes()) {
    try {
      const release = await checkPlugin(type, slug);
      if (release) pending.push(release);
    } catch (error) {
      report('error', `${type}: ${error.message}`);
    }
  }
  output('releases', JSON.stringify(pending));
  return pending;
}

function loadSigningKey(path = process.env.BOOKORBIT_PLUGIN_SIGNING_KEY) {
  const pem = process.env.PLUGIN_SIGNING_KEY;
  if (!pem && !path) throw new Error('set PLUGIN_SIGNING_KEY to the PEM, or BOOKORBIT_PLUGIN_SIGNING_KEY to its path');
  const key = createPrivateKey(pem || readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 private key');
  return key;
}

/** The key installed copies verify the next release with: the one the published release pins. */
function trustedKey(type, slug, nextSource) {
  const manifest = readManifest(type) ?? committedManifest(type);
  return publicKeyIn(manifest ? releasedSource(type, manifest, slug) : nextSource);
}

function localReleaseCommit() {
  const head = git('rev-parse', 'HEAD');
  git('fetch', '--quiet', 'origin', 'main');
  if (spawnSync('git', ['merge-base', '--is-ancestor', head, 'origin/main'], { cwd: root }).status !== 0) {
    throw new Error('push this commit to main first: the manifest points at it');
  }
  return head;
}

function pendingAt(ref) {
  const pending = [];
  for (const type of pluginTypes()) {
    const version = versionIn(gitBytes(ref, sourcePath(type)));
    const published = readManifest(type)?.version;
    if (VERSION.test(version ?? '') && (!published || compareVersions(version, published) > 0)) pending.push({ type, version });
  }
  return pending;
}

function signReleases() {
  const privateKey = loadSigningKey();
  const signer = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const slug = repoSlug();
  const ref = process.env.GITHUB_SHA || localReleaseCommit();
  if (!COMMIT.test(ref)) throw new Error(`"${ref}" is not a full commit id`);
  const releases = process.env.RELEASES ? JSON.parse(process.env.RELEASES) : pendingAt(ref);
  const outDir = process.env.RELEASE_OUTPUT_DIR ? resolve(process.env.RELEASE_OUTPUT_DIR) : join(root, 'updates');
  if (releases.length === 0) console.log('Nothing is awaiting release');

  for (const { type, version } of releases) {
    if (!TYPE.test(type) || !VERSION.test(version)) throw new Error(`refusing a malformed release ${JSON.stringify({ type, version })}`);
    const bytes = gitBytes(ref, sourcePath(type));
    if (versionIn(bytes) !== version) throw new Error(`${type}: ${sourcePath(type)} at ${ref.slice(0, 12)} is not version ${version}`);
    const trusted = trustedKey(type, slug, bytes);
    if (trusted !== signer) throw new Error(`${type}: the signing key is not the one installed copies trust (${trusted})`);

    const signature = sign(null, bytes, privateKey);
    if (!verify(null, bytes, publicKey(trusted), signature)) throw new Error(`${type}: the new signature does not verify`);
    const manifest = {
      schemaVersion: 1,
      type,
      version,
      sourceUrl: `https://raw.githubusercontent.com/${slug}/${ref}/${sourcePath(type)}`,
      sha256: sha256(bytes),
      signature: signature.toString('base64'),
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${type}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Signed ${type} ${version} at ${ref.slice(0, 12)}`);
    if (publicKeyIn(bytes) !== trusted) {
      report('warning', `${type} ${version} pins a new public key: once it is published, store the matching private key as PLUGIN_SIGNING_KEY`);
    }
  }
}

function tagReleases(published, commit) {
  for (const { type, version } of published) {
    const name = `${type}-v${version}`;
    try {
      if (git('ls-remote', '--tags', 'origin', `refs/tags/${name}`)) {
        report('warning', `tag ${name} already exists and was left alone`);
        continue;
      }
      git('tag', name, commit);
      git('push', '--quiet', 'origin', `refs/tags/${name}`);
    } catch (error) {
      report('warning', `could not tag ${name}: ${error.message.split('\n')[0]}`);
    }
  }
}

function publish() {
  if (!inActions || !process.env.RELEASE_OUTPUT_DIR || !COMMIT.test(process.env.GITHUB_SHA ?? '')) {
    throw new Error('publish runs only in GitHub Actions; after a local sign, commit updates/ yourself');
  }
  const outDir = resolve(process.env.RELEASE_OUTPUT_DIR);
  const signed = readdirSync(outDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(outDir, name), 'utf8')));
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');

  for (let attempt = 1; ; attempt += 1) {
    git('fetch', '--quiet', 'origin', 'main');
    git('checkout', '--quiet', '--force', '--detach', 'origin/main');
    const published = [];
    for (const manifest of signed) {
      const current = readManifest(manifest.type);
      if (current && compareVersions(current.version, manifest.version) >= 0) {
        report('notice', `${manifest.type}: main already publishes ${current.version}, so ${manifest.version} was not published`);
        continue;
      }
      mkdirSync(dirname(manifestPath(manifest.type)), { recursive: true });
      writeFileSync(manifestPath(manifest.type), `${JSON.stringify(manifest, null, 2)}\n`);
      published.push(manifest);
    }
    if (published.length === 0) return;

    git('add', 'updates');
    git('commit', '--quiet', '-m', `Release ${published.map(({ type, version }) => `${type} ${version}`).join(', ')}`);
    const push = spawnSync('git', ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: root, encoding: 'utf8' });
    if (push.status === 0) {
      for (const { type, version } of published) console.log(`Published ${type} ${version}`);
      tagReleases(published, process.env.GITHUB_SHA);
      return;
    }
    if (attempt === 3) throw new Error(`could not push the manifests: ${push.stderr.trim()}`);
    report('warning', 'main moved while publishing; retrying');
  }
}

function setup(keyPath) {
  if (!keyPath) throw new Error('usage: node scripts/release.mjs setup <path-to-private-key.pem>');
  const privateKey = loadSigningKey(keyPath);
  const signer = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const slug = repoSlug();
  for (const type of pluginTypes()) {
    const trusted = trustedKey(type, slug, readFileSync(join(root, sourcePath(type))));
    if (trusted !== signer) throw new Error(`${type} trusts ${trusted}, and this key is ${signer}; nothing was changed`);
  }

  const gh = (args, input) =>
    execFileSync('gh', args, { cwd: root, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
  const reviewer = JSON.parse(gh(['api', 'user'])).id;
  const environment = {
    reviewers: [{ type: 'User', id: reviewer }],
    prevent_self_review: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  gh(['api', '--method', 'PUT', `repos/${slug}/environments/${ENVIRONMENT}`, '--input', '-'], JSON.stringify(environment));
  const policies = JSON.parse(gh(['api', `repos/${slug}/environments/${ENVIRONMENT}/deployment-branch-policies`])).branch_policies;
  if (!policies.some((policy) => policy.name === 'main' && policy.type !== 'tag')) {
    gh(['api', '--method', 'POST', `repos/${slug}/environments/${ENVIRONMENT}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch']);
  }
  gh(['secret', 'set', 'PLUGIN_SIGNING_KEY', '--env', ENVIRONMENT, '--repo', slug], readFileSync(keyPath));
  console.log(`${slug}: the ${ENVIRONMENT} environment holds the signing key, runs only from main, and waits for your approval`);
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === 'verify') verifyAll();
  else if (command === 'check') await checkAll();
  else if (command === 'sign') signReleases();
  else if (command === 'publish') publish();
  else if (command === 'setup') setup(argument);
  else throw new Error('usage: node scripts/release.mjs verify | check | sign | publish | setup <key.pem>');
} catch (error) {
  report('error', error.message);
}
process.exit(failures === 0 ? 0 : 1);
