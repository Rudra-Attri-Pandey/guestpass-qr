# GuestPass QR — Office Check-In (real backend)

Touchless office register: the check-in form POSTs to an Express backend,
which stores passes in a JSON-file ledger, serves real QR-code PNGs, and
optionally pings Slack. The reception console renders from `/api/ledger`
and checks out by stable pass ID (no row indexes — the old reversed-index
bug is fixed by design).

## Run

```bash
npm install
npm start        # http://localhost:3014 (or first free 3014-3099)
```

Copy `.env.example` to `.env` to override defaults:

| Var | Effect |
| --- | ------ |
| `PORT` | Preferred port (default `3014`) |
| `CORS_ORIGINS` | Comma-separated allowed origins (default `http://localhost:3014`) |
| `SLACK_WEBHOOK_URL` | If set, check-ins POST a notice (best-effort, never fails the check-in); if unset, skipped with a log line |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | If **both** set, passes persist to Supabase (`guest_passes` via PostgREST) — source of truth across restarts; if unset, local JSON-file store (dev mode) |

## API

- `POST /api/checkin` `{name, phone, purpose, host}` → `201 {pass:{id,name,host,checked_in_at,status}}`
  - Validation: name 2-100, phone 7-15 digits, purpose 2-200, host 2-100 chars → `400` otherwise.
  - ID: `GP-YYYYMMDD-XXXXXX` (crypto random), verified unique against the store.
- `POST /api/checkout` `{id}` → `200 {pass}`; `404` unknown id, `409` already checked out.
- `GET /api/ledger` → `{passes newest-first, count}`.
- `GET /api/hosts?q=` → `{hosts[]}` simple substring host search.
- `GET /api/pass/:id/qr` → PNG of the pass payload `{id,name,host,checked_in_at}`; frontend shows it via `<img src="/api/pass/ID/qr">`.

Store: dual-mode. When `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, data persists to Supabase (`guest_passes` table via PostgREST — pass IDs are uniqueness-checked before insert). Unset, it falls back to `data/ledger.json` (gitignored, local dev mode). The active store is logged at boot and reported by `GET /api/health` (`store: supabase` / `json-file`).

## What is real / what is not

- ✅ Real: validation, collision-free IDs, stable-ID checkout, Supabase persistence (when configured; file ledger otherwise), real QR PNGs, host search, offline fallback queue (localStorage, clearly labeled), toasts, HTML escaping.
- ❌ Not yet: realtime websocket updates, SMS/Twilio alerts, auth/multi-tenant. Slack only if `SLACK_WEBHOOK_URL` is set.

## Prototype notes (fixed)

- Checkout no longer uses row indexes (fixes the `reverse()` bug).
- QR is a real PNG from `qrcode`, not CSS.
- IDs are crypto-random + uniqueness-checked, not `Math.random()` 5-digit.
- Phone/purpose/host are validated server-side (400 on bad input).
