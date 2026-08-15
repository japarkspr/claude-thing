// Newline-delimited base64 chunk transport over a Bluetooth SPP virtual COM port.
// Windows auto-creates this COM port once the Car Thing is paired (Settings >
// Bluetooth > device > "Standard Serial over Bluetooth link") — no raw RFCOMM
// socket code needed, unlike the Mac connector's IOBluetooth path.

import { SerialPort } from 'serialport';
import { encodeMessage, createReassembler } from './chunk-codec.js';

export function openWire(path, { onMessage, onOpen, onError, log }) {
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  const reassembler = createReassembler();
  let buf = '';

  port.open((err) => {
    if (err) { onError?.(err); return; }
    onOpen?.();
  });

  port.on('data', (data) => {
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

  port.on('error', (err) => onError?.(err));

  function send(obj) {
    const lines = encodeMessage(obj);
    for (const line of lines) port.write(line + '\n');
  }

  return { port, send };
}
