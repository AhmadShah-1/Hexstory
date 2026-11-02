import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { createDb, describeDatabase, type Sql } from './db.js';
import { checkPlaces, checkUrls, loadCache, saveCache } from './import/checks.js';
import { readImportFiles, type Issue } from './import/format.js';
import { applyImport, planImport, removeBatch } from './import/run.js';
import { ENVIRONMENTS, checkDatabase } from './migrate.js';
import { createLocalStorage, type Storage } from './storage/index.js';
import { createR2Storage } from './storage/r2.js';

/**
 * Bulk import of events from JSON Lines files (docs/IMPORT.md).
 *
 *   check <files…> [--check-urls] [--check-places] [--photos dir]   validate; no database needed
 *   dry-run <files…> --env <env>                                    what apply would do
 *   apply <files…> --env <env> [--batch name] [--update-edited]     write (links are checked first)
 *   remove-batch <name> --env <env>                                 hide every story of a batch
 *
 * Database: DATABASE_URL_UNPOOLED or DATABASE_URL, else asked for (hidden) in a terminal. The database
 * must be marked for --env and fully migrated, the same guard the API uses at startup. Photos go to R2
 * when STORAGE_BACKEND=r2 and the R2_* variables are set, else to UPLOAD_DIR (local development).
 */
const USAGE = `Usage:
  npm run import:check -- <files…> [--check-urls] [--check-places] [--photos <dir>]
  npm run import -- dry-run <files…> --env development
  npm run import -- apply <files…> --env development [--batch <name>] [--update-edited]
  npm run import -- remove-batch <name> --env development`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    batch: { type: 'string' },
    photos: { type: 'string' },
    'check-urls': { type: 'boolean', default: false },
    'check-places': { type: 'boolean', default: false },
    'skip-url-check': { type: 'boolean', default: false },
    'update-edited': { type: 'boolean', default: false },
    reason: { type: 'string' },
  },
});
const [command, ...args] = positionals;
// npm runs workspace scripts from apps/api; resolve paths from where the command was typed.
const fromCwd = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
const log = (msg: string) => console.log(msg);

function report(issues: Issue[]): number {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  for (const i of [...errors, ...warnings]) console.log(`${i.level === 'error' ? 'ERROR  ' : 'warning'} ${i.where}: ${i.message}`);
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  return errors.length;
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolveAnswer, reject) => {
    if (!stdin.isTTY) return reject(new Error('No terminal to ask in: set DATABASE_URL_UNPOOLED or DATABASE_URL.'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolveAnswer(value.trim());
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function connect(env: string | undefined): Promise<Sql> {
  if (!env || !(ENVIRONMENTS as readonly string[]).includes(env)) throw new Error(`--env must be one of ${ENVIRONMENTS.join(', ')}`);
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || (await askHidden(`Connection string for the ${env} database (input hidden): `));
  if (!url) throw new Error('No connection string given.');
  const sql = createDb(url, { max: 5 });
  await checkDatabase(sql, env);
  log(`[import] ${describeDatabase(url)} (${env})`);
  return sql;
}

function storageFromEnv(env: string, needed: boolean): Storage {
  const e = process.env;
  if (e.STORAGE_BACKEND === 'r2' && e.R2_ENDPOINT && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_PUBLIC_BASE_URL) {
    return createR2Storage({
      endpoint: e.R2_ENDPOINT, bucket: e.R2_BUCKET, stagingBucket: e.R2_STAGING_BUCKET ?? e.R2_BUCKET,
      accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, publicBaseUrl: e.R2_PUBLIC_BASE_URL,
    });
  }
  if (needed && env !== 'development') {
    throw new Error('These files have photos: set STORAGE_BACKEND=r2 and the R2_* variables for this environment (e.g. run through its Doppler config).');
  }
  return createLocalStorage(e.UPLOAD_DIR || './uploads');
}

async function main(): Promise<number> {
  if (!command || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'remove-batch') {
    const [batch] = args;
    if (!batch) throw new Error('Name the batch to remove.');
    const sql = await connect(flags.env);
    try {
      const n = await removeBatch(sql, batch, flags.reason ?? `Import batch "${batch}" removed`);
      log(`Hid ${n} stories from batch "${batch}". Moderators can bring single stories back with Unhide.`);
      return 0;
    } finally {
      await sql.end();
    }
  }

  if (!['check', 'dry-run', 'apply'].includes(command)) {
    console.log(USAGE);
    return 1;
  }
  const files = args.map(fromCwd);
  if (!files.length) throw new Error('Give at least one import file.');
  const photosDir = flags.photos ? fromCwd(flags.photos) : undefined;
  const cachePath = resolve(dirname(files[0]!), '.import-cache.json');

  // `check` validates offline (unless a database URL is configured, which also resolves links to
  // stories imported earlier). `dry-run` and `apply` always use the database.
  const sql = command === 'check' ? (process.env.DATABASE_URL && flags.env ? await connect(flags.env) : null) : await connect(flags.env);
  try {
    const knownKeys = sql
      ? new Set((await sql<{ importKey: string }[]>`SELECT import_key FROM stories WHERE import_key IS NOT NULL`).map((r) => r.importKey))
      : null;
    const { records, issues } = await readImportFiles(files, { photosDir, knownKeys });
    log(`Read ${records.length} events from ${files.length} file(s).`);

    const cache = await loadCache(cachePath);
    if ((command === 'check' && flags['check-urls']) || (command === 'apply' && !flags['skip-url-check'])) {
      issues.push(...(await checkUrls(records, cache, log)));
    }
    if (flags['check-places']) issues.push(...(await checkPlaces(records, cache, log, { geocoderUrl: process.env.IMPORT_GEOCODER_URL || undefined })));
    await saveCache(cachePath, cache);

    const years = records.map((r) => Number(r.record.start.match(/^-?\d+/)![0]));
    const recent = years.filter((y) => y >= 2020).length;
    log(`${recent} of ${records.length} start in 2020 or later; ${records.filter((r) => r.record.ongoing).length} ongoing; `
      + `${records.filter((r) => r.record.photo).length} with a photo; ${records.reduce((n, r) => n + r.record.developments.length, 0)} developments.`);
    const errors = report(issues);
    if (command === 'check' || errors) return errors ? 1 : 0;

    const storage = storageFromEnv(flags.env!, records.some((r) => r.photoPath));
    if (command === 'dry-run') {
      const plan = await planImport({ sql: sql!, storage }, records);
      log(`\nWould create ${plan.create} stories, update ${plan.update}, leave ${plan.unchanged} unchanged, and add ${plan.developments} developments.`);
      if (plan.editedOnSite.length) log(`${plan.editedOnSite.length} were edited on the site since they were imported and would be left alone: ${plan.editedOnSite.slice(0, 20).join(', ')}${plan.editedOnSite.length > 20 ? '…' : ''}`);
      return 0;
    }

    const batch = flags.batch ?? `import-${new Date().toISOString().slice(0, 10)}`;
    log(`\nImporting as batch "${batch}"…`);
    const s = await applyImport({ sql: sql!, storage }, records, { batch, updateEdited: flags['update-edited'], log });
    log(`\nCreated ${s.created}, updated ${s.updated}, unchanged ${s.unchanged}; ${s.developmentsAdded} developments and ${s.photosStored} photos added.`);
    if (s.skippedEdited.length) log(`Left alone (edited on the site since): ${s.skippedEdited.join(', ')}. Use --update-edited to overwrite with a new version.`);
    if (s.failed.length) {
      report(s.failed);
      log('Fix these and run the same command again: everything already imported is skipped.');
      return 1;
    }
    return 0;
  } finally {
    await sql?.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[import] ${(err as Error).message}`);
    process.exit(1);
  },
);
