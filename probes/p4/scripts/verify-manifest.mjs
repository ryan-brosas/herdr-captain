import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');

export const INPUT_FILES = Object.freeze([
  'rules/attempt-budget.mjs',
  'scripts/compile-kernel.mjs',
  'scripts/verify-manifest.mjs',
]);

export const OUTPUT_FILES = Object.freeze([
  'generated/attempt-budget.js',
  'generated/attempt-budget.d.ts',
]);

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readPinnedGdpWiredVersion(packageRoot = PACKAGE_ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  const pinned = pkg.devDependencies?.['gdp-wired'];
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`gdp-wired must be pinned to an exact devDependency version; got ${JSON.stringify(pinned)}`);
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    throw new Error('probes/p4 must have zero runtime dependencies');
  }
  return pinned;
}

export function verifyManifest(baseDir = PACKAGE_ROOT) {
  const pinned = readPinnedGdpWiredVersion(baseDir);
  const manifestPath = resolve(baseDir, 'generated/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  const expectedProver = `gdp-wired@${pinned}`;
  if (manifest.prover !== expectedProver) {
    throw new Error(`Manifest prover mismatch: expected ${expectedProver}, got ${manifest.prover}`);
  }

  for (const relPath of INPUT_FILES) {
    const expected = manifest.inputs?.[relPath];
    const actual = sha256(readFileSync(resolve(baseDir, relPath)));
    if (actual !== expected) {
      throw new Error(`Input hash mismatch for ${relPath}: expected ${expected}, got ${actual}`);
    }
  }

  for (const relPath of OUTPUT_FILES) {
    const expected = manifest.outputs?.[relPath];
    const actual = sha256(readFileSync(resolve(baseDir, relPath)));
    if (actual !== expected) {
      throw new Error(`Artifact hash mismatch for ${relPath}: expected ${expected}, got ${actual}`);
    }
  }

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetDir = process.argv[2] ? resolve(process.argv[2]) : PACKAGE_ROOT;
  try {
    const manifest = verifyManifest(targetDir);
    console.log(
      JSON.stringify(
        {
          ok: true,
          prover: manifest.prover,
          outputs: manifest.outputs,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
