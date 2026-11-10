// Unit test for the invoice-sweep AUTO-ATTACH rules (autoAttachDecision /
// supplierAgrees in routes/po.js). Cases are modelled on real accounts@ mail.
//   node --no-warnings worker/tools/test-invoice-autoattach.mjs
import { autoAttachDecision, supplierAgrees } from "../src/routes/po.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("FAIL:", name); } };
const PO = (n, supplier, extra = {}) => ({ po_number: n, supplier, priced: false, has_invoice: false, ...extra });
const prop = (o) => ({
  mailbox: "accounts@mostlane.com", messageId: "m", attachmentId: "a",
  from: "", subject: "", filename: "invoice.pdf", docType: "invoice",
  fields: { poNumbers: [o.po && o.po.po_number], poNumber: o.po && o.po.po_number, net: 12.6, vat: 2.52, gross: 15.12, supplier: null },
  ...o,
});
const yes = (name, p) => { const d = autoAttachDecision(p); ok(name + " → attach (" + d.why + ")", d.ok); return d; };
const no = (name, p, why) => { const d = autoAttachDecision(p); ok(name + " → hold" + (why ? " [" + why + "]" : ""), !d.ok && (!why || d.why.includes(why))); };

// ── Should attach ──
{
  const d = yes("TLC (acronym, sender domain)", prop({ po: PO(10900, "TLC"), from: "no-reply@tlc-direct.co.uk", subject: "TLC Invoice PM 544197 Order No-10900" }));
  ok("TLC net/vat/gross carried", d.net === 12.6 && d.vat === 2.52 && d.gross === 15.12);
}
yes("Brewers (supplier read)", prop({ po: PO(10894, "Brewers"), subject: "Account MOST022 Invoice 00340814",
  fields: { poNumbers: [10894], net: 81.63, vat: 16.33, gross: 97.96, supplier: "Brewers" } }));
yes("Rexel - WF Senate via rexel sender", prop({ po: PO(10848, "Rexel - WF Senate"), from: "einvoicing@rexel.co.uk",
  subject: "Sales Invoice Nbr 457844413 - Your Order Number : 10848", fields: { poNumbers: [10848], net: 190, vat: 38, gross: 228 } }));
yes("Metro Rod via metrorod.co.uk", prop({ po: PO(10873, "Metro Rod"), from: "metrorodcredit.control@metrorod.co.uk",
  subject: "Metro Rod Limited - Invoice INVMR225031", fields: { poNumbers: [10873], net: 122.5, vat: 24.5, gross: 147 } }));
yes("Forwarded (supplier in subject)", prop({ po: PO(10738, "Mr Electric"), from: "chloe@mostlane.com",
  subject: "FW: Invoice 212468 from TEE LTD T/A Mr Electric & Aireserv", fields: { poNumbers: [10738], net: 133, vat: 26.6, gross: 159.6 } }));
yes("Zero-rated", prop({ po: PO(10950, "Travis Perkins"), subject: "TP Invoice (1054824839) Attached", from: "ebilling@travisperkins.co.uk",
  fields: { poNumbers: [10950], net: 50, vat: 0, gross: 50 } }));
yes("Per-line VAT rounding (a few pence out)", prop({ po: PO(10951, "Brewers"), subject: "Invoice 1", from: "accounts.south@brewers.co.uk",
  fields: { poNumbers: [10951], net: 412.37, vat: 82.49, gross: 494.86 } }));

// ── Must hold ──
no("Proof of Collection carrying the PO no.", prop({ po: PO(10847, "Travis Perkins"), from: "brightraf@travisperkins.co.uk",
  subject: "Proof of Collection for your Travis Perkins order reference 10847", filename: "signed-0E05503748.pdf",
  fields: { poNumbers: [10847], net: 0.27, vat: 0.01, gross: 0.28, supplier: "Travis Perkins" } }), "not an invoice");
no("Statement", prop({ po: PO(10900, "TLC"), subject: "Pickerings Hire Ltd - Statement", from: "no-reply@tlc-direct.co.uk" }), "not an invoice");
no("Credit note", prop({ po: PO(10900, "TLC"), subject: "TLC Credit Note CN123", from: "no-reply@tlc-direct.co.uk" }), "not an invoice");
no("AI says statement", prop({ po: PO(10900, "TLC"), docType: "statement", subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk" }), "not an invoice");
no("Email never calls it an invoice", prop({ po: PO(10900, "TLC"), subject: "Your order 10900", filename: "doc.pdf", from: "no-reply@tlc-direct.co.uk" }), "not called an invoice");
no("PO already priced by hand", prop({ po: PO(10873, "Metro Rod", { priced: true }), subject: "Metro Rod Invoice", from: "x@metrorod.co.uk" }), "already has a cost");
no("PO already has an invoice", prop({ po: PO(10873, "Metro Rod", { has_invoice: true }), subject: "Metro Rod Invoice", from: "x@metrorod.co.uk" }), "already has an invoice");
no("No PO matched", prop({ po: null, subject: "Invoice" }), "no PO");
no("Invoice names two POs", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900, 10901], net: 12.6, vat: 2.52, gross: 15.12 } }), "several POs");
no("Supplier mismatch (PO Metroplumb, invoice Auto Trade Tyres)", prop({ po: PO(10889, "Metroplumb"), from: "accounts@autotradetyres.co.uk",
  subject: "Your Auto Trade Tyres Invoice (#INV-72010)", fields: { poNumbers: [10889], net: 15, vat: 3, gross: 18, supplier: "Auto Trade Tyres" } }), "supplier");
no("Acronym PO supplier vs full name (EPM)", prop({ po: PO(10884, "EPM Plumbing & Heating"), from: "messaging-service@post.xero.com",
  subject: "Invoice - PO10884/ Starbucks, Deane Retail Park", fields: { poNumbers: [10884], net: 99.4, vat: 19.88, gross: 119.28, supplier: "Exeter Property Maintenance" } }), "supplier");
no("VAT not 0/5/20%", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900], net: 100, vat: 12, gross: 112 } }), "VAT");
no("net + VAT ≠ gross", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900], net: 100, vat: 20, gross: 130 } }), "≠ gross");
no("Gross below net", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900], net: 100, vat: -20, gross: 80 } }));
no("Under £1", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900], net: 0.5, vat: 0.1, gross: 0.6 } }), "under £1");
no("Over the auto limit", prop({ po: PO(10656, "Metrorod"), subject: "Metro Rod Invoice", from: "x@metrorod.co.uk",
  fields: { poNumbers: [10656], net: 2635.94, vat: 527.19, gross: 3163.13 } }), "auto limit");
ok("Auto limit is configurable", autoAttachDecision(prop({ po: PO(10656, "Metrorod"), subject: "Metro Rod Invoice", from: "x@metrorod.co.uk",
  fields: { poNumbers: [10656], net: 2635.94, vat: 527.19, gross: 3163.13 } }), { maxNet: 5000 }).ok);
no("Money not read", prop({ po: PO(10900, "TLC"), subject: "TLC Invoice", from: "no-reply@tlc-direct.co.uk",
  fields: { poNumbers: [10900], net: null, vat: null, gross: null } }), "not read");

// ── supplierAgrees edge cases ──
ok("short acronym must be a whole word", !supplierAgrees("TLC", { from: "x@atlcorp.com", subject: "Invoice", filename: "a.pdf", fields: {} }));
ok("generic-only supplier name never matches", !supplierAgrees("Electrical Supplies Ltd", { from: "x@other.co.uk", subject: "Electrical supplies invoice", filename: "a.pdf", fields: {} }));
ok("empty PO supplier never matches", !supplierAgrees("", { from: "x@tlc-direct.co.uk", subject: "TLC Invoice", fields: { supplier: "TLC" } }));

console.log(`invoice auto-attach: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
