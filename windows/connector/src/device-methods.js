// Methods the device expects the "phone" to answer locally — never forwarded to
// the daemon. Shapes for `ping` and the timezone/time fields reuse exactly what
// carthing-knowledge/ui.md documents and what real hardware already accepted in
// the app.ready handshake (nested `timezone:{timezone,offset}`, sibling
// `datetime`/`time` strings) — the same struct is almost certainly reused here.
// device.info has no confirmed shape yet; kept minimal pending hardware feedback.

export function buildDeviceMethods({ log }) {
  return {
    ping: () => ({ pong: true }),

    'device.info': () => ({ platform: 'web', app: 'claude-thing-windows-connector', version: '0.1.0' }),

    'device.time.get': () => {
      const d = new Date();
      return { datetime: d.toISOString(), time: d.toTimeString().slice(0, 5) };
    },

    'device.timezone.get': () => {
      const d = new Date();
      return {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: -d.getTimezoneOffset(),
      };
    },

    'spotify.auth.getStatus': () => ({
      authenticated: false, skipped: true, needsAuthorization: false, loading: false,
    }),
  };
}

export function appReadyData() {
  const d = new Date();
  return {
    platform: 'web',
    datetime: d.toISOString(),
    time: d.toTimeString().slice(0, 5),
    timezone: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: -d.getTimezoneOffset(),
    },
    spotifySkipped: true,
  };
}
