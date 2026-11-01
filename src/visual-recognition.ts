import { type Env, json, rateLimit, tooMany, validateImage, maxUpload, recordSighting } from "./index";

export type VisualFeatureRow = { asset_id: string; feature_json: string };
const TIMEOUT_MS = 15_000;

/** The recognizer is optional: without both URL and secret, visual features are disabled (never a 500). */
export function recognizerConfigured(env: Env) {
  return Boolean(env.RECOGNIZER_URL && env.RECOGNIZER_SECRET);
}

async function callRecognizer(env: Env, path: string, fd: FormData) {
  const r = await fetch(`${env.RECOGNIZER_URL!.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "x-service-secret": env.RECOGNIZER_SECRET! },
    body: fd,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`recognizer ${path} failed: ${r.status}`);
  return r.json<any>();
}

export async function extractAndStore(assetId: string, file: File, env: Env) {
  if (!recognizerConfigured(env)) return { visualFeatures: "disabled" };
  try {
    const fd = new FormData(); fd.set("file", file);
    const feature = await callRecognizer(env, "/extract", fd);
    await env.DB.prepare("INSERT OR REPLACE INTO visual_features(asset_id,feature_json,model_version,created_at) VALUES(?,?,?,?)")
      .bind(assetId, JSON.stringify(feature), String(feature.model ?? "unknown"), new Date().toISOString()).run();
    return { visualFeatures: "stored", model: feature.model };
  } catch (e) {
    // Registration must still succeed if the recognizer is down.
    console.error("visual feature extraction failed", e);
    return { visualFeatures: "failed" };
  }
}

export async function visualIdentify(file: File, env: Env) {
  const rows = await env.DB.prepare("SELECT asset_id,feature_json FROM visual_features LIMIT 200").all<VisualFeatureRow>();
  const candidates = rows.results.map((x) => ({ assetId: x.asset_id, features: JSON.parse(x.feature_json) }));
  if (!candidates.length) return { matched: false, best: null, alternatives: [], reason: "no reference features" };
  const fd = new FormData(); fd.set("file", file); fd.set("candidates", JSON.stringify(candidates));
  return callRecognizer(env, "/match", fd);
}

export async function visualIdentifyRoute(request: Request, env: Env, u: URL): Promise<Response | null> {
  if (u.pathname !== "/api/visual-identify") return null;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!recognizerConfigured(env)) return json({ available: false, error: "visual recognition is not configured" }, 503);
  if (!(await rateLimit(request, env, "visual"))) return tooMany();
  if (Number(request.headers.get("content-length") || 0) > maxUpload(env) + 64_000) return json({ error: "request too large" }, 413);
  const form = await request.formData();
  const file = form.get("file") as unknown;
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);
  const bad = await validateImage(file, env);
  if (bad) return json({ error: bad }, 400);
  let result: any;
  try { result = await visualIdentify(file, env); }
  catch (e) { console.error(e); return json({ available: false, error: "recognizer unavailable" }, 502); }
  const out: Record<string, unknown> = { matched: Boolean(result.matched), model: result.model };
  if (result.matched && result.best?.assetId) {
    const asset = await env.DB.prepare("SELECT id,creator_id FROM assets WHERE id=?").bind(result.best.assetId).first<{ id: string; creator_id: string }>();
    if (asset) {
      await recordSighting(request, env, asset, "visual", result.best.score, "camera-or-upload", { visual: result.best });
      Object.assign(out, { assetId: asset.id, confidence: result.best.score, verificationUrl: `${env.PUBLIC_BASE_URL}/verify/${asset.id}` });
    } else out.matched = false;
  }
  return json(out, out.matched ? 200 : 404);
}
