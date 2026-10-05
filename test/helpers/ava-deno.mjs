// Ava compatibility layer for Deno
/* global Deno */

import { assert, assertEquals, assertStrictEquals, assertThrows, assertRejects } from 'jsr:@std/assert'
import { Buffer } from 'node:buffer'

const testContext = {
  assert,
  is: assertStrictEquals,
  deepEqual: assertEquals,
  falsy: value => assert(!value),
  true: value => assert(value === true),
  throwsAsync: async (operation, condition = {}) => {
    const error = await assertRejects(typeof operation === 'function' ? operation : () => operation)
    if (condition.message instanceof RegExp) assert(condition.message.test(error.message))
    else if (condition.message !== undefined) assertEquals(error.message, condition.message)
    return error
  },
  throws: (fn, condition = {}) => {
    return assertThrows(fn, condition.instanceof, condition.message)
  }
}

function test (name, fn, denoOpts = {}) {
  Deno.test({
    name,
    fn: () => fn(testContext),
    // Disable sanitizers as those throw up because of the shared Storage instance
    sanitizeResources: false,
    sanitizeOps: false,
    ...denoOpts
  })
}

// Does nothing: Deno by default runs tests in serial
test.serial = test

test.skip = test.serial.skip = (name, fn, denoOpts = {}) => {
  Deno.test({
    name,
    fn,
    ignore: true,
    ...denoOpts
  })
}

globalThis.Buffer = Buffer
export default test
