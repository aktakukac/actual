# Production Backup and Disaster Recovery Runbook

This runbook records the verified backup setup and safe recovery procedure for
the Actual instance hosted on Fly.io. It contains no credential values. Keep
this document in version control, but store all credentials and private
deployment configuration only in their intended secret stores.

## Scope and safety

- Production Fly.io app: `actual-gm-budget-2026`
- Region: `fra`
- Persistent volume: `actual_data`, mounted at `/data`
- GitHub repository: [`aktakukac/actual`](https://github.com/aktakukac/actual)
- Backup workflow: [Production Backup](.github/workflows/backup.yml)
- Missed-backup monitor: [Production Backup Watchdog](.github/workflows/backup-watchdog.yml)
- The production Fly configuration and backup scripts are not present in this
  repository. Do not infer deployment settings or recreate the Restic
  repository from this runbook.

Production budget data includes bank connection credentials. Treat snapshots,
restores, logs, and temporary copies as sensitive financial data. Never paste
credentials, Restic passwords, access tokens, database contents, or unredacted
logs into a pull request, issue, chat, or this repository.

Do not initialize, relocate, or prune the Restic repository manually. The
production backup process applies retention and pruning after creating a
backup. Manual workflow dispatch also invokes that process.

## Credential-free setup record

### Credentials and their locations

| Credential | Required use | Storage |
| --- | --- | --- |
| App-scoped Fly SSH token | Lets GitHub Actions connect to the Fly app and invoke the backup trigger | GitHub Actions repository secret `FLY_API_TOKEN` |
| Restic repository credentials | Lets the deployed backup process access the existing encrypted backup repository | Existing Fly app secret/configuration; exact names are intentionally not recorded here |
| Actual account and budget encryption passwords | Needed for normal app access and, if enabled, decrypting encrypted budgets | Password manager or other approved private credential store |
| Bank connection credentials | Used by the live budget for bank connections | Stored in the budget data; restored copies must be treated as sensitive |

Use the complete Fly token value, including any `FlyV1 ` prefix and following
space, when setting `FLY_API_TOKEN`. Never add quotes or put the token in a
workflow file. The currently configured app-scoped SSH token was validated by
a successful production backup workflow run on 2026-10-22.

If that token must be rotated, create an SSH token for this app using the
authenticated Fly CLI, then replace the GitHub secret through the repository
settings page. Do not revoke the previous token until a workflow run using the
replacement has successfully completed.

The production deployment configuration and the exact Fly secret names for
Restic are not tracked in this repository. Obtain those from the authorized
Fly account and its private deployment records; do not create replacement
secrets or initialize a repository as part of recovery.

### Backup schedule and alerts

- The `Production Backup` workflow checks twice daily in UTC and runs at
  approximately 03:17 Europe/Budapest time, accounting for daylight saving
  time. GitHub scheduled workflows are best-effort and may be delayed.
- The workflow connects to the existing Fly app and invokes
  `node /app/backup-trigger.cjs`. The container-side process performs and
  verifies the backup.
- The `Production Backup Watchdog` workflow checks at approximately 06:17
  Europe/Budapest time. It fails if it cannot find a successful scheduled
  backup run for that Budapest calendar day.
- GitHub Actions failure notifications should be enabled for the account that
  owns the scheduled workflow. Scheduled-workflow notifications go to the
  user GitHub associates with the workflow schedule. Confirm this setting in
  GitHub notification preferences.
- A successful watchdog run is evidence that GitHub found the backup
  workflow's verification step succeeded. It is not a substitute for
  periodically checking the Restic repository.

To inspect activity, open the repository **Actions** tab and review both
workflows. A manual dispatch of `Production Backup` is available for a
deliberate test, but it performs a real production backup and its retention
process. Do not use it as a harmless connectivity probe.

### Verified backup evidence

On 2026-10-22, manual Production Backup run
[#2](https://github.com/aktakukac/actual/actions/runs/39779031209) completed
successfully. The new snapshot was `94d4c676` (full snapshot ID is available
from Restic), approximately 1.575 MiB.

The following read-only integrity check completed successfully at that time:

```powershell
flyctl ssh console --app actual-gm-budget-2026 --command "restic check --read-data" --pty=false
```

It read all 6 of 6 packs and reported no errors. These results are a dated
validation record, not a claim about the repository's current state.

## Routine verification

1. Review the latest `Production Backup` workflow run. Confirm the
   **Run and verify production backup** step succeeded.
2. Review the `Production Backup Watchdog` run after its daily check. A failure
   means the watchdog could not find a successful scheduled backup for that
   day, or could not query GitHub Actions successfully; inspect its log before
   treating it as a confirmed backup failure.
3. When performing a periodic repository integrity check, use the read-only
   command shown above and confirm it ends with `no errors were found`.
4. Never publish snapshot paths or logs if they could reveal private data.

An operator who needs to list snapshots can use:

```powershell
flyctl ssh console --app actual-gm-budget-2026 --command "restic snapshots --latest 1" --pty=false
```

Check the snapshot host, timestamp, and size. Do not treat the existence of an
older snapshot as proof that today's backup succeeded.

## Disaster recovery

### Restore a snapshot to a local isolated test

This procedure tests a restored copy without replacing production. It does
not, by itself, prove that the production service can be recovered or that
users can decrypt every budget.

1. Select a known snapshot ID from the verified Restic repository. Do not
   guess the ID or initialize a repository. The commands below use
   `94d4c676` as an example; replace that value with the ID you verified.
   Set the local path and container name from the selected ID:

   ```powershell
   $snapshotId = '94d4c676'
   $restorePath = Join-Path $env:USERPROFILE "Actual-restore-$snapshotId"
   $containerName = "actual-restore-$snapshotId-isolated"
   ```

2. Restore it on the authorized Fly machine to a new, unique temporary
   directory. Never start Actual from this directory on the production
   machine:

   ```powershell
   flyctl ssh console --app actual-gm-budget-2026 --command "restic restore $snapshotId --target /tmp/actual-restore-$snapshotId" --pty=false
   ```

3. Copy the restored directory to a private local folder. For example:

   ```powershell
   flyctl ssh sftp get --app actual-gm-budget-2026 --recursive "/tmp/actual-restore-$snapshotId" $restorePath
   ```

   Protect the copy as carefully as the live budget. Do not put it in a
   synchronized or shared folder unless that storage is approved for the
   financial data it contains.

4. Use a Docker network created with `--internal`. If the network does not
   exist, create it once:

   ```powershell
   docker network create --internal actual-restore-isolated
   ```

   Whether newly created or already present, inspect it before starting the
   container:

   ```powershell
   docker network inspect actual-restore-isolated --format '{{.Internal}}'
   ```

   The inspection output must be `true`. Start a separate container with a
   validated image compatible with the restored data, mounting only the
   restored copy as `/data`. The following command records the image and
   startup arguments used in the 2026-10-22 local test; use that image only
   if it is still available locally and confirmed to be the intended
   backup-enabled image:

   ```powershell
   docker run --detach --name $containerName --network actual-restore-isolated --mount "type=bind,source=$restorePath\data,target=/data" --entrypoint /usr/bin/tini actual-custom:backup-test -- node /app/backup-supervisor.cjs node build/app.js
   ```

   Before continuing, verify the new container is attached only to
   `actual-restore-isolated`. Do not attach it to `bridge`, a host network, or
   any other network; do not publish a host port or enable bank
   synchronization.

5. Verify the application health and page from inside the container, without
   connecting it to a bank:

   ```powershell
   docker exec $containerName node -e "fetch('http://127.0.0.1:5006/health').then(async r => { console.log('HTTP ' + r.status + ' ' + await r.text()); if (!r.ok) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; })"
   docker exec $containerName node -e "fetch('http://127.0.0.1:5006/').then(async r => { const body = await r.text(); console.log('HTTP ' + r.status + ', ' + body.length + ' bytes'); if (!r.ok) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; })"
   ```

   An HTTP 200 health response and page response confirm the server starts and
   serves the app. They do not confirm successful browser login, correct
   budget contents, or successful decryption.
6. If visual inspection is required, decide on a secure local-only access
   method first. Do not weaken network isolation just to make a port
   reachable. A restored budget may contain working bank credentials; do not
   sign in or enable bank sync during this test.

A test on 2026-10-22 restored snapshot `94d4c676` (1.575 MiB; 5 local files,
1,651,701 bytes), and the app returned HTTP 200 for its internal health and
web-page requests on an internal Docker network. Browser/login and budget
content verification were not completed. The test did not establish a
production recovery time objective.

### Restoring production service

The following actions can cause irreversible data loss or expose credentials.
Use an authorized operator and do not improvise these steps during an outage.

1. Preserve the original Fly app, volume, and Restic repository. Do not delete,
   reformat, detach, replace, or restore over the production volume.
2. Confirm the target snapshot with `restic snapshots`, and verify the
   repository with `restic check --read-data`.
3. If the current service is available, take and verify a fresh backup before
   any recovery changes.
4. Restore first to a separate, protected target. Confirm the required
   application image/version, storage layout, Fly configuration, secrets,
   encryption passwords, and rollback plan with the service owner.
5. Validate the restored app and budgets without bank access before deciding
   whether to cut over.
6. Have the service owner approve any production cutover. Keep the original
   volume and previous known-good deployment intact until the recovered
   service is verified and rollback is no longer needed.

This repository does not contain the production Fly configuration, image
build/release definition for the custom backup-enabled image, or the
container-side Restic/backup scripts. Consequently, it does not yet document a
reproducible production redeploy or a safe volume cutover command. Do not use
the generic Actual Fly.io installation instructions as a substitute for this
service's private configuration.

## Planned deployment and upstream maintenance

There is no verified deployment or monthly upstream-update workflow for this
service in this repository. Until one is established and tested:

- Do not automatically deploy upstream `latest` or a newly built image to
  production.
- Review upstream changes and release notes, test a pinned candidate against
  a separate copy, and verify a current backup before any approved update.
- Record the exact image digest, configuration change, validation result, and
  rollback procedure in the authorized deployment record.
- Do not commit Fly tokens, Restic credentials, bank credentials, or private
  deployment configuration to implement this process.

The monthly upstream update and controlled deployment procedure remains an
open operational task; this runbook deliberately does not claim it is
automated.
