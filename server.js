import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const PUBLIC_SITE = 'https://issueflow-cterkbqm.manus.space';
let db;
let vite;

const send = (res, status, payload, headers = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
};
const json = (res, status, payload, headers = {}) => send(res, status, payload, { 'Cache-Control': 'no-store', ...headers });
const parseCookies = (header = '') => Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const id = () => crypto.randomUUID();
const safeEmail = (value) => String(value || '').trim().toLowerCase();
const readBody = async (req) => { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Request is too large.'); } return raw ? JSON.parse(raw) : {}; };
const allowedOrigin = (origin) => { try { const parsed = new URL(origin || PUBLIC_SITE); if (parsed.origin === PUBLIC_SITE || parsed.hostname.endsWith('.manus.computer') || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return parsed.origin; } catch {} return PUBLIC_SITE; };
const cookie = (name, value, options = {}) => `${name}=${encodeURIComponent(value)}; Path=/; ${options.maxAge === 0 ? 'Max-Age=0; ' : options.maxAge ? `Max-Age=${options.maxAge}; ` : ''}${options.httpOnly === false ? '' : 'HttpOnly; '}SameSite=${options.sameSite || 'Lax'}${options.secure ? '; Secure' : ''}`;

async function connectDb() {
  if (!process.env.DATABASE_URL) return null;
  if (!db) db = mysql.createPool(process.env.DATABASE_URL);
  return db;
}
async function ensureSchema() {
  const pool = await connectDb();
  if (!pool) { console.warn('DATABASE_URL is not available; authenticated data APIs will report a setup error.'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS companies (id CHAR(36) PRIMARY KEY, name VARCHAR(180) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id CHAR(36) PRIMARY KEY, company_id CHAR(36) NOT NULL, name VARCHAR(180) NOT NULL, email VARCHAR(320) NOT NULL UNIQUE, password_salt VARCHAR(64), password_hash VARCHAR(256), google_sub VARCHAR(180), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX(company_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, expires_at DATETIME NOT NULL, INDEX(user_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS errors (id CHAR(36) PRIMARY KEY, company_id CHAR(36) NOT NULL, reporter_id CHAR(36) NOT NULL, message TEXT NOT NULL, source VARCHAR(180) NOT NULL, severity VARCHAR(20) NOT NULL DEFAULT 'medium', status VARCHAR(20) NOT NULL DEFAULT 'open', occurred_on DATE NOT NULL, notes TEXT, assistant_analysis TEXT, suggested_fix TEXT, fixed_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX(company_id), INDEX(company_id, occurred_on))`);
}
async function requireUser(req, res) {
  const pool = await connectDb();
  if (!pool) { json(res, 503, { error: 'Database is not connected yet. Start the managed server and database, then try again.' }); return null; }
  const token = parseCookies(req.headers.cookie).issueflow_session;
  if (!token) { json(res, 401, { error: 'Please sign in first.' }); return null; }
  const [rows] = await pool.query(`SELECT u.id, u.company_id AS companyId, u.name, u.email, c.name AS companyName FROM sessions s JOIN users u ON u.id=s.user_id JOIN companies c ON c.id=u.company_id WHERE s.token_hash=? AND s.expires_at > NOW() LIMIT 1`, [hashToken(token)]);
  if (!rows[0]) { json(res, 401, { error: 'Your session has expired. Please sign in again.' }); return null; }
  return rows[0];
}
async function createSession(res, userId, req) {
  const pool = await connectDb();
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL 30 DAY))`, [hashToken(token), userId]);
  const secure = !['localhost', '127.0.0.1'].includes(req.headers.host?.split(':')[0]);
  res.setHeader('Set-Cookie', cookie('issueflow_session', token, { maxAge: 60 * 60 * 24 * 30, sameSite: secure ? 'None' : 'Lax', secure }));
}
const publicUser = (row) => ({ id: row.id, name: row.name, email: row.email, companyId: row.companyId, companyName: row.companyName });
async function findOrCreateGoogleUser(profile, req, res) {
  const pool = await connectDb();
  const email = safeEmail(profile.email);
  const [existing] = await pool.query(`SELECT u.id, u.company_id AS companyId, u.name, u.email, c.name AS companyName FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? LIMIT 1`, [email]);
  let user = existing[0];
  if (!user) {
    const companyId = id(); const userId = id();
    await pool.query(`INSERT INTO companies (id,name) VALUES (?,?)`, [companyId, `${profile.name || email.split('@')[0]}'s company`]);
    await pool.query(`INSERT INTO users (id,company_id,name,email,google_sub) VALUES (?,?,?,?,?)`, [userId, companyId, profile.name || email.split('@')[0], email, profile.sub]);
    user = { id: userId, companyId, name: profile.name || email.split('@')[0], email, companyName: `${profile.name || email.split('@')[0]}'s company` };
  } else {
    await pool.query(`UPDATE users SET google_sub=?, name=? WHERE id=?`, [profile.sub, profile.name || user.name, user.id]);
  }
  await createSession(res, user.id, req);
  return user;
}
async function googleCallback(req, res, url) {
  const stateRaw = url.searchParams.get('state');
  let state;
  try { state = JSON.parse(Buffer.from(stateRaw || '', 'base64url').toString('utf8')); } catch { return send(res, 400, 'Invalid sign-in state.'); }
  const cookies = parseCookies(req.headers.cookie);
  if (!state?.nonce || state.nonce !== cookies.issueflow_oauth_nonce) return send(res, 400, 'The sign-in request expired. Please try again.');
  const redirectUri = allowedOrigin(state.origin) + '/api/auth/google/callback';
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  if (!tokenResponse.ok) return send(res, 502, 'Google sign-in could not be completed.');
  const token = await tokenResponse.json();
  const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!profileResponse.ok) return send(res, 502, 'Google profile could not be read.');
  const profile = await profileResponse.json();
  if (!profile.email) return send(res, 400, 'Google did not provide an email address.');
  await findOrCreateGoogleUser(profile, req, res);
  res.setHeader('Set-Cookie', cookie('issueflow_oauth_nonce', '', { maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: true }));
  res.writeHead(302, { Location: `${allowedOrigin(state.origin)}/?signed_in=1` }); res.end();
}
function deterministicFix(error) {
  const text = `${error.message} ${error.source}`.toLowerCase();
  if (text.includes('timeout') || text.includes('latency')) return 'Check the upstream timeout and add a bounded retry with backoff. Confirm the dependency health before increasing the timeout.';
  if (text.includes('permission') || text.includes('401') || text.includes('403') || text.includes('auth')) return 'Verify the service account scope, token expiry, and environment secret. Rotate the credential only after confirming the scope is correct.';
  if (text.includes('500') || text.includes('exception') || text.includes('crash')) return 'Capture the stack trace, reproduce with the same input, then add a guarded error path and a regression check before deploying.';
  if (text.includes('database') || text.includes('sql')) return 'Check the database connection pool and query plan, then add a safe retry for transient connection failures.';
  return 'Reproduce the error with the recorded source and date, inspect the first failing dependency, then add a small regression check before closing it.';
}
async function assistantAnalysis(error) {
  const fallback = deterministicFix(error);
  if (!process.env.MANUS_API_URL || !process.env.MANUS_API_KEY) return { analysis: `Assistant triage: ${error.severity} severity error from ${error.source}.`, suggestedFix: fallback };
  try {
    const response = await fetch(`${process.env.MANUS_API_URL}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.MANUS_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: 'You are a careful incident triage assistant. Do not claim to have changed source code or deployed anything. Return two short paragraphs: diagnosis and safest next fix.' }, { role: 'user', content: JSON.stringify(error) }] }) });
    const payload = await response.json(); const content = payload?.choices?.[0]?.message?.content;
    if (response.ok && content) return { analysis: content, suggestedFix: fallback };
  } catch {}
  return { analysis: `Assistant triage: ${error.severity} severity error from ${error.source}.`, suggestedFix: fallback };
}
function monthBounds(month) { const value = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toISOString().slice(0, 7); const [year, mon] = value.split('-').map(Number); const start = `${value}-01`; const next = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10); return { value, start, next }; }
async function reportFor(companyId, month) { const pool = await connectDb(); const bounds = monthBounds(month); const [rows] = await pool.query(`SELECT id,message,source,severity,status,occurred_on AS occurredOn,notes,assistant_analysis AS assistantAnalysis,suggested_fix AS suggestedFix,fixed_at AS fixedAt,created_at AS createdAt FROM errors WHERE company_id=? AND occurred_on>=? AND occurred_on<? ORDER BY occurred_on DESC, created_at DESC`, [companyId, bounds.start, bounds.next]); const empty = { total: 0, unresolved: 0, resolved: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, bySource: {}, daily: {} }; const summary = rows.reduce((acc, row) => { acc.total++; acc[row.status === 'resolved' ? 'resolved' : 'unresolved']++; acc.bySeverity[row.severity] = (acc.bySeverity[row.severity] || 0) + 1; acc.bySource[row.source] = (acc.bySource[row.source] || 0) + 1; acc.daily[row.occurredOn] = (acc.daily[row.occurredOn] || 0) + 1; return acc; }, empty); return { month: bounds.value, summary, errors: rows }; }

async function api(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': url.origin || '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }); res.end(); return true; }
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'issueflow' });
    if (url.pathname === '/api/auth/session' && req.method === 'GET') { const token = parseCookies(req.headers.cookie).issueflow_session; if (!token) return json(res, 200, { user: null }); const pool = await connectDb(); if (!pool) return json(res, 200, { user: null }); const [rows] = await pool.query(`SELECT u.id, u.company_id AS companyId, u.name, u.email, c.name AS companyName FROM sessions s JOIN users u ON u.id=s.user_id JOIN companies c ON c.id=u.company_id WHERE s.token_hash=? AND s.expires_at > NOW() LIMIT 1`, [hashToken(token)]); return json(res, 200, { user: rows[0] ? publicUser(rows[0]) : null }); }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const token = parseCookies(req.headers.cookie).issueflow_session; if (token && db) await db.query(`DELETE FROM sessions WHERE token_hash=?`, [hashToken(token)]); const secure = !['localhost', '127.0.0.1'].includes(req.headers.host?.split(':')[0]); return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('issueflow_session', '', { maxAge: 0, sameSite: secure ? 'None' : 'Lax', secure }) }); }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') { const body = await readBody(req); const name = String(body.name || '').trim(); const email = safeEmail(body.email); const password = String(body.password || ''); const companyName = String(body.companyName || '').trim(); if (!name || !email || password.length < 8 || !companyName) return json(res, 400, { error: 'Please provide your name, company name, email, and a password of at least 8 characters.' }); const pool = await connectDb(); if (!pool) return json(res, 503, { error: 'Database is not connected yet.' }); const companyId = id(); const userId = id(); const salt = crypto.randomBytes(16).toString('hex'); const passwordHash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve(derived.toString('hex')))); try { await pool.query(`INSERT INTO companies (id,name) VALUES (?,?)`, [companyId, companyName]); await pool.query(`INSERT INTO users (id,company_id,name,email,password_salt,password_hash) VALUES (?,?,?,?,?,?)`, [userId, companyId, name, email, salt, passwordHash]); await createSession(res, userId, req); return json(res, 201, { user: { id: userId, name, email, companyId, companyName } }); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return json(res, 409, { error: 'That email already has an account. Try signing in instead.' }); throw error; } }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') { const body = await readBody(req); const pool = await connectDb(); if (!pool) return json(res, 503, { error: 'Database is not connected yet.' }); const [rows] = await pool.query(`SELECT u.id,u.company_id AS companyId,u.name,u.email,u.password_salt AS passwordSalt,u.password_hash AS passwordHash,c.name AS companyName FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? LIMIT 1`, [safeEmail(body.email)]); const user = rows[0]; if (!user?.passwordHash) return json(res, 401, { error: 'Email or password is not correct.' }); const candidate = await new Promise((resolve, reject) => crypto.scrypt(String(body.password || ''), user.passwordSalt, 64, (err, derived) => err ? reject(err) : resolve(derived.toString('hex')))); if (!crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'))) return json(res, 401, { error: 'Email or password is not correct.' }); await createSession(res, user.id, req); return json(res, 200, { user: publicUser(user) }); }
    if (url.pathname === '/api/auth/google' && req.method === 'GET') { if (!process.env.GOOGLE_CLIENT_ID) return send(res, 503, 'Google sign-in is not configured yet.'); const origin = allowedOrigin(url.searchParams.get('origin')); const nonce = crypto.randomBytes(18).toString('hex'); const state = Buffer.from(JSON.stringify({ nonce, origin })).toString('base64url'); const secure = !['localhost', '127.0.0.1'].includes(req.headers.host?.split(':')[0]); res.setHeader('Set-Cookie', cookie('issueflow_oauth_nonce', nonce, { maxAge: 600, sameSite: secure ? 'None' : 'Lax', secure })); const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth'); authUrl.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', access_type: 'online', state }).toString(); res.writeHead(302, { Location: authUrl.toString() }); res.end(); return true; }
    if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') { await googleCallback(req, res, url); return true; }
    const user = await requireUser(req, res); if (!user) return true;
    if (url.pathname === '/api/errors' && req.method === 'GET') { const pool = await connectDb(); const params = [user.companyId]; let query = `SELECT id,message,source,severity,status,occurred_on AS occurredOn,notes,assistant_analysis AS assistantAnalysis,suggested_fix AS suggestedFix,fixed_at AS fixedAt,created_at AS createdAt FROM errors WHERE company_id=?`; if (url.searchParams.get('month')) { const bounds = monthBounds(url.searchParams.get('month')); query += ` AND occurred_on>=? AND occurred_on<?`; params.push(bounds.start, bounds.next); } query += ' ORDER BY occurred_on DESC, created_at DESC'; const [rows] = await pool.query(query, params); return json(res, 200, { errors: rows }); }
    if (url.pathname === '/api/errors' && req.method === 'POST') { const body = await readBody(req); const message = String(body.message || '').trim(); const source = String(body.source || '').trim(); if (!message || !source) return json(res, 400, { error: 'Add the error message and where it came from.' }); const pool = await connectDb(); const errorId = id(); await pool.query(`INSERT INTO errors (id,company_id,reporter_id,message,source,severity,status,occurred_on,notes) VALUES (?,?,?,?,?,?,?,?,?)`, [errorId,user.companyId,user.id,message,source,body.severity || 'medium',body.status || 'open',body.occurredOn || new Date().toISOString().slice(0,10),String(body.notes || '').trim()]); return json(res, 201, { id: errorId }); }
    const errorMatch = url.pathname.match(/^\/api\/errors\/([^/]+)$/); const analyzeMatch = url.pathname.match(/^\/api\/errors\/([^/]+)\/analyze$/);
    if (analyzeMatch && req.method === 'POST') { const pool = await connectDb(); const [rows] = await pool.query(`SELECT id,message,source,severity,status,occurred_on AS occurredOn FROM errors WHERE id=? AND company_id=? LIMIT 1`, [analyzeMatch[1],user.companyId]); if (!rows[0]) return json(res, 404, { error: 'Error not found.' }); const result = await assistantAnalysis(rows[0]); await pool.query(`UPDATE errors SET assistant_analysis=?, suggested_fix=? WHERE id=? AND company_id=?`, [result.analysis,result.suggestedFix,analyzeMatch[1],user.companyId]); return json(res, 200, result); }
    if (errorMatch && req.method === 'PATCH') { const body = await readBody(req); const pool = await connectDb(); await pool.query(`UPDATE errors SET message=?,source=?,severity=?,status=?,occurred_on=?,notes=?,fixed_at=CASE WHEN ?='resolved' THEN NOW() ELSE NULL END WHERE id=? AND company_id=?`, [String(body.message || '').trim(),String(body.source || '').trim(),body.severity || 'medium',body.status || 'open',body.occurredOn || new Date().toISOString().slice(0,10),String(body.notes || '').trim(),body.status || 'open',errorMatch[1],user.companyId]); return json(res, 200, { ok: true }); }
    if (errorMatch && req.method === 'DELETE') { const pool = await connectDb(); await pool.query(`DELETE FROM errors WHERE id=? AND company_id=?`, [errorMatch[1],user.companyId]); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/reports' && req.method === 'GET') return json(res, 200, await reportFor(user.companyId, url.searchParams.get('month')));
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { console.error(error); if (!res.writableEnded) json(res, 500, { error: 'The server could not complete that request.' }); return true; }
}
async function serveStatic(req, res) {
  if (vite) return vite.middlewares(req, res, () => {});
  let requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); if (requestPath === '/') requestPath = '/index.html'; const filePath = path.join(__dirname, 'dist', requestPath); try { const file = await fs.readFile(filePath); const ext = path.extname(filePath); const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' }; res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(file); } catch { const file = await fs.readFile(path.join(__dirname, 'dist', 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(file); }
}
async function main() { await ensureSchema(); if (!isProduction) vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' }); const server = http.createServer(async (req, res) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (await api(req, res, url) || res.writableEnded) return; await serveStatic(req, res); }); server.listen(PORT, '0.0.0.0', () => console.log(`IssueFlow server listening on ${PORT}`)); }
main().catch(error => { console.error(error); process.exit(1); });
