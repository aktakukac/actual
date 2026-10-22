'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const statusPath = path.join(
  process.env.ACTUAL_DATA_DIR || '/data',
  '.backup-status.json',
);

async function readStatus() {
  let contents;

  try {
    contents = await fs.readFile(statusPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const status = JSON.parse(contents);

  if (
    !status ||
    status.schemaVersion !== 1 ||
    typeof status.runId !== 'string' ||
    !['running', 'succeeded', 'failed'].includes(status.state)
  ) {
    throw new Error('Invalid backup status file');
  }

  return status;
}

async function findSupervisor() {
  const matches = [];

  for (const entry of await fs.readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) {
      continue;
    }

    let contents;

    try {
      contents = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') {
        continue;
      }

      throw error;
    }

    const args = contents.split('\0');

    if (
      args[1] === '/app/backup-supervisor.cjs' &&
      path.basename(args[0]) === 'node'
    ) {
      matches.push(Number(entry));
    }
  }

  if (matches.length !== 1) {
    throw new Error(`Expected one supervisor; found ${matches.length}`);
  }

  return matches[0];
}

async function trigger() {
  const previous = await readStatus();

  if (previous?.state === 'running') {
    throw new Error('A backup is already running; refusing another request');
  }

  const pid = await findSupervisor();
  process.kill(pid, 'SIGUSR2');
  console.log('Backup requested; waiting for a new result');

  const started = Date.now();
  let runId;

  while (Date.now() - started < 25 * 60 * 1000) {
    const status = await readStatus();

    if (status && status.runId !== previous?.runId) {
      if (runId && status.runId !== runId) {
        throw new Error('Another backup replaced the expected result');
      }

      if (!runId) {
        runId = status.runId;
        console.log(`Tracking backup ${runId}`);
      }

      if (status.state === 'succeeded') {
        console.log(`PASS: backup ${runId} succeeded`);
        return;
      }

      if (status.state === 'failed') {
        throw new Error(`Backup ${runId} failed; inspect supervisor logs`);
      }
    }

    if (!runId && Date.now() - started > 30000) {
      throw new Error('Supervisor did not acknowledge the backup within 30 seconds');
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('Timed out waiting for backup completion; inspect status before retrying');
}

trigger().catch(error => {
  console.error('Backup trigger failed:', error.message);
  process.exitCode = 1;
});
