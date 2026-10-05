import test from 'ava'
import { API, File, encrypt } from '../dist/main.node-es.mjs'
import { downloadRange, downloadUrls } from '../lib/download.mjs'
import { stream2promise, testBuffer } from './helpers/test-utils.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const urls = Array.from({ length: 6 }, (_, i) => `https://storage.test/${i}`)

function shards (data) {
  const parts = Array.from({ length: 6 }, () => [])
  for (let start = 0; start < data.length; start += 80) {
    const parity = Buffer.alloc(Math.min(16, data.length - start))
    for (let i = 1; i < 6; i++) {
      const sector = data.subarray(start + (i - 1) * 16, start + i * 16)
      parts[i].push(sector)
      for (let j = 0; j < sector.length; j++) parity[j] ^= sector[j]
    }
    parts[0].push(parity)
  }
  return parts.map(part => Buffer.concat(part))
}

function shardFetch (data, missing = -1, corrupt = false) {
  const parts = shards(data)
  return async (url, { signal }) => {
    const [, part, start, end] = /\/(\d+)\/(\d+)-(\d+)$/.exec(url).map(Number)
    if (part === missing) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const body = Buffer.from(parts[part].subarray(start, end + 1))
    if (corrupt && body.length) body[0] ^= 1
    return new Response(body)
  }
}

test('CloudRAID reconstructs tails and unaligned ranges with any missing shard', async t => {
  for (const size of [1, 15, 16, 17, 63, 79, 80, 81, 97, 159, 233]) {
    const data = testBuffer(size)
    for (let missing = 0; missing < 6; missing++) {
      for (const start of [0, Math.floor(size / 2)]) {
        const output = await downloadRange(shardFetch(data, missing), urls, start, size - 1, size, new AbortController().signal)
        t.is(output.toString('hex'), data.subarray(start).toString('hex'))
      }
    }
  }
})

test('CloudRAID aborts remaining requests when two shards fail', async t => {
  let aborted = 0
  const fetch = async (url, { signal }) => {
    if (url.includes('/0/') || url.includes('/1/')) throw Error('unavailable')
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason) }, { once: true }))
  }
  await t.throwsAsync(downloadRange(fetch, urls, 0, 159, 160, new AbortController().signal), { message: 'unavailable' })
  t.is(aborted, 4)
})

function fileWithFetch (size, fetch, key) {
  const api = new API(false, { fetch })
  api.request = (request, cb) => {
    queueMicrotask(() => cb(null, { s: size, g: request.v === 2 ? urls : 'https://storage.test/file' }))
  }
  return new File({ downloadId: 'synthetic', api, key })
}

test('prefetch replenishes the window after out-of-order chunks and keeps zero increment', async t => {
  const pending = []
  const ranges = []
  const data = testBuffer(320)
  const file = fileWithFetch(data.length, (url, { signal }) => new Promise((resolve, reject) => {
    const [, start, end] = /\/(\d+)-(\d+)$/.exec(url).map(Number)
    ranges.push([start, end])
    pending.push(() => resolve(new Response(data.subarray(start, end + 1))))
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const stream = file.download({ returnCiphertext: true, maxConnections: 3, initialChunkSize: 32, chunkSizeIncrement: 0, maxChunkSize: 256 })
  const result = stream2promise(stream)
  await tick()
  t.is(pending.length, 3)
  pending[1](); pending[2]()
  await tick()
  t.is(pending.length, 3)
  pending[0]()
  await tick()
  t.is(pending.length, 6)
  for (let i = 3; i < 10; i++) { pending[i](); await tick() }
  t.is((await result).toString('hex'), data.toString('hex'))
  t.true(ranges.every(([start, end]) => end - start + 1 === 32))
})

test('download validates CloudRAID plaintext MAC and rejects corruption', async t => {
  const data = testBuffer(200013)
  const encoder = encrypt()
  const encrypted = stream2promise(encoder)
  encoder.end(Buffer.from(data))
  const ciphertext = await encrypted
  const options = { cloudRaid: true, maxConnections: 3, initialChunkSize: 8192, chunkSizeIncrement: 0, maxChunkSize: 8192 }
  t.is((await fileWithFetch(ciphertext.length, shardFetch(ciphertext, 2), encoder.key).downloadBuffer(options)).toString('hex'), data.toString('hex'))
  await t.throwsAsync(fileWithFetch(ciphertext.length, shardFetch(ciphertext, 2, true), encoder.key).downloadBuffer(options), { message: /MAC verification failed/ })
})

test('destroy cancels active chunks and delayed retries', async t => {
  let requests = 0
  let aborted = 0
  let retry
  const file = fileWithFetch(1000, async (url, { signal }) => {
    if (++requests === 1) throw Error('retry me')
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason) }, { once: true }))
  })
  const stream = file.download({
    returnCiphertext: true,
    initialChunkSize: 100,
    chunkSizeIncrement: 0,
    maxConnections: 3,
    handleRetries: (tries, error, callback) => { retry = callback }
  })
  await tick()
  stream.destroy()
  await tick()
  retry(null)
  await tick()
  t.is(requests, 3)
  t.is(aborted, 2)
})

test('truncated chunks retry, exhausted retries fail', async t => {
  let attempts = 0
  const file = fileWithFetch(32, async () => new Response(Buffer.alloc(++attempts === 1 ? 2 : 32)))
  const result = await file.downloadBuffer({
    returnCiphertext: true,
    maxConnections: 2,
    handleRetries: (tries, error, cb) => cb(tries < 2 ? null : error)
  })
  t.is(result.length, 32)
  t.is(attempts, 2)
  await t.throwsAsync(fileWithFetch(32, async () => new Response(Buffer.alloc(2))).downloadBuffer({
    returnCiphertext: true, handleRetries: (tries, error, cb) => cb(error)
  }), { message: 'Incomplete MEGA download chunk' })
})

test('a paused consumer bounds prefetch and resumes without losing chunks', async t => {
  const data = testBuffer(32 * 65536)
  let requests = 0
  const file = fileWithFetch(data.length, async url => {
    requests++
    const [, start, end] = /\/(\d+)-(\d+)$/.exec(url).map(Number)
    return new Response(data.subarray(start, end + 1))
  })
  const stream = file.download({ returnCiphertext: true, maxConnections: 3, initialChunkSize: 65536, chunkSizeIncrement: 0, maxChunkSize: 65536 })
  const output = []
  let paused = false
  stream.on('data', chunk => {
    output.push(Buffer.from(chunk))
    if (!paused) { paused = true; stream.pause() }
  })
  const done = new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  await tick()
  const before = requests
  await tick()
  t.is(requests, before)
  t.true(requests <= 5, 'three prefetched chunks plus the stream buffers')
  stream.resume()
  await done
  t.is(Buffer.concat(output).toString('hex'), data.toString('hex'))
})

test('ticket parsing preserves shard positions and rejects malformed arrays', t => {
  t.deepEqual(downloadUrls(Object.fromEntries(urls.map((url, i) => [i, url]))), urls)
  t.throws(() => downloadUrls(urls.slice(1)))
  t.throws(() => downloadUrls([...urls.slice(0, 5), 'invalid']))
})
