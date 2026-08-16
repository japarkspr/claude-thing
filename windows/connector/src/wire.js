// Newline-delimited base64 chunk transport over a Bluetooth SPP virtual COM port.
// Windows auto-creates one of these per SPP registration once the Car Thing is
// paired (Settings > Bluetooth > device > "Standard Serial over Bluetooth
// link") — no raw RFCOMM socket code needed, unlike the Mac connector's
// IOBluetooth path.
//
// Two ports normally show up for one paired Car Thing, and Windows does not
// promise the same one carries live traffic across a fresh pairing — observed
// directly: COM4 carried it for hours, then a routine unpair/re-pair (done to
// recover from an unrelated stuck link) swapped it to COM3, with COM4
// continuing to open without error but never receiving anything. So this
// doesn't trust a single path: every connect listens to every
// "Standard Serial over Bluetooth link" port at once and keeps whichever one
// actually produces a decodable frame, closing the rest.
//
// The underlying Bluetooth link can also drop mid-session (radio hiccup,
// device out of range) and Windows surfaces that as a hard I/O error on the
// port, not a clean close — observed as GetOverlappedResult "Unknown error
// code 23" (ERROR_CRC) after 80+ minutes connected. serialport does not retry
// on its own, so this does, with the same backoff shape as daemon-link.js —
// and re-runs the multi-port race on every reconnect rather than assuming
// whichever port was live last time still is.

import { SerialPort } from 'serialport';
import { encodeMessage, createReassembler } from './chunk-codec.js';

const MAX_BACKOFF_MS = 30_000;
const DETECT_WINDOW_MS = 8000; // daemon.ready repeats every ~3s; two cycles of margin

// Pure filter, split out from the SerialPort.list() I/O call below so it's
// unit-testable without a real serial port: prefer ports that look like
// Bluetooth SPP links (Windows' non-localized BTHENUM enumerator prefix, or a
// friendlyName mentioning Bluetooth), falling back to every listed port if
// none match rather than finding zero candidates.
export function filterBluetoothPorts(ports, preferredPath) {
  const bt = ports.filter((p) =>
    (p.pnpId && p.pnpId.toUpperCase().startsWith('BTHENUM')) ||
    (p.friendlyName && /bluetooth/i.test(p.friendlyName)));
  const paths = (bt.length ? bt : ports).map((p) => p.path);
  // preferredPath first, whether or not SerialPort.list() reported it — no
  // functional difference in a race, just makes the common case's log read first.
  const rest = paths.filter((p) => p !== preferredPath);
  return [preferredPath, ...rest];
}

async function candidatePorts(preferredPath) {
  let ports;
  try {
    ports = await SerialPort.list();
  } catch {
    return [preferredPath];
  }
  return filterBluetoothPorts(ports, preferredPath);
}

// Races every candidate; resolves with the port that produced the first frame
// the chunk codec actually accepts (garbage/noise on an unrelated COM port
// won't pass CRC, so a successful decode is a real liveness signal, not just
// "bytes arrived"). Losers are closed; the winner and its already-decoded
// first message are handed to the caller so nothing it sent during the race
// is lost.
function raceForLivePort(paths, log) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const attempts = paths.map((path) => {
      const p = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      const reassembler = createReassembler();
      let buf = '';
      p.open((err) => { if (err) log?.(`probe ${path}: ${err.message}`); });
      p.on('data', (data) => {
        if (settled) return;
        buf += data.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || settled) continue;
          let msg;
          try { msg = reassembler.feed(line); } catch { continue; }
          if (msg) {
            settled = true;
            log?.(`${path} is the live link`);
            for (const other of attempts) if (other.path !== path) other.port.close(() => {});
            resolve({ path, port: p, firstMessage: msg });
          }
        }
      });
      p.on('error', () => {}); // a losing candidate erroring mid-race is expected, not fatal
      return { path, port: p };
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      for (const a of attempts) a.port.close(() => {});
      reject(new Error(`no live traffic on any of ${paths.join(', ')} within ${DETECT_WINDOW_MS}ms`));
    }, DETECT_WINDOW_MS);
  });
}

export function openWire(preferredPath, { onMessage, onOpen, onError, log }) {
  let port = null;
  let attempts = 0;
  let closing = false;
  let downSignaled = false;
  let reconnectScheduled = false;

  function scheduleReconnect(err) {
    if (!downSignaled) {
      downSignaled = true;
      onError?.(err);
    }
    if (closing || reconnectScheduled) return;
    reconnectScheduled = true;
    attempts += 1;
    const delay = Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    log?.(`link down (${err.message}), retrying in ${delay}ms`);
    setTimeout(connect, delay);
  }

  async function connect() {
    reconnectScheduled = false;
    if (closing) return;
    let paths;
    try {
      paths = await candidatePorts(preferredPath);
    } catch (e) {
      scheduleReconnect(e);
      return;
    }
    let winner;
    try {
      winner = await raceForLivePort(paths, log);
    } catch (e) {
      scheduleReconnect(e);
      return;
    }
    if (closing) { winner.port.close(() => {}); return; }

    port = winner.port;
    attempts = 0;
    downSignaled = false;
    onOpen?.(winner.path);
    onMessage(winner.firstMessage);

    // Live handling takes over from here — a fresh reassembler/buffer, since
    // the detection-phase one's state (if any partial chunk was mid-flight)
    // isn't worth carrying forward across the handoff.
    const reassembler = createReassembler();
    let buf = '';
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
    port.on('error', (err) => { port.close(() => {}); scheduleReconnect(err); });
    port.on('close', () => { if (!closing) scheduleReconnect(new Error('port closed unexpectedly')); });
  }

  connect();

  function send(obj) {
    if (!port || !port.isOpen) return; // dropped mid-reconnect; next daemon event/poll resends
    const lines = encodeMessage(obj);
    for (const line of lines) port.write(line + '\n');
  }

  return { send, close: () => { closing = true; port?.close(() => {}); } };
}
