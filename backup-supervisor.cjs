'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const stagingRoot = '/tmp/actual-backup-staging';

const command = process.argv.slice(2);

if (command.length === 0) {
  console.error('Supervisor: missing server command');
  process.exit(1);
}

let server;
let capture;
let restartTimer;
let maintenance = false;
let stopping = false;
let failed = false;
let serverPaused = false;
let reportingBackup = false;

function launch(executable, args) {
  const child = spawn(executable, args, {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });

  /** @type {Error | null} */
  let processError = null;

  child.on('error', error => {
    processError = error;
    console.error('Supervisor: process error', error);
  });

  /** @type {Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>} */
  const done = new Promise(resolve => {
    child.once('close', (code, signal) => {
      resolve({ code, signal, error: processError });
    });
  });

  const record = {
    child,
    get error() {
      return processError;
    },
    done,
  };

  return record;
}

function sendSignal(record, signal) {
  const pid = record.child.pid;

  if (!Number.isInteger(pid)) {
    console.error('Supervisor: cannot signal a process without a PID');
    failed = true;
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') {
      console.log('Supervisor: process group has already exited');
      return;
    }

    console.error(`Supervisor: could not send ${signal}`, error);
    failed = true;
  }
}

async function terminate(record) {
  sendSignal(record, 'SIGTERM');

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error('Supervisor: shutdown timed out; sending SIGKILL');
    sendSignal(record, 'SIGKILL');
  }, 15000);

  try {
    const result = await record.done;

    return (
      !timedOut &&
      !result.error &&
      (result.code === 0 || result.signal === 'SIGTERM')
    );
  } finally {
    clearTimeout(timer);
  }
}

function startServer() {
  if (stopping) {
    return;
  }

  console.log('Supervisor: starting Actual');
  const current = launch(command[0], command.slice(1));
  server = current;

  void current.done.then(result => {
    if (server === current) {
      server = undefined;
    }

    if (stopping || serverPaused) {
      return;
    }

    console.error(
      `Supervisor: Actual exited (code=${result.code}, signal=${result.signal}); restarting in 1 second`,
    );
    restartTimer = setTimeout(startServer, 1000);
  });
}

async function writeBackupStatus(status) {
  const directory = process.env.ACTUAL_DATA_DIR || '/data';
  const destination = path.join(directory, '.backup-status.json');
  const temporary = `${destination}.tmp`;

  await fs.writeFile(
    temporary,
    JSON.stringify(
      {
        schemaVersion: 1,
        ...status,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );

  await fs.rename(temporary, destination);
}

async function recoverBackupStatus() {
  const filename = path.join(
    process.env.ACTUAL_DATA_DIR || '/data',
    '.backup-status.json',
  );

  let contents;

  try {
    contents = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const status = JSON.parse(contents);

  if (
    !status ||
    status.schemaVersion !== 1 ||
    typeof status.runId !== 'string' ||
    typeof status.startedAt !== 'string' ||
    !['running', 'succeeded', 'failed'].includes(status.state)
  ) {
    throw new Error('Invalid backup status file');
  }

  if (status.state === 'running') {
    await writeBackupStatus({
      runId: status.runId,
      startedAt: status.startedAt,
      finishedAt: new Date().toISOString(),
      state: 'failed',
      message: 'Previous backup was interrupted by supervisor termination',
    });

    console.error('Supervisor: previous backup was interrupted');
  }
}

async function runMaintenance() {
  if (stopping || reportingBackup || maintenance || !server) {
    console.error('Supervisor: backup rejected; busy or server unavailable');
    return;
  }

  reportingBackup = true;

  const runId = require('node:crypto').randomUUID();
  const startedAt = new Date().toISOString();

  try {
    await writeBackupStatus({
      runId,
      startedAt,
      state: 'running',
    });

    if (stopping) {
      throw new Error('Container shutdown requested before backup');
    }

    await performMaintenance();

    if (stopping) {
      throw new Error('Container shutdown interrupted backup');
    }

    await writeBackupStatus({
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      state: 'succeeded',
    });

    console.log(`Supervisor: backup ${runId} succeeded`);
  } catch (error) {
    try {
      await writeBackupStatus({
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        state: 'failed',
        message: 'Backup did not complete; inspect supervisor logs',
      });
    } catch (statusError) {
      console.error(
        'Supervisor: failed to write backup failure status',
        statusError,
      );
    }

    throw error;
  } finally {
    reportingBackup = false;
  }
}

async function performMaintenance() {
  if (stopping || maintenance || !server) {
    throw new Error('Maintenance cannot start: busy or server unavailable');
  }

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

  maintenance = true;
  clearTimeout(restartTimer);
  let staging;

  async function runWorker(script, args, timeout) {
    if (stopping) {
      throw new Error('Container shutdown requested');
    }

    const worker = launch(process.execPath, [script, ...args]);
    capture = worker;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`Supervisor: ${script} timed out; cancelling`);
      sendSignal(worker, 'SIGKILL');
    }, timeout);

    try {
      const result = await worker.done;

      if (timedOut || result.error || result.code !== 0 || stopping) {
        throw new Error(
          `${script} failed: exit=${result.code}, signal=${result.signal}, timeout=${timedOut}`,
        );
      }
    } finally {
      clearTimeout(timer);
      capture = undefined;
    }
  }

  try {
    serverPaused = true;

    try {
      const current = server;

      if (!(await terminate(current))) {
        throw new Error('Actual did not stop normally; capture cancelled');
      }

      if (stopping) {
        throw new Error('Container shutdown requested; capture cancelled');
      }

      staging = await fs.mkdtemp(path.join(stagingRoot, 'capture-'));
      await fs.chmod(staging, 0o700);

      await runWorker(
        '/app/backup-capture.cjs',
        [process.env.ACTUAL_DATA_DIR || '/data', staging],
        60000,
      );

      console.log('Supervisor: capture completed');
    } finally {
      serverPaused = false;

      if (!server) {
        startServer();
      }
    }

    await runWorker('/app/backup-upload.cjs', [staging], 22 * 60 * 1000);

    console.log('Supervisor: encrypted backup upload completed');
  } finally {
    try {
      if (staging) {
        await fs.rm(staging, { recursive: true, force: true });
        console.log('Supervisor: staging removed');
      }
    } finally {
      maintenance = false;
    }
  }
}

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;
  clearTimeout(restartTimer);

  if (capture) {
    const currentCapture = capture;
    sendSignal(currentCapture, 'SIGKILL');
    await currentCapture.done;
  }

  if (server && !(await terminate(server))) {
    failed = true;
  }

  process.exitCode = failed ? 1 : 0;
}

process.on('SIGUSR2', () => {
  runMaintenance().catch(error => {
    console.error('Supervisor: maintenance failed', error);
  });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error('Supervisor: shutdown failed', error);
      process.exitCode = 1;
    });
  });
}

async function initialize() {
  await recoverBackupStatus();

  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { mode: 0o700 });

  console.log('Supervisor: temporary backup staging initialized');
  startServer();
}

initialize().catch(error => {
  console.error('Supervisor: startup recovery failed', error);
  process.exitCode = 1;
});
