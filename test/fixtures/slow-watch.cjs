/* Makes fs.watch block for EASEL_TEST_WATCH_BLOCK_MS, standing in for the slow
   directory that once delayed the daemon's bind. Loaded with --require. */
const fs = require('fs')

const blockMs = Number(process.env.EASEL_TEST_WATCH_BLOCK_MS || 0)
const original = fs.watch

fs.watch = function (...args) {
  if (blockMs > 0) {
    const until = Date.now() + blockMs
    while (Date.now() < until) { /* synchronous, exactly as a stuck fs.watch is */ }
  }
  return original.apply(this, args)
}
