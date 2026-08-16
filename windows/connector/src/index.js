// Entry point: relays claude.* between the Car Thing (over its Bluetooth SPP
// COM port) and the daemon's ws://127.0.0.1:8790/ws hub. Windows equivalent of
// patches/swift-connector.md's ClaudeRelayService, minus the IOBluetooth layer —
// Windows already exposes the RFCOMM link as a COM port once paired, so this
// only has to speak the chunk/msgpack wire protocol, not raw Bluetooth sockets.

import { openWire } from './wire.js';
import { connectDaemon } from './daemon-link.js';
import { buildDeviceMethods, appReadyData } from './device-methods.js';

// A hint, not a guarantee — Windows can carry live traffic on a different
// "Standard Serial over Bluetooth link" port than this across a re-pair, so
// wire.js races every candidate on each connect rather than trusting it.
const PREFERRED_COM_PORT = process.env.CLAUDE_THING_WIN_COM_PORT || 'COM4';
const DAEMON_URL = process.env.CLAUDE_THING_DAEMON_URL || 'ws://127.0.0.1:8790/ws';

const start = Date.now();
function log(msg) {
  console.log(`[+${String(Date.now() - start).padStart(7)}ms] ${msg}`);
}

const deviceMethods = buildDeviceMethods({ log });
let wireUp = false;
let livePort = null;
let readyReplied = false;

const daemon = connectDaemon(DAEMON_URL, {
  log,
  onEvent: (topic, data) => {
    if (!topic.startsWith('claude.')) return;
    wire.send({ type: 'event', topic, data });
  },
});
daemon.setStatusProvider(() => ({
  connected: wireUp,
  device: wireUp ? 'Car Thing' : undefined,
  address: livePort || PREFERRED_COM_PORT,
}));

const wire = openWire(PREFERRED_COM_PORT, {
  log,
  onOpen: (path) => {
    wireUp = true;
    livePort = path;
    readyReplied = false; // a fresh connect gets a fresh daemon.ready/app.ready round trip
    log(`${path} opened and confirmed live`);
    daemon.pushStatus();
  },
  onError: (err) => {
    wireUp = false;
    log(`link error — ${err.message}`);
    daemon.pushStatus();
  },
  onMessage: (msg) => handleDeviceMessage(msg).catch((err) => log(`handler crashed: ${err.stack}`)),
});

async function handleDeviceMessage(msg) {
  if (msg && msg.type === 'event' && msg.topic === 'daemon.ready') {
    if (!readyReplied) {
      readyReplied = true;
      wire.send({ type: 'event', topic: 'app.ready', data: appReadyData() });
      log('handshake: replied app.ready');
    }
    return;
  }

  if (msg && msg.type === 'call' && typeof msg.method === 'string') {
    const { id, method, params } = msg;
    try {
      let result;
      if (method.startsWith('claude.')) {
        result = await daemon.call(method, params || {});
      } else if (deviceMethods[method]) {
        result = await deviceMethods[method](params || {});
      } else {
        wire.send({ type: 'error', id, error: 'Unknown method' });
        log(`RECV call ${method} -> Unknown method`);
        return;
      }
      wire.send({ type: 'result', id, result });
      log(`RECV call ${method} -> OK`);
    } catch (err) {
      wire.send({ type: 'error', id, error: String(err.message || err) });
      log(`RECV call ${method} -> ERROR ${err.message}`);
    }
    return;
  }

  log(`RECV unhandled: ${JSON.stringify(msg).slice(0, 200)}`);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
