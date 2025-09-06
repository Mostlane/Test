
const LS_JOBS='ms_fsm_jobs', LS_SETTINGS='ms_fsm_settings', LS_ENGINEERS='ms_fsm_engineers';
const Statuses=['New','Assigned','In Progress','On Hold','Completed','Cancelled'];
const defaultEngineers=[{id:'jamie.line',name:'Jamie Line'},{id:'john.thorn',name:'John Thorn'}];
const defaultSettings={company:'Mostlane',webhookJobCreate:'',webhookJobUpdate:'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
function load(k,d){try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(d))}catch(e){return d}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v))}
if(!localStorage.getItem(LS_ENGINEERS)) save(LS_ENGINEERS, defaultEngineers);
if(!localStorage.getItem(LS_SETTINGS)) save(LS_SETTINGS, defaultSettings);
const loadJobs=()=>load(LS_JOBS,[]), saveJobs=v=>save(LS_JOBS,v), loadSettings=()=>load(LS_SETTINGS,defaultSettings), loadEngineers=()=>load(LS_ENGINEERS,defaultEngineers);
const uid=n=>Array.from({length:n},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
function newJobId(){ const d=new Date(); return `J-${String(d.getFullYear()).slice(2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-`+uid(4); }
function postZap(url,data){ if(!url) return; const b=new URLSearchParams(); for(const [k,v] of Object.entries(data)) b.append(k, typeof v==='object'?JSON.stringify(v):String(v)); fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b}).catch(()=>{}); }
function KPIs(j){ const open=j.filter(x=>!['Completed','Cancelled'].includes(x.status)).length;
  const today=j.filter(x=>x.dueDate && new Date(x.dueDate).toDateString()===new Date().toDateString()).length;
  const overdue=j.filter(x=>x.dueDate && new Date(x.dueDate)<new Date() && x.status!=='Completed').length;
  const risk=j.filter(x=>x.slaHours && (new Date(x.createdAt).getTime()+x.slaHours*3600000 - Date.now())/3600000 < 4 && x.status!=='Completed').length;
  return {open,today,overdue,risk}; }
window.MFSM={Statuses,loadJobs,saveJobs,loadSettings,loadEngineers,newJobId,postZap,KPIs};
