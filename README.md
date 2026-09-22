# Sticky disk action

`LuxorLabs/stickydisk@v1` mounts a workspace-scoped cache path on a compatible Tenki runner.
Your workspace must have runner sticky disks enabled by a Tenki operator.
The runner supplies a session capability through its environment.
The action does not accept storage names, pool identifiers, or other storage access details.

```yaml
- uses: LuxorLabs/stickydisk@v1
  with:
    key: npm-cache
    path: ~/.npm
```

`commit` defaults to `auto` and asks the control plane to publish after a successful job.
Set it to `never` for read-only reuse or disposable data.
Before attachment, storage errors leave the job uncached and set `source=fallback` unless `fail-on-error` is `true`.
A `storage_degraded` response always fails the step, because the mount outcome is unknown and publishing could expose damaged data.
Storage loss after attachment can cancel the owning job to prevent publication of damaged cache data.

The action writes `mounted`, `source`, and `generation` outputs.
Its job summary includes the mount mode, generation, fallback reason, previous candidate outcome, and publication state.

## BuildKit

`LuxorLabs/stickydisk/buildkit@v1` starts a named remote BuildKit builder with its state in the mounted path.
It always uses BuildKit's native snapshotter.
The helper exports `name`, which can be passed to Docker build actions that accept a builder name.

```yaml
- id: buildkit
  uses: LuxorLabs/stickydisk/buildkit@v1
  with:
    key: buildkit-linux-amd64
    path: /var/lib/buildkit

- uses: docker/build-push-action@v7
  with:
    builder: ${{ steps.buildkit.outputs.name }}
```

The daemon runs with a garbage collection policy that prunes cache records unused for `gc-keep-duration` (default `192h`) and keeps the cache under `gc-keep-bytes` (default 90% of the sticky disk).
Set `max-parallelism` to cap concurrent BuildKit steps.
The BuildKit post hook stops the managed daemon before requesting finalization.
Publication remains pending until device removal, filesystem verification, and a successful GitHub job conclusion.
Use an existing single Tenki offering label, such as `tenki-standard-medium-4c-8g`.
Container jobs and persistence of all of `/var/lib/docker` are not supported.

Run `npm run smoke:buildkit` from this repository on a Linux host with passwordless `sudo docker` to test the local BuildKit state lifecycle.
It uses a mock HTTPS control plane, starts the action's real main and post hooks twice, checks the native snapshotter command, and proves a state marker survives the first cleanup.
It also checks two local OverlayFS consumer-like views do not write through to each other or their lower directory.
This smoke test does not exercise Ceph-backed sandbox storage.

For an in-guest storage test, run `npm run e2e:buildkit-guest -- --state-path /trusted/mounted/path --mode publisher --expect cold`.
Run a second consumer invocation against the mounted path with `--mode consumer --expect warm`.
The script starts and stops the exported builder lifecycle, builds a scratch `COPY` context, verifies the exported file, and checks BuildKit cache output.

## Releases

Release tags such as `v1.0.0` are immutable; the `v1` tag advances with each version 1 release.
Pin an immutable release tag or commit SHA when you need a fixed version.
