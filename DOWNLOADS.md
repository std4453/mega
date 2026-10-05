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

This fork is published as `@std4453/megajs` with the `beta` dist-tag. Install a
specific version to keep deployments reproducible:

```sh
npm install --save-exact @std4453/megajs@1.3.10-beta.0
```

Import from `@std4453/megajs` instead of `megajs`; the exported API is unchanged.
AoI pins that registry version and commits its lockfile.

`npm ci`, `npm test`, and `npm pack` build and validate all four bundles. `prepare`
builds the bundles before packing or publishing. Publish with
`npm publish --access public --tag beta`; local publication does not attach
provenance. Provenance can be requested explicitly from a supported CI runner.
