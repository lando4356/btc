// Cloudflare Workers / Durable Objects version of managedSocket (same interface as src/ws.mjs).
// Outbound WebSockets in Workers are opened with fetch() + "Upgrade: websocket", which (unlike Node's built-in
// WebSocket) lets us send Kalshi's signed headers. wss:// is written as https:// for fetch.
// Note: outbound sockets cannot hibernate, so the Durable Object stays in memory (and is billed for duration)
// while they are open. See cloudflare/README.md.
export function managedSocketCF(opts) {
  const st = { name: opts.name, connected: false, lastMsg: 0, msgs: 0, reconnects: 0, lastError: null, ws: null, stopped: false };
  let backoff = 1000;
  const wrap = (ws) => ({ send: (o) => { try { ws.send(typeof o === "string" ? o : JSON.stringify(o)); return true; } catch { return false; } }, close: () => { try { ws.close(1000, "bye"); } catch {} } });
  const start = async () => {
    if (st.stopped) return;
    try {
      const headers = { Upgrade: "websocket", ...(opts.headers ? await opts.headers() : {}) };
      const resp = await fetch(opts.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), { headers });
      const ws = resp.webSocket;
      if (!ws) { st.lastError = `upgrade failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`; return schedule(); }
      ws.accept();
      const w = wrap(ws); st.ws = w; st.connected = true; st.lastMsg = Date.now(); backoff = 1000;
      ws.addEventListener("message", (e) => {
        st.lastMsg = Date.now(); st.msgs++;
        const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
        try { opts.onMessage(text, w); } catch (err) { st.lastError = "parse: " + err.message; }
      });
      const down = (why) => { if (st.ws !== w) return; st.connected = false; st.ws = null; if (why) st.lastError = why; schedule(); };
      ws.addEventListener("close", (e) => down(e.code !== 1000 ? `closed ${e.code}` : null));
      ws.addEventListener("error", (e) => down(String(e.message || "socket error")));
      try { opts.onOpen && opts.onOpen(w); } catch (e) { st.lastError = e.message; }
    } catch (e) { st.lastError = String(e.message || e); schedule(); }
  };
  const schedule = () => { if (st.stopped) return; st.reconnects++; setTimeout(start, backoff); backoff = Math.min(backoff * 2, 30000); };
  const staleTimer = setInterval(() => {
    if (st.ws && st.connected && Date.now() - st.lastMsg > (opts.staleMs || 30000)) { st.lastError = "stale, reconnecting"; const w = st.ws; st.ws = null; st.connected = false; w.close(); schedule(); }
  }, Math.min(opts.staleMs || 30000, 10000));
  start();
  st.stop = () => { st.stopped = true; clearInterval(staleTimer); try { st.ws && st.ws.close(); } catch {} };
  st.send = (o) => (st.ws ? st.ws.send(o) : false);
  return st;
}
