# AoI fork download options

This fork keeps MEGAJS's public API and adds `cloudRaid: true` to `File.download`
and `downloadBuffer`. It requests a version 2 download ticket. A string URL uses
normal byte ranges; six URLs are decoded as five 16-byte data sectors plus XOR
parity. Any five complete shards reconstruct a range; the remaining request is
cancelled. Two failed shards fail the range and use `handleRetries`.

The download scheduler bounds outstanding and buffered chunks by
`maxConnections`, replenishes all available slots after ordered writes, and
respects stream backpressure. `chunkSizeIncrement: 0` selects fixed-size chunks.
Each CloudRAID chunk can use six HTTP requests, so choose concurrency accordingly.
Full-file downloads still perform MEGA's MAC verification after reconstruction.

```js
file.download({
  forceHttps: true,
  cloudRaid: true,
  maxConnections: 8,
  initialChunkSize: 3355440,
  chunkSizeIncrement: 0,
  maxChunkSize: 3355440
})
```

No download URL logging, environment overrides, or probe requests are included.
The protocol layout is documented in MEGA's official webclient
`js/transfers/cloudraid.js` and ticket selection in `js/utils/network.js`.

## Build and consume

`npm ci`, `npm test`, and `npm pack` build and validate all four bundles. `prepare`
also builds the bundles when installing a Git dependency pinned to a commit.
AoI pins the full commit SHA; its lockfile is committed with that dependency.
No unpublished registry version or local tarball is required.
