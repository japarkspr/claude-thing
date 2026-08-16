// Newline-delimited base64 chunk transport over a Bluetooth SPP virtual COM port.
// Windows auto-creates this COM port once the Car Thing is paired (Settings >
// Bluetooth > device > "Standard Serial over Bluetooth link") — no raw RFCOMM
// socket code needed, unlike the Mac connector's IOBluetooth path.
//
// The underlying Bluetooth link can drop mid-session (radio hiccup, device out
// of range) and Windows surfaces that as a hard I/O error on the port, not a
// clean close — observed in practice as GetOverlappedResult "Unknown error
// code 23" (ERROR_CRC) after 80+ minutes connected. serialport does not retry
// on its own, so this does, with the same backoff shape as daemon-link.js.

import { SerialPort } from 'serialport';
import { encodeMessage, createReassembler } from './chunk-codec.js';

const MAX_BACKOFF_MS = 30_000;

export function openWire(path, { onMessage, onOpen, onError, log }) {
  let port = null;
  let reassembler = createReassembler();
  let buf = '';
  let attempts = 0;
  let closing = false;
  let downSignaled = false;

  function scheduleReconnect(err) {
    if (!downSignaled) {
      downSignaled = true;
      onError?.(err);
    }
    if (closing) return;
    attempts += 1;
    const delay = Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    log?.(`${path} down (${err.message}), retrying in ${delay}ms`);
    setTimeout(open, delay);
  }

  function open() {
    if (closing) return;
    buf = '';
    reassembler = createReassembler(); // a message in flight across a dropped link can't be completed anyway
    const p = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    port = p;

    p.open((err) => {
      if (err) { scheduleReconnect(err); return; }
      attempts = 0;
      downSignaled = false;
      onOpen?.();
    });

    p.on('data', (data) => {
      buf += data.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = reassembler.feed(line);
        } catch (e) {
          log?.(`frame error: ${e.message}`);
          continue;
        }
        if (msg) onMessage(msg);
      }
    });

    // 'error' and 'close' can both fire for the same underlying failure;
    // downSignaled + closing above collapse that into one reconnect attempt.
    p.on('error', (err) => { p.close(() => {}); scheduleReconnect(err); });
    p.on('close', () => { if (!closing) scheduleReconnect(new Error('port closed unexpectedly')); });
  }

  open();

  function send(obj) {
    if (!port || !port.isOpen) return; // dropped mid-reconnect; next daemon event/poll resends
    const lines = encodeMessage(obj);
    for (const line of lines) port.write(line + '\n');
  }

  return { send, close: () => { closing = true; port?.close(() => {}); } };
}
