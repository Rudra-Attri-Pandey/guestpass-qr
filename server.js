'use strict';
/* GuestPass QR backend — Express server.
 * Dual-mode store:
 *   - Supabase PostgREST table guest_passes (via ./supabase.js) when
 *     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set — source of truth.
 *   - JSON-file ledger in data/ledger.json (gitignored) otherwise (dev).
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { sbConfigured, sbInsert, sbList, sbGet, sbUpdate } = require('./supabase');

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || '').trim();

// Supabase PostgREST is the source of truth when configured; JSON file (dev) otherwise.
const USE_SB = sbConfigured();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3014')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Security middleware -------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / non-browser
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: 'draft-7' }));

// Sensitive-file guard: never expose secrets, store, or server internals.
const SENSITIVE = /(\.env(\.|$)|package(-lock)?\.json|\.gitignore|(^|\/)server\.js$|\.map$|(^|\/)data\/|ledger\.json)/i;
app.use((req, res, next) => {
  if (SENSITIVE.test(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(APP_DIR, { dotfiles: 'deny', index: 'index.html' }));

// --- JSON-file store ------------------------------------------------------
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, '[]', 'utf8');
}

function readLedger() {
  ensureStore();
  try {
    const raw = fs.readFileSync(LEDGER_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLedger(passes) {
  ensureStore();
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(passes, null, 2), 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
}

// --- Validation -----------------------------------------------------------
function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function validateCheckin(body) {
  const errors = [];
  const name = str(body && body.name);
  const phone = str(body && body.phone);
  const purpose = str(body && body.purpose);
  const host = str(body && body.host);
  if (name.length < 2 || name.length > 100) errors.push('name must be 2-100 chars');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) errors.push('phone must contain 7-15 digits');
  if (purpose.length < 2 || purpose.length > 200) errors.push('purpose must be 2-200 chars');
  if (host.length < 2 || host.length > 100) errors.push('host must be 2-100 chars');
  return { errors, clean: { name, phone, purpose, host } };
}

function generatePassId(existing) {
  const seen = new Set(existing.map((p) => p.id));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let id;
  do {
    id = `GP-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (seen.has(id));
  return id;
}

// --- Slack (best-effort, never fails the check-in) ------------------------
async function notifySlack(pass) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[guestpass] Slack skipped: SLACK_WEBHOOK_URL not set');
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        text: `🔔 *New Visitor Checked In!*\n*Guest:* ${pass.name}\n*Host:* ${pass.host}\n*Purpose:* ${pass.purpose}\n*ID:* ${pass.id}`,
      }),
    });
    clearTimeout(t);
    console.log('[guestpass] Slack notice sent for', pass.id);
  } catch (e) {
    console.log('[guestpass] Slack notice failed (best-effort):', (e && e.message) || e);
  }
}

// --- API ------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, store: USE_SB ? 'supabase' : 'json-file', simulated: false });
});

app.post('/api/checkin', async (req, res) => {
  const { errors, clean } = validateCheckin(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const now = new Date().toISOString();
  let pass;
  if (USE_SB) {
    // Crypto-random ID, uniqueness-checked against PostgREST: pre-query
    // (?id=eq.<id>) then insert, retrying on PK conflict.
    try {
      for (let attempt = 0; attempt < 5 && !pass; attempt += 1) {
        const id = generatePassId([]);
        // eslint-disable-next-line no-await-in-loop
        const exists = await sbGet('guest_passes', id);
        if (exists) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          pass = await sbInsert('guest_passes', {
            id,
            name: clean.name,
            phone: clean.phone,
            purpose: clean.purpose,
            host: clean.host,
            checked_in_at: now,
            checked_out_at: null,
            status: 'Active',
          });
        } catch (e) {
          if (e && (e.status === 409 || e.code === '23505')) continue; // ID collision — regenerate
          throw e;
        }
      }
    } catch (e) {
      return res.status(500).json({ error: `Store write failed: ${(e && e.message) || e}` });
    }
    if (!pass) return res.status(500).json({ error: 'Could not allocate a unique pass ID.' });
  } else {
    const passes = readLedger();
    pass = {
      id: generatePassId(passes),
      name: clean.name,
      phone: clean.phone,
      purpose: clean.purpose,
      host: clean.host,
      checked_in_at: now,
      checked_out_at: null,
      status: 'Active',
    };
    passes.push(pass);
    writeLedger(passes);
  }
  notifySlack(pass); // fire-and-forget (async, never awaited to fail)
  return res.status(201).json({
    pass: { id: pass.id, name: pass.name, host: pass.host, checked_in_at: pass.checked_in_at, status: pass.status },
  });
});

app.post('/api/checkout', async (req, res) => {
  const id = str(req.body && req.body.id);
  if (!id) return res.status(400).json({ error: 'Missing "id" string in request body.' });
  if (USE_SB) {
    let row;
    try {
      row = await sbGet('guest_passes', id);
    } catch (e) {
      return res.status(500).json({ error: `Store read failed: ${(e && e.message) || e}` });
    }
    if (!row) return res.status(404).json({ error: 'Pass not found.' });
    if (row.status !== 'Active') return res.status(409).json({ error: 'Pass already checked out.' });
    const now = new Date().toISOString();
    try {
      const updated = await sbUpdate('guest_passes', id, { status: 'Checked Out', checked_out_at: now });
      return res.json({ pass: updated || { ...row, status: 'Checked Out', checked_out_at: now } });
    } catch (e) {
      return res.status(500).json({ error: `Store write failed: ${(e && e.message) || e}` });
    }
  }
  const passes = readLedger();
  const found = passes.find((p) => p.id === id); // stable-id lookup: no indexes used
  if (!found) return res.status(404).json({ error: 'Pass not found.' });
  if (found.status !== 'Active') return res.status(409).json({ error: 'Pass already checked out.' });
  found.status = 'Checked Out';
  found.checked_out_at = new Date().toISOString();
  writeLedger(passes);
  return res.json({ pass: found });
});

app.get('/api/ledger', async (_req, res) => {
  if (USE_SB) {
    try {
      const passes = await sbList('guest_passes', { order: 'checked_in_at.desc', limit: 1000 }); // newest-first
      return res.json({ passes, count: passes.length });
    } catch (e) {
      return res.status(500).json({ error: `Store read failed: ${(e && e.message) || e}` });
    }
  }
  const passes = readLedger();
  return res.json({ passes: [...passes].reverse(), count: passes.length }); // newest-first
});

app.get('/api/hosts', async (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let passes;
  if (USE_SB) {
    try {
      passes = await sbList('guest_passes', { order: 'checked_in_at.desc', limit: 1000 });
    } catch (e) {
      return res.status(500).json({ error: `Store read failed: ${(e && e.message) || e}` });
    }
  } else {
    passes = readLedger();
  }
  const hosts = [...new Set(passes.map((p) => p.host).filter(Boolean))];
  const filtered = q ? hosts.filter((h) => h.toLowerCase().includes(q)) : hosts;
  return res.json({ hosts: filtered.slice(0, 50) });
});

app.get('/api/pass/:id/qr', async (req, res) => {
  const id = String(req.params.id || '').trim();
  let found;
  if (USE_SB) {
    try {
      found = await sbGet('guest_passes', id);
    } catch (e) {
      return res.status(500).json({ error: `Store read failed: ${(e && e.message) || e}` });
    }
  } else {
    found = readLedger().find((p) => p.id === id);
  }
  if (!found) return res.status(404).json({ error: 'Pass not found.' });
  const payload = JSON.stringify({
    id: found.id, name: found.name, host: found.host, checked_in_at: found.checked_in_at,
  });
  try {
    const png = await QRCode.toBuffer(payload, { type: 'png', width: 280, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(png);
  } catch {
    return res.status(500).json({ error: 'QR generation failed.' });
  }
});

// --- Boot: PORT or first free 30xx ----------------------------------------
function listenOn(port) {
  if (port > 3099) { console.error('No free port in 3014-3099.'); process.exit(1); }
  const server = net.createServer();
  server.once('error', () => listenOn(port + 1));
  server.once('listening', () => {
    server.close(() => {
      app.listen(port, () => {
        console.log(`[guestpass] listening on http://localhost:${port}`);
        console.log(`[guestpass] store: ${USE_SB ? 'supabase (guest_passes — source of truth)' : 'json-file (dev)'}`);
        console.log(`[guestpass] CORS origins: ${CORS_ORIGINS.join(', ')}`);
        if (!SLACK_WEBHOOK_URL) console.log('[guestpass] Slack: SLACK_WEBHOOK_URL not set — skipping notifications');
      });
    });
  });
  server.listen(port);
}
module.exports = app;

// Guarded so `require('./server')` (e.g. serverless) does not start a listener.
// Direct `node server.js` behavior is unchanged.
if (require.main === module) {
  listenOn(Number(process.env.PORT) || 3014);
}
