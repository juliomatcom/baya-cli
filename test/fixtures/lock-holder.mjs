#!/usr/bin/env node
/**
 * Holds a lock file the way a real Baya process would, so cross-process tests
 * exercise genuine pid liveness instead of a mocked predicate.
 *
 * usage: lock-holder.mjs <lockPath> <holdMs> <heartbeatMs>
 * Prints "READY" on stdout once the lock file exists.
 */
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const [lockPath, holdMsRaw, heartbeatMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw ?? 1000);
const heartbeatMs = Number(heartbeatMsRaw ?? 300);

const info = {
  token: randomUUID(),
  pid: process.pid,
  host: hostname(),
  owner: 'lock-holder-fixture',
  acquiredAt: Date.now(),
  heartbeatAt: Date.now(),
};

function write() {
  const tmp = `${lockPath}.${info.token}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, 'utf8');
  renameSync(tmp, lockPath);
}

write();
process.stdout.write('READY\n');

const beat = setInterval(() => {
  info.heartbeatAt = Date.now();
  write();
}, heartbeatMs);

setTimeout(() => {
  clearInterval(beat);
  if (process.env['LOCK_HOLDER_LEAVE_FILE'] !== '1') {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}, holdMs);
