# AssetIDProtocol

**Digital Asset Passport on Cloudflare Workers.** Register images, attach license rules and C2PA provenance,
serve license-gated downloads, identify copies, and notify creators via signed webhooks.

- Live (Phase 1): https://assetidprotocol.message-0ad.workers.dev
- Worker: `assetidprotocol` - D1 `asset-registry` - Queue `asset-notifications` - R2 `asset-passport-files`
- Phase 2: visual recognition of screenshots, crops and camera photos (`/camera.html`, `POST /api/visual-identify`,
  hosted recognizer Worker [AssetIDProtocolRecognizer](https://github.com/pjrny/AssetIDProtocolRecognizer); OpenCV reference in `recognizer/`). Disabled until `RECOGNIZER_URL` (var) and `RECOGNIZER_SECRET` (secret) are set.
  See [INTEGRATION.md](INTEGRATION.md).

Creator and operator guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)

## API
| Method | Path | Notes |
|---|---|---|
| POST | `/api/assets` | multipart register (jpeg/png/gif/webp, size-limited, rate-limited) |
| POST | `/api/identify` | exact file (sha256) or decoded `watermarkId` |
| GET | `/api/assets/:id` | public projection only (no hash, storage key or watermark ID) |
| GET | `/api/assets/:id/download` | license-gated; counter increments only after the file is fetched |
| GET | `/verify/:id` | public passport page |
| GET | `/api/health` | storage mode and upload limit |

## Security notes
- Webhook URLs must be `https`, default port, a public hostname; private/reserved IPs and internal TLDs are rejected (checked at registration and before delivery; redirects are not followed).
- Per-IP fixed-window rate limiting in D1 (`RATE_LIMIT_PER_MINUTE`, default 20).
- Upload MIME allow-list with magic-byte sniffing, `MAX_UPLOAD_BYTES` (default 10 MB; 1 MB while the D1 fallback store is used).
- **Storage:** masters are stored in R2. If the binding is removed, masters of 1 MB or less fall back to D1 (`asset_blobs`).

## Starter notes (original)

A proof-of-concept for asset registration, C2PA preparation, demo invisible watermark payloads,
license enforcement at download time, sightings, and webhook notifications.

## Important boundaries
- C2PA proves signed provenance/integrity; it does not stop screenshots or metadata removal.
- The included LSB watermark is an integration demonstrator, not a screenshot-resistant forensic watermark.
- Download limits and expiry apply to this service, not to copies already held by a user.
- The matching endpoint currently supports exact SHA-256 matches and a decoded watermark ID. Add a
  perceptual-hash or embedding service for screenshots/webcam photographs.

## Setup
```powershell
npm install
npx wrangler login
npx wrangler r2 bucket create asset-passport-files
npx wrangler d1 create asset-registry
npx wrangler queues create asset-notifications
```
The D1 database ID is already set in `wrangler.jsonc` for the production account. Locally:
```powershell
npm run db:local   # applies migrations/ locally
npm run dev
```
For production:
```powershell
npm run db:remote
npx wrangler secret put NOTIFICATION_WEBHOOK_SECRET
npm run deploy
```
`PUBLIC_BASE_URL` is set to the workers.dev URL.

## Registration and watermark flow
1. Register an image through the home page.
2. Copy the returned `watermarkId` and download/locate the original.
3. Install Pillow: `py -m pip install Pillow`
4. Run:
```powershell
py scripts/process_asset.py embed input.png watermarked.png WATERMARK_ID
py scripts/process_asset.py extract watermarked.png
```
5. In production, replace this demonstration with a robust forensic watermark encoder/decoder.

## C2PA flow
Install the official `c2patool`, create test signing credentials following its documentation, replace the
placeholders in `scripts/c2pa-manifest.template.json`, then sign a processed derivative. Keep private
keys outside this repository. Production signing should use a protected signer/KMS/HSM rather than a
private key committed to disk or source control.

Illustrative command only; adjust flags to the installed c2patool version:
```powershell
c2patool watermarked.jpg --manifest manifest.json --output signed.jpg
```
Upload the signed derivative to R2 and mark the database record `c2pa_status='signed'` after validating it.

## Notification webhook
When `/api/identify` records a sighting, a Queue consumer POSTs JSON to the creator's webhook URL.
If `NOTIFICATION_WEBHOOK_SECRET` is set, the request includes `x-asset-signature`, an HMAC-SHA256 hex
signature of the raw request body. The receiving service must verify it before trusting the event.

## Production backlog
- Authentication and creator ownership checks (creators are currently one row per upload)
- Presigned/direct uploads; malware scanning, CSRF/CORS policy, Turnstile
- Robust watermark vendor/codec and perceptual/image-embedding matching
- C2PA validation service and protected remote signer
- Email/push provider behind the notification Queue
- License checkout/payment integration
- Privacy policy, retention controls, consent, and location minimization
- Separate originals from public derivatives

## License
See [LICENSE](LICENSE).
