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
Failed requests to the cache service are retried with exponential backoff.
`retries` sets how many retries follow the first attempt (default `2`), `retry-delay` the wait before the first retry (default `150ms`, doubling each time), `retry-max-delay` the longest wait (default `5s`), and `attempt-timeout` the longest a single request may take (default `35s` for the mount, `5s` for finalization).
When the retries run out, or the service reports degraded storage, the job continues uncached with `source=fallback` unless `fail-on-error` is `true`.
An unconfirmed mount is never finalized, so the service cannot publish it.

```yaml
- uses: LuxorLabs/stickydisk@v1
  with:
    key: npm-cache
    path: ~/.npm
    retries: 1
    attempt-timeout: 4s
```

Storage loss after attachment can cancel the owning job to prevent publication of damaged cache data.

The action writes `mounted`, `source`, and `generation` outputs.
Its job summary includes the mount mode, generation, fallback reason, previous candidate outcome, and publication state.

## Releases

Use `LuxorLabs/stickydisk@v1` in workflows to follow version 1 releases.
Release tags such as `v1.0.1` are immutable; the `v1` tag advances with each version 1 release.
Pin an immutable release tag or commit SHA when you need a fixed version.
