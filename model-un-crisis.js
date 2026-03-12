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
let isModerator = false;
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
        isModerator = s.isModerator || false;
        return true;
      }
    } catch(e) {}
  }
  return false;
}

function saveSession(callSign, cd) {
  localStorage.setItem('warroom_session', JSON.stringify({ callSign, isCD: cd, isModerator }));
}

function clearSession() {
  localStorage.removeItem('warroom_session');
}

function showLoginModal() {
  // Detach old presence
  if (myPresRef) { remove(myPresRef); myPresRef = null; }
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-select').value = '';
  document.getElementById('login-password-wrap').style.display = 'block';
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('login-btn').classList.remove('cd-mode');
  document.getElementById('login-btn').textContent = '[ AUTHENTICATE ]';
}
window.showLoginModal = showLoginModal;

function attemptLogin() {
  const sel = document.getElementById('login-select').value;
  const pw = document.getElementById('login-password').value;

  if (!sel) { shakeLoginError('SELECT AN AGENT DESIGNATION'); return; }

  if (!sel) { shakeLoginError('SELECT AN AGENT DESIGNATION'); return; }

  const expected = sel === 'CD' ? CD_PASSWORD : sel === 'MODERATOR' ? 'watches' : sel.toLowerCase();

  if (pw !== expected) {
    shakeLoginError('✕ AUTHORIZATION FAILED — INCORRECT CODE');
    document.getElementById('login-password').value = '';
    document.getElementById('login-password').focus();
    return;
  }

  isModerator = (sel === 'MODERATOR');
  completeLogin(sel, sel === 'CD');
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
  try {
    myCallSign = callSign;
    isCD = cd;
    presKey = callSign.replace(/[^a-zA-Z0-9]/g, '_');
    myPresRef = ref(db, `presence/${presKey}`);
    set(myPresRef, { callSign: myCallSign, isCD, isModerator, ts: Date.now() });
    onDisconnect(myPresRef).remove();
    saveSession(callSign, cd);

    // Hide login
    document.getElementById('login-overlay').classList.add('hidden');

    // Apply permissions
    applyPermissions();

    // Update UI labels
    setCallSignLabel();
    setTimeout(() => fbPostLog(`Agent ${myCallSign} authenticated and connected.`, false), 800);
  } catch(err) {
    console.error('completeLogin error:', err);
    // Force hide login even if something else failed
    document.getElementById('login-overlay').classList.add('hidden');
  }
}

function applyPermissions() {
  const badge = document.getElementById('agent-badge');
  if (badge) badge.textContent = isCD ? '⬡ CD // CRISIS DIRECTOR' : `⬡ ${myCallSign}`;
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

  // Show/hide CD delete buttons via body class
  document.body.classList.toggle("cd-mode", isCD);
  document.body.classList.toggle("mod-mode", isModerator);
  const modBadge = document.getElementById('mod-agent-badge');
  if (modBadge) modBadge.textContent = `⬡ ${myCallSign} // MODERATOR`;

  // If not CD, ensure we're in view mode
  if (!isCD && mode !== 'view') setMode('view');
}

// ── Handle select change to show/hide password field ──────
document.getElementById('login-select').addEventListener('change', function() {
  const wrap = document.getElementById('login-password-wrap');
  const label = document.getElementById('login-password-label');
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.style.display = 'none';
  document.getElementById('login-password').value = '';
  wrap.style.display = 'block';
  if (this.value === 'CD') {
    label.textContent = '⚠ CD AUTHORIZATION CODE REQUIRED';
    btn.classList.add('cd-mode');
    btn.textContent = '[ REQUEST ACCESS ]';
  } else if (this.value) {
    label.textContent = 'AGENT ACCESS CODE';
    btn.classList.remove('cd-mode');
    btn.textContent = '[ AUTHENTICATE ]';
  }
  if (this.value) setTimeout(() => document.getElementById('login-password').focus(), 50);
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

onValue(crisisRef,snap=>{ const data=snap.val()||{}; renderCrisisFeed(data); updateTicker(data); });

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
        <button class="cd-delete-crisis" data-id="${c.id}" onclick="cdDeleteCrisis(event,'${c.id}')">✕ DELETE</button>
      </div>
      <div class="crisis-title">${c.title}</div>
      <div class="crisis-body">${(c.body||'').split('\n')[0].substring(0,120)}</div>`;
    div.addEventListener('click',()=>openCrisisData(c));
    feed.appendChild(div);
  });
}

function updateTicker(data) {
  const el = document.getElementById('ticker-content');
  if (!el) return;
  const items = Object.values(data).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  if (!items.length) { el.textContent = '◆ AWAITING DISPATCHES ◆'; return; }
  el.textContent = items.map(c => `◆ [${c.pri}] ${c.loc} — ${c.title}`).join(' ') + ' ◆';
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
  const entries=snap.val()||{};
  renderModLog(entries);
  renderIntelLog(entries);
  renderMsgLog(entries);
});

function renderIntelLog(entries) {
  if(isModerator) return;
  const logEl=document.getElementById('intel-log');
  if(!logEl) return;
  // Intel log shows ONLY public announcements (no recipient = broadcast)
  // CD messages with isUser=true are public announcements; system messages (isUser=false/null) also show
  const sorted=Object.entries(entries)
    .filter(([,e])=>!e.recipient) // no DMs — public only
    .sort((a,b)=>((b[1].ts||0)-(a[1].ts||0))).slice(0,50);
  logEl.innerHTML='';
  if(!sorted.length){
    logEl.innerHTML='<div style="color:rgba(0,255,65,0.15);font-size:8px;letter-spacing:2px;padding:10px 0;">NO PUBLIC ANNOUNCEMENTS</div>';
    return;
  }
  sorted.forEach(([key,e])=>{
    const div=document.createElement('div');
    const isAnnouncement = e.isUser && e.callSign;
    const col = isAnnouncement ? 'var(--amber)' : 'rgba(0,255,65,0.38)';
    div.className='log-entry'+(e.isUser?' new':'');
    div.innerHTML=`<span class="timestamp" style="color:${col}">[${e.ts_str||'--:--:--'}]</span> `+
      (e.callSign?`<span style="color:${col};font-size:8px;">${e.callSign}:</span> `:'')+
      `<span class="msg">${e.msg}</span>`+
      `<button class="cd-delete-log" onclick="cdDeleteLog('${key}')">✕</button>`;
    logEl.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════
// TRANSMISSIONS — iMessage-style DM system
// ═══════════════════════════════════════════════════════════
let txActiveThread = null; // callSign of currently open conversation
let txAllEntries = {};     // latest snapshot of all entries

function renderMsgLog(entries) {
  txAllEntries = entries;
  renderTxThreadList();
  if (txActiveThread) renderTxConvo(txActiveThread);
}

function renderTxThreadList() {
  const listEl = document.getElementById('tx-thread-list');
  if (!listEl) return;

  // All DMs involving me (or all if CD/mod)
  const myDMs = Object.entries(txAllEntries)
    .filter(([,e]) => e.recipient)
    .filter(([,e]) => isCD || isModerator || e.recipient === myCallSign || e.callSign === myCallSign);

  if (!myDMs.length) {
    listEl.innerHTML = '<div class="tx-empty">NO TRANSMISSIONS YET<br><span style="color:rgba(153,91,255,0.18);">PRESS + NEW TO BEGIN</span></div>';
    return;
  }

  // Group by conversation partner
  const threads = {}; // key = other party's callSign
  myDMs.forEach(([key,e]) => {
    const other = (isCD || isModerator)
      ? (e.callSign === myCallSign ? e.recipient : e.callSign)
      : (e.callSign === myCallSign ? e.recipient : e.callSign);
    if (!threads[other]) threads[other] = [];
    threads[other].push([key, e]);
  });

  // Sort threads by most recent message
  const threadList = Object.entries(threads).sort((a,b) => {
    const latestA = Math.max(...a[1].map(([,e])=>e.ts||0));
    const latestB = Math.max(...b[1].map(([,e])=>e.ts||0));
    return latestB - latestA;
  });

  listEl.innerHTML = '';
  threadList.forEach(([partner, msgs]) => {
    const latest = msgs.sort((a,b)=>(b[1].ts||0)-(a[1].ts||0))[0][1];
    const isUnread = latest.callSign !== myCallSign && txActiveThread !== partner;
    const item = document.createElement('div');
    item.className = 'tx-thread-item' + (isUnread ? ' unread' : '');
    item.onclick = () => txOpenThread(partner);
    item.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline;">
         <span class="tx-thread-name">${partner}</span>
         <span class="tx-thread-time">${latest.ts_str||'--:--'}</span>
       </div>
       <div class="tx-thread-preview">${latest.callSign===myCallSign?'YOU: ':''}${latest.msg}</div>`;
    listEl.appendChild(item);
  });
}

function renderTxConvo(partner) {
  const msgEl = document.getElementById('tx-messages');
  if (!msgEl) return;

  const convoMsgs = Object.entries(txAllEntries)
    .filter(([,e]) => e.recipient)
    .filter(([,e]) => {
      if (isCD || isModerator) {
        return (e.callSign === partner || e.recipient === partner) &&
               (e.callSign === myCallSign || e.recipient === myCallSign || isCD || isModerator);
      }
      return (e.callSign === myCallSign && e.recipient === partner) ||
             (e.callSign === partner && e.recipient === myCallSign);
    })
    .sort((a,b) => (a[1].ts||0) - (b[1].ts||0));

  msgEl.innerHTML = '';
  if (!convoMsgs.length) {
    msgEl.innerHTML = '<div class="tx-empty">NO MESSAGES YET<br><span style="color:rgba(153,91,255,0.15);">SEND THE FIRST TRANSMISSION</span></div>';
    return;
  }
  convoMsgs.forEach(([key, e]) => {
    const isMine = e.callSign === myCallSign;
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = isMine ? 'flex-end' : 'flex-start';
    const bubble = document.createElement('div');
    bubble.className = 'tx-bubble ' + (isMine ? 'mine' : 'theirs');
    bubble.innerHTML =
      `<div class="tx-bubble-meta">${e.callSign} · ${e.ts_str||'--:--:--'}</div>` +
      `<div>${e.msg}</div>`;
    wrap.appendChild(bubble);
    msgEl.appendChild(wrap);
  });
  msgEl.scrollTop = msgEl.scrollHeight;
}

function txOpenThread(partner) {
  txActiveThread = partner;
  document.getElementById('tx-thread-list').style.display = 'none';
  document.getElementById('tx-new-contact').style.display = 'none';
  const convoView = document.getElementById('tx-convo-view');
  convoView.style.display = 'flex';
  document.getElementById('tx-convo-name').textContent = partner;
  renderTxConvo(partner);
  renderTxThreadList(); // refresh unread badges
  document.getElementById('tx-input').focus();
}

function txBack() {
  txActiveThread = null;
  document.getElementById('tx-convo-view').style.display = 'none';
  document.getElementById('tx-new-contact').style.display = 'none';
  document.getElementById('tx-thread-list').style.display = 'block';
  renderTxThreadList();
}

function txStartNew() {
  txActiveThread = null;
  document.getElementById('tx-convo-view').style.display = 'none';
  document.getElementById('tx-thread-list').style.display = 'none';
  const nc = document.getElementById('tx-new-contact');
  nc.style.display = 'block';
  // Listener: selecting a contact opens that thread
  const sel = document.getElementById('tx-contact-select');
  sel.onchange = function() {
    const chosen = sel.value;
    if (!chosen) return;
    sel.value = '';
    nc.style.display = 'none';
    document.getElementById('tx-thread-list').style.display = 'block';
    txOpenThread(chosen);
  };
}

function txSend() {
  const input = document.getElementById('tx-input');
  const msg = input.value.trim();
  if (!msg || !txActiveThread) return;
  fbPostDM(msg, txActiveThread);
  input.value = '';
  input.focus();
}
window.txSend = txSend;
window.txBack = txBack;
window.txStartNew = txStartNew;
window.txOpenThread = txOpenThread;

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



function fbPostDM(msg, recipient){
  const now=new Date(),p=n=>String(n).padStart(2,'0');
  const r=push(intelRef);
  set(r,{msg,isUser:true,callSign:myCallSign,recipient,ts:Date.now(),ts_str:p(now.getUTCHours())+':'+p(now.getUTCMinutes())+':'+p(now.getUTCSeconds())});
}

function resetAllChats() {
  if (!isCD) return;
  if (!confirm('WIPE ALL INTEL LOG DATA?\n\nThis will permanently delete all public announcements and private transmissions from the database. This cannot be undone.')) return;
  remove(intelRef).then(() => {
    fbPostLog('CD purged all communications. Chat log reset.', false);
  });
}
window.resetAllChats = resetAllChats;

function renderModLog(entries) {
  const logEl = document.getElementById('mod-log');
  if (!logEl) return;
  const sorted = Object.entries(entries).sort((a,b)=>((b[1].ts||0)-(a[1].ts||0))).slice(0,100);
  logEl.innerHTML = '';
  if (!sorted.length) {
    logEl.innerHTML = '<div style="color:rgba(0,255,65,0.2);font-size:9px;letter-spacing:2px;padding:20px;">NO MESSAGES YET</div>';
    return;
  }
  sorted.forEach(([key,e]) => {
    const div = document.createElement('div');
    div.className = 'mod-log-entry' + (e.recipient ? ' dm' : '');
    const dmTag = e.recipient ? `<span class="mod-dm-tag">[DM→${e.recipient}]</span>` : '';
    div.innerHTML =
      `<span class="mod-ts">[${e.ts_str||'--:--:--'}]</span>` +
      `<span class="mod-sender">${e.callSign||'SYSTEM'}</span>` +
      dmTag +
      `<span class="mod-msg">${e.msg}</span>` +
      `<button class="mod-del" onclick="cdDeleteLog('${key}')">✕ DEL</button>`;
    logEl.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════
// PRESENCE COUNTER
// ═══════════════════════════════════════════════════════════
onValue(ref(db,'presence'),snap=>{
  const agents=snap.val()||{};
  const count=Object.keys(agents).length;
  const el=document.getElementById('online-indicator');
  if(el) el.textContent=`◉ ${count} AGENT${count!==1?'S':''} ONLINE`;
  renderCDAgentList(agents);
});

function renderCDAgentList(agents) {
  const list = document.getElementById('cd-agent-list');
  if (!list) return;
  const rows = Object.values(agents);
  if (rows.length === 0) {
    list.innerHTML = '<div id="cd-agent-empty">NO AGENTS ONLINE</div>';
  } else {
    list.innerHTML = '';
    rows.forEach(a => {
      const isSelf = a.callSign === myCallSign;
      const row = document.createElement('div');
      row.className = 'cd-agent-row';
      const nameSpan = `<span class="cd-agent-name${a.isCD?' is-cd':''}">${a.callSign}${a.isCD?' ★':''}</span>`;
      const kickBtn = isSelf
        ? `<span style="font-size:7px;color:rgba(0,255,65,0.2);letter-spacing:1px;">YOU</span>`
        : `<button class="cd-kick-btn" onclick="kickAgent('${a.callSign}')">KICK</button>`;
      row.innerHTML = nameSpan + kickBtn;
      list.appendChild(row);
    });
  }
  // Update dp-intel-recipient (CD dispatch panel) — always show all accounts
  const dpSel = document.getElementById('dp-intel-recipient');
  if (dpSel) {
    const dpCurrent = dpSel.value;
    dpSel.innerHTML = '<option value="ALL">◆ ALL DELEGATES (PUBLIC)</option>';
    ['AGENT-1','AGENT-2','AGENT-3','AGENT-4','AGENT-5','AGENT-6','AGENT-7','AGENT-8','AGENT-9','AGENT-10','AGENT-11','AGENT-12','AGENT-13','AGENT-14','AGENT-15','AGENT-16','AGENT-17','AGENT-18','AGENT-19','AGENT-20','MODERATOR'].forEach(name => {
      if (name === myCallSign) return;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `⬡ ${name}`;
      dpSel.appendChild(opt);
    });
    if ([...dpSel.options].some(o=>o.value===dpCurrent)) dpSel.value = dpCurrent;
  }

  // Update tx-contact-select (Transmissions "new conversation" selector) — online agents only
  const txSel = document.getElementById('tx-contact-select');
  if (txSel) {
    const txCurrent = txSel.value;
    txSel.innerHTML = '<option value="">— ONLINE AGENTS —</option>';
    Object.values(agents).forEach(a => {
      if (a.callSign === myCallSign) return;
      const opt = document.createElement('option');
      opt.value = a.callSign;
      opt.textContent = `⬡ ${a.callSign}${a.isCD?' (CD)':a.isModerator?' (MOD)':''}`;
      txSel.appendChild(opt);
    });
    if ([...txSel.options].some(o=>o.value===txCurrent)) txSel.value = txCurrent;
  }
}

function toggleCDPanel() {
  const panel = document.getElementById('cd-agent-panel');
  if (panel) panel.classList.toggle('active');
}
window.toggleCDPanel = toggleCDPanel;

function kickAgent(callSign) {
  if (!isCD && !isModerator) return;
  // Write kick record to Firebase with expiry timestamp
  const kickUntil = Date.now() + 20000;
  set(ref(db, `kicks/${callSign.replace(/[^a-zA-Z0-9]/g,'_')}`), { callSign, kickUntil });
  // Remove their presence immediately
  remove(ref(db, `presence/${callSign.replace(/[^a-zA-Z0-9]/g,'_')}`));
  fbPostLog(`CD issued disconnect order: ${callSign}`, false);
}
window.kickAgent = kickAgent;

// Listen for kicks targeting this client
onValue(ref(db,'kicks'), snap => {
  const kicks = snap.val() || {};
  const myKey = myCallSign.replace(/[^a-zA-Z0-9]/g,'_');
  const kick = kicks[myKey];
  if (kick && kick.kickUntil > Date.now()) {
    // We've been kicked — force logout and lock login
    if (myPresRef) { remove(myPresRef); myPresRef = null; }
    myCallSign = '';
    isCD = false;
      showLoginModal();
    lockLoginUntil(kick.kickUntil);
  }
});

let kickLockInterval = null;
function lockLoginUntil(until) {
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const sel = document.getElementById('login-select');
  const pw  = document.getElementById('login-password');

  function applyLock() {
    const remaining = Math.ceil((until - Date.now()) / 1000);
    if (remaining <= 0) {
      // Unlock
      if (btn)  { btn.disabled = false; btn.textContent = '[ AUTHENTICATE ]'; }
      if (sel)  sel.disabled = false;
      if (pw)   pw.disabled = false;
      if (err)  { err.style.display = 'none'; }
      clearInterval(kickLockInterval);
      // Clean up kick record
      remove(ref(db, `kicks/${myCallSign.replace(/[^a-zA-Z0-9]/g,'_')}`));
      return;
    }
    if (btn)  { btn.disabled = true; btn.textContent = `[ LOCKED — ${remaining}s ]`; }
    if (sel)  sel.disabled = true;
    if (pw)   pw.disabled = true;
    if (err)  { err.textContent = `✕ DISCONNECTED BY CD — RETRY IN ${remaining}s`; err.style.display = 'block'; }
  }

  applyLock();
  clearInterval(kickLockInterval);
  kickLockInterval = setInterval(applyLock, 500);
}

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
  if(!isCD) return;
  radioSfx.currentTime = 0;
  radioSfx.play().catch(()=>{});
  document.getElementById('dispatch-panel').classList.add('active');
  if(isCD) {
    // CD sees crisis form by default
    switchDPTab('crisis');
  } else {
    // Agents skip straight to intel tab, crisis tab hidden
    switchDPTab('intel');
    document.getElementById('dp-tab-crisis').style.display = 'none';
    // Remove ALL option for agents — must pick a specific recipient
    const sel = document.getElementById('dp-intel-recipient');
    if(sel) {
      [...sel.options].forEach(o => { if(o.value==='ALL') o.style.display='none'; });
      if(sel.value==='ALL') sel.value = sel.options[1]?.value || 'ALL';
    }
    const hint = document.getElementById('dp-intel-hint');
    if(hint) hint.textContent = 'Select a recipient — only they will see this message.';
  }
}
window.openDispatchPanel=openDispatchPanel;

function switchDPTab(tab){
  const crisisForm=document.getElementById('dp-crisis-form');
  const intelForm=document.getElementById('dp-intel-form');
  const tabCrisis=document.getElementById('dp-tab-crisis');
  const tabIntel=document.getElementById('dp-tab-intel');
  if(tab==='crisis'){
    crisisForm.style.display=''; intelForm.style.display='none';
    tabCrisis.classList.add('active'); tabIntel.classList.remove('active');
  } else {
    crisisForm.style.display='none'; intelForm.style.display='';
    tabIntel.classList.add('active'); tabCrisis.classList.remove('active');
  }
}
window.switchDPTab=switchDPTab;
function closeDispatchPanel(){
  document.getElementById('dispatch-panel').classList.remove('active');
  // Reset for next open
  document.getElementById('dp-tab-crisis').style.display = '';
  const sel = document.getElementById('dp-intel-recipient');
  if(sel) [...sel.options].forEach(o => { o.style.display=''; });
}
window.closeDispatchPanel=closeDispatchPanel;

function submitCrisis(){
  if(!isCD) return;
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
  const recipientEl=document.getElementById('dp-intel-recipient');
  const recipient=recipientEl?recipientEl.value:'ALL';
  if(recipient==='ALL'){
    fbPostLog(msg,true);
  } else {
    fbPostDM(msg,recipient);
  }
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
  const txInput = document.getElementById('tx-input');
  if(txInput) txInput.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();txSend();}
  });
  document.getElementById('dp-intel-recipient').addEventListener('change',function(){
    const hint=document.getElementById('dp-intel-hint');
    if(!hint) return;
    hint.textContent = this.value==='ALL'
      ? '◆ PUBLIC — visible to all agents in the intel log.'
      : `⬡ PRIVATE — only you and ${this.value} will see this.`;
  });
});

// CD-only: delete crisis
function cdDeleteCrisis(event, id) {
  event.stopPropagation();
  if (!isCD) return;
  remove(ref(db, `crises/${id}`))
  if (!isCD) return;
  remove(ref(db, `crises/${id}`));
  fbPostLog(`CD removed crisis dispatch [${id}]`, false);
}
window.cdDeleteCrisis = cdDeleteCrisis;

// CD-only: delete log entry
function cdDeleteLog(key) {
  if (!isCD && !isModerator) return;
  if (!isCD && !isModerator) return;
  remove(ref(db, `intelLog/${key}`));
}
window.cdDeleteLog = cdDeleteLog;



window.addEventListener('resize',renderAll);
setTimeout(renderAll,100);
setTimeout(renderAll,700);

// ═══════════════════════════════════════════════════════════
// BOOT — check saved session or show login
// ═══════════════════════════════════════════════════════════
// Login overlay is visible by default — always prompt on load
if (loadSession()) {
  // Restore session
  document.getElementById('login-overlay').classList.add('hidden');
  presKey = myCallSign.replace(/[^a-zA-Z0-9]/g, '_');
  myPresRef = ref(db, `presence/${presKey}`);
  set(myPresRef, { callSign: myCallSign, isCD, isModerator, ts: Date.now() });
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
