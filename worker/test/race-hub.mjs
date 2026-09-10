// The Durable Object that fans a write out to everyone watching a race.
//
// It cannot be deployed from here, so this drives the class directly with
// stand-ins for the two things Cloudflare provides: WebSocketPair, and the
// state object's hibernation API. That is enough to hold the properties that
// matter, which are all about what happens when a socket misbehaves.
//
//   node worker/test/race-hub.mjs
import { RaceHub } from '../src/race-hub.js';

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

function fakeSocket(behaviour) {
  return {
    got: [], closed: null,
    send(t) { if (behaviour === 'throws') throw new Error('gone'); this.got.push(t); },
    close(code, reason) { this.closed = { code, reason }; }
  };
}

function fakeState() {
  const sockets = [];
  return {
    sockets,
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets; }
  };
}

// Node's Response refuses a 101, which is the whole point of a websocket
// handshake and is perfectly legal in a Worker. Allowed here so the upgrade
// path can be exercised at all.
const NodeResponse = globalThis.Response;
globalThis.Response = class extends NodeResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { get: () => 101 });
      this.webSocket = init.webSocket || (init && init.webSocket) || null;
      return;
    }
    super(body, init);
  }
};

globalThis.WebSocketPair = function () {
  const client = fakeSocket(), server = fakeSocket();
  return { 0: client, 1: server };
};

const publish = (hub, body) => hub.fetch(new Request('https://race-hub/publish', {
  method: 'POST', body: JSON.stringify(body)
}));

console.log('\na write reaches everybody watching');
let state = fakeState();
let hub = new RaceHub(state, {});
for (let i = 0; i < 3; i++) state.acceptWebSocket(fakeSocket());
let res = await publish(hub, { type: 'changed', slug: 'r1', at: '2026-09-26T12:00:00.000Z' });
ok('every socket is told', await res.json(), { sent: 3 });
ok('and told the same thing', state.sockets.map(s => JSON.parse(s.got[0]).type),
   ['changed', 'changed', 'changed']);
ok('which says only that it changed, not what',
   Object.keys(JSON.parse(state.sockets[0].got[0])).sort(), ['at', 'slug', 'type']);

console.log('\none dead socket does not silence the others');
state = fakeState();
hub = new RaceHub(state, {});
const good1 = fakeSocket(), dead = fakeSocket('throws'), good2 = fakeSocket();
[good1, dead, good2].forEach(s => state.acceptWebSocket(s));
res = await publish(hub, { type: 'changed' });
ok('the live ones still hear it', await res.json(), { sent: 2 });
ok('and the dead one is closed rather than left', !!dead.closed, true);

console.log('\nnobody watching');
state = fakeState();
hub = new RaceHub(state, {});
ok('is not an error', (await (await publish(hub, { type: 'changed' })).json()), { sent: 0 });

console.log('\nan upgrade is accepted for hibernation');
state = fakeState();
hub = new RaceHub(state, {});
res = await hub.fetch(new Request('https://race-hub/', { headers: { Upgrade: 'websocket' } }));
ok('the handshake is answered', res.status, 101);
ok('and the socket is held by the object', state.sockets.length, 1);

console.log('\nand a plain request is not mistaken for one');
res = await hub.fetch(new Request('https://race-hub/'));
ok('it is refused', res.status, 426);
ok('without adding a socket', state.sockets.length, 1);

console.log('\nwhat a watcher sends is ignored');
ok('a message costs nothing to handle', hub.webSocketMessage(fakeSocket(), 'hello'), undefined);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
