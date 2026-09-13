# Coal Park Lane — go-live setup (one-time, all dashboard clicks)

The whole thing — public site, admin panel and bookings database — runs from
**one Cloudflare Worker** (`coalparklane-api`) on your own domain
**coalparklane.com**. Nothing touches Mostlane or GitHub Pages.

- `coalparklane.com` → the public marketing site + enquiry form
- `admin.coalparklane.com` → the admin panel (bookings)
- Both sit **behind Cloudflare Access**, so nothing is visible to the public until
  you deliberately open it, and the admin stays locked forever.

Do these once, in order, after Cloudflare shows the domain as **Active**.

---

## 1. Create the Worker

1. Cloudflare → **Workers & Pages** → **Create** → **Worker**.
2. Name it exactly **`coalparklane-api`** → **Deploy** (the placeholder is fine).
3. Open it → **Settings** → **Build** → **Connect** to Git:
   - Repository: **Mostlane/Test**
   - Production branch: **main**
   - **Root directory: `football-ground/worker`**
   - Build/deploy commands: leave the defaults.
4. Save. From now on it rebuilds on every push to `main`. The database
   (`DB` → `coalparklane`) and the static site (`./public`) bind automatically
   from `wrangler.toml` — nothing to wire by hand.

## 2. Set the admin password

Worker → **Settings** → **Variables and Secrets** → **Add**:

| Name             | Type   | Value                         |
|------------------|--------|-------------------------------|
| `ADMIN_PASSWORD` | Secret | *(a strong password only you know)* |

Click **Deploy**. This is what you type on the admin page.

## 3. Put BOTH addresses behind Cloudflare Access (this is what hides it)

Cloudflare → **Zero Trust** → **Access** → **Applications** → **Add an application**
→ **Self-hosted**. Do this **twice**:

**a) The whole public site — private during the build**
- Application name: `Coal Park Lane (site)`
- Domains: `coalparklane.com` **and** `www.coalparklane.com`
- Policy → **Allow**, Include → **Emails** → *your email address(es)*
- Accept method: **One-time PIN** (Cloudflare emails you a code).
- Save. → *This is the "keep it hidden" gate. You DELETE this one app at launch;
  everything else stays.*

**b) The admin — locked forever**
- Application name: `Coal Park Lane admin`
- Domain: `admin.coalparklane.com`
- Same **Allow / your emails / One-time PIN** policy.
- Save.

## 4. Point the domain at the worker (custom domains)

Back on the worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**,
add each of these (Cloudflare creates the DNS records for you):
- `coalparklane.com`
- `www.coalparklane.com`
- `admin.coalparklane.com`

Because Access (step 3) is already in front of these hostnames, the very first
moment they resolve they already ask for your email + PIN — there is no public
window.

## 5. Flip the site live (Claude does this)

Tell Claude the domains + Access are set up. Claude merges the site code so the
worker serves the full site. Visit `coalparklane.com` → you'll get the Cloudflare
PIN prompt → then the site. Visit `admin.coalparklane.com` → PIN → the admin
panel → sign in with your `ADMIN_PASSWORD`.

---

## 6. (Optional) Get an email when an enquiry lands

Add secret `RESEND_API_KEY`, set the `NOTIFY_EMAIL` variable to where you want it,
and `EMAIL_FROM` to a Resend-verified sender on `coalparklane.com`. Without this,
enquiries still save — you just read them in the admin panel.

## 7. Launching to the public (later, when you're ready)

Delete **only** the `Coal Park Lane (site)` Access application (step 3a). The
public site is then live to everyone. The `Coal Park Lane admin` app stays, so the
admin remains locked. That's the whole launch — one deletion.

---

## Using it

- **Enquiries** from the site appear in the admin as **New**. Set each to
  Contacted / Confirmed / Declined, add private notes; Confirmed ones show on the
  **Calendar**.
- **Add your regular club slots** with **+ Add a booking** so the calendar is your
  at-a-glance guard against double-booking.

## Not yet (Phase 2)

No online payment / self-service booking yet — the data model is already
payment-ready, so Stripe is an addition later, not a rebuild. Before that you'll
need: a Stripe account for the ground, and a written cancellation/refund policy.
