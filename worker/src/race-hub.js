// One Durable Object per race: the thing that lets a write reach the people
// watching, instead of them all asking on a timer.
//
// A Worker is stateless and disposable. Forty people watching one race hold
// forty sockets on forty different machines, and the Worker handling the
// crew's press has no way to reach any of them. A Durable Object is the
// exception: a single named instance, unique worldwide. Name it after the race
// and every socket for that race lands on the same object, so there is one
// place that knows who is watching.
//
// Two things keep it cheap, and both come straight from how Cloudflare bills:
//
//   Outgoing WebSocket messages are free. The fan-out, which is the whole
//   point, costs nothing. Cost scales with how many people connect, not with
//   how long they watch, which is the opposite of polling.
//
//   Hibernation lets the object be evicted from memory while its sockets stay
//   open, and wake when something arrives. A race is quiet for forty minutes
//   between aid stations, so almost all of the time it is asleep.
//
// The watchers never send anything. That is deliberate: incoming messages are
// billed (at 20:1) and there is nothing a watcher needs to say.
export class RaceHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // The Worker telling this race that something changed. Not public: only
    // reachable through the binding, which only the Worker holds.
    if (url.pathname === '/publish') {
      let body = '';
      try { body = await req.text(); } catch (e) { body = ''; }
      const n = this.broadcast(body || '{}');
      return new Response(JSON.stringify({ sent: n }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected a websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    // acceptWebSocket, not accept: this is what lets the object hibernate and
    // still hold the connection.
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Every socket this race is holding. A send can throw on one that has gone
  // away without saying so, which must not stop the rest being told.
  broadcast(text) {
    let sent = 0;
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(text); sent++; }
      catch (e) { try { ws.close(1011, 'send failed'); } catch (e2) {} }
    }
    return sent;
  }

  // Hibernation handlers. A watcher has nothing to say, so anything arriving
  // is ignored rather than parsed: the cheapest thing to do with a message
  // that should not exist is nothing.
  webSocketMessage() {}
  webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (e) {}
  }
  webSocketError() {}
}
