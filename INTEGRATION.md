# Next-layer integration (Phase 2)

> **Status in this repo:** the wiring below is already applied. `src/main.ts` composes the Phase 1 handler
> with `/api/visual-identify` and post-registration feature extraction (`src/visual-recognition.ts`).
> If `RECOGNIZER_URL` or `RECOGNIZER_SECRET` is unset, registration works normally and
> `/api/visual-identify` returns `503 {"available":false}`. The recognizer refuses every request
> (503) when its own `RECOGNIZER_SECRET` is empty. Apply `migrations/0002_visual_features.sql`
> with `npm run db:remote` (already applied to the remote `asset-registry`; additive).
>
> **Hosted recognizer:** the production recognizer is a separate pure-TypeScript Worker,
> [`assetidprotocolrecognizer`](https://github.com/pjrny/AssetIDProtocolRecognizer), at
> `https://assetidprotocolrecognizer.message-0ad.workers.dev` (pHash/dHash grid + HSV, model `ts-phash-grid-v1`).
> It is configured as `RECOGNIZER_URL` in `wrangler.jsonc`, and `RECOGNIZER_SECRET` is set on both Workers.
> The Python/OpenCV service in `recognizer/` remains the higher-accuracy (ORB) option for Containers or another host.
> Feature models are not interchangeable; re-extract features if you switch recognizers.
> The original manual steps are kept below for reference.

This extension adds a visual recognizer for screenshots, crops, phone/webcam photos, and printed items.
It uses complementary signals: pHash, dHash, HSV color histograms, and ORB local keypoints. ORB is the
main crop/perspective signal; the hashes handle close screen captures and resized copies.

## 1. Run the recognizer locally
```powershell
cd recognizer
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
$env:RECOGNIZER_SECRET="replace-this"
uvicorn app:app --reload --port 8080
```
Test `http://127.0.0.1:8080/health`.

## 2. Configure the Worker
Add to `wrangler.jsonc` vars for local testing:
```jsonc
"RECOGNIZER_URL": "http://127.0.0.1:8080"
```
Set the shared secret as a Worker secret:
```powershell
npx wrangler secret put RECOGNIZER_SECRET
```
For local development, add it to `.dev.vars` instead.

## 3. Wire the two calls into `src/index.ts`
Import:
```ts
import { extractAndStore, visualIdentify } from "./visual-recognition";
```
After the asset row is created in `register`, call:
```ts
await extractAndStore(assetId, file, env);
```
Add this route before the static-assets fallback:
```ts
if (request.method === "POST" && u.pathname === "/api/visual-identify") {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({error:"file is required"},400);
  const result:any = await visualIdentify(file,env);
  if (result.matched && result.best?.assetId) {
    const assetId=result.best.assetId;
    const asset=await env.DB.prepare("SELECT creator_id FROM assets WHERE id=?").bind(assetId).first<any>();
    const sightingId=id("see");
    await env.DB.prepare("INSERT INTO sightings(id,asset_id,method,confidence,source,country_code,ip_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(sightingId,assetId,"visual",result.best.score,"camera-or-upload",(request as any).cf?.country||null,await ipHash(request),now()).run();
    if(asset) await env.NOTIFICATIONS.send({creatorId:asset.creator_id,eventType:"asset.sighted",assetId,payload:{sightingId,visual:result.best}});
    result.verificationUrl=`${env.PUBLIC_BASE_URL}/verify/${assetId}`;
  }
  return json(result,result.matched?200:404);
}
```
The existing helper functions `json`, `id`, `ipHash`, and `now` are currently private in `index.ts`, so
put the route directly in that file as shown.

## 4. Apply the schema and open the camera page
```powershell
npm run db:local
npm run dev
```
Open `http://localhost:8787/camera.html`.

## 5. Recognition tests
Use at least 10 registered images and test each with:
- exact screenshot
- 25%, 50%, and 70% crop
- phone photograph of a monitor
- glossy and matte print
- oblique camera angle
- low light and glare
- partial obstruction

Record false positives and false negatives. Tune the acceptance threshold in `recognizer/app.py` against
that corpus rather than lowering it based on one image.

## Production changes
- Run the recognizer behind HTTPS in a private service/container and rotate the shared secret.
- Replace the `LIMIT 200` candidate transfer with a two-stage retrieval system. Use compact image
  embeddings in Vectorize to shortlist candidates, then run ORB/geometric verification on the shortlist.
- Generate multiple reference variants per asset: full image, four quadrants, central crop, and thumbnail.
- Add QR and robust forensic-watermark decoding before visual matching.
- Add file-size/pixel limits, MIME validation, rate limits, authentication, audit retention, and privacy controls.
- Do not report location more precisely than necessary; disclose camera upload and sighting retention.
