# Coal Park Lane — booking system setup (one-time, ~10 minutes)

The website already talks to a booking backend. You just need to stand that
backend up once in the Cloudflare dashboard. The database is **already created**
for you (`coalparklane`) — these steps create the little service that reads and
writes it, and switch on the admin page.

Everything here is dashboard clicking — no coding, no wrangler, same as your
other Cloudflare bits.

---

## 1. Create the Worker (the booking service)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker**.
2. Name it exactly **`coalparklane-api`** → **Deploy** (a placeholder deploy is fine).
3. Open the new worker → **Settings** → **Build** (Workers Builds) → **Connect**:
   - Repository: **Mostlane/Test**
   - Production branch: **main**
   - **Root directory: `football-ground/worker`**
   - Build command: *(leave blank)*
   - Deploy command: *(leave the default — `npx wrangler deploy`)*
4. Save. It will build and deploy from `football-ground/worker/` on every push to
   `main`, exactly like `mostlane-api`. The database binding (`DB` →
   `coalparklane`) is set automatically from `wrangler.toml`, so you don't bind it
   by hand.

## 2. Set the admin password (required)

Worker → **Settings** → **Variables and Secrets** → **Add**:

| Name             | Type   | Value                                  |
|------------------|--------|----------------------------------------|
| `ADMIN_PASSWORD` | Secret | *(a password only you know)*           |

Click **Deploy** after adding it.

That password is what you type on the admin page. Change it any time here.

## 3. (Optional) Get an email when an enquiry lands

If you want an email every time someone enquires, add:

| Name             | Type   | Value                                  |
|------------------|--------|----------------------------------------|
| `RESEND_API_KEY` | Secret | *(a Resend API key)*                   |

…and set the **`NOTIFY_EMAIL`** variable (already listed in the worker's
variables, currently blank) to the address you want notified, and
**`EMAIL_FROM`** to a Resend-verified sender. Without these, enquiries still save
fine — you just check the admin page instead of getting an email.

---

## 4. Check the address matches

The worker's address will be shown at the top of its page, something like:

```
https://coalparklane-api.jamie-def.workers.dev
```

The website and admin page are already pointed at **exactly that**. If your
account's `*.workers.dev` subdomain is NOT `jamie-def`, tell me the real address
and I'll update two lines (the `API_BASE` in `admin.html` and the
`bookingEndpoint` in `script.js`).

---

## 5. Use it

- **Admin page:** `https://mostlane-portal.com/football-ground/admin.html`
  → sign in with your `ADMIN_PASSWORD`.
- **Enquiries** from the website appear here automatically as **New**. Set each to
  Contacted / Confirmed / Declined, add private notes, and they show on the
  **Calendar** once Confirmed.
- **Add your regular club slots** with **+ Add a booking** so the calendar shows
  everything the ground is being used for — your at-a-glance guard against
  double-booking.

---

## What this deliberately does NOT do yet (Phase 2)

- No online payment, no self-service slot picking, no live public availability.
- The data model is already payment-ready. When you're ready to take money
  online we add Stripe on top of this — it's an addition, not a rebuild. Before
  that, you'll need: a Stripe account for the ground's company, a domain
  (e.g. coalparklane.co.uk), and a written cancellation/refund policy to show
  before payment.
