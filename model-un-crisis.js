// ═══════════════════════════════════════════════════════════
// FIREBASE REAL-TIME BACKEND — two-way communication
// ═══════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase, ref, set, push, onValue, remove, update, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDgnchR23SOC1BIb3DTiE02sp79D508NsE",
  authDomain: "model-un-crisis-64215.firebaseapp.com",
  databaseURL: "https://model-un-crisis-64215-default-rtdb.firebaseio.com",
  projectId: "model-un-crisis-64215",
  storageBucket: "model-un-crisis-64215.firebasestorage.app",
  messagingSenderId: "261991935482",
  appId: "1:261991935482:web:d6bf3ec6a729f970c0c843"
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ═══════════════════════════════════════════════════════════
// LOGIN & SESSION IDENTITY
// ═══════════════════════════════════════════════════════════
const CD_PASSWORD = 'enters';
let myCallSign = '';
let isCD = false;
let presKey = '';
let myPresRef = null;

function loadSession() {
  const saved = localStorage.getItem('warroom_session');
  if (saved) {
    try {
      const s = JSON.parse(saved);
      if (s.callSign) {
        myCallSign = s.callSign;
        isCD = s.isCD || false;
        return true;
      }
    } catch(e) {}
  }
  return false;
}

function saveSession(callSign, cd) {
  localStorage.setItem('warroom_session', JSON.stringify({ callSign, isCD: cd }));
}

function clearSession() {
  localStorage.removeItem('warroom_session');
}

function showLoginModal() {
  // Detach old presence
  if (myPresRef) { remove(myPresRef); myPresRef = null; }
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-select').value = '';
  document.getElementById('login-password-wrap').style.display = 'none';
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('login-btn').classList.remove('cd-mode');
  document.getElementById('login-btn').textContent = '[ AUTHENTICATE ]';
}
window.showLoginModal = showLoginModal;

function attemptLogin() {
  const sel = document.getElementById('login-select').value;
  if (!sel) { shakeLoginError('SELECT AN AGENT DESIGNATION'); return; }

  if (sel === 'CD') {
    const pw = document.getElementById('login-password').value;
    if (pw !== CD_PASSWORD) {
      shakeLoginError('✕ AUTHORIZATION FAILED — INCORRECT CODE');
      document.getElementById('login-password').value = '';
      document.getElementById('login-password').focus();
      return;
    }
    completeLogin(sel, true);
  } else {
    completeLogin(sel, false);
  }
}
window.attemptLogin = attemptLogin;

function shakeLoginError(msg) {
  const err = document.getElementById('login-error');
  err.textContent = msg;
  err.style.display = 'block';
  err.style.animation = 'none';
  requestAnimationFrame(() => { err.style.animation = 'blink 0.6s step-end 3'; });
}

function completeLogin(callSign, cd) {
  myCallSign = callSign;
  isCD = cd;
  saveSession(callSign, cd);

  // Register presence
  presKey = callSign.replace(/[^a-zA-Z0-9]/g, '_');
  myPresRef = ref(db, `presence/${presKey}`);
  set(myPresRef, { callSign: myCallSign, isCD, ts: Date.now() });
  onDisconnect(myPresRef).remove();

  // Hide login
  document.getElementById('login-overlay').classList.add('hidden');

  // Apply permissions
  applyPermissions();

  // Update UI labels
  setCallSignLabel();
  setTimeout(() => fbPostLog(`Agent ${myCallSign} authenticated and connected.`, false), 800);
}

function applyPermissions() {
  // Editor bar — only CD can add/move/delete cities
  const editorBtns = document.querySelectorAll('#btn-add, #btn-move, #btn-delete');
  editorBtns.forEach(btn => {
    if (isCD) {
      btn.style.display = '';
      btn.style.opacity = '1';
      btn.style.pointerEvents = '';
    } else {
      btn.style.display = 'none';
    }
  });

  // Show/hide CD delete buttons on existing crisis items and log entries
  document.querySelectorAll('.cd-delete-crisis, .cd-delete-log').forEach(el => {
    el.style.display = isCD ? 'inline' : 'none';
  });

  // If not CD, ensure we're in view mode
  if (!isCD && mode !== 'view') setMode('view');
}

// ── Handle select change to show/hide password field ──────
document.getElementById('login-select').addEventListener('change', function() {
  const wrap = document.getElementById('login-password-wrap');
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.style.display = 'none';
  if (this.value === 'CD') {
    wrap.style.display = 'block';
    btn.classList.add('cd-mode');
    btn.textContent = '[ REQUEST ACCESS ]';
    setTimeout(() => document.getElementById('login-password').focus(), 50);
  } else {
    wrap.style.display = 'none';
    btn.classList.remove('cd-mode');
    btn.textContent = '[ AUTHENTICATE ]';
  }
});

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') attemptLogin();
});



// ── Local state ─────────────────────────────────────────────
let cities = {};
let mode   = 'view';
let pendingX = 0, pendingY = 0;
let selectedType = 'normal';
let dragging = null;

// ── DOM refs ────────────────────────────────────────────────
const svg          = document.getElementById('city-layer');
const mapContainer = document.getElementById('map-container');
function pct(v,t){ return v/100*t; }

// ═══════════════════════════════════════════════════════════
// RENDER CITIES
// ═══════════════════════════════════════════════════════════
function renderAll() {
  while (svg.children.length>1) svg.removeChild(svg.lastChild);
  const W = svg.clientWidth  || mapContainer.clientWidth;
  const H = svg.clientHeight || mapContainer.clientHeight;

  const mkLine=(cx,cy,x1,y1,x2,y2,col)=>{
    const l=document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1',cx+x1); l.setAttribute('y1',cy+y1);
    l.setAttribute('x2',cx+x2); l.setAttribute('y2',cy+y2);
    l.setAttribute('stroke',col||'#ff2200'); l.setAttribute('stroke-width','1.2'); l.setAttribute('opacity','0.8');
    return l;
  };
  const mkCircle=(cx,cy,r,fill,filt,pulse,dur)=>{
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx',cx); c.setAttribute('cy',cy); c.setAttribute('r',r); c.setAttribute('fill',fill);
    if(filt) c.setAttribute('filter',`url(#${filt})`);
    if(pulse){
      const a1=document.createElementNS('http://www.w3.org/2000/svg','animate');
      a1.setAttribute('attributeName','r'); a1.setAttribute('values',`${r-1};${r+4};${r-1}`);
      a1.setAttribute('dur',dur||'1.4s'); a1.setAttribute('repeatCount','indefinite');
      const a2=document.createElementNS('http://www.w3.org/2000/svg','animate');
      a2.setAttribute('attributeName','opacity'); a2.setAttribute('values','1;0.5;1');
      a2.setAttribute('dur',dur||'1.4s'); a2.setAttribute('repeatCount','indefinite');
      c.appendChild(a1); c.appendChild(a2);
    }
    return c;
  };
  const mkLabel=(text,color,cx,cy,dx,dy)=>{
    const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',cx+dx); t.setAttribute('y',cy+dy);
    t.setAttribute('fill',color); t.setAttribute('font-size','10'); t.setAttribute('font-family','monospace');
    t.textContent=text; return t;
  };

  Object.values(cities).forEach(city=>{
    const cx=pct(city.x,W), cy=pct(city.y,H);
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('data-id',city.id);
    g.style.cursor=mode==='move'?'grab':mode==='delete'?'crosshair':'pointer';
    if(city.type==='alert'){
      g.appendChild(mkCircle(cx,cy,6,'#ff2200','alertglow',true,'1.4s'));
      g.appendChild(mkLine(cx,cy,0,-18,0,-9)); g.appendChild(mkLine(cx,cy,0,9,0,18));
      g.appendChild(mkLine(cx,cy,-18,0,-9,0)); g.appendChild(mkLine(cx,cy,9,0,18,0));
      const ring=document.createElementNS('http://www.w3.org/2000/svg','circle');
      ring.setAttribute('cx',cx); ring.setAttribute('cy',cy); ring.setAttribute('r','20');
      ring.setAttribute('fill','none'); ring.setAttribute('stroke','#ff2200');
      ring.setAttribute('stroke-width','0.9'); ring.setAttribute('opacity','0.45');
      g.appendChild(ring);
      g.appendChild(mkLabel(city.name,'#ff2200',cx,cy,10,-4));
    } else if(city.type==='amber'){
      g.appendChild(mkCircle(cx,cy,5,'#ffb000','cityglow',true,'2.4s'));
      g.appendChild(mkLabel(city.name,'#ffb000',cx,cy,8,-4));
    } else {
      g.appendChild(mkCircle(cx,cy,4.5,'#00ff41','cityglow',false,null));
      g.appendChild(mkLabel(city.name,'#a8ffb8',cx,cy,7,-3));
    }
    g.addEventListener('pointerdown',e=>onCityPointerDown(e,city.id));
    svg.appendChild(g);
  });
}

// ═══════════════════════════════════════════════════════════
// FIREBASE: CITIES
// ═══════════════════════════════════════════════════════════
const citiesRef=ref(db,'cities');
onValue(citiesRef,snap=>{ cities=snap.val()||{}; renderAll(); });

function fbAddCity(name,x,y,type){
  const r=push(citiesRef);
  set(r,{id:r.key,name,x,y,type,addedBy:myCallSign});
}
function fbMoveCity(id,x,y){ update(ref(db,`cities/${id}`),{x,y}); }
function fbDeleteCity(id){ remove(ref(db,`cities/${id}`)); }

// ═══════════════════════════════════════════════════════════
// FIREBASE: CRISIS FEED
// ═══════════════════════════════════════════════════════════
const crisisRef=ref(db,'crises');

onValue(crisisRef,snap=>{ renderCrisisFeed(snap.val()||{}); });

onValue(crisisRef,snap=>{
  if(!snap.exists()){
    CRISES.forEach((c,i)=>{
      set(ref(db,`crises/default_${i}`),{id:`default_${i}`,...c,postedBy:'SYSTEM',timestamp:Date.now()-(i*3600000)});
    });
  }
},{onlyOnce:true});

function renderCrisisFeed(data){
  const feed=document.getElementById('crisis-feed');
  if(!feed) return;
  const sorted=Object.values(data).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  feed.innerHTML='';
  sorted.forEach((c,i)=>{
    const pc=c.pri==='HIGH'?'priority-high':c.pri==='MED'?'priority-med':'priority-low';
    const div=document.createElement('div');
    div.className=`crisis-item ${pc}`;
    div.style.animationDelay=`${i*0.1}s`;
    div.innerHTML=`
      <div class="crisis-meta">
        <span class="crisis-time">${c.time||'LIVE'}</span>
        <span class="crisis-priority ${c.pri}">${c.pri}</span>
        <span class="crisis-location">${c.loc}</span>
        ${c.postedBy&&c.postedBy!=='SYSTEM'?`<span style="font-size:8px;color:rgba(0,255,65,0.4);margin-left:auto;">[${c.postedBy}]</span>`:''}
        <button class="cd-delete-crisis" style="display:${isCD?'inline':'none'}" data-id="${c.id}" onclick="cdDeleteCrisis(event,'${c.id}')">✕ DELETE</button>
      </div>
      <div class="crisis-title">${c.title}</div>
      <div class="crisis-body">${(c.body||'').split('\n')[0].substring(0,120)}</div>`;
    div.addEventListener('click',()=>openCrisisData(c));
    feed.appendChild(div);
  });
}

function fbPushCrisis(title,loc,pri,body){
  const now=new Date(),p=n=>String(n).padStart(2,'0');
  const r=push(crisisRef);
  set(r,{id:r.key,title,loc,pri,body,time:p(now.getUTCHours())+':'+p(now.getUTCMinutes())+' GMT',clr:'OPERATIVE',postedBy:myCallSign,timestamp:Date.now()});
}

// ═══════════════════════════════════════════════════════════
// FIREBASE: INTEL LOG
// ═══════════════════════════════════════════════════════════
const intelRef=ref(db,'intelLog');

onValue(intelRef,snap=>{
  const logEl=document.getElementById('intel-log');
  if(!logEl) return;
  const entries=snap.val()||{};
  const sorted=Object.entries(entries).sort((a,b)=>((b[1].ts||0)-(a[1].ts||0))).slice(0,25);
  logEl.innerHTML='';
  sorted.forEach(([key,e])=>{
    const div=document.createElement('div');
    div.className='log-entry'+(e.isUser?' new':'');
    const col=e.isUser?'var(--amber)':'rgba(0,255,65,0.38)';
    div.innerHTML=`<span class="timestamp" style="color:${col}">[${e.ts_str||'--:--:--'}]</span> `+
      (e.callSign?`<span style="color:${col};font-size:8px;">${e.callSign}:</span> `:'')+
      `<span class="msg">${e.msg}</span>`+
      `<button class="cd-delete-log" style="display:${isCD?'inline':'none'}" onclick="cdDeleteLog('${key}')">✕</button>`;
    logEl.appendChild(div);
  });
});

function fbPostLog(msg,isUser){
  const now=new Date(),p=n=>String(n).padStart(2,'0');
  const r=push(intelRef);
  set(r,{msg,isUser,callSign:isUser?myCallSign:null,ts:Date.now(),ts_str:p(now.getUTCHours())+':'+p(now.getUTCMinutes())+':'+p(now.getUTCSeconds())});
  onValue(intelRef,snap=>{
    const all=snap.val()||{};
    const keys=Object.keys(all).sort((a,b)=>(all[a].ts||0)-(all[b].ts||0));
    if(keys.length>50) keys.slice(0,keys.length-50).forEach(k=>remove(ref(db,`intelLog/${k}`)));
  },{onlyOnce:true});
}

// Seed initial log entries
const AUTO_LOG=['Station FOXGLOVE — contact re-established on channel DELTA-9','Cipher decode progress: 47% — cryptanalysis ongoing','Asset CRIMSON checked in — Berlin sector, status nominal','Radio silence from Node 7 — dispatching relay probe','Aerial recon confirms armored formation movement','Diplomatic pouch intercepted — contents sealed','Eastern bloc communiqué logged under SUNRAY','Committee session alpha adjourned at 03:40 GMT','Priority dispatch received from Washington','Morse relay: SUNRAY acknowledges standing by','Asset NIGHTINGALE requests extraction window','Allied fleet repositioning — North Sea, bearing 270'];
let autoIdx=0;

onValue(intelRef,snap=>{
  if(!snap.exists()){
    AUTO_LOG.slice(0,8).forEach((msg,i)=>{
      const t=new Date(Date.now()-(8-i)*60000),p=n=>String(n).padStart(2,'0');
      const r=push(intelRef);
      set(r,{msg,isUser:false,callSign:null,ts:t.getTime(),ts_str:p(t.getUTCHours())+':'+p(t.getUTCMinutes())+':'+p(t.getUTCSeconds())});
    });
  }
},{onlyOnce:true});

setInterval(()=>{ fbPostLog(AUTO_LOG[autoIdx%AUTO_LOG.length],false); autoIdx++; },7000);

// ═══════════════════════════════════════════════════════════
// PRESENCE COUNTER
// ═══════════════════════════════════════════════════════════
onValue(ref(db,'presence'),snap=>{
  const count=Object.keys(snap.val()||{}).length;
  const el=document.getElementById('online-indicator');
  if(el) el.textContent=`◉ ${count} AGENT${count!==1?'S':''} ONLINE`;
});

// ═══════════════════════════════════════════════════════════
// MODE CONTROLS
// ═══════════════════════════════════════════════════════════
function setMode(m){
  // Non-CD agents can only be in view mode
  if (!isCD && m !== 'view') return;
  mode=m;
  document.getElementById('mode-label').textContent=
    m==='add'?'MODE: ADD — TAP MAP TO PLACE':
    m==='move'?'MODE: MOVE — DRAG CITIES':
    m==='delete'?'MODE: DELETE — TAP CITY TO REMOVE':'MODE: VIEW';
  ['btn-add','btn-move','btn-delete'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.remove('active');
  });
  if(m!=='view'){const btn=document.getElementById('btn-'+m); if(btn) btn.classList.add('active');}
  renderAll();
}
window.setMode=setMode;

mapContainer.addEventListener('click',e=>{
  if(mode!=='add') return;
  if(e.target.closest('#editor-bar')||e.target.closest('#header')) return;
  const rect=mapContainer.getBoundingClientRect();
  pendingX=(e.clientX-rect.left)/rect.width*100;
  pendingY=(e.clientY-rect.top)/rect.height*100;
  document.getElementById('city-name-input').value='';
  selectedType='normal';
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('selected'));
  document.querySelector('.type-btn[data-type="normal"]').classList.add('selected');
  document.getElementById('name-popup').classList.add('active');
  setTimeout(()=>document.getElementById('city-name-input').focus(),50);
});

function selectType(btn,type){
  selectedType=type;
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
}
window.selectType=selectType;

function confirmAdd(){
  const name=(document.getElementById('city-name-input').value.trim()||'CITY').toUpperCase();
  fbAddCity(name,pendingX,pendingY,selectedType);
  fbPostLog(`New marker placed: ${name} — by ${myCallSign}`,false);
  document.getElementById('name-popup').classList.remove('active');
  setMode('view');
}
window.confirmAdd=confirmAdd;

function cancelAdd(){ document.getElementById('name-popup').classList.remove('active'); }
window.cancelAdd=cancelAdd;

document.getElementById('city-name-input').addEventListener('keydown',e=>{
  if(e.key==='Enter') confirmAdd();
  if(e.key==='Escape') cancelAdd();
});

// Drag
function onCityPointerDown(e,id){
  if(mode==='delete'){
    e.stopPropagation();
    const city=cities[id];
    if(city) fbPostLog(`Marker removed: ${city.name} — by ${myCallSign}`,false);
    fbDeleteCity(id); return;
  }
  if(mode!=='move') return;
  e.stopPropagation(); dragging=id;
  svg.setPointerCapture(e.pointerId); e.preventDefault();
}
svg.addEventListener('pointermove',e=>{
  if(dragging===null) return;
  const rect=mapContainer.getBoundingClientRect();
  const x=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100));
  const y=Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100));
  const city=cities[dragging];
  if(city){city.x=x;city.y=y;renderAll();}
});
svg.addEventListener('pointerup',()=>{
  if(dragging!==null){
    const city=cities[dragging];
    if(city) fbMoveCity(dragging,city.x,city.y);
    dragging=null;
  }
});

// Export
function showExport(){
  const lines=Object.values(cities).map(c=>`  { name:'${c.name}', x:${c.x.toFixed(2)}, y:${c.y.toFixed(2)}, type:'${c.type}' },`).join('\n');
  document.getElementById('export-out').value=`let cities = [\n${lines}\n];`;
  document.getElementById('export-box').classList.add('active');
}
window.showExport=showExport;

function copyExport(){ navigator.clipboard.writeText(document.getElementById('export-out').value).then(()=>alert('Copied!')); }
window.copyExport=copyExport;

// Clock
function updateClock(){
  const now=new Date(),p=n=>String(n).padStart(2,'0');
  document.getElementById('clock').textContent=p(now.getUTCHours())+':'+p(now.getUTCMinutes())+':'+p(now.getUTCSeconds());
  const M=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const D=['SUN','MON','TUE','WED','THU','FRI','SAT'];
  document.getElementById('dateline').textContent=D[now.getUTCDay()]+' '+p(now.getUTCDate())+' '+M[now.getUTCMonth()]+' '+now.getUTCFullYear()+' // UTC';
}
setInterval(updateClock,1000); updateClock();

// Audio
const audio=document.getElementById('bg-audio');
let audioOn=false;
document.addEventListener('click',function startAudio(){
  if(!audioOn){audio.volume=0.45;audio.play().then(()=>{audioOn=true;const b=document.getElementById('audio-bottom-btn');if(b)b.textContent='[ ♪ AUDIO: ON ]';}).catch(()=>{});}
  document.removeEventListener('click',startAudio);
},{once:true});
function toggleAudio(){
  if(audioOn){audio.pause();audioOn=false;document.getElementById('audio-bottom-btn').textContent='[ ♪ AUDIO: OFF ]';}
  else{audio.volume=0.45;audio.play().then(()=>{audioOn=true;document.getElementById('audio-bottom-btn').textContent='[ ♪ AUDIO: ON ]';}).catch(()=>{});}
}
window.toggleAudio=toggleAudio;

// Modals
let twInterval=null;
function openCrisisData(c){
  document.getElementById('modal-tag').textContent='CRISIS DISPATCH — '+(c.clr||'OPERATIVE')+' CLEARANCE REQUIRED';
  document.getElementById('modal-title').textContent=c.title;
  document.getElementById('modal-meta').innerHTML=`LOCATION: ${c.loc} &nbsp;|&nbsp; PRIORITY: ${c.pri} &nbsp;|&nbsp; RECEIVED: ${c.time||'LIVE'}`+(c.postedBy&&c.postedBy!=='SYSTEM'?` &nbsp;|&nbsp; POSTED BY: ${c.postedBy}`:'');
  startTW(c.body||'');
  document.getElementById('modal-overlay').classList.add('active');
}
function openModal(rank,stars,body){
  document.getElementById('modal-tag').textContent='CLEARANCE DOSSIER — EYES ONLY';
  document.getElementById('modal-title').textContent=rank+' — ACCESS BRIEFING';
  document.getElementById('modal-meta').innerHTML=`DESIGNATION: ${rank} &nbsp;|&nbsp; STARS: ${stars} &nbsp;|&nbsp; STATUS: ACTIVE`;
  startTW(body); document.getElementById('modal-overlay').classList.add('active');
}
window.openModal=openModal;
function startTW(text){
  const el=document.getElementById('modal-content'); el.textContent='';
  if(twInterval) clearInterval(twInterval); let i=0;
  twInterval=setInterval(()=>{if(i<text.length){el.textContent+=text[i];i++;}else clearInterval(twInterval);},10);
}
function closeModalBg(e){if(e.target===document.getElementById('modal-overlay')) closeModalNow();}
window.closeModalBg=closeModalBg;
function closeModalNow(){document.getElementById('modal-overlay').classList.remove('active');if(twInterval)clearInterval(twInterval);}
window.closeModalNow=closeModalNow;

// Dispatch panel
const radioSfx = new Audio('radio.mp3');
radioSfx.volume = 0.8;

function openDispatchPanel(){
  radioSfx.currentTime = 0;
  radioSfx.play().catch(()=>{});
  document.getElementById('dispatch-panel').classList.add('active');
}
window.openDispatchPanel=openDispatchPanel;
function closeDispatchPanel(){ document.getElementById('dispatch-panel').classList.remove('active'); }
window.closeDispatchPanel=closeDispatchPanel;

function submitCrisis(){
  const title=document.getElementById('dp-title').value.trim();
  const loc=(document.getElementById('dp-loc').value.trim()||'UNKNOWN').toUpperCase();
  const pri=document.getElementById('dp-pri').value;
  const body=document.getElementById('dp-body').value.trim();
  if(!title||!body){alert('TITLE and BODY are required.');return;}
  fbPushCrisis(title.toUpperCase(),loc,pri,body);
  fbPostLog(`NEW DISPATCH posted by ${myCallSign}: ${title.toUpperCase()}`,false);
  document.getElementById('dp-title').value='';
  document.getElementById('dp-loc').value='';
  document.getElementById('dp-body').value='';
  closeDispatchPanel();
}
window.submitCrisis=submitCrisis;

function submitIntel(){
  const msg=document.getElementById('dp-intel-msg').value.trim();
  if(!msg) return;
  fbPostLog(msg,true);
  document.getElementById('dp-intel-msg').value='';
  document.getElementById('dp-intel-msg').focus();
}
window.submitIntel=submitIntel;

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('dp-tab-crisis').addEventListener('click',()=>{
    document.getElementById('dp-crisis-form').style.display='block';
    document.getElementById('dp-intel-form').style.display='none';
    document.getElementById('dp-tab-crisis').classList.add('active');
    document.getElementById('dp-tab-intel').classList.remove('active');
  });
  document.getElementById('dp-tab-intel').addEventListener('click',()=>{
    document.getElementById('dp-crisis-form').style.display='none';
    document.getElementById('dp-intel-form').style.display='block';
    document.getElementById('dp-tab-intel').classList.add('active');
    document.getElementById('dp-tab-crisis').classList.remove('active');
    document.getElementById('dp-intel-msg').focus();
  });
  document.getElementById('dp-intel-msg').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitIntel();}
  });
});

// CD-only: delete crisis
function cdDeleteCrisis(event, id) {
  event.stopPropagation();
  if (!isCD) return;
  remove(ref(db, `crises/${id}`));
  fbPostLog(`CD removed crisis dispatch [${id}]`, false);
}
window.cdDeleteCrisis = cdDeleteCrisis;

// CD-only: delete log entry
function cdDeleteLog(key) {
  if (!isCD) return;
  remove(ref(db, `intelLog/${key}`));
}
window.cdDeleteLog = cdDeleteLog;


const CRISES=[
  {title:'EASTERN FLANK INCURSION — ARMORED COLUMN SIGHTED',loc:'BERLIN',pri:'HIGH',time:'04:17 GMT',clr:'OPERATIVE',body:`INTELLIGENCE REPORT — PRIORITY ALPHA\n────────────────────────────────────────\n\nStation NIGHTWATCH confirmed mechanized column of ~40 armored vehicles crossed demarcation line at NOVEMBER-7-ECHO, 03:51 GMT.\n\nCombined-arms assessment: armor, infantry, towed artillery. Material breach of Krakow Provisional Agreement.\n\nRECOMMENDED ACTION: Convene emergency session. Issue condemnation. Activate Article IV.`},
  {title:'DIPLOMATIC CIPHER INTERCEPTED — INTENT UNCLEAR',loc:'MOSCOW',pri:'HIGH',time:'03:52 GMT',clr:'DIRECTOR',body:`SIGNALS INTELLIGENCE — COMPARTMENTALIZED\n────────────────────────────────────────\n\nStation FOXGLOVE: partial intercept 03:22 GMT, DELTA-9. Unknown cypher variant. Decode: 47%.\n\nRECOMMENDED ACTION: Elevated readiness. Full decode: 90 min.`},
  {title:'NEUTRAL ZONE AGREEMENT UNDER STRAIN',loc:'GENEVA',pri:'MED',time:'02:30 GMT',clr:'AGENT',body:`SITUATION REPORT — DIPLOMATIC\n────────────────────────────────────────\n\n3 airspace violations in 48hr. No transponder IDs.\n\nRECOMMENDED ACTION: Emergency resolution. 72hr advance-notice requirement.`},
  {title:'NAVAL RESUPPLY ROUTE DISPUTED — BLOCKADE IMMINENT',loc:'ISTANBUL',pri:'MED',time:'01:14 GMT',clr:'AGENT',body:`NAVAL INTELLIGENCE — URGENT\n────────────────────────────────────────\n\nSS KARPATHIA seized 00:42 GMT, lower Bosphorus. 3.2M civilians at risk.\n\nRECOMMENDED ACTION: Back-channel contact. Bosphorus Convention arbitration.`},
  {title:'PRESS BUREAU REQUESTING OFFICIAL STATEMENT',loc:'LONDON',pri:'LOW',time:'00:05 GMT',clr:'CADET',body:`COMMUNICATIONS ADVISORY\n────────────────────────────────────────\n\n17 press inquiries. Draft ROMEO-4 recommended.\n\nRECOMMENDED ACTION: DIRECTOR clearance to authorize ROMEO-4.`},
  {title:'RATIFICATION OF ARTICLE IX — SIGNATURES OUTSTANDING',loc:'WARSAW',pri:'LOW',time:'PREV. SESSION',clr:'CADET',body:`PROCEDURAL NOTICE — SECRETARIAT\n────────────────────────────────────────\n\n7 of 12 ratifications received. France, Netherlands, Belgium, Norway, Czechoslovakia outstanding.\n\nDeadline: morning plenary.`},
];

window.addEventListener('resize',renderAll);
setTimeout(renderAll,100);
setTimeout(renderAll,700);

// ═══════════════════════════════════════════════════════════
// BOOT — check saved session or show login
// ═══════════════════════════════════════════════════════════
if (loadSession()) {
  // Restore session
  document.getElementById('login-overlay').classList.add('hidden');
  presKey = myCallSign.replace(/[^a-zA-Z0-9]/g, '_');
  myPresRef = ref(db, `presence/${presKey}`);
  set(myPresRef, { callSign: myCallSign, isCD, ts: Date.now() });
  onDisconnect(myPresRef).remove();
  applyPermissions();
  setCallSignLabel();
  setTimeout(() => fbPostLog(`Agent ${myCallSign} reconnected to secure channel.`, false), 1500);
} else {
  // Show login — page is blocked until login completes
  // login-overlay is visible by default (no hidden class)
}


// Update dispatch panel callsign label when DOM is ready
function setCallSignLabel() {
  const lbl = document.getElementById('dp-callsign-label');
  if (lbl) lbl.textContent = `SENDING AS: ${myCallSign}`;
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setCallSignLabel);
} else {
  setCallSignLabel();
}
