
// Mostlane FSM MVP (Workever-lite) — localStorage + optional Zapier webhooks
const LS_JOBS = 'ms_fsm_jobs';
const LS_SETTINGS = 'ms_fsm_settings';
const LS_ENGINEERS = 'ms_fsm_engineers';

const defaultEngineers = [
  { id:'jamie.line', name:'Jamie Line' },
  { id:'john.thorn', name:'John Thorn' },
  { id:'sarah', name:'Sarah' },
  { id:'brad', name:'Bradley Graham' },
  { id:'ryan', name:'Ryan Diggens' },
  { id:'connor', name:'Connor Brady' },
];

const defaultSettings = {
  company:'Mostlane',
  webhookJobCreate:'',     // paste Zapier URL if you want outbound events
  webhookJobUpdate:'',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
};

const Statuses = ['New','Assigned','In Progress','On Hold','Completed','Cancelled'];

function loadJobs(){ return JSON.parse(localStorage.getItem(LS_JOBS)||'[]'); }
function saveJobs(arr){ localStorage.setItem(LS_JOBS, JSON.stringify(arr)); }
function loadSettings(){ return JSON.parse(localStorage.getItem(LS_SETTINGS)||JSON.stringify(defaultSettings)); }
function saveSettings(s){ localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }
function loadEngineers(){ return JSON.parse(localStorage.getItem(LS_ENGINEERS)||JSON.stringify(defaultEngineers)); }
function saveEngineers(e){ localStorage.setItem(LS_ENGINEERS, JSON.stringify(e)); }

if(!localStorage.getItem(LS_SETTINGS)) saveSettings(defaultSettings);
if(!localStorage.getItem(LS_ENGINEERS)) saveEngineers(defaultEngineers);

function uid(n=5){
  const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out=''; for(let i=0;i<n;i++) out+=s[Math.floor(Math.random()*s.length)];
  return out;
}

function newJobId(){
  const d=new Date();
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `J-250906-`+uid(4);
}

function postToZap(url, data){
  if(!url) return;
  const body = new URLSearchParams();
  Object.entries(data).forEach(([k,v])=> body.append(k, typeof v==='object'? JSON.stringify(v): String(v)));
  fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })
    .catch(err=>console.warn('Zapier post failed', err));
}

function kpis(jobs){
  const open = jobs.filter(j=>!['Completed','Cancelled'].includes(j.status)).length;
  const dueToday = jobs.filter(j=> j.dueDate && sameDay(new Date(j.dueDate), new Date())).length;
  const overdue = jobs.filter(j=> j.dueDate && new Date(j.dueDate)<new Date() && j.status!=='Completed').length;
  const atRisk = jobs.filter(j=> j.slaHours && hoursToDue(j) < 4 && j.status!=='Completed').length;
  return {open, dueToday, overdue, atRisk};
}

function hoursToDue(job){
  if(!job.slaHours) return 9999;
  const created = new Date(job.createdAt||Date.now());
  const target = new Date(created.getTime() + job.slaHours*3600*1000);
  return (target - new Date())/3600000;
}

function sameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function fmtDate(d){ if(!d) return ''; return new Date(d).toLocaleString(); }
function fmtMins(ms){
  if(!ms) return '0m';
  const m = Math.round(ms/60000);
  const h = Math.floor(m/60);
  const mm = m%60;
  return (h? h+'h ':'') + mm+'m';
}

window.MostlaneFSM = {
  loadJobs, saveJobs, loadSettings, saveSettings, loadEngineers, saveEngineers,
  Statuses, newJobId, postToZap, kpis, fmtDate, fmtMins, hoursToDue
};
