# AssetIDProtocol User Guide

Live service: **https://assetidprotocol.message-0ad.workers.dev**

AssetIDProtocol gives each image a **Digital Asset Passport**: a public verification page, license rules,
license-gated downloads, and notifications when a copy of your image is identified.

---

## Part A: For creators

### 1. Register an asset
**In the browser:** open the home page, fill in the form and press **Register**.

**From the command line:**
```bash
curl -F file=@photo.jpg \
     -F title="Sunset over Lake" \
     -F creator="Jane Doe" \
     -F email=jane@example.com \
     -F licenseCode=CC-BY-4.0 \
     -F webhookUrl=https://hooks.example.com/assetid \
     -F maxDownloads=100 \
     -F expiresAt=2027-12-31 \
     https://assetidprotocol.message-0ad.workers.dev/api/assets
```

| Field | Required | Notes |
|---|---|---|
| `file` | yes | JPEG, PNG, GIF or WebP, up to 10 MB. The file contents are checked, not only the extension. |
| `title` | no | Defaults to the file name. |
| `creator`, `email` | no | Shown as the creator (the email is never shown publicly). |
| `licenseCode` | no | `ARR` (all rights reserved, the default), `CC-BY-4.0`, or `COMMERCIAL`. |
| `webhookUrl` | no | Where to send sighting notifications (see section 4). |
| `maxDownloads` | no | Download limit for the license-gated download link. |
| `expiresAt` | no | Date after which the license/download expires. |

The response gives you:
- `assetId`: your passport ID.
- `verificationUrl`: the public page to share, e.g. `/verify/ast_...`.
- `watermarkId`: **keep this private**. It is used for watermarking (section 2).
- `sha256`: the fingerprint of the exact file you uploaded.

Limit: 20 requests per minute per network. After that you get HTTP 429; wait a minute.

### 2. Watermark your copy (optional, demo)
Embed the `watermarkId` into the version of the image you publish:
```bash
pip install Pillow
python scripts/process_asset.py embed photo.png photo_marked.png <watermarkId>
python scripts/process_asset.py extract photo_marked.png   # prints the ID back
```
Use PNG output. The demo watermark is stored in pixel bits and repeated 5 times, so extraction can recover it
from small damage. It does **not** survive JPEG recompression, resizing or screenshots. For those, use visual
identification (section 5b). A robust forensic watermark is on the roadmap.

**Content credentials (C2PA):** `scripts/c2pa-manifest.template.json` is a template for
[c2patool](https://github.com/contentauth/c2patool). Replace `{{TITLE}}`, `{{FORMAT}}`, `{{LICENSE_URL}}`
and the other placeholders, then sign your published file.

### 3. Verify and look up an asset
- **Public page:** `https://assetidprotocol.message-0ad.workers.dev/verify/<assetId>` shows the title, creator,
  license, status and C2PA status.
- **JSON:** `GET /api/assets/<assetId>`. This returns public fields only (no file hash, storage key or watermark ID).
- **Licensed download:** `GET /api/assets/<assetId>/download`. This works only while the asset is active, not expired,
  and under `maxDownloads`. Each successful download counts toward the limit.

### 4. Get notified (webhooks)
If you set `webhookUrl`, the service POSTs JSON to it whenever your asset is identified:
```json
{ "type": "asset.sighted", "assetId": "ast_...", "data": { "method": "sha256", "confidence": 1, "country": "US" }, "sentAt": "..." }
```
- The URL must be **https**, use the default port, and point at a public host. Private/internal addresses
  and `localhost` are rejected.
- Each request carries `x-asset-signature`: a hex HMAC-SHA256 of the raw body, made with the service's webhook
  secret. Ask the operator for the verification key if you need to check signatures.
- Failed deliveries are retried up to 5 times. Redirects are not followed.

### 5. Identify a copy you found
**a) Exact file or watermark ID** (works now):
```bash
curl -F file=@found.jpg https://assetidprotocol.message-0ad.workers.dev/api/identify
curl -F watermarkId=<id-from-extract> https://assetidprotocol.message-0ad.workers.dev/api/identify
```
A match returns `{ matched: true, assetId, method, verificationUrl }`, logs a sighting, and notifies the creator.
The file must be byte-identical. Any re-save or screenshot changes the hash, so use (b) for those.

**b) Camera / screenshot / crop** (Phase 2):
Open `/camera.html`, point your camera at the image (or upload a screenshot), and press **Capture**.
Matching uses perceptual hashes, so it handles resizes, screenshots and crops that keep about 50% or more of the
image. It is weak on steep angles, rotation and glare. Only assets registered after Phase 2 is deployed (or
re-extracted) can be found this way.

---

## Part B: For operators

### Stack
| Resource | Name |
|---|---|
| Worker | `assetidprotocol` (this repo) |
| D1 | `asset-registry` (`migrations/`) |
| R2 | `asset-passport-files` (masters) |
| Queue | `asset-notifications` (webhook delivery) |
| Recognizer (Phase 2) | `assetidprotocolrecognizer` ([repo](https://github.com/pjrny/AssetIDProtocolRecognizer)) |

### Deploy
```bash
npm ci
export CLOUDFLARE_ACCOUNT_ID=0adfeaaccd1d2cfa389d7bcd33b55ee4   # plus CLOUDFLARE_API_TOKEN with Workers, D1, R2 and Queues edit
npm run typecheck
npm run db:remote          # apply new migrations (additive)
npx wrangler deploy
curl https://assetidprotocol.message-0ad.workers.dev/api/health   # expect storage "r2"
```
Local development: `npm run db:local && npx wrangler dev`. With the pinned wrangler, add
`--compatibility-date 2026-05-03` if local startup complains.

### Secrets
Set secrets by piping, so they are never echoed or committed:
```bash
openssl rand -hex 32 | npx wrangler secret put NOTIFICATION_WEBHOOK_SECRET
# Phase 2: the SAME value goes on both Workers
openssl rand -hex 32 > /tmp/s && \
  npx wrangler secret put RECOGNIZER_SECRET < /tmp/s && \
  (cd ../AssetIDProtocolRecognizer && npx wrangler secret put RECOGNIZER_SECRET < /tmp/s) && rm /tmp/s
```

### Settings (`wrangler.jsonc` vars)
| Var | Default | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | workers.dev URL | Used in verification links |
| `MAX_UPLOAD_BYTES` | 10000000 | Upload cap (1 MB if R2 is unbound and the D1 fallback is used) |
| `RATE_LIMIT_PER_MINUTE` | 20 | Per-IP limit for register and identify |
| `NOTIFICATION_MODE` | webhook | Delivery mode |
| `RECOGNIZER_URL` | recognizer URL | Phase 2. Unset means visual identify returns 503 and registration is unaffected. |

### Troubleshooting
- `429`: the rate limit was hit. Raise `RATE_LIMIT_PER_MINUTE` if you need to.
- `413` / `unsupported type`: the file is too large or not an allowed image.
- `/api/visual-identify` returns 503: the recognizer is not configured. Returns 502: the recognizer is unreachable or the secret doesn't match.
- Webhooks are not arriving: check Worker logs (observability is on) and that the URL is public https.
