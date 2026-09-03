/* =========================================================
   Coal Park Lane (CPL) — site script
   ---------------------------------------------------------
   EDIT THIS BLOCK to make the site yours. It fills in your
   ground name, location, and contact details in one place.
   ========================================================= */
const CONFIG = {
  siteName:  "Coal Park Lane",         // trading name (CPL)
  location:  "Coal Park Lane",
  address:   "Coal Park Lane, [town, postcode]",   // add the full address
  email:     "bookings@example.com",   // where enquiries are sent — set this before go-live
  phone:     "01234 567 890",
  phoneLink: "+440000000000",          // tel: format, no spaces

  /* -------------------------------------------------------
     HOW ENQUIRIES ARE DELIVERED
     "mailto"  – opens the visitor's email app with the
                 enquiry pre-filled (zero setup, works today).
     "endpoint"– POSTs the enquiry to a URL you provide
                 (e.g. Formspree, or a Cloudflare Worker +
                 Resend like your Mostlane stack). Set
                 formEndpoint below and switch this to "endpoint".
     ------------------------------------------------------- */
  deliveryMode: "mailto",
  formEndpoint: ""   // e.g. "https://formspree.io/f/xxxx" or your own Worker URL
};

/* ---------- Apply config to the page ---------- */
(function applyConfig(){
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("heroLocation", CONFIG.location);
  set("cAddress", CONFIG.address);
  const email = document.getElementById("cEmail");
  if (email){ email.textContent = CONFIG.email; email.href = "mailto:" + CONFIG.email; }
  const phone = document.getElementById("cPhone");
  if (phone){ phone.textContent = CONFIG.phone; phone.href = "tel:" + CONFIG.phoneLink; }
  const yr = document.getElementById("year");
  if (yr) yr.textContent = new Date().getFullYear();
})();

/* ---------- Sticky nav background ---------- */
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
onScroll();
window.addEventListener("scroll", onScroll, { passive:true });

/* ---------- Mobile menu ---------- */
const toggle = document.getElementById("navToggle");
toggle.addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
});
document.querySelectorAll(".nav-links a").forEach(a =>
  a.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    toggle.setAttribute("aria-expanded", "false");
  })
);

/* ---------- Reveal on scroll ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting){ e.target.classList.add("in"); io.unobserve(e.target); } });
}, { threshold:0.12, rootMargin:"0px 0px -40px 0px" });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));

/* ---------- Enquiry form ---------- */
const form = document.getElementById("enquiryForm");
const note = document.getElementById("formNote");
const submitBtn = document.getElementById("submitBtn");

// don't let people pick a date in the past
const dateInput = document.getElementById("date");
if (dateInput) dateInput.min = new Date().toISOString().split("T")[0];

const showError = (name, msg) => {
  const field = form.querySelector(`[name="${name}"]`)?.closest(".field");
  const err = form.querySelector(`.err[data-for="${name}"]`);
  if (field) field.classList.add("invalid");
  if (err) err.textContent = msg;
};
const clearError = (name) => {
  const field = form.querySelector(`[name="${name}"]`)?.closest(".field");
  const err = form.querySelector(`.err[data-for="${name}"]`);
  if (field) field.classList.remove("invalid");
  if (err) err.textContent = "";
};

// clear a field's error as the user fixes it
form.querySelectorAll("input,select,textarea").forEach(el =>
  el.addEventListener("input", () => clearError(el.name))
);

function validate(){
  let ok = true;
  const data = Object.fromEntries(new FormData(form).entries());

  if (!data.name || !data.name.trim()){ showError("name","Please tell us your name."); ok = false; }
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)){ showError("email","Please enter a valid email address."); ok = false; }
  if (!data.date){ showError("date","Please choose a preferred date."); ok = false; }
  if (!data.use){ showError("use","Please tell us what it's for."); ok = false; }
  if (!form.querySelector("#consent").checked){ showError("consent","Please tick to allow us to contact you."); ok = false; }
  if (data.people && (isNaN(+data.people) || +data.people < 1)){ showError("people","Enter a valid number."); ok = false; }

  return { ok, data };
}

function buildBody(d){
  const line = (label, val) => val ? `${label}: ${val}\n` : "";
  return (
    `New booking enquiry from ${CONFIG.siteName} website\n` +
    `----------------------------------------------\n` +
    line("Name", d.name) +
    line("Email", d.email) +
    line("Phone", d.phone) +
    line("Preferred date", d.date) +
    line("Preferred time", d.time) +
    line("What for", d.use) +
    line("Approx. players", d.people) +
    line("Message", d.message) +
    `\nSent from ${location.href}`
  );
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  note.textContent = ""; note.className = "form-note";

  const { ok, data } = validate();
  if (!ok){
    note.textContent = "Please check the highlighted fields.";
    note.classList.add("bad");
    form.querySelector(".invalid input,.invalid select,.invalid textarea")?.focus();
    return;
  }

  const subject = `Booking enquiry — ${data.use} — ${data.date}`;
  const body = buildBody(data);

  // ---- Delivery: hosted endpoint (Formspree / your own Worker) ----
  if (CONFIG.deliveryMode === "endpoint" && CONFIG.formEndpoint){
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = "Sending…";
    try{
      const res = await fetch(CONFIG.formEndpoint, {
        method:"POST",
        headers:{ "Accept":"application/json", "Content-Type":"application/json" },
        body: JSON.stringify({ subject, ...data })
      });
      if (!res.ok) throw new Error("bad status " + res.status);
      form.reset();
      note.textContent = "Thanks — your enquiry has been sent. We'll be in touch shortly.";
      note.classList.add("ok");
    }catch(err){
      note.textContent = "Sorry, something went wrong sending that. Please email us directly at " + CONFIG.email + ".";
      note.classList.add("bad");
    }finally{
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
    return;
  }

  // ---- Delivery: mailto (default, no backend needed) ----
  const mailto = `mailto:${CONFIG.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
  note.textContent = "Opening your email app to send the enquiry. If nothing happens, email us at " + CONFIG.email + ".";
  note.classList.add("ok");
});
