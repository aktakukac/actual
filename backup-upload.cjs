'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function upload() {
  for (const name of [
    'RESTIC_REPOSITORY',
    'RESTIC_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ]) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const stagingArgument = process.argv[2];

  if (!stagingArgument) {
    throw new Error('Expected a capture staging directory');
  }

  const staging = await fs.realpath(stagingArgument);
  const data = await fs.lstat(path.join(staging, 'data'));

  if (!data.isDirectory() || data.isSymbolicLink()) {
    throw new Error('Capture data must be a real directory');
  }

  const port = process.env.ACTUAL_PORT || '5006';
  let healthy = false;

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = await response.json();

      if (response.ok && body.status === 'UP') {
        healthy = true;
        break;
      }

      console.error('Upload: Actual not ready, HTTP', response.status);
    } catch (error) {
      console.error('Upload: health check failed:', error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!healthy) {
    throw new Error('Actual did not become healthy; upload cancelled');
  }

  const result = spawnSync(
    'restic',
    [
      'backup',
      '--host',
      'actual-gm-budget-2026',
      '--tag',
      'actual-server',
      '--',
      'data',
    ],
    {
      cwd: staging,
      env: process.env,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGKILL',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Restic upload failed: exit=${result.status}, signal=${result.signal}`,
    );
  }

  console.log('Upload: restic backup completed successfully');

  const retention = spawnSync(
    'restic',
    [
      'forget',
      '--host',
      'actual-gm-budget-2026',
      '--tag',
      'actual-server',
      '--group-by',
      'host,tags',
      '--keep-daily',
      '14',
      '--keep-weekly',
      '8',
      '--keep-monthly',
      '6',
      '--prune',
    ],
    {
      env: process.env,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGKILL',
    },
  );

  if (retention.error) {
    throw retention.error;
  }

  if (retention.status !== 0) {
    throw new Error(
      `Restic retention failed: exit=${retention.status}, signal=${retention.signal}`,
    );
  }

  console.log('Upload: retention and pruning completed successfully');
}

upload().catch(error => {
  console.error('Upload failed:', error.message);
  process.exitCode = 1;
});
