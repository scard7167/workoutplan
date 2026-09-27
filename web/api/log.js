// The store of record for the deployed app.
//
// GET  /api/log  -> { ok, data }        the whole document, or null if nothing stored yet
// PUT  /api/log  -> { ok }              replace the document
//
// Backed by Vercel Blob. Until a Blob store is connected to this project the route
// answers { ok: false, reason: "not_configured" } with a 200 - the page then runs on
// localStorage alone and SAYS SO on every screen, rather than pretending to have saved.
// A store that silently is not there is the one failure mode this app cannot have.

const PATH = "strengthlog/state.json";
const MAX_BYTES = 4 * 1024 * 1024;

const send = (res, code, body) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

async function blob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try { return await import("@vercel/blob"); } catch { return null; }
}

export default async function handler(req, res) {
  const b = await blob();
  if (!b) return send(res, 200, { ok: false, reason: "not_configured" });

  try {
    if (req.method === "GET") {
      const { blobs } = await b.list({ prefix: PATH, limit: 1 });
      if (!blobs.length) return send(res, 200, { ok: true, data: null });
      const r = await fetch(`${blobs[0].url}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return send(res, 200, { ok: true, data: null });
      return send(res, 200, { ok: true, data: await r.json() });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req);
      if (body.length > MAX_BYTES) return send(res, 413, { ok: false, reason: "too_large" });
      let doc;
      try { doc = JSON.parse(body); } catch { return send(res, 400, { ok: false, reason: "bad_json" }); }
      if (!doc || typeof doc !== "object") return send(res, 400, { ok: false, reason: "bad_json" });
      await b.put(PATH, JSON.stringify(doc), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 0,
      });
      return send(res, 200, { ok: true });
    }

    res.setHeader("allow", "GET, PUT");
    return send(res, 405, { ok: false, reason: "method" });
  } catch (e) {
    return send(res, 500, { ok: false, reason: String((e && e.message) || e) });
  }
}

function readBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > MAX_BYTES * 2) req.destroy(); });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
