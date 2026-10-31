export interface Env {
  DB: D1Database;
  /** Optional until the R2 bucket exists; falls back to D1 blob storage for small files. */
  ASSET_FILES?: R2Bucket;
  ASSETS: Fetcher;
  NOTIFICATIONS: Queue<NotifyMessage>;
  PUBLIC_BASE_URL: string;
  NOTIFICATION_MODE: string;
  NOTIFICATION_WEBHOOK_SECRET?: string;
  MAX_UPLOAD_BYTES?: string;
  RATE_LIMIT_PER_MINUTE?: string;
}

export type NotifyMessage = { creatorId: string; eventType: string; assetId: string; payload: unknown };

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export const now = () => new Date().toISOString();

export async function sha256Hex(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function ipHash(request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256Hex(new TextEncoder().encode(ip).buffer as ArrayBuffer);
}
async function event(env: Env, assetId: string, eventType: string, payload: unknown) {
  await env.DB.prepare("INSERT INTO events(id,asset_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
    .bind(id("evt"), assetId, eventType, JSON.stringify(payload), now()).run();
}

// ---------- limits & validation ----------
const D1_BLOB_LIMIT = 1_000_000; // D1 rows max out near 2 MB; keep fallback blobs small.
const ALLOWED_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};
export function maxUpload(env: Env) {
  const configured = Number(env.MAX_UPLOAD_BYTES || 10_000_000);
  return env.ASSET_FILES ? configured : Math.min(configured, D1_BLOB_LIMIT);
}
/** Returns an error string, or null when the upload is an allowed image within the size limit. */
export async function validateImage(file: File, env: Env): Promise<string | null> {
  if (file.size === 0) return "file is empty";
  if (file.size > maxUpload(env)) return `file too large (max ${maxUpload(env)} bytes)`;
  const sniff = ALLOWED_TYPES[file.type];
  if (!sniff) return `unsupported type; allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!sniff(head)) return "file content does not match its declared image type";
  return null;
}

function isPrivateIPv4(h: string) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
/** SSRF guard: https only, default port, public DNS hostname, no IP literals for private/internal ranges. */
export function validateWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "webhookUrl is not a valid URL"; }
  if (u.protocol !== "https:") return "webhookUrl must use https";
  if (u.port && u.port !== "443") return "webhookUrl must use the default https port";
  if (u.username || u.password) return "webhookUrl must not contain credentials";
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[")) return "webhookUrl must not be an IPv6 literal";
  if (isPrivateIPv4(h)) return "webhookUrl points to a private or reserved address";
  if (/^\d+$/.test(h) || /^0x/i.test(h)) return "webhookUrl host is not allowed";
  if (!h.includes(".") || h === "localhost" || /\.(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(h))
    return "webhookUrl must be a public hostname";
  return null;
}

/** Fixed-window rate limit per IP hash and bucket, stored in D1. Returns true when allowed. */
export async function rateLimit(request: Request, env: Env, bucket: string) {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE || 20);
  const window = Math.floor(Date.now() / 60_000);
  const key = `${bucket}:${await ipHash(request)}:${window}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)
     ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`,
  ).bind(key, window).first<{ count: number }>();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - 5).run();
  return (row?.count ?? 0) <= limit;
}
const tooMany = () => json({ error: "rate limit exceeded; try again in a minute" }, 429, { "retry-after": "60" });

// ---------- storage ----------
async function putMaster(env: Env, key: string, bytes: ArrayBuffer, type: string, meta: Record<string, string>) {
  if (env.ASSET_FILES) {
    await env.ASSET_FILES.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: meta });
  } else {
    await env.DB.prepare("INSERT INTO asset_blobs(key,content_type,data,created_at) VALUES(?,?,?,?)")
      .bind(key, type, bytes, now()).run();
  }
}
async function getMaster(env: Env, key: string): Promise<{ body: BodyInit; type: string; etag?: string } | null> {
  if (env.ASSET_FILES) {
    const obj = await env.ASSET_FILES.get(key);
    if (obj) return { body: obj.body, type: obj.httpMetadata?.contentType || "application/octet-stream", etag: obj.httpEtag };
    // Legacy: masters stored in D1 before R2 was enabled.
  }
  const row = await env.DB.prepare("SELECT content_type,data FROM asset_blobs WHERE key=?").bind(key)
    .first<{ content_type: string; data: number[] | ArrayBuffer }>();
  if (!row) return null;
  const data = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer;
  return { body: data, type: row.content_type };
}

// ---------- handlers ----------
const PUBLIC_FIELDS = `a.id, a.title, c.display_name AS creator_name, a.mime_type, a.c2pa_status, a.license_code,
  a.license_url, a.max_downloads, a.download_count, a.expires_at, a.status, a.created_at`;

export async function register(request: Request, env: Env, afterRegister?: (assetId: string, file: File) => Promise<unknown>) {
  if (!(await rateLimit(request, env, "register"))) return tooMany();
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxUpload(env) + 64_000) return json({ error: `request too large (max ${maxUpload(env)} bytes)` }, 413);
  const form = await request.formData();
  const file = form.get("file") as unknown;
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  const invalid = await validateImage(file, env);
  if (invalid) return json({ error: invalid }, 400);
  const title = String(form.get("title") || file.name).slice(0, 200);
  const creatorName = String(form.get("creator") || "Demo creator").slice(0, 120);
  const creatorEmail = String(form.get("email") || "").slice(0, 200);
  const webhookUrl = String(form.get("webhookUrl") || "").trim();
  if (webhookUrl) {
    const bad = validateWebhookUrl(webhookUrl);
    if (bad) return json({ error: bad }, 400);
  }
  const licenseCode = String(form.get("licenseCode") || "ARR");
  if (!["ARR", "CC-BY-4.0", "COMMERCIAL"].includes(licenseCode)) return json({ error: "unknown licenseCode" }, 400);
  const expiresRaw = String(form.get("expiresAt") || "");
  const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;
  if (expiresRaw && Number.isNaN(Date.parse(expiresRaw))) return json({ error: "invalid expiresAt" }, 400);
  const maxDownloadsRaw = String(form.get("maxDownloads") || "");
  const maxDownloads = maxDownloadsRaw ? Math.max(0, Number.parseInt(maxDownloadsRaw, 10) || 0) : null;

  const bytes = await file.arrayBuffer();
  const digest = await sha256Hex(bytes);
  const existing = await env.DB.prepare("SELECT id FROM assets WHERE sha256=?").bind(digest).first<{ id: string }>();
  if (existing) return json({ error: "asset already registered", assetId: existing.id }, 409);
  const creatorId = id("cr");
  const assetId = id("ast");
  const watermarkId = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const key = `masters/${assetId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100)}`;
  await putMaster(env, key, bytes, file.type, { assetId, watermarkId });
  const verificationUrl = `${env.PUBLIC_BASE_URL}/verify/${assetId}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO creators(id,display_name,email,webhook_url,created_at) VALUES(?,?,?,?,?)")
      .bind(creatorId, creatorName, creatorEmail || null, webhookUrl || null, now()),
    env.DB.prepare(`INSERT INTO assets(id,creator_id,title,r2_key,mime_type,sha256,watermark_id,license_code,license_url,max_downloads,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(assetId, creatorId, title, key, file.type, digest, watermarkId, licenseCode, verificationUrl, maxDownloads, expiresAt, now()),
  ]);
  await event(env, assetId, "asset.registered", { digest, watermarkId });
  let extra: Record<string, unknown> = {};
  if (afterRegister) extra = { postProcessing: await afterRegister(assetId, file) };
  // watermarkId and sha256 are returned once, to the registrant only; they are never exposed by public endpoints.
  return json({
    assetId, watermarkId, sha256: digest, verificationUrl,
    storage: env.ASSET_FILES ? "r2" : "d1-fallback",
    next: "Run scripts/process_asset.py locally to create the watermarked derivative, then sign it with c2patool.",
    ...extra,
  }, 201);
}

export async function recordSighting(request: Request, env: Env, asset: { id: string; creator_id: string }, method: string, confidence: number, source: string, payload: Record<string, unknown> = {}) {
  const sightingId = id("see");
  const country = (request as any).cf?.country || null;
  await env.DB.prepare("INSERT INTO sightings(id,asset_id,method,confidence,source,country_code,ip_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(sightingId, asset.id, method, confidence, source, country, await ipHash(request), now()).run();
  await env.NOTIFICATIONS.send({ creatorId: asset.creator_id, eventType: "asset.sighted", assetId: asset.id, payload: { sightingId, method, confidence, country, ...payload } });
  return sightingId;
}

async function identify(request: Request, env: Env) {
  if (!(await rateLimit(request, env, "identify"))) return tooMany();
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxUpload(env) + 64_000) return json({ error: "request too large" }, 413);
  const form = await request.formData();
  const watermarkId = String(form.get("watermarkId") || "").trim();
  const file = form.get("file") as unknown;
  let asset: { id: string; creator_id: string } | null = null; let method = "";
  if (watermarkId) {
    if (!/^[a-f0-9]{20}$/.test(watermarkId)) return json({ error: "invalid watermarkId format" }, 400);
    asset = await env.DB.prepare("SELECT id, creator_id FROM assets WHERE watermark_id=?").bind(watermarkId).first();
    method = "watermark-id";
  } else if (file instanceof File && file.size > 0) {
    const invalid = await validateImage(file, env);
    if (invalid) return json({ error: invalid }, 400);
    const digest = await sha256Hex(await file.arrayBuffer());
    asset = await env.DB.prepare("SELECT id, creator_id FROM assets WHERE sha256=?").bind(digest).first();
    method = "sha256";
  } else return json({ error: "Provide file or watermarkId" }, 400);
  if (!asset) return json({ matched: false }, 404);
  await recordSighting(request, env, asset, method, 1, "public-identify");
  return json({ matched: true, assetId: asset.id, method, confidence: 1, verificationUrl: `${env.PUBLIC_BASE_URL}/verify/${asset.id}` });
}

async function publicAsset(env: Env, assetId: string) {
  return env.DB.prepare(`SELECT ${PUBLIC_FIELDS} FROM assets a JOIN creators c ON c.id=a.creator_id WHERE a.id=?`).bind(assetId).first<any>();
}
const isExpired = (a: { expires_at?: string | null }) => !!a.expires_at && Date.parse(a.expires_at) <= Date.now();

async function assetInfo(assetId: string, env: Env) {
  const row = await publicAsset(env, assetId);
  if (!row) return json({ error: "not found" }, 404);
  return json({ ...row, effective_status: isExpired(row) ? "expired" : row.status });
}

async function download(assetId: string, request: Request, env: Env) {
  if (!(await rateLimit(request, env, "download"))) return tooMany();
  const a = await env.DB.prepare("SELECT id, r2_key, status, expires_at, max_downloads, download_count FROM assets WHERE id=?").bind(assetId).first<any>();
  if (!a) return json({ error: "not found" }, 404);
  if (a.status !== "active" || isExpired(a)) return json({ error: "license inactive or expired" }, 403);
  if (a.max_downloads !== null && a.download_count >= a.max_downloads) return json({ error: "download limit reached" }, 403);
  // Fetch the object first so a missing file never consumes a download.
  const obj = await getMaster(env, a.r2_key);
  if (!obj) return json({ error: "stored object missing" }, 500);
  const updated = await env.DB.prepare(
    "UPDATE assets SET download_count=download_count+1 WHERE id=? AND (max_downloads IS NULL OR download_count < max_downloads)",
  ).bind(assetId).run();
  if (!updated.meta.changes) {
    if (obj.body instanceof ReadableStream) await obj.body.cancel();
    return json({ error: "download limit reached" }, 403);
  }
  await event(env, assetId, "asset.downloaded", { userAgent: request.headers.get("user-agent") });
  const headers = new Headers({ "content-type": obj.type, "content-disposition": `attachment; filename="${assetId}"`, "cache-control": "no-store" });
  if (obj.etag) headers.set("etag", obj.etag);
  return new Response(obj.body, { headers });
}

async function verificationPage(assetId: string, env: Env) {
  const a = await publicAsset(env, assetId);
  if (!a) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  const expired = isExpired(a);
  const safe = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Asset verification</title><style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:20px;color:#172033}dt{font-weight:700;margin-top:12px}.ok{color:#08783e}.bad{color:#b42318}code{overflow-wrap:anywhere}</style><h1>Digital Asset Passport</h1><p class="${expired ? "bad" : "ok"}"><b>${expired ? "Expired" : "Active"}</b></p><dl><dt>Asset</dt><dd><code>${safe(a.id)}</code></dd><dt>Title</dt><dd>${safe(a.title)}</dd><dt>Creator</dt><dd>${safe(a.creator_name)}</dd><dt>License</dt><dd>${safe(a.license_code)}</dd><dt>C2PA status</dt><dd>${safe(a.c2pa_status)}</dd><dt>Downloads</dt><dd>${safe(a.download_count)} / ${safe(a.max_downloads ?? "unlimited")}</dd><dt>Expires</dt><dd>${safe(a.expires_at ?? "no expiry")}</dd></dl><p><a href="/api/assets/${encodeURIComponent(a.id)}/download">Download licensed copy</a></p></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

export type ExtraRoute = (request: Request, env: Env, url: URL) => Promise<Response | null>;

export function createHandler(opts: { extraRoutes?: ExtraRoute[]; afterRegister?: (env: Env) => ((assetId: string, file: File) => Promise<unknown>) | undefined } = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const u = new URL(request.url); const p = u.pathname.split("/").filter(Boolean);
      try {
        if (request.method === "POST" && u.pathname === "/api/assets") return await register(request, env, opts.afterRegister?.(env));
        if (request.method === "POST" && u.pathname === "/api/identify") return await identify(request, env);
        for (const route of opts.extraRoutes ?? []) { const r = await route(request, env, u); if (r) return r; }
        if (request.method === "GET" && p[0] === "api" && p[1] === "assets" && p[2] && p.length === 3) return await assetInfo(p[2], env);
        if (request.method === "GET" && p[0] === "api" && p[1] === "assets" && p[2] && p[3] === "download" && p.length === 4) return await download(p[2], request, env);
        if (request.method === "GET" && p[0] === "verify" && p[1]) return await verificationPage(p[1], env);
        if (request.method === "GET" && u.pathname === "/api/health") return json({ ok: true, storage: env.ASSET_FILES ? "r2" : "d1-fallback", maxUploadBytes: maxUpload(env) });
        if (p[0] === "api") return json({ error: "not found" }, 404);
        return env.ASSETS.fetch(request);
      } catch (err) {
        console.error("unhandled", err);
        return json({ error: "internal error" }, 500);
      }
    },
    async queue(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
      for (const msg of batch.messages) {
        const creator = await env.DB.prepare("SELECT webhook_url FROM creators WHERE id=?").bind(msg.body.creatorId).first<{ webhook_url: string | null }>();
        if (!creator?.webhook_url || validateWebhookUrl(creator.webhook_url)) { msg.ack(); continue; }
        const body = JSON.stringify({ type: msg.body.eventType, assetId: msg.body.assetId, data: msg.body.payload, sentAt: now() });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (env.NOTIFICATION_WEBHOOK_SECRET) {
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.NOTIFICATION_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
          headers["x-asset-signature"] = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
        }
        try {
          const r = await fetch(creator.webhook_url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
          if (r.ok) msg.ack(); else if (r.status >= 400 && r.status < 500 && r.status !== 429) msg.ack(); else msg.retry();
        } catch { msg.retry(); }
      }
    },
  };
}

export default createHandler();
