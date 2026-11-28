// Dashboard at http://localhost:8787 (localhost only). It only READS the bot's state; all decisions are in the bot.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export function startServer({ port, dir, getState, onStop }) {
  const page = path.join(dir, "public", "index.html");
  const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const origin = `http://localhost:${port}`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, origin);
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) return send(res, 200, fs.readFileSync(page, "utf8"), "text/html;charset=utf-8");
    if (req.method === "GET" && u.pathname === "/api/state") { try { return send(res, 200, getState()); } catch (e) { return send(res, 500, { error: e.message }); } }
    if (req.method === "POST" && u.pathname === "/api/stop") { // kill switch button: creates the STOP file (blocks new buys)
      if (![origin, `http://127.0.0.1:${port}`].includes(req.headers.origin)) return send(res, 403, { ok: false });
      onStop(); return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}
