# Mostlane Portal → Multi-Tenant SaaS Product

**A design brief for turning the Mostlane Portal into something you can licence and sell.**
Written 12 July 2026. Plain-English, for Jamie (non-developer). Nothing here is built yet — this is the plan and the honest trade-offs.

---

## 1. The one decision everything hangs on

You described it like this:

> when they log in, they create their own portal… automatically create their own workers, codes, KV spaces, D1 & R2 so everything is personalised to them.

That instinct is completely natural — "each customer gets their own copy" *feels* like the safe, clean thing. But it's actually the **wrong architecture for a SaaS product**, and I need to be straight with you about why before we design anything else, because it changes everything downstream.

There are three ways to build this. Only one of them is the right default.

### Model A — Infrastructure-per-tenant (what you described)
Every company that signs up gets their **own** Worker, D1, R2 bucket and KV namespace, spun up automatically.

- ❌ **Cloudflare won't let you scale it.** A Cloudflare account has hard caps — you can't have 500 separate D1 databases and 500 Workers on one account without hitting limits and per-item costs. You'd be fighting the platform from customer ~50 onwards.
- ❌ **Every update becomes 500 deployments.** Right now you fix a bug by pasting *one* `worker.js`. In Model A, a bug fix means re-deploying every customer's separate worker. You cannot run that by pasting from a phone. It's not "harder" — it's impossible to operate.
- ❌ **Provisioning is fragile.** Auto-creating real infrastructure means calling Cloudflare's API with a powerful token, and every half-created customer (network blip mid-signup) is a manual clean-up job.
- ✅ The *only* thing it buys you is hard physical data separation — which most customers never actually ask for, and which Model B gives you 95% of anyway.

### Model B — One shared system, separated by a `tenant_id` (RECOMMENDED)
**One** Worker, **one** D1 database, **one** R2 bucket. Every row in every table gets a `tenant_id` column. Acme Ltd is tenant 7, BuildCo is tenant 12. The code makes it impossible for tenant 7 to ever see tenant 12's data.

- ✅ **This is how real SaaS is built** — Slack, Notion, Xero, Monday.com all work this way. It's the boring, proven answer.
- ✅ **Signing up a new customer = inserting one row.** No infrastructure to create. It's instant and free. That's your "automatic provisioning" — it just isn't *infrastructure* provisioning, it's *data* provisioning.
- ✅ **One deploy updates everyone.** You keep your paste-one-worker workflow (though you'll want to outgrow it — see §9).
- ✅ Scales to thousands of companies on the infrastructure you already have.
- ⚠️ The one real risk: a coding mistake in the "filter by tenant_id" logic = one customer sees another's data. This is a *solvable* engineering discipline problem (§6), not an architectural flaw.

### Model C — Shared Worker, one D1 *per customer* (the enterprise upsell)
Middle ground: shared code, but each customer's data lives in its own D1. Cloudflare *does* let you create D1s via API, so this is automatable.

- Use this **later, for big/regulated customers** who contractually demand physical data isolation and will pay extra for it. Your architecture can support both: most customers on shared Model B, a premium tier on Model C.

> **Recommendation: Build Model B. Keep Model C as a future premium tier.**
> The rest of this document assumes Model B.

---

## 2. The genuinely good news

Your current portal is a **much better starting point than you probably realise.** You already have, built and working:

| You already have | Why it matters for SaaS |
|---|---|
| One consolidated Worker + one D1 | This is *exactly* Model B's shape. No re-platforming. |
| Server-side sessions & tokens | Multi-tenant auth builds directly on this. |
| A flexible **permissions** system (`user_permissions`) | Becomes your per-customer roles with almost no change. |
| A **theme engine** (per-user accent + logo/background) | This is your "personalised to them" branding — already done, just needs to key off tenant instead of user. |
| An **audit log** middleware on every write | Enterprise buyers *demand* this. You have it already. |
| Device locking, password policy, reset flows | All the boring security plumbing customers expect. |

**This is a retrofit, not a rewrite.** The hard, unglamorous 80% of a B2B SaaS product already exists. What's missing is the tenant layer, signup, and billing.

---

## 3. What a customer actually experiences

```
1. They visit  app.yourproduct.com  (a marketing + signup page — you don't have a domain yet, §8)
2. They click "Start free trial", enter company name + their email + a card (Stripe)
3. Behind the scenes: one `tenants` row is created, they become that tenant's ADMIN
4. They land on  acme.yourproduct.com  — their portal, their logo, their colours
5. They add their staff (invite by email → staff set a password → log in)
6. Staff use the SAME generic app; login tells the system which company they belong to
7. Each month Stripe charges them per active user. Non-payment → portal goes read-only.
```

No infrastructure is created at any step. Step 3 is a database insert. That's the whole "magic".

---

## 4. The three levels of user

You'll have a role hierarchy you don't have today:

- **You (Super-Admin / platform owner).** Can see the list of all companies, their user counts, their billing status. A separate console (§7). Only you.
- **Tenant Admin (their "Jamie").** The person who signed the company up. Manages *their* users, *their* branding, *their* subscription. Cannot see any other company. This maps onto your existing `FullAccess` permission.
- **User (their staff).** Uses the app. Sees only their company. Maps onto your existing per-permission model exactly as it works now.

---

## 5. What changes in the database

Every table gets a `tenant_id`. Concretely:

```sql
-- NEW: the master list of customer companies
CREATE TABLE tenants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,     -- 'acme'  → acme.yourproduct.com
  company_name TEXT NOT NULL,
  status      TEXT DEFAULT 'trialing',  -- trialing | active | past_due | suspended | cancelled
  plan        TEXT DEFAULT 'standard',
  seat_limit  INTEGER,                  -- optional hard cap
  branding    TEXT,                     -- JSON: logo URL, accent colour, menu bg
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  trial_ends_at TEXT
);

-- EVERY existing table gains:  tenant_id INTEGER NOT NULL
-- and every index/lookup gains tenant_id as its first column.
```

**One important knock-on:** today usernames are **globally unique** (`users.username … UNIQUE`). In a multi-company world, two different companies will both have a "jsmith" or an "admin". So the rule changes to **unique *per tenant*** — the identity key becomes `(tenant_id, username)`. Login has to resolve which company first (from the subdomain, or ask "which company?" if using a shared login page). This is a real but well-understood change; it touches auth, sessions, permissions, and the `findUser` logic you already have.

R2 (files/images) doesn't need separate buckets — every file key just gets prefixed with the tenant: `tenant/7/asset-images/…`. Same bucket, walled-off by key path.

---

## 6. The safety discipline (this is the important bit)

In Model B, **one class of bug leaks Company A's data to Company B.** Preventing it is a discipline, and it's very achievable:

1. **The session carries the tenant.** When someone logs in, their session row records their `tenant_id`. It's never taken from the URL or anything the browser can fake.
2. **One choke-point adds the filter.** Every database query goes through a single helper that automatically injects `WHERE tenant_id = ?`. Individual route code can't "forget" it because it never writes the filter by hand.
3. **Automated cross-tenant tests.** Part of shipping is a test that logs in as Company A and *tries* to read Company B's data, and fails. This runs on every change. (You already have a Playwright harness — this extends it.)

Do these three things and tenant isolation is solid. This is exactly what every SaaS does.

---

## 7. Your super-admin console

A small new area only you can reach:
- List every company, their user count, plan, billing status, last activity.
- Suspend / reactivate a company.
- Impersonate a tenant admin for support ("log in as Acme's admin to see what they see") — you already built **View As** for this; it extends naturally.
- Platform-wide metrics: total companies, total seats, monthly revenue.

---

## 8. The URL / domain question

You said you don't have a general URL. You'll need:

- **One product domain**, e.g. `yourproduct.com` (pick and buy a brand — this is a naming/marketing exercise as much as technical).
- **A wildcard subdomain** `*.yourproduct.com` so every customer gets `theircompany.yourproduct.com` automatically. Cloudflare does this well.
- **Cloudflare for SaaS ("custom hostnames")** if you later want to let a customer use *their own* domain (`portal.acme.com`) pointing at your system. Nice premium feature; not needed for launch.

The generic app is **one codebase** served to every subdomain. The subdomain tells it which company's branding and data to load. Your existing static-pages-on-Cloudflare-Pages setup already fits this.

---

## 9. Billing — per-user monthly subscription

**Use Stripe.** Don't build billing yourself.

- **Stripe Billing** with a **per-seat price** (e.g. £X per active user per month).
- Signup collects the card via **Stripe Checkout** (hosted by Stripe — you never touch card data, which saves you an enormous compliance burden).
- A **Stripe webhook** hits your Worker on every billing event:
  - payment succeeded → keep tenant `active`
  - payment failed / subscription past due → flip tenant to `past_due`, then `suspended` (portal becomes read-only or locked with a "please update billing" screen)
  - subscription cancelled → `cancelled`
- **Seat counting:** when a tenant admin adds/removes a user, you report the new seat count to Stripe so the next invoice is right. Decide the fairness rule up front: do you bill on *active* users, *peak in the month*, or *seats provisioned*? (Recommend: active users at time of invoice, with a small minimum.)
- **Free trial:** Stripe supports a trial period natively (e.g. 14 days) — `status = trialing` until it converts.

---

## 10. The parts people forget (but you can't)

Selling software *to other companies* is a bigger responsibility than running your own portal:

- **You become a data processor.** Other companies' staff data lives in your system. In the UK that means **GDPR obligations**: a **Data Processing Agreement (DPA)** you offer every customer, a privacy policy, a way to export and delete a company's data on request, and a breach-notification plan.
- **Terms of Service / Licence agreement.** What they're paying for, uptime expectations, what happens to their data if they leave or you shut down. Worth a solicitor.
- **Data export & offboarding.** A cancelled customer must be able to get their data out (CSV/JSON export per tenant) and be assured it's deleted after.
- **Backups & recovery.** One shared D1 is now *everyone's* business-critical data. Scheduled backups become non-negotiable.
- **Support & onboarding.** A self-serve signup means strangers hit your product with no hand-holding. It needs to be genuinely self-explanatory (your `help.html` system is a strong asset here).
- **Status / uptime.** Business customers will ask "what happens when it's down". Even a simple status page helps.

---

## 11. Honest effort assessment

This is a **substantial project** — think months, not a weekend — but it's *de-risked* by how much you already have. Rough shape of the work, largest-first:

1. **The `tenant_id` retrofit** across the schema, the Worker routes, and the query layer (§5, §6). The biggest and most careful piece.
2. **Signup + Stripe billing + webhooks** (§9). Well-trodden ground, lots of examples.
3. **Subdomain routing + per-tenant branding** (§8). Small, since the theme engine exists.
4. **Super-admin console** (§7). Small-to-medium.
5. **Legal/compliance/backups** (§10). Not code, but can't be skipped.

**One hard truth about tooling:** you currently deploy by pasting `worker.js` from your phone into the Cloudflare dashboard, and edit D1 by hand. That's fine for one portal you own. It is **not** a safe way to run software that dozens of other companies depend on for payroll and compliance. Before you have paying customers, you'll want a proper deploy pipeline (git → automatic deploy) and database migrations that run themselves. This is part of "becoming a software business", and it's the right time to invest in it.

---

## 12. Suggested phased roadmap

**Phase 0 — Decide & name (no code).** Confirm Model B. Pick and buy the product domain/brand. Sketch pricing.

**Phase 1 — Multi-tenant core.** Add `tenants` table + `tenant_id` everywhere. Make **your own Mostlane data "Tenant 1"** so the live system keeps working throughout. Add the query choke-point (§6) and the cross-tenant isolation test. *Nothing customer-facing yet — this is the foundation.*

**Phase 2 — Self-serve signup + billing.** Signup page, Stripe Checkout + trial, webhooks, suspend-on-non-payment. Now a stranger can create a company and pay.

**Phase 3 — Branding & subdomains.** `company.yourproduct.com`, tenant admin sets logo/colours (reuse the theme engine). Polish the "new empty portal" first-run experience.

**Phase 4 — Super-admin console + operations.** Your platform overview, impersonation, backups, data export, status page.

**Phase 5 — Go to market.** ToS/DPA/privacy policy, onboarding guides, then invite a friendly first customer (a "design partner") before opening the doors.

**Phase 6 (later) — Enterprise tier.** Model C (dedicated D1) and custom domains for customers who'll pay for isolation.

---

## 13. The two things I'd want from you next

1. **A gut-check on Model B vs A.** I've recommended the shared-tenant model strongly — but it *is* a change from what you pictured. If hard per-customer data separation is a hill you want to die on (some markets demand it), say so and we design around Model C from the start. Otherwise we go Model B.

2. **Where to start.** Realistically Phase 1 is the foundation everything else needs. I'd suggest we begin by designing the exact `tenant_id` retrofit against your real schema — i.e. turn §5 and §6 into a concrete, table-by-table plan and the query helper — while you work on Phase 0 (the name/domain/pricing decisions that are yours to make, not mine).

---

*This is a design document, not built code. Nothing in your live portal has been changed.*
