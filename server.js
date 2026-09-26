import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { newDb } from 'pg-mem';
import Stripe from 'stripe';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 10000);
const root = path.dirname(fileURLToPath(import.meta.url));
const localDatabase = process.env.DATABASE_URL ? null : newDb();
const production = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
if (production && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production. Configure PostgreSQL before accepting users.');
if (production && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) throw new Error('A JWT_SECRET of at least 32 characters is required in production.');
if (production && (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_STARTER_PRICE_ID || !process.env.STRIPE_PROFESSIONAL_PRICE_ID)) throw new Error('Stripe secret, webhook, and recurring price IDs are required in production.');
if (production && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12 || process.env.ADMIN_PASSWORD === '1562')) throw new Error('Set a strong ADMIN_PASSWORD of at least 12 characters in production.');
const pool = localDatabase
  ? new (localDatabase.adapters.createPg().Pool)()
  : new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const jwtSecret = process.env.JWT_SECRET || 'change-this-before-publishing';

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'SKY TRADERS', timestamp: new Date().toISOString() }));
const advertClients = new Set();

async function query(text, values = []) {
  return pool.query(text, values);
}

async function initialiseDatabase() {
  if (localDatabase) console.warn('DATABASE_URL is not set; using temporary local storage. Configure PostgreSQL before publishing.');
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'pending',
      balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
      trading_status TEXT NOT NULL DEFAULT 'pending',
      mt5_status TEXT NOT NULL DEFAULT 'not_connected',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(14, 2) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trading_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mt5_status TEXT NOT NULL DEFAULT 'not_connected';
    CREATE TABLE IF NOT EXISTS adverts (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS account_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_type TEXT NOT NULL,
      amount NUMERIC(14, 2),
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role || 'user' }, jwtSecret, { expiresIn: '7d' });
}

function auth(requiredRole) {
  return (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const user = jwt.verify(token, jwtSecret);
      if (requiredRole && user.role !== requiredRole) return res.status(403).json({ error: 'Administrator access required.' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Authentication required.' });
    }
  };
}

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe is not configured.');
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    const object = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const subscription = await stripe.subscriptions.retrieve(object.subscription);
      await query(`UPDATE users SET subscription_status = $1, stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $4`, ['active', object.customer, subscription.id, object.metadata.userId]);
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      await query(`UPDATE users SET subscription_status = $1 WHERE stripe_subscription_id = $2`, [object.status, object.id]);
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.json({ limit: '1mb' }));

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, plan } = req.body;
  if (!name || !email || !password || !['starter', 'professional'].includes(plan)) return res.status(400).json({ error: 'Name, email, password, and a valid plan are required.' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(`INSERT INTO users (name, email, password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id, name, email, plan, subscription_status`, [name.trim(), email.trim().toLowerCase(), passwordHash, plan]);
    const user = result.rows[0];
    if (!stripe) {
      await query(`UPDATE users SET subscription_status = 'active' WHERE id = $1`, [user.id]);
      user.subscription_status = 'active';
      return res.json({ token: tokenFor(user), user, localAccess: true });
    }
    const price = plan === 'starter' ? process.env.STRIPE_STARTER_PRICE_ID : process.env.STRIPE_PROFESSIONAL_PRICE_ID;
    if (!price) return res.status(503).json({ error: 'Payment plan is not configured on the server.' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${req.protocol}://${req.get('host')}/?payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`,
      customer_email: user.email,
      subscription_data: plan === 'starter' ? { trial_period_days: 7 } : undefined,
      metadata: { userId: String(user.id), plan }
    });
    res.status(201).json({ token: tokenFor(user), user, checkoutUrl: session.url });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
    res.status(500).json({ error: 'Unable to create the account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email = $1`, [email?.trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email, plan: user.plan, subscription_status: user.subscription_status } });
});

app.get('/api/auth/me', auth(), async (req, res) => {
  const result = await query(`SELECT id, name, email, plan, subscription_status, balance, trading_status, mt5_status FROM users WHERE id = $1`, [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: result.rows[0] });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  advertClients.add(res);
  res.write('event: ready\ndata: {}\n\n');
  req.on('close', () => advertClients.delete(res));
});

app.get('/api/account', auth(), async (req, res) => {
  const result = await query(`SELECT id, name, email, balance, trading_status, mt5_status FROM users WHERE id = $1`, [req.user.id]);
  res.json(result.rows[0] || {});
});

app.post('/api/account/requests', auth(), async (req, res) => {
  const { requestType, amount, reference } = req.body;
  if (!['mt5_connection', 'deposit'].includes(requestType)) return res.status(400).json({ error: 'Unsupported request type.' });
  if (requestType === 'deposit' && (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || !reference?.trim())) return res.status(400).json({ error: 'Deposit amount and payment reference are required.' });
  const result = await query(`INSERT INTO account_requests (user_id, request_type, amount, reference) VALUES ($1, $2, $3, $4) RETURNING id, request_type, amount, status, created_at`, [req.user.id, requestType, requestType === 'deposit' ? Number(amount) : null, reference?.trim() || null]);
  res.status(201).json(result.rows[0]);
});

app.post('/api/payments/checkout', auth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured.' });
  const { plan } = req.body;
  const price = plan === 'starter' ? process.env.STRIPE_STARTER_PRICE_ID : process.env.STRIPE_PROFESSIONAL_PRICE_ID;
  if (!price) return res.status(503).json({ error: 'Payment plan is not configured.' });
  const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price, quantity: 1 }], success_url: `${req.protocol}://${req.get('host')}/?payment=success`, cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`, metadata: { userId: String(req.user.id), plan } });
  res.json({ checkoutUrl: session.url });
});

app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid management password.' });
  res.json({ token: tokenFor({ id: 'admin', email: 'owner', role: 'admin' }) });
});

app.get('/api/admin/users', auth('admin'), async (req, res) => {
  const result = await query(`SELECT id, name, email, plan, subscription_status, balance, trading_status, mt5_status, created_at FROM users ORDER BY created_at DESC`);
  res.json(result.rows);
});

app.get('/api/admin/requests', auth('admin'), async (req, res) => {
  const result = await query(`SELECT r.id, r.request_type, r.amount, r.reference, r.status, r.created_at, u.name, u.email FROM account_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.created_at ASC`);
  res.json(result.rows);
});

app.post('/api/admin/requests/:id/:decision', auth('admin'), async (req, res) => {
  const decision = req.params.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
  const requestResult = await query(`SELECT * FROM account_requests WHERE id = $1 AND status = 'pending'`, [req.params.id]);
  const request = requestResult.rows[0];
  if (!request) return res.status(404).json({ error: 'Pending request not found.' });
  await query(`UPDATE account_requests SET status = $1, reviewed_at = NOW() WHERE id = $2`, [decision === 'approve' ? 'approved' : 'rejected', request.id]);
  if (decision === 'approve') {
    if (request.request_type === 'deposit') await query(`UPDATE users SET balance = balance + $1, trading_status = 'active' WHERE id = $2`, [request.amount, request.user_id]);
    if (request.request_type === 'mt5_connection') await query(`UPDATE users SET mt5_status = 'connected', trading_status = 'active' WHERE id = $1`, [request.user_id]);
  }
  res.json({ success: true });
});

app.get('/api/adverts', async (req, res) => {
  const result = await query(`SELECT id, title, body, created_at FROM adverts WHERE active = TRUE ORDER BY created_at DESC`);
  res.json(result.rows);
});

app.post('/api/admin/adverts', auth('admin'), async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and message are required.' });
  const result = await query(`INSERT INTO adverts (title, body) VALUES ($1, $2) RETURNING *`, [title.trim(), body.trim()]);
  const advert = result.rows[0];
  for (const client of advertClients) client.write(`event: advert\ndata: ${JSON.stringify(advert)}\n\n`);
  res.status(201).json(advert);
});

app.get('/api/mt5/status', async (req, res) => {
  if (!process.env.MT5_STATUS_URL) return res.json({ connected: false, message: 'MT5 bridge is not configured.' });
  try {
    const response = await fetch(process.env.MT5_STATUS_URL, { signal: AbortSignal.timeout(5000) });
    res.status(response.ok ? 200 : 502).json(await response.json());
  } catch {
    res.status(502).json({ connected: false, message: 'MT5 bridge unavailable.' });
  }
});

app.use(express.static(root));
app.get('*', (req, res) => res.sendFile(path.join(root, 'main.html')));

initialiseDatabase().then(() => app.listen(port, () => console.log(`Sky Traders listening on ${port}`))).catch(error => { console.error(error); process.exit(1); });