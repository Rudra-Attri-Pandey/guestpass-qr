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

## API

- `POST /api/checkin` `{name, phone, purpose, host}` → `201 {pass:{id,name,host,checked_in_at,status}}`
  - Validation: name 2-100, phone 7-15 digits, purpose 2-200, host 2-100 chars → `400` otherwise.
  - ID: `GP-YYYYMMDD-XXXXXX` (crypto random), verified unique against the store.
- `POST /api/checkout` `{id}` → `200 {pass}`; `404` unknown id, `409` already checked out.
- `GET /api/ledger` → `{passes newest-first, count}`.
- `GET /api/hosts?q=` → `{hosts[]}` simple substring host search.
- `GET /api/pass/:id/qr` → PNG of the pass payload `{id,name,host,checked_in_at}`; frontend shows it via `<img src="/api/pass/ID/qr">`.

Store: `data/ledger.json` (gitignored). Swap for Supabase when multi-host
realtime is needed — the server logs this at boot.

## What is real / what is not

- ✅ Real: validation, collision-free IDs, stable-ID checkout, JSON ledger, real QR PNGs, host search, offline fallback queue (localStorage, clearly labeled), toasts, HTML escaping.
- ❌ Not yet: realtime websocket/Supabase sync, SMS/Twilio alerts, auth/multi-tenant. Slack only if `SLACK_WEBHOOK_URL` is set.

## Prototype notes (fixed)

- Checkout no longer uses row indexes (fixes the `reverse()` bug).
- QR is a real PNG from `qrcode`, not CSS.
- IDs are crypto-random + uniqueness-checked, not `Math.random()` 5-digit.
- Phone/purpose/host are validated server-side (400 on bad input).
