// CloudRAID stripes five 16-byte data sectors plus XOR parity over six URLs.
// These URLs are shards, never interchangeable mirrors of the complete file.
export function downloadUrls (value) {
  const urls = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Object.keys(value).length === 6
        ? Array.from({ length: 6 }, (_, index) => value[index])
        : []
  if (![1, 6].includes(urls.length) || urls.some(url => typeof url !== 'string' || !/^https?:\/\//.test(url))) {
    throw Error('MEGA servers returned an invalid download response')
  }
  return urls
}

async function fetchRange (fetch, url, start, end, signal) {
  const response = await fetch(`${url}/${start}-${end}`, { signal })
  if (response.status !== 200) {
    await response.body?.cancel?.()
    if (response.status === 509) {
      const error = Error('Bandwidth limit reached')
      error.timeLimit = response.headers.get('x-mega-time-left')
      throw error
    }
    throw Error(`MEGA returned a ${response.status} status code`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length !== end - start + 1) throw Error('Incomplete MEGA download chunk')
  return buffer
}

export async function downloadRange (fetch, urls, start, end, size, signal) {
  if (urls.length === 1) return fetchRange(fetch, urls[0], start, end, signal)
  signal.throwIfAborted()
  const firstLine = Math.floor(start / 80)
  const lastLine = Math.floor(end / 80)
  const partStart = firstLine * 16
  const controllers = urls.map(() => new AbortController())
  const abort = () => controllers.forEach(controller => controller.abort(signal.reason))
  signal.addEventListener('abort', abort, { once: true })
  const parts = new Array(6)
  try {
    // Any five shards suffice. Stop the sixth as soon as five complete, including
    // when one shard fails. A second failure makes reconstruction impossible.
    await new Promise((resolve, reject) => {
      let completed = 0
      let failed = 0
      let settled = false
      urls.forEach((url, index) => {
        const tail = Math.min(16, Math.max(0, size % 80 - Math.max(0, index - 1) * 16))
        const partSize = Math.floor(size / 80) * 16 + tail
        const partEnd = Math.min(partSize, (lastLine + 1) * 16) - 1
        const request = partEnd < partStart
          ? Promise.resolve(Buffer.alloc(0))
          : fetchRange(fetch, url, partStart, partEnd, controllers[index].signal)
        request.then(buffer => {
          if (settled) return
          parts[index] = buffer
          if (++completed === 5) { settled = true; resolve() }
        }, error => {
          if (!settled && ++failed === 2) { settled = true; reject(error) }
        })
      })
    })
    signal.throwIfAborted()
    const output = Buffer.alloc(end - start + 1)
    for (let position = start; position <= end;) {
      const sector = Math.floor(position / 16)
      const part = sector % 5 + 1
      const offset = Math.floor(sector / 5) * 16 - partStart + position % 16
      const length = Math.min(16 - position % 16, end - position + 1)
      if (parts[part]) {
        parts[part].copy(output, position - start, offset, offset + length)
      } else {
        for (let i = 0; i < 6; i++) {
          if (!parts[i]) continue
          for (let j = 0; j < length; j++) output[position - start + j] ^= parts[i][offset + j] || 0
        }
      }
      position += length
    }
    return output
  } finally {
    signal.removeEventListener('abort', abort)
    controllers.forEach(controller => controller.abort())
  }
}
