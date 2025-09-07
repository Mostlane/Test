
/* Vehicles data layer (standalone) */
const LS_VEHICLES = 'ms_vehicles_list';      // [{reg, make, model, serviceInterval, driverId, driverName}]
const LS_VEH_REC  = 'ms_vehicles_records';   // { [reg]: { services:[], fuel:[], tyres:[], claims:[], odolog:[] } }
const LS_VSET     = 'ms_vehicles_settings';  // { jotformVanCheckURL: '' }

function v_loadVehicles(){ try{ return JSON.parse(localStorage.getItem(LS_VEHICLES)||'[]'); }catch(e){ return []; } }
function v_saveVehicles(v){ localStorage.setItem(LS_VEHICLES, JSON.stringify(v)); }
function v_loadRecs(){ try{ return JSON.parse(localStorage.getItem(LS_VEH_REC)||'{}'); }catch(e){ return {}; } }
function v_saveRecs(r){ localStorage.setItem(LS_VEH_REC, JSON.stringify(r)); }
function v_settings(){ try{ return JSON.parse(localStorage.getItem(LS_VSET)||'{}'); }catch(e){ return {}; } }
function v_saveSettings(s){ localStorage.setItem(LS_VSET, JSON.stringify(s)); }

function v_ensure(reg){
  const recs = v_loadRecs();
  if(!recs[reg]) recs[reg] = { services:[], fuel:[], tyres:[], claims:[], odolog:[] };
  v_saveRecs(recs);
  return recs[reg];
}
function v_byReg(reg){ return v_loadVehicles().find(v=> v.reg.toUpperCase()===reg.toUpperCase()); }

function v_costs(reg){
  const r = v_loadRecs()[reg] || {services:[], fuel:[], tyres:[], claims:[]};
  const sum = a => (a||[]).reduce((t,x)=> t + (Number(x.cost)||0), 0);
  const fuel=sum(r.fuel), serv=sum(r.services), tyre=sum(r.tyres), claims=sum(r.claims);
  return {fuel, serv, tyre, claims, total: fuel+serv+tyre+claims};
}
function v_miles(reg){
  const r = v_loadRecs()[reg] || { fuel:[], odolog:[] };
  const odos = (r.odolog||[]).map(x=>Number(x.odo)).filter(x=>!isNaN(x));
  if(odos.length>=2){ const mi=Math.max(...odos)-Math.min(...odos); return mi; }
  const trips = (r.fuel||[]).map(x=>Number(x.distance)).filter(x=>!isNaN(x));
  return trips.reduce((a,b)=>a+b,0);
}
