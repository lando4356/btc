// Minimal, dependency-free WebSocket client (RFC 6455) for Node 18+.
// Why not the built-in WebSocket? Kalshi needs signed headers on the handshake, and Node's global WebSocket
// (Node 22+) has no supported way to send them. This client supports custom headers, text/binary frames,
// fragmentation, ping/pong and close. No compression is negotiated.
import tls from "node:tls";
import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeFrame(payload, opcode = 1, mask = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, out]);
}

// Parses as many complete frames as possible from buf. Returns { frames, rest }.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let key = null;
    if (masked) { if (buf.length - p < 4) break; key = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (key) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ key[i & 3]; payload = o; }
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export class WSClient extends EventEmitter {
  constructor(url, { headers = {}, timeoutMs = 10000 } = {}) {
    super();
    this.url = new URL(url);
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.open = false;
    this.buf = Buffer.alloc(0);
    this.frag = null;
  }
  connect() {
    const u = this.url, secure = u.protocol === "wss:";
    const port = Number(u.port) || (secure ? 443 : 80);
    const key = crypto.randomBytes(16).toString("base64");
    const onConnect = () => {
      const lines = [
        `GET ${u.pathname || "/"}${u.search || ""} HTTP/1.1`, `Host: ${u.host}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "User-Agent: kalshi-bot-v48",
        ...Object.entries(this.headers).map(([k, v]) => `${k}: ${v}`),
      ];
      this.sock.write(lines.join("\r\n") + "\r\n\r\n");
    };
    this.sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }, onConnect) : net.connect({ host: u.hostname, port }, onConnect);
    this.sock.setNoDelay(true);
    const timer = setTimeout(() => this._fail(new Error("handshake timeout")), this.timeoutMs);
    let handshake = true, hbuf = Buffer.alloc(0);
    this.sock.on("data", (chunk) => {
      if (handshake) {
        hbuf = Buffer.concat([hbuf, chunk]);
        const end = hbuf.indexOf("\r\n\r\n");
        if (end < 0) { if (hbuf.length > 65536) this._fail(new Error("bad handshake")); return; }
        const head = hbuf.subarray(0, end).toString();
        const status = Number(head.split(" ")[1]);
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        const want = crypto.createHash("sha1").update(key + GUID).digest("base64");
        clearTimeout(timer);
        if (status !== 101 || accept !== want) {
          const err = new Error(`handshake failed: HTTP ${status}`); err.status = status; err.body = hbuf.subarray(end + 4).toString().slice(0, 300);
          return this._fail(err);
        }
        handshake = false; this.open = true;
        this.emit("open");
        chunk = hbuf.subarray(end + 4);
        if (!chunk.length) return;
      }
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      const { frames, rest } = decodeFrames(this.buf);
      this.buf = Buffer.from(rest);
      for (const f of frames) this._frame(f);
    });
    this.sock.on("error", (e) => this._fail(e));
    this.sock.on("close", () => { clearTimeout(timer); const was = this.open || true; this.open = false; if (was && !this.closedEmitted) { this.closedEmitted = true; this.emit("close"); } });
    return this;
  }
  _frame({ fin, opcode, payload }) {
    if (opcode === 9) { this._raw(encodeFrame(payload, 10)); return; } // ping -> pong
    if (opcode === 10) { this.emit("pong"); return; }
    if (opcode === 8) { try { this._raw(encodeFrame(payload.subarray(0, 2), 8)); } catch {} this.sock.end(); return; }
    if (opcode === 0) { if (!this.frag) return; this.frag.parts.push(payload); }
    else this.frag = { opcode, parts: [payload] };
    if (!fin) return;
    const data = Buffer.concat(this.frag.parts), op = this.frag.opcode;
    this.frag = null;
    this.emit("message", op === 1 ? data.toString("utf8") : data);
  }
  _raw(b) { if (this.sock && !this.sock.destroyed) this.sock.write(b); }
  send(obj) { if (!this.open) return false; this._raw(encodeFrame(typeof obj === "string" ? obj : JSON.stringify(obj), 1)); return true; }
  ping() { if (this.open) this._raw(encodeFrame(Buffer.alloc(0), 9)); }
  close() { try { if (this.open) this._raw(encodeFrame(Buffer.from([0x03, 0xe8]), 8)); } catch {} try { this.sock.destroy(); } catch {} }
  _fail(e) { this.emit("error", e); try { this.sock.destroy(); } catch {} }
}

// A WebSocket that reconnects by itself with backoff, and reconnects if nothing arrives for staleMs.
// opts: { name, url, headers()?, onOpen(ws), onMessage(text, ws), staleMs, log }
export function managedSocket(opts) {
  const st = { name: opts.name, connected: false, lastMsg: 0, msgs: 0, reconnects: 0, lastError: null, ws: null, stopped: false };
  let backoff = 1000, staleTimer = null;
  const start = () => {
    if (st.stopped) return;
    let ws;
    Promise.resolve(opts.headers ? opts.headers() : {}).then((headers) => {
    try { ws = new WSClient(opts.url, { headers }).connect(); }
    catch (e) { st.lastError = String(e.message || e); return schedule(); }
    st.ws = ws;
    ws.on("open", () => { st.connected = true; st.lastMsg = Date.now(); backoff = 1000; try { opts.onOpen && opts.onOpen(ws); } catch (e) { st.lastError = e.message; } });
    ws.on("message", (m) => { st.lastMsg = Date.now(); st.msgs++; try { opts.onMessage(m, ws); } catch (e) { st.lastError = "parse: " + e.message; } });
    ws.on("error", (e) => { st.lastError = String(e.message || e) + (e.body ? " " + e.body : ""); });
    ws.on("close", () => { st.connected = false; if (st.ws === ws) { st.ws = null; schedule(); } });
    }, (e) => { st.lastError = "headers: " + (e.message || e); schedule(); });
  };
  const schedule = () => { if (st.stopped) return; st.reconnects++; setTimeout(start, backoff); backoff = Math.min(backoff * 2, 30000); };
  staleTimer = setInterval(() => {
    if (st.ws && st.connected && Date.now() - st.lastMsg > (opts.staleMs || 30000)) { st.lastError = "stale, reconnecting"; st.ws.close(); }
    else if (st.ws && st.connected && opts.pingMs) st.ws.ping();
  }, Math.min(opts.staleMs || 30000, 10000));
  staleTimer.unref?.();
  start();
  st.stop = () => { st.stopped = true; clearInterval(staleTimer); try { st.ws && st.ws.close(); } catch {} };
  st.send = (o) => (st.ws ? st.ws.send(o) : false);
  return st;
}
