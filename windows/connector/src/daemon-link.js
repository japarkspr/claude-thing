// WebSocket client of the daemon's hub (daemon/src/hub.js), same role a Mac
// Nocturne.app plays via patches/swift-connector.md's ClaudeRelayService — a
// client of role "connector", not a server. protocol/claude-protocol.md is the
// wire contract; this mirrors it exactly (json request/response/event, not the
// device-side msgpack call/result/event envelope translated in index.js).

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export function connectDaemon(url, { onEvent, log }) {
  let ws = null;
  let attempts = 0;
  let statusTimer = null;
  const pending = new Map(); // id -> {resolve, reject}
  let connected = false;
  let statusProvider = () => ({});

  function send(frame) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!connected) return reject(new Error('daemon unreachable'));
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      send({ type: 'request', id, method, params });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('timeout'));
      }, 30_000);
    });
  }

  function pushStatus() {
    if (!connected) return;
    send({ type: 'request', id: randomUUID(), method: 'bridge.status', params: { bt: statusProvider() } });
  }

  function scheduleReconnect() {
    connected = false;
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    for (const { reject } of pending.values()) reject(new Error('daemon link dropped'));
    pending.clear();
    attempts += 1;
    const delay = Math.min(1000 * 2 ** (attempts - 1), 30_000);
    log?.(`daemon link down, retrying in ${delay}ms`);
    setTimeout(connect, delay);
  }

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => {
      log?.('daemon link up');
      send({
        type: 'request', id: 'hello-connector', method: 'bridge.hello',
        params: { role: 'connector', info: { app: 'claude-thing-windows-connector', version: '0.1.0' } },
      });
      connected = true;
      attempts = 0;
      pushStatus();
      statusTimer = setInterval(pushStatus, 10_000);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.type === 'event') {
        onEvent?.(msg.topic, msg.data);
        return;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.type === 'response') waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || 'error'));
    });
    ws.on('close', scheduleReconnect);
    ws.on('error', () => {}); // 'close' follows; avoid the unhandled-error crash path
  }

  connect();

  return {
    call,
    setStatusProvider: (fn) => { statusProvider = fn; },
    isConnected: () => connected,
  };
}
