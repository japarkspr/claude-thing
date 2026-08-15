// Wire format for the Car Thing's Bluetooth SPP link (carthing-knowledge/daemon.md §2),
// verified byte-for-byte against real hardware traffic (id_len marker, field order,
// CRC32 variant) before this was written.
//
// Frame: [1B id_len=36][36B ASCII UUID][2B index BE][2B total BE][4B CRC32 BE (over
// payload only)][2B payload_len BE][payload]. Whole frame is base64'd, one line per
// chunk, newline-terminated. A multi-chunk message reassembles by concatenating
// chunk payloads in index order under one id — the concatenated buffer is then a
// single MsgPack value, not one value per chunk.

import { encode, decode } from '@msgpack/msgpack';
import crc32 from 'buffer-crc32';
import { randomUUID } from 'node:crypto';

export const CHUNK_SIZE = 2000;
const REASSEMBLY_CAP = 256 * 1024;

export function encodeMessage(obj) {
  const payload = Buffer.from(encode(obj));
  const id = randomUUID().toUpperCase();
  const total = Math.max(1, Math.ceil(payload.length / CHUNK_SIZE));
  const lines = [];
  for (let index = 0; index < total; index++) {
    const slice = payload.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const head = Buffer.alloc(1 + 36 + 2 + 2 + 4 + 2);
    let off = 0;
    head.writeUInt8(36, off); off += 1;
    head.write(id, off, 'ascii'); off += 36;
    head.writeUInt16BE(index, off); off += 2;
    head.writeUInt16BE(total, off); off += 2;
    head.writeUInt32BE(crc32.unsigned(slice), off); off += 4;
    head.writeUInt16BE(slice.length, off); off += 2;
    lines.push(Buffer.concat([head, slice]).toString('base64'));
  }
  return lines;
}

// Stateful reassembler: feed() one base64 line (no trailing newline) at a time.
// Returns the decoded object once a message's every chunk has arrived, else null.
export function createReassembler() {
  const pending = new Map(); // id -> {total, chunks: Map<index, Buffer>, bytes}

  function feed(line) {
    if (!line) return null;
    let raw;
    try { raw = Buffer.from(line, 'base64'); } catch { return null; }
    if (raw.length < 1 || raw[0] !== 36) return null; // frame-sync marker, id_len=36='$'

    const idLen = raw[0];
    const id = raw.subarray(1, 1 + idLen).toString('ascii');
    let off = 1 + idLen;
    if (raw.length < off + 10) return null;
    const index = raw.readUInt16BE(off); off += 2;
    const total = raw.readUInt16BE(off); off += 2;
    const expectedCrc = raw.readUInt32BE(off); off += 4;
    const payloadLen = raw.readUInt16BE(off); off += 2;
    const slice = raw.subarray(off, off + payloadLen);
    if (slice.length !== payloadLen) return null;
    if (crc32.unsigned(slice) !== expectedCrc) return null; // drop silently, matches nocturned's no-retransmit reality

    let entry = pending.get(id);
    if (!entry) {
      entry = { total, chunks: new Map(), bytes: 0 };
      pending.set(id, entry);
    }
    if (!entry.chunks.has(index)) {
      entry.bytes += slice.length;
      if (entry.bytes > REASSEMBLY_CAP) { pending.delete(id); return null; }
      entry.chunks.set(index, slice);
    }
    if (entry.chunks.size < entry.total) return null;

    pending.delete(id);
    const full = Buffer.concat(Array.from({ length: entry.total }, (_, i) => entry.chunks.get(i)));
    try {
      return decode(full);
    } catch {
      return null;
    }
  }

  return { feed };
}
