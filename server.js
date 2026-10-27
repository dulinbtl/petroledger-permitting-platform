/*
 * PetroLedger — Permitting Business Model server
 *
 * Serves the single-page app (index.html next to this file, or public/index.html) and a small JSON API that saves everything
 * users do to shared storage, so the whole team works from one set of data. No npm packages:
 * plain Node.js (20 or later), so the deployment zip needs no install step.
 *
 *   Saved items (each a JSON document {data, updatedBy, updatedById, updatedAt}):
 *     docs/catalog.json    service catalog, units and tiers
 *     docs/settings.json   economics, engagement discount, team, letterhead
 *     docs/actions.json    action items and assignments
 *     proposals/<id>.json  one document per proposal
 *
 *   Storage:
 *     STORAGE_ACCOUNT_URL set (https://<account>.blob.core.windows.net) → Azure Blob Storage,
 *       signed in with the web app's system-assigned managed identity (no keys or secrets).
 *       BLOB_CONTAINER names the container (default "permitting").
 *     otherwise → JSON files under DATA_DIR (default ./data; /home/data/permitting on App Service).
 *
 *   Identity: App Service built-in authentication (Microsoft Entra ID) signs users in and passes
 *   who they are in X-MS-CLIENT-PRINCIPAL* headers, which outside callers cannot set. Every save
 *   records that person. Off App Service (local testing) the user is LOCAL_USER.
 *
 *   Concurrency: reads return an etag; a save sends the etag it last saw. If someone else saved
 *   in between, the API answers 409 with the current version, and the app asks the user whether
 *   to keep their version or load the other person's.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const ON_APP_SERVICE = !!process.env.WEBSITE_SITE_NAME;
// App Service injects WEBSITE_AUTH_ENABLED when built-in sign-in is on. Without it, the identity headers
// could be forged, so the API refuses to run (TRUST_AUTH_HEADERS=1 overrides, for unusual setups only).
const AUTH_ON = /^true$/i.test(process.env.WEBSITE_AUTH_ENABLED || "") || process.env.TRUST_AUTH_HEADERS === "1";
// The page is index.html in the same folder as server.js; public/index.html is still accepted.
const APP_FILES = [path.join(__dirname, "index.html"), path.join(__dirname, "public", "index.html")];
const appFile = () => APP_FILES.find(f => fs.existsSync(f)) || APP_FILES[0];
const MAX_BODY = 10 * 1024 * 1024; // 10 MB
const DOC_NAMES = ["catalog", "settings", "actions"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ storage */

class ConflictError extends Error {}

/** JSON files on disk. Writes are atomic (temp file + rename) and serialized per key. */
class FileStore {
  constructor(dir) { this.dir = dir; this.locks = new Map(); }
  get kind() { return "file"; }
  get label() { return this.dir; }
  file(key) { return path.join(this.dir, ...key.split("/")); }
  async init() { for (const d of ["docs", "proposals"]) await fsp.mkdir(path.join(this.dir, d), { recursive: true }); }
  etagOf(text) { return '"' + crypto.createHash("sha1").update(text).digest("hex") + '"'; }
  async lock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release; const mine = new Promise(r => (release = r));
    const chain = prev.then(() => mine); this.locks.set(key, chain);
    await prev;
    try { return await fn(); } finally { release(); if (this.locks.get(key) === chain) this.locks.delete(key); }
  }
  async read(key) {
    try { const text = await fsp.readFile(this.file(key), "utf8"); return { body: JSON.parse(text), etag: this.etagOf(text) }; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async list(prefix) { // → [{key, etag, by, at}]
    let names; try { names = await fsp.readdir(this.file(prefix.replace(/\/$/, ""))); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const out = [];
    for (const n of names.filter(f => f.endsWith(".json"))) { const r = await this.read(prefix + n); if (r) out.push({ key: prefix + n, etag: r.etag, by: r.body.updatedBy || "", at: r.body.updatedAt || "" }); }
    return out;
  }
  async write(key, body, ifMatch) {
    return this.lock(key, async () => {
      const cur = await this.read(key);
      if (ifMatch ? (!cur || cur.etag !== ifMatch) : !!cur) throw new ConflictError();
      const text = JSON.stringify(body), tmp = this.file(key) + "." + process.pid + "." + Date.now() + ".tmp";
      await fsp.writeFile(tmp, text, "utf8");
      await fsp.rename(tmp, this.file(key));
      return this.etagOf(text);
    });
  }
  async remove(key, ifMatch) {
    return this.lock(key, async () => {
      const cur = await this.read(key);
      if (!cur) return;
      if (ifMatch && cur.etag !== ifMatch) throw new ConflictError();
      await fsp.unlink(this.file(key));
    });
  }
}

/** Token for the web app's system-assigned managed identity, from App Service's local token endpoint. */
class ManagedIdentity {
  constructor() { this.tok = null; }
  async token() {
    if (this.tok && this.tok.exp - Date.now() > 5 * 60 * 1000) return this.tok.value;
    const ep = process.env.IDENTITY_ENDPOINT, hdr = process.env.IDENTITY_HEADER;
    if (!ep || !hdr) throw new Error("Managed identity is not turned on for this web app (Identity › System assigned › On).");
    const u = new URL(ep); u.searchParams.set("resource", "https://storage.azure.com/"); u.searchParams.set("api-version", "2019-08-01");
    const r = await fetch(u, { headers: { "X-IDENTITY-HEADER": hdr } });
    if (!r.ok) throw new Error("Managed identity token request failed: " + r.status + " " + (await r.text()).slice(0, 300));
    const j = await r.json(), n = Number(j.expires_on);
    this.tok = { value: j.access_token, exp: isFinite(n) ? n * 1000 : (Date.parse(j.expires_on) || Date.now() + 30 * 60 * 1000) };
    return this.tok.value;
  }
}

/** Azure Blob Storage over its REST API, with optimistic concurrency on blob ETags. */
class BlobStore {
  constructor(accountUrl, container) {
    this.base = accountUrl.replace(/\/+$/, "") + "/" + container;
    this.mi = new ManagedIdentity();
  }
  get kind() { return "blob"; }
  get label() { return this.base; }
  url(key) { return this.base + "/" + key.split("/").map(encodeURIComponent).join("/"); }
  async call(method, url, headers = {}, body) {
    const h = Object.assign({ Authorization: "Bearer " + (await this.mi.token()), "x-ms-version": "2023-11-03", "x-ms-date": new Date().toUTCString() }, headers);
    return fetch(url, { method, headers: h, body });
  }
  static async fail(r, what) { const t = await r.text().catch(() => ""); const e = new Error(`Blob storage ${what} failed: ${r.status} ${t.slice(0, 300)}`); e.blobStatus = r.status; return e; }
  async init() {
    const r = await this.call("PUT", this.base + "?restype=container");
    if (r.status === 403) { console.warn("Can't create or check the container (403) — assuming it exists. Give the web app's identity Storage Blob Data Contributor on the storage account."); await r.arrayBuffer().catch(() => {}); return; }
    if (r.status !== 201 && r.status !== 409) throw await BlobStore.fail(r, "create container");
    await r.arrayBuffer().catch(() => {});
  }
  async read(key) {
    const r = await this.call("GET", this.url(key));
    if (r.status === 404) { await r.arrayBuffer().catch(() => {}); return null; }
    if (!r.ok) throw await BlobStore.fail(r, "read " + key);
    return { body: JSON.parse(await r.text()), etag: r.headers.get("etag") };
  }
  async list(prefix) { // → [{key, etag, by, at}]
    const out = []; let marker = "";
    do {
      const u = `${this.base}?restype=container&comp=list&include=metadata&prefix=${encodeURIComponent(prefix)}${marker ? "&marker=" + encodeURIComponent(marker) : ""}`;
      const r = await this.call("GET", u);
      if (!r.ok) throw await BlobStore.fail(r, "list");
      const xml = await r.text();
      for (const b of xml.match(/<Blob>[\s\S]*?<\/Blob>/g) || []) {
        const tag = t => { const m = b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i")); return m ? xmlText(m[1]) : ""; };
        const key = tag("Name"); if (!key.endsWith(".json")) continue;
        out.push({ key, etag: '"' + tag("Etag").replace(/"/g, "") + '"', by: safeDecode(tag("updatedby")), at: safeDecode(tag("updatedat")) });
      }
      const nm = xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/); marker = nm ? xmlText(nm[1]) : "";
    } while (marker);
    return out;
  }
  async write(key, body, ifMatch) {
    const text = JSON.stringify(body);
    const r = await this.call("PUT", this.url(key), Object.assign({
      "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json; charset=utf-8",
      "x-ms-meta-updatedby": encodeURIComponent(body.updatedBy || ""), "x-ms-meta-updatedat": encodeURIComponent(body.updatedAt || ""),
    }, ifMatch ? { "If-Match": ifMatch } : { "If-None-Match": "*" }), text);
    if (r.status === 412 || r.status === 409 || (r.status === 404 && ifMatch)) { await r.arrayBuffer().catch(() => {}); throw new ConflictError(); }
    if (!r.ok) throw await BlobStore.fail(r, "write " + key);
    await r.arrayBuffer().catch(() => {});
    return r.headers.get("etag");
  }
  async remove(key, ifMatch) {
    const r = await this.call("DELETE", this.url(key), ifMatch ? { "If-Match": ifMatch } : {});
    await r.arrayBuffer().catch(() => {});
    if (r.status === 404) return;
    if (r.status === 412) throw new ConflictError();
    if (!r.ok) throw await BlobStore.fail(r, "delete " + key);
  }
}
const xmlText = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const safeDecode = s => { try { return decodeURIComponent(s); } catch (_) { return s; } };

const store = process.env.STORAGE_ACCOUNT_URL
  ? new BlobStore(process.env.STORAGE_ACCOUNT_URL, process.env.BLOB_CONTAINER || "permitting")
  : new FileStore(process.env.DATA_DIR || (ON_APP_SERVICE ? "/home/data/permitting" : path.join(__dirname, "data")));

/* ----------------------------------------------------------------- identity */

function userOf(req) {
  const h = req.headers;
  if (ON_APP_SERVICE) {
    if (!AUTH_ON) return { refused: true };
    const email = h["x-ms-client-principal-name"] || "", id = h["x-ms-client-principal-id"] || "";
    let name = "";
    if (h["x-ms-client-principal"]) {
      try {
        const cp = JSON.parse(Buffer.from(h["x-ms-client-principal"], "base64").toString("utf8"));
        const claim = t => ((cp.claims || []).find(c => c.typ === t) || {}).val;
        name = claim("name") || "";
      } catch (_) { /* use the email */ }
    }
    if (!id && !email) return null;
    return { id: id || email, name: name || email, email };
  }
  // Local testing only: tests may act as different people with a header.
  const test = process.env.ALLOW_TEST_USER === "1" && h["x-test-user"];
  const name = test || process.env.LOCAL_USER || "Local user";
  return { id: name, name, email: "" };
}

/* --------------------------------------------------------------------- http */

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (_) { reject(Object.assign(new Error("Bad JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const out = r => r && { data: r.body.data, etag: r.etag, updatedBy: r.body.updatedBy || "", updatedAt: r.body.updatedAt || "" };
async function mapLimit(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

async function loadState() {
  const docs = {};
  for (const n of DOC_NAMES) docs[n] = out(await store.read("docs/" + n + ".json"));
  const keys = (await store.list("proposals/")).map(x => x.key);
  const proposals = (await mapLimit(keys, 8, k => store.read(k))).filter(Boolean).map(out);
  return { docs, proposals };
}
/** Light check for other people's changes: etags and who saved, no document bodies. */
async function loadVersions() {
  const all = (await store.list("docs/")).concat(await store.list("proposals/"));
  const v = {}; for (const x of all) v[x.key] = { etag: x.etag, by: x.by, at: x.at };
  return v;
}

async function save(res, key, data, etag, user) {
  const body = { data, updatedBy: user.name, updatedById: user.id, updatedAt: new Date().toISOString() };
  try {
    const newEtag = await store.write(key, body, etag || null);
    send(res, 200, { etag: newEtag, updatedBy: body.updatedBy, updatedAt: body.updatedAt });
  } catch (e) {
    if (e instanceof ConflictError) return send(res, 409, { conflict: true, current: out(await store.read(key)) });
    throw e;
  }
}

async function handleApi(req, res, url) {
  const user = userOf(req);
  if (user && user.refused) return send(res, 503, { error: "Microsoft sign-in is not turned on for this web app, so data is locked. Turn on Authentication in the Azure portal." });
  if (!user) return send(res, 401, { error: "Sign in required" });
  const method = req.method, p = url.pathname;
  // Changes must come from the app itself (custom header → browsers block cross-site requests).
  if (method !== "GET" && req.headers["x-pl-client"] !== "1") return send(res, 403, { error: "Missing client header" });

  if (method === "GET" && p === "/api/me") return send(res, 200, { name: user.name, email: user.email, storage: store.kind });
  if (method === "GET" && p === "/api/state") return send(res, 200, Object.assign({ me: { name: user.name, email: user.email }, storage: store.kind, appService: ON_APP_SERVICE }, await loadState()));
  if (method === "GET" && p === "/api/versions") return send(res, 200, await loadVersions());

  let m = p.match(/^\/api\/docs\/([a-z]+)$/);
  if (m && DOC_NAMES.includes(m[1]) && method === "PUT") {
    const b = await readBody(req);
    if (!b || typeof b.data !== "object" || b.data === null) return send(res, 400, { error: "data must be an object" });
    return save(res, "docs/" + m[1] + ".json", b.data, b.etag, user);
  }
  m = p.match(/^\/api\/proposals\/([^/]+)$/);
  if (m) {
    let id; try { id = decodeURIComponent(m[1]); } catch (_) { return send(res, 400, { error: "Bad proposal id" }); }
    if (!ID_RE.test(id)) return send(res, 400, { error: "Bad proposal id" });
    const key = "proposals/" + id + ".json";
    if (method === "PUT") {
      const b = await readBody(req);
      if (!b || typeof b.data !== "object" || b.data === null || String(b.data.id) !== id) return send(res, 400, { error: "data.id must match the URL" });
      return save(res, key, b.data, b.etag, user);
    }
    if (method === "DELETE") {
      try { await store.remove(key, url.searchParams.get("etag") || null); return send(res, 200, { deleted: true }); }
      catch (e) { if (e instanceof ConflictError) return send(res, 409, { conflict: true, current: out(await store.read(key)) }); throw e; }
    }
  }
  return send(res, 404, { error: "Not found" });
}

async function serveApp(req, res, url) {
  if (url.pathname !== "/" && url.pathname !== "/index.html") { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
  const html = await fsp.readFile(appFile());
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
  res.end(req.method === "HEAD" ? undefined : html);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (_) { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("Bad request"); }
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method === "GET" || req.method === "HEAD") return await serveApp(req, res, url);
    res.writeHead(405); res.end();
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, e.stack || e.message);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Server error — the change was not saved. Try again; if it keeps happening, check the web app's log stream." : e.message });
    else res.end();
  }
});

process.on("unhandledRejection", e => console.error(new Date().toISOString(), "unhandled", e));
process.on("uncaughtException", e => console.error(new Date().toISOString(), "uncaught", e));

store.init()
  .then(() => server.listen(PORT, () => console.log(`Permitting Business Model on port ${PORT}; storage ${store.kind} ${store.label}; ${ON_APP_SERVICE ? "App Service sign-in" : "local mode"}`)))
  .catch(e => { console.error("Storage could not be opened:", e.message); process.exit(1); });
