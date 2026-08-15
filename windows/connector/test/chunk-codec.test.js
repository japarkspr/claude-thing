import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, createReassembler, CHUNK_SIZE } from '../src/chunk-codec.js';

test('round-trips a small message through one chunk', () => {
  const lines = encodeMessage({ type: 'event', topic: 'app.ready', data: { platform: 'web' } });
  assert.equal(lines.length, 1);
  const r = createReassembler();
  assert.deepEqual(r.feed(lines[0]), { type: 'event', topic: 'app.ready', data: { platform: 'web' } });
});

test('splits a large payload across multiple chunks and reassembles in order', () => {
  const big = { type: 'event', topic: 'claude.sessions.update', data: { blob: 'x'.repeat(CHUNK_SIZE * 3) } };
  const lines = encodeMessage(big);
  assert.ok(lines.length > 1, 'expected more than one chunk for a payload this size');
  const r = createReassembler();
  let result = null;
  for (const line of lines) {
    const out = r.feed(line);
    if (out) result = out;
  }
  assert.deepEqual(result, big);
});

test('reassembles out-of-order chunks', () => {
  const big = { data: 'y'.repeat(CHUNK_SIZE * 2) };
  const lines = encodeMessage(big);
  assert.ok(lines.length >= 2);
  const r = createReassembler();
  const shuffled = [...lines].reverse();
  let result = null;
  for (const line of shuffled) {
    const out = r.feed(line);
    if (out) result = out;
  }
  assert.deepEqual(result, big);
});

test('ignores a line without the frame-sync marker instead of throwing', () => {
  const r = createReassembler();
  assert.doesNotThrow(() => assert.equal(r.feed(Buffer.from('not a frame').toString('base64')), null));
});

test('drops a chunk whose CRC does not match instead of reassembling garbage', () => {
  const lines = encodeMessage({ hello: 'world' });
  const raw = Buffer.from(lines[0], 'base64');
  raw[raw.length - 1] ^= 0xff; // corrupt the last payload byte, CRC now stale
  const corrupted = raw.toString('base64');
  const r = createReassembler();
  assert.equal(r.feed(corrupted), null);
});

test('decodes a real single-chunk frame captured from hardware', () => {
  // Captured verbatim off the Car Thing's Bluetooth SPP link during the
  // daemon.ready handshake — CRC32 was verified against this exact frame
  // before any of this module's code was written.
  const captured = 'JEY0NUMzREVDLUEyRUEtNDc1OC1BMjBELUY1QjNEMENDMUMxRQAAAAGHWHb9ACWDpHR5cGWlZXZlbnSldG9waWOsZGFlbW9uLnJlYWR5pGRhdGGA';
  const r = createReassembler();
  assert.deepEqual(r.feed(captured), { type: 'event', topic: 'daemon.ready', data: {} });
});
