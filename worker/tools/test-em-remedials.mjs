// EM remedials v2 — drives the real certs.js handler with a mock D1/R2: quote text,
// email draft, PO Received (works job / auto-filed clean cert), batteries arrived,
// tracker payload. Run:  node worker/tools/test-em-remedials.mjs
import * as certs from "../src/routes/certs.js";
const CERT = { id:"C1", tenant_id:"1", type:"em", status:"final", job_id:"J1", site_code:"0622", cert_number:"0622-26", engineer:"Daniel Walker", finalised_at:"2026-09-07T13:39:18Z", updated_at:"2026-09-07T13:39:18Z", created_at:"2026-09-07T10:00:00Z",
  data: JSON.stringify({ installation:{ name:"Co-op Shanklin", postcode:"PO37" }, client:{ name:"Southern Co-op" }, contractor:{ date:"2026-09-07" }, signature:"", rows:[
    { no:1, normal:"Pass", led:"Pass", emergency:"Pass", battery:180, comments:"Front door" },
    { no:3, normal:"Pass", led:"Pass", emergency:"Fail", battery:180, comments:"Stock room", remedial:{ failed:true, kind:"light", replacedOnSite:false, lightSpec:"3W LED bulkhead", photos:[{key:"certremedial/1/C1/a.jpg"}] } },
    { no:11, normal:"Pass", led:"Pass", emergency:"Fail", battery:180, comments:"Back corridor", remedial:{ failed:true, kind:"battery", replacedOnSite:false, batterySpec:"4.8V 4Ah NiCd", batteryQty:2, photos:[{key:"certremedial/1/C1/b.jpg"}] } },
    { no:14, normal:"Pass", led:"Pass", emergency:"Pass", battery:180, comments:"Office", remedial:{ failed:true, kind:"light", replacedOnSite:true, photos:[{key:"certremedial/1/C1/c.jpg"}] } },
  ] }) };
function makeEnv(scenario) {
  const calls = [], writes = [];
  let rems = scenario === "legacy"
    ? [{ id:"C1:0", cert_id:"C1", tenant_id:"1", kind:"light", status:"pending", replaced_on_site:0, fitting_no:null, light_ref:"Stock room", site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:"[]", charge:50 },
       { id:"C1:1", cert_id:"C1", tenant_id:"1", kind:"battery", status:"pending", replaced_on_site:0, fitting_no:null, light_ref:"Back corridor", battery_spec:"4.8V 4Ah NiCd", battery_qty:2, site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:"[]", charge:50 },
       { id:"C1:2", cert_id:"C1", tenant_id:"1", kind:"light", status:"done", replaced_on_site:1, fitting_no:null, light_ref:"Office", site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:"[]", charge:50 }]
    : scenario === "allonsite"
    ? [{ id:"C1:0", cert_id:"C1", tenant_id:"1", kind:"light", status:"done", replaced_on_site:1, fitting_no:14, light_ref:"Office", site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:"[]", charge:50 }]
    : [{ id:"C1:0", cert_id:"C1", tenant_id:"1", kind:"light", status:"pending", replaced_on_site:0, fitting_no:3, light_ref:"Stock room", light_spec:"3W LED bulkhead", site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:'["certremedial/1/C1/a.jpg"]', charge:50 },
       { id:"C1:1", cert_id:"C1", tenant_id:"1", kind:"battery", status:"pending", replaced_on_site:0, fitting_no:11, light_ref:"Back corridor", battery_spec:"4.8V 4Ah NiCd", battery_qty:2, site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:'["certremedial/1/C1/b.jpg"]', charge:50 },
       { id:"C1:2", cert_id:"C1", tenant_id:"1", kind:"light", status:"done", replaced_on_site:1, fitting_no:14, light_ref:"Office", site_code:"0622", site_name:"Co-op Shanklin", cert_number:"0622-26", photos:"[]", charge:50 }];
  const ack = { cert_id:"C1", tenant_id:"1", cert_number:"0622-26", site_code:"0622", site_name:"Co-op Shanklin", fittings: rems.length, charge: rems.length*50, onsite: rems.filter(r=>r.status==="done").length, pending: rems.filter(r=>r.status==="pending").length, batteries: rems.filter(r=>r.kind==="battery").length, stage:"quoted", status_label: scenario==="allonsite"?"onsite":"works", created_at:"2026-09-07T13:40:00Z" };
  const jobs = {}; const inserted = {};
  const db = { prepare(sql) { let binds=[]; const st = {
    bind(...a){ binds=a; return st; },
    async first(){ calls.push(sql.slice(0,80));
      if (/FROM certificates WHERE tenant_id=\? AND id=\?/i.test(sql)) return inserted[binds[1]] || (binds[1]==="C1" ? CERT : null);
      if (/SELECT id FROM certificates/i.test(sql)) return inserted[binds[1]] ? { id: binds[1] } : null;
      if (/FROM em_remedial_acks/i.test(sql)) return ack;
      if (/FROM users WHERE/i.test(sql)) return { first_name:"Jamie", last_name:"Line", status:"Active", profile:"{}" };
      if (/FROM user_permissions/i.test(sql)) return null;
      if (/FROM sites WHERE/i.test(sql)) return { client:"retail" };
      if (/FROM sla_jobs WHERE/i.test(sql)) { const j = jobs[binds[1]]; return j ? { data: JSON.stringify(j), status: j.status } : null; }
      if (/FROM app_config/i.test(sql)) return null;
      if (/COUNT\(\*\)/i.test(sql)) return { n:0, c:0 };
      return null; },
    async all(){ calls.push(sql.slice(0,80));
      if (/FROM user_permissions/i.test(sql)) return { results:[{ permission:"FullAccess", value:1 }] };
      if (/FROM em_remedials WHERE/i.test(sql)) { let rows = rems; if (/status='pending'/i.test(sql)) rows = rows.filter(r=>r.status==="pending"); return { results: rows }; }
      if (/FROM em_remedial_acks/i.test(sql)) return { results:[ack] };
      if (/FROM sla_jobs WHERE tenant_id=\? AND id LIKE/i.test(sql)) return { results: Object.values(jobs).map(j=>({id:j.id,status:j.status})) };
      return { results:[] }; },
    async run(){ calls.push(sql.slice(0,80)); writes.push({ sql, binds });
      if (/INSERT INTO certificates/i.test(sql)) inserted[binds[0]] = { id:binds[0], tenant_id:binds[1], type:binds[2], status:binds[3], job_id:binds[4], site_code:binds[5], cert_number:binds[6], data:binds[7], engineer:binds[8] };
      if (/INSERT INTO sla_jobs|UPDATE sla_jobs/i.test(sql)) { const d = binds.find(b => typeof b === "string" && b.startsWith("{")); if (d) { const j = JSON.parse(d); jobs[j.id] = j; } }
      if (/UPDATE em_remedial_acks SET/i.test(sql)) { const m = sql.match(/stage='(\w+)'/); if (m) ack.stage = m[1]; if (/awaiting_batteries=\?/.test(sql)) ack.awaiting_batteries = binds[1]; if (/awaiting_batteries=0/.test(sql)) ack.awaiting_batteries = 0; if (/reissue_cert_id=\?/.test(sql)) ack.reissue_cert_id = binds[0]; }
      return { meta:{ last_row_id:1, changes:1 } }; },
  }; return st; }, batch(s){ return Promise.all(s.map(x=>x.run())); } };
  const r2 = { store:{}, async get(k){ return this.store[k] ? { body:"b", arrayBuffer: async()=>new Uint8Array([0xff,0xd8,0xff,0xe0]).buffer, httpMetadata:{contentType:"image/jpeg"} } : null; }, async put(k,v){ this.store[k]=1; }, async list(){ return { objects:[] }; }, async delete(){} };
  r2.store["certremedial/1/C1/a.jpg"]=1; r2.store["certremedial/1/C1/b.jpg"]=1;
  return { env:{ DB: db, JOB_FILES: r2, ASSET_BUCKET: r2, OWNER_USERNAME:"Jamie Line", PORTAL_BRIDGE_SECRET:"s" }, calls, writes, ack, jobs, inserted };
}
const sess = { user:{ username:"Jamie Line", tenant_id:"1" }, tenantId:"1", session:{ token:"T" } };
async function call(env, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers:{ Authorization:"Bearer T", "Content-Type":"application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await certs.handle(req, env, { waitUntil(){} }, url, sess);
  let j=null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
let fail = 0; const ok = (name, cond, extra="") => { console.log((cond?"PASS":"FAIL")+"  "+name+(extra?"  → "+extra:"")); if(!cond) fail++; };

{ const E = makeEnv("mixed");
  const q = await call(E.env, "GET", "/certs/remedials/quote-text?certId=C1");
  ok("quote text format", q.status===200 && q.body.text === "Failed EM fittings at store 0622:\nFitting 3 - Light replacement - £50\nFitting 11 - Batteries - £50\nFitting 14 - Light replacement (replaced on site) - £50\nTotal: 3 fittings - £150", JSON.stringify(q.body && q.body.text));
  const d = await call(E.env, "GET", "/certs/remedials/email-draft?certId=C1");
  ok("email draft: reference + greeting + name", d.status===200 && d.body.reference==="0622-EM-26" && /^Good (morning|afternoon),\n\nPlease see attached document showing batteries required and quantities\. If you could please send us a quotation including delivery times and use reference 0622-EM-26\./.test(d.body.body) && /Jamie Line/.test(d.body.body), d.body && d.body.subject);
  const po = await call(E.env, "POST", "/certs/remedials/po-received", { certId:"C1" });
  const job = E.jobs["emrem:C1"];
  ok("PO received (mixed) → in_works + ONE audit job, awaiting batteries", po.status===200 && po.body.stage==="in_works" && po.body.awaitingBatteries===true && job && Array.isArray(job.auditItems) && job.auditItems.length===2 && /AWAITING BATTERIES/.test(job.description), JSON.stringify(job && job.auditItems.map(i=>i.text)));
  ok("audit items carry the engineer's photos", job && job.auditItems.every(i => i.refPhotos.length===1 && /^jobs\/emrem:C1\/audit\//.test(i.refPhotos[0])));
  ok("job unassigned + RA on, other gates off", job && job.assignedEngineers.length===0 && job.requiresRA===true && job.requiresSignature===false);
  const ba = await call(E.env, "POST", "/certs/remedials/batteries-arrived", { certId:"C1" });
  ok("batteries arrived clears the job flag", ba.status===200 && !/AWAITING BATTERIES/.test(E.jobs["emrem:C1"].description) && E.ack.awaiting_batteries===0);
  const bd = await call(E.env, "GET", "/certs/remedials/board");
  const c = bd.body && bd.body.cases && bd.body.cases[0];
  ok("board carries status + per-fitting items", c && c.statusLabel==="works" && c.items.length===3 && c.items[1].kind==="battery" && c.items[1].qty===2, JSON.stringify(c && c.items.map(i=>i.no+":"+i.kind)));
}
{ const E = makeEnv("allonsite");
  const po = await call(E.env, "POST", "/certs/remedials/po-received", { certId:"C1" });
  const re = E.inserted["CERT-reissue-C1"];
  ok("PO received (all on site) → done + updated cert AUTO-FILED", po.status===200 && po.body.stage==="done" && po.body.reissueCertId==="CERT-reissue-C1" && E.ack.stage==="done" && E.writes.some(w => /UPDATE certificates SET status='final', cert_number=\?/.test(w.sql) && w.binds[0]==="0622-26"), JSON.stringify(po.body));
  const rows = re && JSON.parse(re.data).rows;
  ok("re-issued rows flipped to Pass with (Replaced) and same number", rows && rows.filter(r => /\(Replaced\)/.test(r.comments||"")).length===3 && rows.every(r => !r.remedial) && re.cert_number==="0622-26");
  ok("filed to compliance (R2 put + compliance_files insert)", E.writes.some(w => /INSERT INTO compliance_files|compliance_files/i.test(w.sql)) && Object.keys(E.env.JOB_FILES.store).some(k => /^compliance\//.test(k)), Object.keys(E.env.JOB_FILES.store).filter(k=>/^compliance/.test(k)).join(","));
}

{ // Rows logged before fitting_no/photos were captured (pre-Sep-2026 certs) heal from the cert.
  const E = makeEnv("legacy");
  const bd = await call(E.env, "GET", "/certs/remedials/board");
  const c = bd.body && bd.body.cases && bd.body.cases[0];
  ok("legacy rows: fitting numbers re-derived from the cert", c && c.items.map(i=>i.no).join(",")==="3,11,14", c && c.items.map(i=>i.no).join(","));
  const up = E.writes.filter(w => /UPDATE em_remedials SET fitting_no=\?, photos=\?/.test(w.sql));
  ok("legacy rows: healed values persisted (3 updates, photos filled)", up.length===3 && up.every(w => w.binds[0]!=null) && JSON.parse(up[0].binds[1]).length>=1, String(up.length));
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
