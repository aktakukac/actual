'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function getRequiredSpace(directory) {
  let bytes = 0;

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      bytes += await getRequiredSpace(filename);
    } else if (entry.isFile()) {
      const stat = await fs.stat(filename);
      bytes += Math.ceil(stat.size / 4096) * 4096 + 4096;
    } else {
      throw new Error(`Unsupported data entry: ${filename}`);
    }
  }

  return bytes + 4096;
}

async function capture() {
  const [sourceArgument, stagingArgument] = process.argv.slice(2);

  if (!sourceArgument || !stagingArgument) {
    throw new Error('Expected source and existing empty staging directory');
  }

  const source = await fs.realpath(sourceArgument);
  const staging = await fs.realpath(stagingArgument);
  const relative = path.relative(source, staging);

  if (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error('Staging must be outside the source directory');
  }

  if ((await fs.readdir(staging)).length !== 0) {
    throw new Error('Staging directory must be empty');
  }

  await fs.chmod(staging, 0o700);

  const required = await getRequiredSpace(source);
  const disk = await fs.statfs(staging);
  const available = disk.bavail * disk.bsize;
  const reserve = 64 * 1024 * 1024;

  if (available < required + reserve) {
    throw new Error('Insufficient staging space, including 64 MiB reserve');
  }

  await fs.cp(source, path.join(staging, 'data'), {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });

  console.log('Capture completed');
}

capture().catch(error => {
  console.error('Capture failed:', error.message);
  process.exitCode = 1;
});
