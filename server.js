require('dotenv').config();

const path = require('node:path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT) || 3000;
// IMEILookup may hold a single order for up to 55 seconds before returning Processing.
const apiTimeoutMs = Math.max(70000, Number(process.env.IMEI_API_TIMEOUT_MS) || 70000);
const pollIntervalMs = 3000;
const maxPollAttempts = 12;
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const isServerlessRuntime = Boolean(
  process.env.VERCEL
  || process.env.VERCEL_ENV
  || process.env.LAMBDA_TASK_ROOT
  || process.env.AWS_LAMBDA_FUNCTION_NAME
  || __dirname.startsWith('/var/task')
);
const configuredDatabasePath = process.env.DATABASE_PATH;
const defaultDatabasePath = isServerlessRuntime
  ? '/tmp/imei-checker.sqlite'
  : path.join(__dirname, 'data/imei-checker.sqlite');
const useConfiguredPath = !isServerlessRuntime
  || (configuredDatabasePath && path.isAbsolute(configuredDatabasePath) && configuredDatabasePath.startsWith('/tmp/'));
const databasePath = path.resolve(useConfiguredPath && configuredDatabasePath ? configuredDatabasePath : defaultDatabasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    imei TEXT,
    status TEXT NOT NULL,
    device_data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    received_at TEXT NOT NULL,
    matched INTEGER NOT NULL DEFAULT 0
  );
`);

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  maxAge: 600
}));
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Webhook request limit exceeded.' }
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function webhookAuthorized(req, rawBody) {
  const secret = process.env.IMEI_WEBHOOK_SECRET;
  if (!secret) return false;
  const allowedIps = (process.env.IMEI_WEBHOOK_IPS || '').split(',').map((ip) => ip.trim()).filter(Boolean);
  if (allowedIps.length && !allowedIps.includes(req.ip)) return false;
  const signature = req.get('x-imeilookup-signature') || req.get('x-webhook-signature') || '';
  const suppliedToken = req.get('x-webhook-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const expectedSignature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expectedSignature) || safeEqual(suppliedToken, secret);
}

function webhookFields(payload) {
  const orderId = payload.orderId ?? payload.order_id ?? payload.order?.id;
  const status = payload.status ?? payload.orderStatus ?? payload.order_status;
  if ((typeof orderId !== 'string' && typeof orderId !== 'number') || !String(orderId).trim() || String(orderId).length > 128) return null;
  if (typeof status !== 'string' || !/^(completed|complete|success|successful|failed|failure|processing|waiting|pending)$/i.test(status.trim())) return null;
  const normalizedStatus = /^(completed|complete|success|successful)$/i.test(status.trim()) ? 'completed'
    : /^(failed|failure)$/i.test(status.trim()) ? 'failed'
      : /^(processing)$/i.test(status.trim()) ? 'processing' : 'waiting';
  const deviceData = payload.result ?? payload.data ?? payload.deviceData ?? payload.device_data ?? null;
  if (deviceData !== null && (typeof deviceData !== 'object' || Array.isArray(deviceData))) return null;
  return { orderId: String(orderId).trim(), status: normalizedStatus, deviceData };
}

const upsertOrder = database.prepare(`
  INSERT INTO orders (order_id, imei, status, device_data, created_at, updated_at)
  VALUES (@orderId, @imei, @status, @deviceData, @now, @now)
  ON CONFLICT(order_id) DO UPDATE SET
    status = excluded.status,
    device_data = COALESCE(excluded.device_data, orders.device_data),
    updated_at = excluded.updated_at
`);
const saveProviderOrder = database.transaction(({ orderId, imei, status, data }) => {
  const now = new Date().toISOString();
  upsertOrder.run({
    orderId: String(orderId), imei, status,
    deviceData: data ? JSON.stringify(data) : null,
    now
  });
});

app.post('/api/webhooks/imei-lookup', webhookLimiter, express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !webhookAuthorized(req, req.body)) {
    console.warn('IMEI webhook rejected: authentication failed', { ip: req.ip });
    return res.status(401).json({ success: false, error: 'Webhook authentication failed.' });
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    console.warn('IMEI webhook rejected: malformed JSON', { ip: req.ip });
    return res.status(400).json({ success: false, error: 'Webhook body must be valid JSON.' });
  }
  const fields = payload && typeof payload === 'object' && !Array.isArray(payload) ? webhookFields(payload) : null;
  if (!fields) {
    console.warn('IMEI webhook rejected: required fields missing or invalid', { ip: req.ip });
    return res.status(400).json({ success: false, error: 'Webhook must include a valid order ID and status.' });
  }

  const payloadHash = crypto.createHash('sha256').update(req.body).digest('hex');
  const eventId = String(payload.eventId ?? payload.event_id ?? payloadHash).slice(0, 128);
  const now = new Date().toISOString();
  try {
    const result = database.transaction(() => {
      const duplicate = database.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(eventId);
      if (duplicate) return { duplicate: true, matched: true };
      const order = database.prepare('SELECT status FROM orders WHERE order_id = ?').get(fields.orderId);
      const matched = Boolean(order);
      database.prepare(`INSERT INTO webhook_events (event_id, order_id, status, payload_hash, received_at, matched)
        VALUES (?, ?, ?, ?, ?, ?)`).run(eventId, fields.orderId, fields.status, payloadHash, now, matched ? 1 : 0);
      if (matched) {
        const terminal = ['completed', 'failed'].includes(order.status);
        const incomingPending = ['processing', 'waiting'].includes(fields.status);
        if (!(terminal && incomingPending)) {
          database.prepare(`UPDATE orders SET status = ?, device_data = COALESCE(?, device_data), updated_at = ? WHERE order_id = ?`)
            .run(fields.status, fields.deviceData ? JSON.stringify(fields.deviceData) : null, now, fields.orderId);
        }
      }
      return { duplicate: false, matched };
    })();
    if (!result.matched) console.warn('IMEI webhook order not found; event recorded for reconciliation', { orderId: fields.orderId, eventId });
    return res.status(200).json({ success: true, received: true, duplicate: result.duplicate });
  } catch (error) {
    console.error('IMEI webhook persistence failed:', error.code || 'DATABASE_ERROR');
    return res.status(500).json({ success: false, error: 'Webhook could not be saved. The provider may retry.' });
  }
});

app.use(express.json({ limit: '10kb', strict: true }));

const imeiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many lookup attempts. Please wait 15 minutes and try again.' }
});

function isValidImei(imei) {
  if (typeof imei !== 'string' || !/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let index = 0; index < imei.length; index += 1) {
    let digit = Number(imei[imei.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseTextResult(text) {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (match && match[2]) fields[normalizeKey(match[1])] = match[2];
  }
  return fields;
}

function firstDefined(source, names) {
  const fields = new Map(Object.entries(source || {}).map(([key, value]) => [normalizeKey(key), value]));
  for (const name of names) {
    const value = fields.get(normalizeKey(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeProviderResponse(payload, imei) {
  const root = payload?.result ?? payload?.data ?? payload?.response ?? payload;
  let data = root?.device ?? root?.deviceInfo ?? root?.details ?? root;
  if (typeof data === 'string') data = parseTextResult(data);
  if (!data || typeof data !== 'object') data = {};
  const model = firstDefined(data, ['model', 'modelName', 'deviceModel', 'productName', 'description']);
  const storage = firstDefined(data, ['storage', 'capacity', 'memory', 'storageSize']);
  const color = firstDefined(data, ['color', 'colour', 'deviceColor', 'finish']);
  const serialNumber = firstDefined(data, ['serialNumber', 'serial_number', 'serial', 'sn']);
  const icloudStatus = firstDefined(data, [
    'icloudStatus', 'fmiStatus', 'fmiOn', 'fmi', 'findMy', 'findMyStatus', 'findMyiPhone', 'activationLock', 'icloudLock'
  ]);

  if (serialNumber === null && model === null && storage === null && color === null && icloudStatus === null) {
    throw new Error('PROVIDER_SCHEMA');
  }
  return { imei, serialNumber, model, storage, color, icloudStatus };
}

function providerErrorMessage(error) {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return { status: 504, message: 'The provider request timed out and may still have created this order. Check your provider order history before submitting this IMEI again.' };
  }
  const status = error.response?.status;
  if (status === 401 || status === 403) {
    const providerMessage = String(error.response?.data?.message || '');
    if (providerMessage.includes('LOW_CREDIT') || providerMessage.includes('CREDIT_LIMIT_REACHED')) {
      return { status: 503, message: 'Unexpected error. Please try again later.' };
    }
    return { status: 502, message: 'The lookup provider rejected access. Check the API key, account approval, and server IP allow-list.' };
  }
  if (status === 402) {
    return { status: 503, message: 'The device lookup provider has insufficient balance. Please try again later.' };
  }
  if (status === 429) {
    return { status: 503, message: 'The device lookup provider is busy. Please try again later.' };
  }
  if (status >= 500) {
    return { status: 502, message: 'The provider returned a server error. The order may still exist; check the provider order history before submitting this IMEI again.' };
  }
  return { status: 502, message: 'The device lookup provider could not complete this request. Check the provider order history before retrying.' };
}

function providerPayloadError(payload) {
  const providerMessage = Array.isArray(payload?.message)
    ? payload.message.join(' ')
    : String(payload?.message || '');
  if (providerMessage.includes('LOW_CREDIT') || providerMessage.includes('CREDIT_LIMIT_REACHED')) {
    return { status: 503, message: 'The lookup provider account has insufficient balance. Please try again later.' };
  }
  if (providerMessage.includes('SERVICE_NOT_FOUND') || providerMessage.includes('SERVICE_ID_MUST_BE_NUMBER')) {
    return { status: 503, message: 'The configured lookup service is unavailable. Check the service ID in the server configuration.' };
  }
  if (providerMessage.includes('INVALID_IMEI_PROVIDED') || providerMessage.includes('TAC_FAILED')) {
    return { status: 422, message: 'The provider could not match this IMEI to the selected lookup service.' };
  }
  if (providerPayloadStatus(payload) === 'Failed') {
    return { status: 422, message: 'The lookup provider could not return a device report for this IMEI.' };
  }
  if (payload?.success === false) {
    return { status: 502, message: 'The lookup provider could not complete this request. Check provider order history before retrying.' };
  }
  return null;
}

function providerPayloadStatus(payload) {
  return String(payload?.status || '').toLowerCase();
}

function providerBaseUrl() {
  let configured;
  try {
    configured = new URL(process.env.IMEI_API_URL || 'https://api.imeilookup.com');
  } catch {
    throw new Error('IMEILOOKUP_URL_INVALID');
  }
  if (configured.protocol !== 'https:' || configured.hostname !== 'api.imeilookup.com') {
    throw new Error('IMEILOOKUP_URL_INVALID');
  }
  return configured.origin;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function placeAndWaitForOrder(imei, serviceId, apiKey, onOrderUpdate) {
  const url = `${providerBaseUrl()}/order/single`;
  const headers = { 'access-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  let response = await axios.post(url, { imei, serviceId }, {
    headers,
    timeout: apiTimeoutMs,
    validateStatus: (status) => status >= 200 && status < 300
  });
  let order = response.data;
  if (order?.id !== undefined && order?.id !== null) onOrderUpdate(order);

  for (let attempt = 0; attempt < maxPollAttempts && ['waiting', 'processing'].includes(providerPayloadStatus(order)); attempt += 1) {
    if (!Number.isSafeInteger(Number(order.id))) {
      throw new Error('PROVIDER_ORDER_ID_MISSING');
    }
    await delay(pollIntervalMs);
    response = await axios.get(url, {
      headers: { 'access-key': apiKey, Accept: 'application/json' },
      params: { id: order.id },
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 300
    });
    order = response.data;
    onOrderUpdate(order);
  }
  if (['waiting', 'processing'].includes(providerPayloadStatus(order))) {
    const error = new Error('PROVIDER_ORDER_STILL_PROCESSING');
    error.orderId = order.id;
    throw error;
  }
  return order;
}

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok' }));

app.post('/api/check-imei', imeiLimiter, async (req, res) => {
  const { imei } = req.body || {};
  if (typeof imei !== 'string' || !/^\d{15}$/.test(imei)) {
    return res.status(400).json({ success: false, error: 'IMEI must contain exactly 15 numeric digits.' });
  }
  if (!isValidImei(imei)) {
    return res.status(400).json({ success: false, error: 'IMEI check digit is invalid. Please verify the number and try again.' });
  }

  const providerUrl = process.env.IMEI_API_URL;
  const apiKey = process.env.IMEI_API_KEY;
  const serviceId = Number(process.env.IMEI_SERVICE_ID);
  if (!providerUrl || !apiKey || !Number.isSafeInteger(serviceId) || serviceId < 1) {
    return res.status(503).json({ success: false, error: 'Device lookup is not configured yet. Please try again later.' });
  }

  try {
    const order = await placeAndWaitForOrder(imei, serviceId, apiKey, (providerOrder) => {
      if (providerOrder?.id === undefined || providerOrder?.id === null) return;
      const providerStatus = providerPayloadStatus(providerOrder);
      const status = ['success', 'completed', 'complete'].includes(providerStatus) ? 'completed'
        : ['failed', 'failure'].includes(providerStatus) ? 'failed'
          : providerStatus === 'processing' ? 'processing' : 'waiting';
      let deviceData = null;
      if (status === 'completed') {
        try { deviceData = normalizeProviderResponse(providerOrder, imei); } catch { /* final response is validated below */ }
      }
      saveProviderOrder({ orderId: providerOrder.id, imei, status, data: deviceData });
    });
    const providerPayloadFailure = providerPayloadError(order);
    if (providerPayloadFailure) {
      return res.status(providerPayloadFailure.status).json({ success: false, error: providerPayloadFailure.message });
    }
    const orderStatus = providerPayloadStatus(order);
    if (orderStatus !== 'success') {
      return res.status(502).json({ success: false, error: 'The provider returned an unexpected order status. Check provider order history before retrying.' });
    }
    const data = normalizeProviderResponse(order, imei);
    if (order?.id !== undefined && order?.id !== null) {
      saveProviderOrder({ orderId: order.id, imei, status: 'completed', data });
    }
    return res.json({ success: true, data });
  } catch (error) {
    if (error.message === 'IMEILOOKUP_URL_INVALID') {
      return res.status(503).json({ success: false, error: 'Device lookup configuration is invalid.' });
    }
    if (error.message === 'PROVIDER_ORDER_STILL_PROCESSING') {
      return res.status(504).json({ success: false, error: `Lookup order ${error.orderId} is still processing. Do not submit the IMEI again yet; check the provider order history.` });
    }
    if (error.message === 'PROVIDER_SCHEMA') {
      return res.status(502).json({ success: false, error: 'The lookup provider returned an unsupported response. Please contact the site operator.' });
    }
    const providerPayloadFailure = providerPayloadError(error.response?.data);
    if (providerPayloadFailure) {
      return res.status(providerPayloadFailure.status).json({ success: false, error: providerPayloadFailure.message });
    }
    const providerError = providerErrorMessage(error);
    if (error.response || error.isAxiosError || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(providerError.status).json({ success: false, error: providerError.message });
    }
    // Do not include the request config: it contains the provider authorization header.
    console.error('IMEI provider request failed:', error.code || 'NETWORK_ERROR');
    return res.status(502).json({ success: false, error: 'The lookup provider is unavailable. Check provider order history before submitting this IMEI again.' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  index: 'index.html'
}));

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ success: false, error: 'Request body must be valid JSON.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request body is too large.' });
  }
  console.error('Unhandled request error:', error.message);
  return res.status(500).json({ success: false, error: 'An unexpected server error occurred.' });
});

// Vercel invokes the exported Express application as a serverless function.
module.exports = app;
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`Boardroom lookup app listening on port ${port}`));
}
