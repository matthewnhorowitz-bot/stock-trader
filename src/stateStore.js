// Persistence layer for dedup state + alert history.
//
//   Local (default):  reads/writes JSON files under ./data
//   Cloud (Cloud Run): set STATE_BUCKET to a GCS bucket name and state is
//                      stored there instead, so it survives the container being
//                      torn down between scheduled runs.
//
// The GCS client is imported lazily, so local/sample runs don't need the
// @google-cloud/storage dependency loaded at all.

import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Read STATE_BUCKET directly (not via config.js) to avoid a circular import —
// config.js imports `stateBackend` from this module for its startup banner.
const STATE_BUCKET = (process.env.STATE_BUCKET || '').trim();
const useGcs = !!STATE_BUCKET;
let bucketPromise = null;

async function getBucket() {
  if (!bucketPromise) {
    bucketPromise = import('@google-cloud/storage').then(
      ({ Storage }) => new Storage().bucket(STATE_BUCKET)
    );
  }
  return bucketPromise;
}

// Read a JSON object by logical name (e.g. "seen.json"); return `fallback`
// when it doesn't exist yet.
export async function readState(name, fallback) {
  if (useGcs) {
    const file = (await getBucket()).file(name);
    const [exists] = await file.exists();
    if (!exists) return fallback;
    const [buf] = await file.download();
    return JSON.parse(buf.toString('utf8'));
  }
  try {
    return JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeState(name, data) {
  const json = JSON.stringify(data, null, 2);
  if (useGcs) {
    await (await getBucket())
      .file(name)
      .save(json, { contentType: 'application/json' });
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, name), json);
}

// Returns true if a state object does NOT exist yet (used to detect first run).
export async function stateMissing(name) {
  if (useGcs) {
    const [exists] = await (await getBucket()).file(name).exists();
    return !exists;
  }
  try {
    await readFile(join(DATA_DIR, name), 'utf8');
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

export const stateBackend = useGcs ? `gcs://${STATE_BUCKET}` : 'local ./data';
