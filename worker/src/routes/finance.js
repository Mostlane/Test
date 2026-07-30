// Household wealth tracker — a private, owner-only personal-finance backend.
//
// This is deliberately NOT part of the multi-user portal surface: every route
// here is gated to the OWNER account only (env.OWNER_USERNAME, default
// "Jamie Line"), so no member of staff can ever reach a household bill, an
// income figure or a bank transaction. The page that drives it (wealth.html)
// is unlinked from the portal menu.
//
// Storage (all self-migrating — no manual SQL needed, same as the fleet tables):
//   fin_bills         recurring monthly bills   (JSON blob per row)
//   fin_income        income sources            (JSON blob per row)
//   fin_transactions  imported bank transactions (indexed cols + JSON)
//   app_config key `fin:config`  opening balance, categories, auto-rules
//
// Routes (every one OWNER-ONLY):
//   GET  /finance/data                 -> { ok, bills, income, config }
//   POST /finance/bill                 -> add / update a bill
//   POST /finance/bill/delete          -> { id }
//   POST /finance/income               -> add / update an income source
//   POST /finance/income/delete        -> { id }
//   POST /finance/config               -> save opening balance / categories / rules
//   GET  /finance/transactions?from=&to=&q=&category=&limit=&offset=
//   POST /finance/transactions/import  -> { transactions:[…] } (dedup, auto-categorise)
//   POST /finance/transaction          -> update one (recategorise / rename)
//   POST /finance/transaction/delete   -> { id }
//   POST /finance/transactions/clear   -> { account? }  wipe all / one account
//   GET  /finance/spending?from=&to=   -> aggregates for the charts

import { corsHeaders } from "../lib/http.js";
import { requireSession } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";

// ── Self-migration ──────────────────────────────────────────────────────────
// Runs once per isolate; CREATE … IF NOT EXISTS so it is safe to call on every
// request. DDL goes through env.DB directly (the tenant guard only polices
// FROM/INTO/UPDATE/JOIN queries, not CREATE).
let migrated = false;
async function ensureTables(env) {
  if (migrated) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS fin_bills (
      tenant_id INTEGER NOT NULL DEFAULT 1,
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS fin_income (
      tenant_id INTEGER NOT NULL DEFAULT 1,
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS fin_transactions (
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      id          TEXT PRIMARY KEY,
      dt          TEXT NOT NULL,           -- ISO date (YYYY-MM-DD)
      description TEXT NOT NULL,
      amount      REAL NOT NULL,           -- signed: +in / -out
      category    TEXT,
      account     TEXT,
      hash        TEXT NOT NULL,           -- dedupe key
      data        TEXT
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS fin_tx_hash ON fin_transactions (tenant_id, hash)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS fin_tx_dt ON fin_transactions (tenant_id, dt)`),
  ]);
  migrated = true;
}

// ── Owner gate ──────────────────────────────────────────────────────────────
async function ownerGate(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { code: 401, error: "Not authenticated" };
  const OWNER = env.OWNER_USERNAME || "Jamie Line";
  if (sess.user.username !== OWNER) return { code: 403, error: "This area is private." };
  return { sess };
}

// ── Config (opening balance, categories, auto-categorise rules) ─────────────
const DEFAULT_CATEGORIES = [
  "Groceries", "Eating out", "Fuel / transport", "Shopping", "Bills & utilities",
  "Rent / mortgage", "Subscriptions", "Health", "Kids", "Cash", "Savings & transfers",
  "Income", "Other",
];
// Sensible starter rules for common UK merchants — the user can edit these on
// the page. { match: lowercase substring, category }. First match wins.
const DEFAULT_RULES = [
  { match: "tesco", category: "Groceries" },
  { match: "sainsbury", category: "Groceries" },
  { match: "asda", category: "Groceries" },
  { match: "aldi", category: "Groceries" },
  { match: "lidl", category: "Groceries" },
  { match: "morrison", category: "Groceries" },
  { match: "co-op", category: "Groceries" },
  { match: "iceland", category: "Groceries" },
  { match: "waitrose", category: "Groceries" },
  { match: "m&s", category: "Groceries" },
  { match: "greggs", category: "Eating out" },
  { match: "mcdonald", category: "Eating out" },
  { match: "costa", category: "Eating out" },
  { match: "starbucks", category: "Eating out" },
  { match: "just eat", category: "Eating out" },
  { match: "deliveroo", category: "Eating out" },
  { match: "uber eats", category: "Eating out" },
  { match: "nando", category: "Eating out" },
  { match: "shell", category: "Fuel / transport" },
  { match: "bp ", category: "Fuel / transport" },
  { match: "esso", category: "Fuel / transport" },
  { match: "texaco", category: "Fuel / transport" },
  { match: "trainline", category: "Fuel / transport" },
  { match: "uber", category: "Fuel / transport" },
  { match: "tfl", category: "Fuel / transport" },
  { match: "amazon", category: "Shopping" },
  { match: "argos", category: "Shopping" },
  { match: "ebay", category: "Shopping" },
  { match: "b&q", category: "Shopping" },
  { match: "screwfix", category: "Shopping" },
  { match: "netflix", category: "Subscriptions" },
  { match: "spotify", category: "Subscriptions" },
  { match: "disney", category: "Subscriptions" },
  { match: "youtube", category: "Subscriptions" },
  { match: "prime video", category: "Subscriptions" },
  { match: "apple.com", category: "Subscriptions" },
  { match: "google", category: "Subscriptions" },
  { match: "british gas", category: "Bills & utilities" },
  { match: "octopus energy", category: "Bills & utilities" },
  { match: "edf", category: "Bills & utilities" },
  { match: "eon", category: "Bills & utilities" },
  { match: "e.on", category: "Bills & utilities" },
  { match: "thames water", category: "Bills & utilities" },
  { match: "council tax", category: "Bills & utilities" },
  { match: "vodafone", category: "Bills & utilities" },
  { match: "ee ", category: "Bills & utilities" },
  { match: "o2", category: "Bills & utilities" },
  { match: "three", category: "Bills & utilities" },
  { match: "sky", category: "Bills & utilities" },
  { match: "virgin media", category: "Bills & utilities" },
  { match: "bt ", category: "Bills & utilities" },
  { match: "boots", category: "Health" },
  { match: "pharmacy", category: "Health" },
  { match: "puregym", category: "Health" },
  { match: "the gym", category: "Health" },
];

function defaultConfig() {
  return {
    openingBalance: 0,
    openingDate: new Date().toISOString().slice(0, 10),
    currency: "£",
    categories: DEFAULT_CATEGORIES.slice(),
    rules: DEFAULT_RULES.slice(),
  };
}

async function getConfig(env, db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE key=? AND tenant_id=?")
    .bind("fin:config", db.tenantId).first();
  if (!row) return defaultConfig();
  try {
    const c = JSON.parse(row.value);
    // Fill any gaps from defaults so an older/partial blob still works.
    return Object.assign(defaultConfig(), c);
  } catch { return defaultConfig(); }
}

async function saveConfig(env, db, config) {
  await db.prepare(`INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(db.tenantId, "fin:config", JSON.stringify(config)).run();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const rid = (p) => p + Math.random().toString(36).slice(2, 9);

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// A stable per-transaction fingerprint so re-uploading the same statement never
// duplicates rows. date + amount (to the penny) + squashed description.
function txHash(dt, amount, description, account) {
  const norm = String(description || "").toLowerCase().replace(/\s+/g, " ").trim();
  return [dt, Math.round(num(amount) * 100), norm, account || ""].join("|");
}

// Apply the user's auto-categorise rules to a description. Money-in defaults to
// "Income" when no rule matches; money-out to "Other".
function categorise(description, amount, rules) {
  const d = String(description || "").toLowerCase();
  for (const r of rules || []) {
    if (r && r.match && d.includes(String(r.match).toLowerCase())) return r.category || "Other";
  }
  return num(amount) > 0 ? "Income" : "Other";
}

// ── Handler ─────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  const gate = await ownerGate(env, request);
  if (gate.error) return json({ ok: false, error: gate.error }, gate.code);

  await ensureTables(env);
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);

  // ── Everything the page needs to draw the setup + forecast ────────────────
  if (method === "GET" && pathname === "/finance/data") {
    const [bills, income] = await Promise.all([
      db.prepare("SELECT data FROM fin_bills WHERE tenant_id=?").bind(db.tenantId).all(),
      db.prepare("SELECT data FROM fin_income WHERE tenant_id=?").bind(db.tenantId).all(),
    ]);
    const parse = (r) => { try { return JSON.parse(r.data); } catch { return null; } };
    const config = await getConfig(env, db);
    const txCount = await db.prepare("SELECT COUNT(*) n FROM fin_transactions WHERE tenant_id=?").bind(db.tenantId).first();
    return json({
      ok: true,
      bills: (bills.results || []).map(parse).filter(Boolean),
      income: (income.results || []).map(parse).filter(Boolean),
      config,
      txCount: txCount ? txCount.n : 0,
    });
  }

  // ── Add / update a bill ────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/finance/bill") {
    const b = await request.json().catch(() => ({}));
    if (!String(b.name || "").trim()) return json({ ok: false, error: "A bill needs a name" }, 400);
    const id = String(b.id || "").trim() || rid("B-");
    const bill = {
      id,
      name: String(b.name).trim(),
      amount: num(b.amount),
      dayOfMonth: Math.min(31, Math.max(1, Math.round(num(b.dayOfMonth, 1)))),
      category: String(b.category || "Bills & utilities"),
      notes: String(b.notes || "").trim(),
      active: b.active !== false,
    };
    await db.prepare(`INSERT INTO fin_bills (id, tenant_id, data) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .bind(id, db.tenantId, JSON.stringify(bill)).run();
    return json({ ok: true, bill });
  }

  if (method === "POST" && pathname === "/finance/bill/delete") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    await db.prepare("DELETE FROM fin_bills WHERE id=? AND tenant_id=?").bind(id, db.tenantId).run();
    return json({ ok: true });
  }

  // ── Add / update an income source ──────────────────────────────────────────
  if (method === "POST" && pathname === "/finance/income") {
    const b = await request.json().catch(() => ({}));
    if (!String(b.name || "").trim()) return json({ ok: false, error: "An income source needs a name" }, 400);
    const freq = ["weekly", "fortnightly", "fourweekly", "monthly"].includes(b.frequency) ? b.frequency : "weekly";
    const id = String(b.id || "").trim() || rid("I-");
    const inc = {
      id,
      name: String(b.name).trim(),
      amount: num(b.amount),
      frequency: freq,
      // weekly/fortnightly/4-weekly are anchored to a real pay date; monthly to a day-of-month.
      anchorDate: String(b.anchorDate || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
      dayOfMonth: Math.min(31, Math.max(1, Math.round(num(b.dayOfMonth, 1)))),
      notes: String(b.notes || "").trim(),
      active: b.active !== false,
    };
    await db.prepare(`INSERT INTO fin_income (id, tenant_id, data) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .bind(id, db.tenantId, JSON.stringify(inc)).run();
    return json({ ok: true, income: inc });
  }

  if (method === "POST" && pathname === "/finance/income/delete") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    await db.prepare("DELETE FROM fin_income WHERE id=? AND tenant_id=?").bind(id, db.tenantId).run();
    return json({ ok: true });
  }

  // ── Save config (opening balance, categories, auto-rules) ─────────────────
  if (method === "POST" && pathname === "/finance/config") {
    const b = await request.json().catch(() => ({}));
    const cur = await getConfig(env, db);
    if (b.openingBalance !== undefined) cur.openingBalance = num(b.openingBalance);
    if (b.openingDate) cur.openingDate = String(b.openingDate).slice(0, 10);
    if (b.currency) cur.currency = String(b.currency).slice(0, 3);
    if (Array.isArray(b.categories)) cur.categories = b.categories.map(c => String(c).slice(0, 60)).filter(Boolean);
    if (Array.isArray(b.rules)) {
      cur.rules = b.rules
        .filter(r => r && r.match)
        .map(r => ({ match: String(r.match).toLowerCase().slice(0, 60), category: String(r.category || "Other").slice(0, 60) }));
    }
    await saveConfig(env, db, cur);
    return json({ ok: true, config: cur });
  }

  // ── List transactions (paged, filterable) ─────────────────────────────────
  if (method === "GET" && pathname === "/finance/transactions") {
    const where = ["tenant_id=?"];
    const binds = [db.tenantId];
    const from = searchParams.get("from"), to = searchParams.get("to");
    const q = searchParams.get("q"), cat = searchParams.get("category");
    if (from) { where.push("dt>=?"); binds.push(from); }
    if (to) { where.push("dt<=?"); binds.push(to); }
    if (cat) { where.push("category=?"); binds.push(cat); }
    if (q) { where.push("LOWER(description) LIKE ?"); binds.push("%" + q.toLowerCase() + "%"); }
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get("limit") || "200", 10)));
    const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10));
    const sql = `SELECT id, dt, description, amount, category, account FROM fin_transactions
      WHERE ${where.join(" AND ")} ORDER BY dt DESC, id DESC LIMIT ? OFFSET ?`;
    const { results } = await db.prepare(sql).bind(...binds, limit, offset).all();
    const total = await db.prepare(`SELECT COUNT(*) n FROM fin_transactions WHERE ${where.join(" AND ")}`).bind(...binds).first();
    return json({ ok: true, transactions: results || [], total: total ? total.n : 0, limit, offset });
  }

  // ── Import a parsed statement (dedup + auto-categorise) ───────────────────
  if (method === "POST" && pathname === "/finance/transactions/import") {
    const b = await request.json().catch(() => ({}));
    const rows = Array.isArray(b.transactions) ? b.transactions : [];
    if (!rows.length) return json({ ok: false, error: "No transactions to import" }, 400);
    if (rows.length > 5000) return json({ ok: false, error: "Too many rows in one import (max 5000) — split the file." }, 400);
    const config = await getConfig(env, db);
    const account = String(b.account || "").slice(0, 60);
    let created = 0, skipped = 0;
    const stmts = [];
    for (const r of rows) {
      const dt = String(r.date || r.dt || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { skipped++; continue; }
      const amount = num(r.amount);
      if (!amount) { skipped++; continue; }
      const description = String(r.description || "").slice(0, 200).trim();
      const acct = String(r.account || account).slice(0, 60);
      const hash = txHash(dt, amount, description, acct);
      // Honour a user-set category from the review step; else auto-categorise.
      const category = String(r.category || "").trim() || categorise(description, amount, config.rules);
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO fin_transactions (id, tenant_id, dt, description, amount, category, account, hash, data)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(rid("T-"), db.tenantId, dt, description, amount, category, acct, hash, null));
    }
    // Batch in chunks so a big statement doesn't exceed D1's statement cap.
    for (let i = 0; i < stmts.length; i += 100) {
      const chunk = stmts.slice(i, i + 100);
      const res = await db.batch(chunk);
      for (const r of res) created += (r.meta && r.meta.changes) ? r.meta.changes : 0;
    }
    skipped += (stmts.length - created);
    return json({ ok: true, created, skipped, received: rows.length });
  }

  // ── Update one transaction (recategorise / rename) ────────────────────────
  if (method === "POST" && pathname === "/finance/transaction") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    const sets = [], binds = [];
    if (b.category !== undefined) { sets.push("category=?"); binds.push(String(b.category).slice(0, 60)); }
    if (b.description !== undefined) { sets.push("description=?"); binds.push(String(b.description).slice(0, 200)); }
    if (!sets.length) return json({ ok: false, error: "Nothing to update" }, 400);
    await db.prepare(`UPDATE fin_transactions SET ${sets.join(", ")} WHERE id=? AND tenant_id=?`)
      .bind(...binds, id, db.tenantId).run();
    return json({ ok: true });
  }

  if (method === "POST" && pathname === "/finance/transaction/delete") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    await db.prepare("DELETE FROM fin_transactions WHERE id=? AND tenant_id=?").bind(id, db.tenantId).run();
    return json({ ok: true });
  }

  // ── Clear transactions (all, or one account) ──────────────────────────────
  if (method === "POST" && pathname === "/finance/transactions/clear") {
    const b = await request.json().catch(() => ({}));
    if (b.account) {
      await db.prepare("DELETE FROM fin_transactions WHERE tenant_id=? AND account=?").bind(db.tenantId, String(b.account)).run();
    } else {
      await db.prepare("DELETE FROM fin_transactions WHERE tenant_id=?").bind(db.tenantId).run();
    }
    return json({ ok: true });
  }

  // ── Spending aggregates for the charts ────────────────────────────────────
  if (method === "GET" && pathname === "/finance/spending") {
    const where = ["tenant_id=?"];
    const binds = [db.tenantId];
    const from = searchParams.get("from"), to = searchParams.get("to");
    if (from) { where.push("dt>=?"); binds.push(from); }
    if (to) { where.push("dt<=?"); binds.push(to); }
    const w = where.join(" AND ");

    // Spend by category (money OUT only), biggest first.
    const byCat = await db.prepare(
      `SELECT category, COUNT(*) n, SUM(-amount) total FROM fin_transactions
       WHERE ${w} AND amount<0 GROUP BY category ORDER BY total DESC`
    ).bind(...binds).all();

    // Top merchants (money OUT), squashed to a rough merchant key.
    const merchants = await db.prepare(
      `SELECT description, COUNT(*) n, SUM(-amount) total FROM fin_transactions
       WHERE ${w} AND amount<0 GROUP BY LOWER(description) ORDER BY total DESC LIMIT 15`
    ).bind(...binds).all();

    // Money in vs out by calendar month.
    const monthly = await db.prepare(
      `SELECT substr(dt,1,7) ym,
              SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) inn,
              SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) out
       FROM fin_transactions WHERE ${w} GROUP BY ym ORDER BY ym`
    ).bind(...binds).all();

    const totals = await db.prepare(
      `SELECT SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) inn,
              SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) out,
              MIN(dt) first, MAX(dt) last, COUNT(*) n
       FROM fin_transactions WHERE ${w}`
    ).bind(...binds).first();

    return json({
      ok: true,
      byCategory: byCat.results || [],
      merchants: merchants.results || [],
      monthly: monthly.results || [],
      totals: totals || { inn: 0, out: 0, n: 0 },
    });
  }

  return json({ ok: false, error: "Not found: " + pathname }, 404);
}
