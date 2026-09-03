# Parkside Football Ground — website

A self-contained marketing + enquiry website for a football ground available to hire.
Everything lives in this one folder — you can move it into its own repository and
its own domain later without touching anything else.

```
football-ground/
├── index.html    ← the whole site (one page, all sections)
├── styles.css    ← the look and feel
├── script.js     ← behaviour + the ONE place you edit your details
├── assets/       ← put your photos here
└── README.md     ← this file
```

---

## 1. Make it yours (5 minutes, no coding)

Open **`script.js`** and edit the block at the very top:

```js
const CONFIG = {
  siteName:  "Parkside Football Ground",
  location:  "Your Town",
  address:   "…",
  email:     "bookings@example.com",   // where enquiries go
  phone:     "01234 567 890",
  phoneLink: "+440000000000",
  ...
};
```

Then edit the wording directly in **`index.html`** — it's plain English, and every
placeholder (facilities, "who it's for", FAQ) is there to be changed to match your
actual ground. Search the file for `Parkside` to find the name in a few headings.

**The single biggest upgrade: real photos.** Drop good photos of the pitch,
floodlights, changing rooms and clubhouse into `assets/`, then replace the grey
`<figure class="ph …">` placeholders in the Gallery section and the hero. Nothing
makes a ground site look impressive like real photography of the ground.

---

## 2. How enquiries reach you

The enquiry form works **today with no backend**. There are two modes, set by
`deliveryMode` in `script.js`:

- **`"mailto"` (default)** — when someone submits, their email app opens with the
  enquiry pre-filled and addressed to you. Zero setup. The only catch: it relies on
  the visitor having an email app set up.
- **`"endpoint"`** — the form POSTs the enquiry to a URL, so it sends silently in the
  background and shows a "thanks" message. Set `formEndpoint` to either:
  - a **Formspree** form URL (easiest — free tier, sign up at formspree.io), or
  - your **own Cloudflare Worker + Resend** endpoint (this matches your Mostlane
    stack — a ~30-line worker that emails the enquiry via Resend). Ask me to build
    this when you want it.

Switch `deliveryMode: "endpoint"` once `formEndpoint` is set.

---

## 3. Add a real map

In `index.html`, find the `Contact` section's `map-ph` block and replace it with a
Google Maps embed:

1. Google Maps → search your ground → **Share → Embed a map → Copy HTML**.
2. Paste that `<iframe>` in place of the `<div class="map-ph">…</div>`.

---

## 4. Put it live

This folder is static HTML, so it can be hosted almost anywhere for free:

- **GitHub Pages** (already in use for your other site): once merged, this is served at
  `https://<your-pages-domain>/football-ground/`.
- **Cloudflare Pages / Netlify**: drag the `football-ground` folder in, or connect the
  repo. Point your own domain (e.g. `parksidefootballground.co.uk`) at it.

To preview locally, open `index.html` in a browser, or run a tiny server from this
folder: `python3 -m http.server 8000` then visit `http://localhost:8000`.

---

## 5. Phase 2 — real bookings (when you're ready)

This site is deliberately **enquiry-only** for now. When you want live availability
and/or online payment, the clean path is to **embed a proven facility-booking
platform** (Bookteq, Pitchbooking, Skedda + Stripe) into a "Book now" page — they
already handle calendars, double-booking prevention, deposits and refunds, which is
the risky part you don't want to hand-build. The site is structured so that drops in
as a new page/section without a rebuild.
