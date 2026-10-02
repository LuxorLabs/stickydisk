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
Set it to `never` when a job should read the published cache without publishing its own writes.
Before attachment, storage errors leave the job uncached and set `source=fallback` unless `fail-on-error` is `true`.
A `storage_degraded` response always fails the step, because the mount outcome is unknown and publishing could expose damaged data.
Storage loss after attachment can cancel the owning job to prevent publication of damaged cache data.

The action writes `mounted`, `source`, and `generation` outputs.
Its job summary includes the mount mode, generation, fallback reason, previous candidate outcome, and publication state.

## Releases

Use `LuxorLabs/stickydisk@v1` in workflows to follow version 1 releases.
Release tags such as `v1.0.1` are immutable; the `v1` tag advances with each version 1 release.
Pin an immutable release tag or commit SHA when you need a fixed version.
