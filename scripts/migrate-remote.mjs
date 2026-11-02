#!/usr/bin/env node
/**
 * Applies migrations to a deployed database: `npm run migrate:production` / `npm run migrate:preview`.
 *
 * Uses DATABASE_URL_UNPOOLED from the environment if set; otherwise asks for the direct (unpooled) Neon
 * connection string with hidden input. The string is passed only to the migrate process: never
 * printed, written to a file or kept in shell history. (`vercel env run` isn't used: it can't read
 * variables marked Sensitive, and some CLI versions misread its arguments.)
 */
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const env = process.argv[2];
if (env !== 'production' && env !== 'preview') {
  console.error('Usage: node scripts/migrate-remote.mjs production|preview');
  process.exit(2);
}

/** Reads one line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) return reject(new Error('No terminal to ask in: set DATABASE_URL_UNPOOLED instead.'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

let url = process.env.DATABASE_URL_UNPOOLED;
try {
  url ||= await askHidden(`Paste the DIRECT (unpooled) Neon connection string for ${env} (input hidden): `);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (!url) {
  console.error('No connection string given.');
  process.exit(2);
}

// Only the URL for this run: never a local DATABASE_URL by accident.
const childEnv = { ...process.env, DATABASE_URL_UNPOOLED: url };
delete childEnv.DATABASE_URL;
const child = spawn('npm', ['run', 'migrate', '-w', '@hexstory/api', '--', '--env', env], { stdio: 'inherit', env: childEnv });
child.on('exit', (code) => process.exit(code ?? 1));
