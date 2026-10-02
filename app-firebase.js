import { initializeApp, getApps, getApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, query, where, limit, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
window._fbSignOut = fbSignOut;

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
let db_fs = null, auth = null;
const TODAY = new Date().toISOString().split('T')[0];
const CUR_YEAR = TODAY.slice(0,4);
const CUR_MONTH = TODAY.slice(0,7);

// Données lues depuis TRIOMPHANT (lecture seule)
let TDB = {
  agences:[], commerciaux:[], clients:[], paiements:[],
  articles:[], stockMvts:[], livraisons:[], adhesionPays:[], mises:[], depenses:[]
};

// Données propres à la comptabilité (lecture/écriture)
let CHARGES = []; // Stockées dans localStorage de ce logiciel
let chargeEditId = null;

let chartEvo = null, chartDonut = null, chartResMensuel = null;

/* ═══════════════════════════════════════════════════
   UTILITAIRES
═══════════════════════════════════════════════════ */
const fmt = v => Number(v||0).toLocaleString('fr-FR') + ' FCFA';
const fmtShort = v => {
  const n = Number(v||0);
  if(n>=1000000) return (n/1000000).toFixed(1)+'M FCFA';
  if(n>=1000) return Math.round(n/1000)+'k FCFA';
  return n.toLocaleString('fr-FR')+' FCFA';
};

function notify(msg, type='ok'){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show t-'+type;
  clearTimeout(t._tm);
  t._tm = setTimeout(()=>{ t.className=''; }, 3200);
}

function saveChargesLocal(){
  localStorage.setItem('triomphant_compta_charges', JSON.stringify(CHARGES));
  buildIndexes();
  // Sync vers Firestore (best-effort, non bloquant) pour partager les charges
  // entre tous les appareils connectés à la même base.
  if(db_fs){
    setDoc(doc(db_fs,'charges','data'), {items:CHARGES, updatedAt:serverTimestamp()})
      .catch(e=>console.warn('Sync Firestore (charges) échouée :', e.message));
  }
}
function loadChargesLocal(){
  try { CHARGES = JSON.parse(localStorage.getItem('triomphant_compta_charges')||'[]'); }
  catch(e){ CHARGES = []; }
  buildIndexes();
}

/* ═══════════════════════════════════════════════════
   INDEXATION (perf) — évite les .find()/.filter() répétés
   sur les tableaux complets à chaque rendu de page. Construit
   une fois par chargement/modification de données, puis les
   pages consomment des lookups en O(1) au lieu de scans en O(n).
═══════════════════════════════════════════════════ */
let IDX = {
  clientsById:new Map(), commerciauxById:new Map(), articlesById:new Map(),
  paiementsByMonth:new Map(), paiementsByClient:new Map(),
  livraisonsByMonth:new Map(), livraisonsByClient:new Map(),
  adhesionsByMonth:new Map(), chargesByMonth:new Map()
};
function _groupBy(arr, keyFn){
  const m = new Map();
  (arr||[]).forEach(x=>{
    const k = keyFn(x);
    if(k===null||k===undefined) return;
    if(!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return m;
}
function buildIndexes(){
  IDX.clientsById     = new Map((TDB.clients||[]).map(c=>[c._id,c]));
  IDX.commerciauxById = new Map((TDB.commerciaux||[]).map(c=>[c._id,c]));
  IDX.articlesById    = new Map((TDB.articles||[]).map(a=>[a._id,a]));
  IDX.paiementsByMonth  = _groupBy(TDB.paiements,  p=>p.date?p.date.slice(0,7):null);
  IDX.paiementsByClient = _groupBy(TDB.paiements,  p=>p.clientId);
  IDX.livraisonsByMonth  = _groupBy(TDB.livraisons, l=>l.date?l.date.slice(0,7):null);
  IDX.livraisonsByClient = _groupBy(TDB.livraisons, l=>l.clientId);
  IDX.adhesionsByMonth = _groupBy(TDB.adhesionPays, a=>a.date?a.date.slice(0,7):null);
  IDX.chargesByMonth   = _groupBy(CHARGES, c=>c.date?c.date.slice(0,7):null);
}
/* Retourne les entrées d'une map-par-mois pour une période donnée :
   un mois précis ('YYYY-MM'), ou toute une année si month est vide. */
function _monthlyRange(map, year, month){
  if(month) return map.get(`${year}-${month}`) || [];
  let out = [];
  for(let m=1;m<=12;m++){
    const key = `${year}-${String(m).padStart(2,'0')}`;
    const arr = map.get(key);
    if(arr) out = out.concat(arr);
  }
  return out;
}

function getYears(){
  const yrs = new Set([CUR_YEAR]);
  TDB.paiements.forEach(p=>{ if(p.date) yrs.add(p.date.slice(0,4)); });
  TDB.livraisons.forEach(l=>{ if(l.date) yrs.add(l.date.slice(0,4)); });
  CHARGES.forEach(c=>{ if(c.date) yrs.add(c.date.slice(0,4)); });
  return [...yrs].sort().reverse();
}

function populateYearSelects(){
  const yrs = getYears();
  ['dash-year','bilan-year','res-year','proj-year','cf-year'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    const prev = el.value;
    el.innerHTML = yrs.map(y=>`<option value="${y}"${y===CUR_YEAR?'selected':''}>${y}</option>`).join('');
    if(prev && yrs.includes(prev)) el.value = prev;
  });
}

function periodLabel(year, month){
  if(!month) return `Exercice ${year}`;
  const mois=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  return `${mois[parseInt(month)-1]} ${year}`;
}

/* ═══════════════════════════════════════════════════
   CATÉGORIE COULEURS
═══════════════════════════════════════════════════ */
const CAT_COLORS = {
  'Personnel':'#ef4444','Loyer':'#f97316','Transport':'#eab308',
  'Fournitures':'#22c55e','Télécoms':'#06b6d4','Bancaire':'#6366f1',
  'Impots':'#ec4899','Marketing':'#a78bfa','Divers':'#6b7499'
};
function catColor(cat){ return CAT_COLORS[cat]||'#6b7499'; }

/* ═══════════════════════════════════════════════════
   FIREBASE — CONFIG INTÉGRÉE (plus d'écran à remplir manuellement)
═══════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyATa_tOvEbGROCIZ9xZgkAsr_--d2vYIjc",
  authDomain: "triomphant-v2.firebaseapp.com",
  projectId: "triomphant-v2",
  storageBucket: "triomphant-v2.firebasestorage.app",
  messagingSenderId: "908578874554",
  appId: "1:908578874554:web:5c008fba39204ce6c24e83",
  measurementId: "G-STQHJF83X2"
};

/* Initialisation Firebase immédiate (avant tout login), comme dans l'app
   TRIOMPHANT : ceci permet d'utiliser directement signInWithEmailAndPassword
   depuis le formulaire de connexion, sans étape intermédiaire. */
const _fbApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
db_fs = getFirestore(_fbApp);
auth = getAuth(_fbApp);

// [OPTIM LECTURES] Verrous de démarrage (anti double-chargement)
let _bootInProgress = false, _appStarted = false, _autoSyncTimer = null;
let _lastFullSync = 0;
const AUTO_SYNC_MS = 30*60*1000; // auto-sync toutes les 30 min (avant : 5 min)

// Rôles autorisés à utiliser l'application comptabilité
const VALID_ROLES = ['admin','comptable'];

/* ═══════════════════════════════════════════════════
   VERROU ANTI-BRUTE-FORCE DOUBLE COUCHE
   (identique à l'app TRIOMPHANT — même mécanisme, même collection
   Firestore 'loginAttempts', puisque les deux apps partagent le projet)
   Couche 1 : localStorage (client) — bloque immédiatement
   Couche 2 : Firestore 'loginAttempts' (serveur) — résiste au changement
              de navigateur, d'appareil, ou au vidage du cache
═══════════════════════════════════════════════════ */
const _LGA_PALIERS = [60000, 300000, 1800000, 7200000]; // 1min,5min,30min,2h
function _lgaKey(key){ return '_lga_compta_' + key.replace(/[^a-z0-9._-]/gi,'_'); }
function _getLoginAttempt(key){
  try{ return JSON.parse(localStorage.getItem(_lgaKey(key)) || '{"count":0,"until":0,"cycles":0}'); }
  catch(e){ return {count:0,until:0,cycles:0}; }
}
function _setLoginAttempt(key,val){ try{ localStorage.setItem(_lgaKey(key), JSON.stringify(val)); }catch(e){} }
function _lgsKey(email){ return email.replace(/[^a-z0-9._-]/gi,'_').slice(0,100); }

async function _checkServerLock(email){
  if(!db_fs) return null;
  try{
    const snap = await getDoc(doc(db_fs,'loginAttempts', _lgsKey(email)));
    if(!snap.exists()) return null;
    return snap.data();
  }catch(e){ return null; }
}
async function _incServerLock(email){
  if(!db_fs) return;
  try{
    const key = _lgsKey(email);
    const ref = doc(db_fs,'loginAttempts', key);
    const snap = await getDoc(ref);
    const now = new Date();
    if(!snap.exists()){
      await setDoc(ref, { count:1, windowStart: now });
    } else {
      const d = snap.data();
      const windowMs = 60*1000;
      const windowStart = d.windowStart?.toDate ? d.windowStart.toDate() : new Date(d.windowStart);
      if(Date.now() - windowStart.getTime() > windowMs){
        await setDoc(ref, { count:1, windowStart: now });
      } else {
        await updateDoc(ref, { count:(d.count||0)+1 });
      }
    }
  }catch(e){ /* non bloquant */ }
}
async function _resetServerLock(email){
  if(!db_fs) return;
  try{ await setDoc(doc(db_fs,'loginAttempts', _lgsKey(email)), { count:0, windowStart: new Date() }); }
  catch(e){}
}

/* ═══════════════════════════════════════════════════
   TIMEOUT DE SESSION (inactivité 30 min) + rafraîchissement de token
   (identique à l'app TRIOMPHANT)
═══════════════════════════════════════════════════ */
const SESSION_TIMEOUT_MS = 30*60*1000;
let _sessionTimer = null, _sessionWarningTimer = null, _tokenRefreshInterval = null;
function _resetSessionTimer(){
  if(!getCurrentUser()) return;
  clearTimeout(_sessionTimer); clearTimeout(_sessionWarningTimer);
  _sessionWarningTimer = setTimeout(()=>{
    if(getCurrentUser()) notify('⚠️ Session inactive — déconnexion dans 2 minutes','warn');
  }, SESSION_TIMEOUT_MS - 2*60*1000);
  _sessionTimer = setTimeout(()=>{
    if(getCurrentUser()){
      notify('🔒 Session expirée — veuillez vous reconnecter','err');
      doLogout(true);
    }
  }, SESSION_TIMEOUT_MS);
}
['click','keydown','mousemove'].forEach(evt=>{
  document.addEventListener(evt, ()=>{ if(getCurrentUser()) _resetSessionTimer(); });
});
function _startTokenRefresh(){
  clearInterval(_tokenRefreshInterval);
  _tokenRefreshInterval = setInterval(async ()=>{
    try{ if(auth.currentUser) await auth.currentUser.getIdToken(true); }catch(e){}
  }, 50*60*1000);
}
function _stopSessionTimer(){
  clearTimeout(_sessionTimer); clearTimeout(_sessionWarningTimer); clearInterval(_tokenRefreshInterval);
}

/* Recherche du profil dans 'commerciaux' — priorité à l'UID Firebase
   (source de vérité), fallback email pour compatibilité/migration. */
async function _fetchProfile(uid, email){
  try{
    const snap = await getDoc(doc(db_fs,'commerciaux', uid));
    if(snap.exists()) return {...snap.data(), _id:snap.id};
  }catch(e){}
  // [OPTIM LECTURES] Requête ciblée (1 lecture) au lieu de lire toute la collection.
  try{
    const qs = await getDocs(query(collection(db_fs,'commerciaux'), where('email','==',email), limit(1)));
    if(!qs.empty){ const d = qs.docs[0]; return {...d.data(), _id: d.id}; }
  }catch(e){}
  // Dernier recours (ancien comportement) : profils dont l'email est stocké avec
  // des majuscules. Coûteux — le console.warn permet de repérer ces profils à corriger.
  try{
    const qs = await getDocs(collection(db_fs,'commerciaux'));
    const match = qs.docs.find(d => (d.data().email||'').toLowerCase() === email);
    if(match){
      console.warn('[lecture] Profil trouvé par scan complet — corrigez la casse de l\'email ou l\'ID du document :', match.id);
      return {...match.data(), _id: match.id};
    }
  }catch(e){}
  return null;
}

/* ═══════════════════════════════════════════════════
   CONNEXION (Firebase Auth réelle, double verrou anti-brute-force,
   validation stricte du rôle) — même fonctionnement que l'app TRIOMPHANT
═══════════════════════════════════════════════════ */
window.doLogin = async function(){
  const raw = (document.getElementById('login-email').value || '').trim().toLowerCase();
  const pwd = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-err');
  errEl.style.display = 'none';

  if(!raw || !pwd){
    errEl.textContent = 'Veuillez saisir votre email et mot de passe.';
    errEl.style.display = 'block';
    return;
  }

  // ── Couche 1 : verrou localStorage (immédiat) ──
  const now = Date.now();
  const att = _getLoginAttempt(raw);
  if(att.until > now){
    const resteS = Math.ceil((att.until-now)/1000);
    const msg = resteS>90 ? `réessayez dans ${Math.ceil(resteS/60)} min` : `réessayez dans ${resteS} s`;
    errEl.textContent = `🔒 Trop de tentatives — ${msg}`;
    errEl.style.display = 'block';
    return;
  }

  // ── Couche 2 : verrou serveur Firestore ──
  const serverLock = await _checkServerLock(raw);
  if(serverLock && serverLock.count >= 5){
    const windowStart = serverLock.windowStart?.toDate ? serverLock.windowStart.toDate() : new Date(serverLock.windowStart);
    const elapsed = Date.now() - windowStart.getTime();
    if(elapsed < 60000){
      const resteS = Math.ceil((60000-elapsed)/1000);
      errEl.textContent = `🔒 Trop de tentatives (serveur) — réessayez dans ${resteS} s`;
      errEl.style.display = 'block';
      return;
    }
  }

  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('loading-screen').classList.remove('hidden');
  document.getElementById('load-text').textContent = 'Connexion…';

  // [OPTIM LECTURES] doLogin prend la main : onAuthStateChanged ne doit pas
  // relancer un 2e chargement complet en parallèle.
  _bootInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, raw, pwd);
    const uid = cred.user.uid;

    const profile = await _fetchProfile(uid, raw);
    if(!profile){
      await fbSignOut(auth);
      throw new Error('Profil utilisateur introuvable dans la base. Contactez l\'administrateur.');
    }
    if(!profile.role || !VALID_ROLES.includes(profile.role)){
      await fbSignOut(auth);
      throw new Error(`Accès refusé — rôle "${profile.role || 'vide'}" non autorisé pour la comptabilité.`);
    }

    // Succès — réinitialiser les deux verrous
    _setLoginAttempt(raw, {count:0, until:0, cycles:0});
    await _resetServerLock(raw);

    const safeUser = { id: uid, name: profile.nom || profile.name || raw, email: raw, role: profile.role };
    setCurrentUser(safeUser);
    _resetSessionTimer();
    _startTokenRefresh();

    document.getElementById('load-text').textContent = 'Chargement des données…';
    await loadTDBData();
    await loadComptaData();
    startApp();

  } catch(e){
    _bootInProgress = false;
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');

    // Incrémenter les deux verrous
    att.count = (att.count || 0) + 1;
    if(att.count >= 5){
      const cycle = Math.min(att.cycles || 0, _LGA_PALIERS.length - 1);
      att.until = now + _LGA_PALIERS[cycle];
      att.cycles = (att.cycles || 0) + 1;
      att.count = 0;
    }
    _setLoginAttempt(raw, att);
    await _incServerLock(raw);

    const resteMin = att.until > now ? Math.ceil((att.until-now)/60000) : 0;
    let msg = e.message || 'Email ou mot de passe incorrect.';
    if(e.code==='auth/wrong-password' || e.code==='auth/invalid-credential' || e.code==='auth/user-not-found'){
      msg = att.until > now
        ? (resteMin<=1 ? '🔒 Trop de tentatives — compte bloqué 1 minute' : `🔒 Trop de tentatives — compte bloqué ${resteMin} minutes`)
        : `❌ Email ou mot de passe incorrect (${att.count}/5)`;
    } else if(e.code==='auth/invalid-email'){
      msg = '❌ Adresse email invalide.';
    } else if(e.code==='auth/too-many-requests'){
      msg = '🔒 Trop de tentatives — Firebase a temporairement bloqué ce compte.';
    }
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
};

/* ─── Déconnexion ─── */
window.doLogout = async function(silent){
  if(!silent && !confirm('Se déconnecter ?')) return;
  _stopSessionTimer();
  setCurrentUser(null);
  try{ if(auth) await fbSignOut(auth); }catch(e){}
  location.reload();
};

/* ═══════════════════════════════════════════════════
   RECONNEXION AUTOMATIQUE (session Firebase persistée)
   Firebase Auth conserve la session entre rechargements de page.
   Ce listener restaure la session applicative dans ce cas, avec la
   même validation de rôle que doLogin(). Il gère aussi l'affichage
   initial de l'écran de connexion si aucune session n'existe.
═══════════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
  if(user){
    // [OPTIM LECTURES] Ignoré si doLogin() est en cours ou si l'app est déjà démarrée
    // (l'ancien test sur sessionStorage laissait passer un double chargement à la connexion).
    if(_bootInProgress || _appStarted) return;
    _bootInProgress = true;
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('loading-screen').classList.remove('hidden');
    document.getElementById('load-text').textContent = 'Reconnexion…';
    try{
      const email = (user.email||'').toLowerCase();
      const profile = await _fetchProfile(user.uid, email);
      if(!profile || !profile.role || !VALID_ROLES.includes(profile.role)){
        await fbSignOut(auth);
        throw new Error('Profil invalide');
      }
      const safeUser = { id: user.uid, name: profile.nom || profile.name || email, email, role: profile.role };
      setCurrentUser(safeUser);
      _resetSessionTimer();
      _startTokenRefresh();
      await loadTDBData();
      await loadComptaData();
      startApp();
    } catch(e){
      _bootInProgress = false;
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
    }
  } else {
    setCurrentUser(null);
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
  }
});

/* ═══════════════════════════════════════════════════
   GESTION DES COMPTES (admin) — comptes Firebase Auth + Firestore réels
═══════════════════════════════════════════════════ */
window.adminCreateAccount = async function(){
  const name  = document.getElementById('new-acct-name').value.trim();
  const email = document.getElementById('new-acct-email').value.trim().toLowerCase();
  const pwd   = document.getElementById('new-acct-pwd').value;
  const role  = document.getElementById('new-acct-role').value;
  const errEl = document.getElementById('admin-create-err');
  const okEl  = document.getElementById('admin-create-ok');
  errEl.style.display='none'; okEl.style.display='none';

  const cur = getCurrentUser();
  if(!cur || cur.role !== 'admin'){ errEl.textContent='⛔ Réservé aux administrateurs.'; errEl.style.display='block'; return; }
  if(!name||!email||!pwd){ errEl.textContent='⚠️ Tous les champs sont obligatoires.'; errEl.style.display='block'; return; }
  if(pwd.length<8){ errEl.textContent='⚠️ Mot de passe trop court (8 caractères min).'; errEl.style.display='block'; return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ errEl.textContent='⚠️ Adresse email invalide.'; errEl.style.display='block'; return; }

  try{
    // Création via une instance Firebase secondaire et temporaire : la création
    // d'un compte Firebase Auth connecte automatiquement ce nouveau compte sur
    // l'instance utilisée. Passer par une app séparée évite de déconnecter
    // l'administrateur en cours de session.
    const tmpApp = initializeApp(FIREBASE_CONFIG, 'AdminCreateUser_'+Date.now());
    const tmpAuth = getAuth(tmpApp);
    let newUid;
    try{
      const cred = await createUserWithEmailAndPassword(tmpAuth, email, pwd);
      newUid = cred.user.uid;
      await fbSignOut(tmpAuth);
    } finally {
      await deleteApp(tmpApp);
    }

    await setDoc(doc(db_fs,'commerciaux', newUid), {
      nom: name, email, role, agenceId: '', createdAt: serverTimestamp()
    });

    okEl.textContent = `✅ Compte ${role==='admin'?'Administrateur':'Comptable'} créé pour ${esc(name)}.`;
    okEl.style.display='block';
    document.getElementById('new-acct-name').value='';
    document.getElementById('new-acct-email').value='';
    document.getElementById('new-acct-pwd').value='';

    await reloadCollection('commerciaux'); // [OPTIM LECTURES] au lieu de tout recharger
    if(typeof renderComptes === 'function') renderComptes();
  } catch(e){
    let msg = e.message;
    if(e.code==='auth/email-already-in-use') msg='Cet email est déjà utilisé.';
    else if(e.code==='auth/weak-password') msg='Mot de passe trop faible.';
    else if(e.code==='auth/invalid-email') msg='Adresse email invalide.';
    errEl.textContent = '❌ '+msg;
    errEl.style.display='block';
  }
};

/* Supprime le profil applicatif (Firestore). Note : la révocation de l'accès
   est immédiate et suffisante (le login échoue sans profil valide), mais la
   suppression du compte Firebase Auth lui-même nécessite soit la console
   Firebase, soit une Cloud Function (le SDK client ne permet pas de
   supprimer le compte d'un AUTRE utilisateur que celui connecté). */
window.deleteAccount = async function(id){
  const cur = getCurrentUser();
  if(cur && cur.id===id){ alert('Vous ne pouvez pas supprimer votre propre compte.'); return; }
  if(!confirm('Supprimer ce compte ?\n\nLe profil applicatif sera supprimé (accès immédiatement bloqué).\nLe compte de connexion Firebase devra être retiré depuis la console Firebase si vous voulez le supprimer entièrement.')) return;
  try{
    await deleteDoc(doc(db_fs,'commerciaux', id));
    await reloadCollection('commerciaux'); // [OPTIM LECTURES]
    if(typeof renderComptes === 'function') renderComptes();
    notify('✅ Compte retiré.');
  }catch(e){ notify('Erreur : '+e.message,'err'); }
};

function _withTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Délai dépassé (${ms/1000}s) sur "${label}" — vérifiez la connexion ou les règles Firestore.`)), ms))
  ]);
}

/* [OPTIM LECTURES] 'stockMvts' et 'mises' ne servent QU'À afficher un nombre
   sur la page Synchronisation (vérifié : aucun calcul ne les utilise).
   On les compte avec getCountFromServer (≈1 lecture par tranche de 1000 docs)
   au lieu de télécharger chaque document. */
const COUNT_ONLY_COLS = ['stockMvts','mises'];
let TDB_COUNTS = {};
function tdbCount(col){ return COUNT_ONLY_COLS.includes(col) ? (TDB_COUNTS[col]||0) : (TDB[col]||[]).length; }

async function _loadOneCollection(col){
  const snap = await _withTimeout(getDocs(collection(db_fs, col)), 12000, col);
  TDB[col] = snap.docs.map(d=>({...d.data(),_id:d.id}));
  return snap.size;
}

async function loadTDBData(){
  const cols = ['agences','commerciaux','clients','paiements','articles','livraisons','adhesionPays','depenses'];
  let lectures = 0;
  for(const col of cols){
    const lt = document.getElementById('load-text');
    if(lt) lt.textContent = `Chargement : ${col}…`;
    try{
      lectures += await _loadOneCollection(col);
    } catch(e){
      console.warn(`Chargement de "${col}" échoué :`, e.message);
      TDB[col] = TDB[col] || [];
      // On continue avec les autres collections plutôt que de bloquer toute l'app.
    }
  }
  for(const col of COUNT_ONLY_COLS){
    try{
      const c = await _withTimeout(getCountFromServer(collection(db_fs, col)), 12000, col);
      TDB_COUNTS[col] = c.data().count;
      lectures += Math.max(1, Math.ceil(TDB_COUNTS[col]/1000));
    }catch(e){ console.warn(`Comptage de "${col}" échoué :`, e.message); }
  }
  _lastFullSync = Date.now();
  console.info(`[lecture] Synchronisation complète ≈ ${lectures} lectures Firestore`);
  buildIndexes();
}

/* Recharge une seule collection (ex. après création/suppression de compte). */
async function reloadCollection(col){
  try{ await _loadOneCollection(col); buildIndexes(); }
  catch(e){ console.warn(`Rechargement de "${col}" échoué :`, e.message); }
}

window.syncNow = async function(){
  if(!db_fs){ notify('Non connecté à Firebase','err'); return; }
  notify('Synchronisation en cours…');
  await loadTDBData();
  await loadComptaData();
  setSyncStatus(true);
  populateYearSelects();
  renderPg(curPg);
  notify('Synchronisation réussie ✓');
};

function setSyncStatus(ok){
  document.getElementById('sync-dot').className = 'sync-dot'+(ok?'':' off');
  document.getElementById('sync-label').textContent = ok?'Connecté':'Hors ligne';
  if(ok){
    const now = new Date();
    const time = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const date = now.toLocaleDateString('fr-FR',{day:'2-digit',month:'short'});
    document.getElementById('last-sync-label').textContent = `Sync : ${date} ${time}`;
  }
  document.getElementById('sync-count').textContent = Object.keys(TDB).reduce((a,k)=>a+tdbCount(k),0);
}

/* ═══════════════════════════════════════════════════
   DEMO MODE
═══════════════════════════════════════════════════ */
window.useDemoMode = function(){
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('loading-screen').classList.remove('hidden');
  injectDemoData();
  buildIndexes();
  setTimeout(()=>{
    document.getElementById('loading-screen').classList.add('hidden');
    startApp();
  }, 900);
};

function injectDemoData(){
  const now = new Date();
  TDB.agences = [{_id:'ag1',nom:'Agence Centrale'},{_id:'ag2',nom:'Agence Nord'}];
  TDB.commerciaux = [
    {_id:'c1',nom:'Kofi Mensah',role:'commercial',agenceId:'ag1'},
    {_id:'c2',nom:'Amina Traoré',role:'commercial',agenceId:'ag1'},
    {_id:'c3',nom:'Brice Houndji',role:'commercial',agenceId:'ag2'}
  ];
  TDB.clients = Array.from({length:80},(_,i)=>({
    _id:'cl'+i,nom:'Client '+i,commercialId:'c'+(1+(i%3)),
    mise:15000+Math.floor(Math.random()*35000),nbMois:12
  }));
  TDB.articles = [
    {_id:'a1',nom:'Canapé 3 places',cat:'Mobilier',pa:200000,pv:300000},
    {_id:'a2',nom:'Télévision 43"',cat:'Électroménager',pa:120000,pv:180000},
    {_id:'a3',nom:'Réfrigérateur',cat:'Électroménager',pa:150000,pv:220000},
    {_id:'a4',nom:'Table basse',cat:'Mobilier',pa:80000,pv:120000},
    {_id:'a5',nom:'Climatiseur',cat:'Électroménager',pa:200000,pv:280000},
  ];
  TDB.paiements = [];
  for(let m=0;m<12;m++){
    const d = new Date(now.getFullYear(),now.getMonth()-m,1);
    const nb = 40+Math.floor(Math.random()*30);
    for(let i=0;i<nb;i++){
      const day = 1+Math.floor(Math.random()*26);
      const date = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
      TDB.paiements.push({_id:'p'+m+'_'+i,date,montant:15000+Math.floor(Math.random()*50000),commercialId:'c'+(1+(i%3)),clientId:'cl'+(i%80)});
    }
  }
  TDB.livraisons = [];
  ['a1','a2','a3','a4','a5'].forEach((aid,ai)=>{
    const art = TDB.articles.find(a=>a._id===aid);
    for(let i=0;i<(8+ai*4);i++){
      const m = Math.floor(Math.random()*12);
      const d = new Date(now.getFullYear(),now.getMonth()-m,1+Math.floor(Math.random()*25));
      const date = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const qty = 1+Math.floor(Math.random()*3);
      const statut = (i%5===0) ? 'en_attente' : 'livre';
      TDB.livraisons.push({_id:'l'+ai+'_'+i,date,articleId:aid,clientId:'cl'+(i%80),qty,montant:art.pv*qty,statut});
    }
  });
  TDB.adhesionPays = Array.from({length:60},(_,i)=>({_id:'ad'+i,clientId:'cl'+i,date:CUR_YEAR+'-01-10',montant:5000}));
  // Clients payés non livrés pour la démo (cl70..cl79 ont payé mais aucune livraison 'livre' les concerne)
  for(let i=70;i<80;i++){
    const day = 1+Math.floor(Math.random()*25);
    const date = CUR_YEAR+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    TDB.paiements.push({_id:'p_nonliv'+i,date,montant:80000+Math.floor(Math.random()*120000),commercialId:'c'+(1+(i%3)),clientId:'cl'+i});
  }
  // S'assurer qu'aucune livraison 'livre' ne concerne cl70..cl79
  TDB.livraisons = TDB.livraisons.filter(l=>!['cl70','cl71','cl72','cl73','cl74','cl75','cl76','cl77','cl78','cl79'].includes(l.clientId));
}

/* ═══════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════ */
const PAGE_TITLES = {
  dashboard:'Vue d\'ensemble',charges:'Charges & Dépenses',bilan:'Bilan Comptable',
  resultat:'Compte de Résultat',journaux:'Journal des écritures',import:'Synchronisation',
  salaires:'Auto-Salaire Commerciaux','fiche-paie':'Fiche de Paie',projection:'Projection livraisons',
  comptes:'Gestion des comptes',tresorerie:'Tableau de Trésorerie',periodes:'Verrouillage des périodes',
  autonomie:'Autonomie de l\'entreprise'
};

window.go = function(pg){
  curPg = pg;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pageEl = document.getElementById('page-'+pg);
  const navEl  = document.getElementById('nav-'+pg);
  if(pageEl) pageEl.classList.add('active');
  if(navEl)  navEl.classList.add('active');
  document.getElementById('topbar-title').textContent = PAGE_TITLES[pg]||pg;
  renderPg(pg);
  if(window.innerWidth<=860) toggleMobileSidebar(false);
  const contentEl = document.getElementById('content');
  if(contentEl) contentEl.scrollTop = 0;
};

function toggleMobileSidebar(force){
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if(!sb||!bd) return;
  const show = typeof force==='boolean' ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', show);
  bd.classList.toggle('open', show);
}

function renderPg(pg){
  if(pg==='dashboard') renderDashboard();
  else if(pg==='charges') renderCharges();
  else if(pg==='bilan') renderBilan();
  else if(pg==='resultat') renderResultat();
  else if(pg==='journaux') renderJournal();
  else if(pg==='import') renderImport();
  else if(pg==='salaires') renderSalaires();
  else if(pg==='fiche-paie') renderFichePaie();
  else if(pg==='projection') renderProjection();
  else if(pg==='comptes') renderComptes();
  else if(pg==='tresorerie') renderTresorerie();
  else if(pg==='periodes') renderPeriodes();
  else if(pg==='autonomie') renderAutonomie();
}

/* ═══════════════════════════════════════════════════
   CALCULS COMMUNS
═══════════════════════════════════════════════════ */
function totalPaiements(year, month){
  return _monthlyRange(IDX.paiementsByMonth, year, month)
    .reduce((a,p)=>a+Number(p.montant||0),0);
}
function margeLivraison(l){
  // Revenu livraison = montant vente - coût produit (pa * qty)
  const art = IDX.articlesById.get(l.articleId);
  const cout = art ? Number(art.pa||0)*Number(l.qty||1) : 0;
  return Number(l.montant||0) - cout;
}
function totalLivraisons(year, month){
  return _monthlyRange(IDX.livraisonsByMonth, year, month)
    .filter(l=>l.statut!=='en_attente')
    .reduce((a,l)=>a+margeLivraison(l),0);
}
function getClientsPayesNonLivres(year, month){
  // Clients ayant payé (sur la période) mais sans livraison avec statut 'livre'
  const prefix = month ? `${year}-${month}` : (year||'');
  const clientsAvecPaiement = [...new Set(
    TDB.paiements
      .filter(p=>p.date&&(prefix?p.date.startsWith(prefix):true))
      .map(p=>p.clientId)
  )];
  const clientsLivres = new Set(
    TDB.livraisons
      .filter(l=>l.statut==='livre')
      .map(l=>l.clientId)
  );
  return clientsAvecPaiement.filter(cid=>!clientsLivres.has(cid));
}

function projectionClientsRestants(year, month){
  // Marge projetée = total paiements des clients non livrés - coût produit estimé
  const prefix = month ? `${year}-${month}` : (year||'');
  const clientsIds = getClientsPayesNonLivres(year, month);

  // Ratio moyen PA/PV sur tous les articles
  const arts = TDB.articles.filter(a=>Number(a.pv||0)>0);
  const ratioCout = arts.length>0
    ? arts.reduce((s,a)=>s+(Number(a.pa||0)/Number(a.pv||1)),0)/arts.length
    : 0.6;

  let totalMarge = 0;
  clientsIds.forEach(cid=>{
    const totalPaye = (IDX.paiementsByClient.get(cid)||[])
      .filter(p=>p.date&&(prefix?p.date.startsWith(prefix):true))
      .reduce((s,p)=>s+Number(p.montant||0),0);
    totalMarge += totalPaye * (1 - ratioCout);
  });
  return { marge: totalMarge, nbClients: clientsIds.length, ratioCout };
}
function totalAdhesions(year, month){
  return _monthlyRange(IDX.adhesionsByMonth, year, month)
    .reduce((a,p)=>a+Number(p.montant||0),0);
}
function totalCharges(year, month){
  return _monthlyRange(IDX.chargesByMonth, year, month)
    .reduce((a,c)=>a+Number(c.montant||0),0);
}
function chargesParCat(year, month){
  const map = {};
  _monthlyRange(IDX.chargesByMonth, year, month)
    .forEach(c=>{ map[c.categorie]=(map[c.categorie]||0)+Number(c.montant||0); });
  return map;
}

/* ═══════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════ */
window.renderDashboard = function(){
  const year  = document.getElementById('dash-year')?.value||CUR_YEAR;
  const month = document.getElementById('dash-month')?.value||'';

  const collectes   = totalPaiements(year,month);          // épargne clients (dette)
  const margeLiv    = totalLivraisons(year,month);          // revenu réel livraisons
  const adhesions   = totalAdhesions(year,month);
  const produits    = margeLiv + adhesions;                 // vrais produits
  const proj        = projectionClientsRestants(year,month);
  const charges     = totalCharges(year,month);
  const resultat    = produits - charges;
  const resultatAvecEnCours = produits + proj.marge - charges;
  const tx = produits>0 ? ((resultat/produits)*100).toFixed(1) : '—';

  document.getElementById('topbar-period-label').textContent = periodLabel(year,month);

  document.getElementById('dash-kpi').innerHTML=`
    <div class="kpi-card kc-green">
      <div class="kpi-lbl">Produits réels (livrés)</div>
      <div class="kpi-val kv-green">${fmt(produits)}</div>
      <div class="kpi-sub">Marge livraisons + Adhésions</div>
    </div>
    <div class="kpi-card kc-red">
      <div class="kpi-lbl">Total Charges</div>
      <div class="kpi-val kv-red">${fmt(charges)}</div>
      <div class="kpi-sub">${CHARGES.filter(c=>c.date&&c.date.startsWith(month?`${year}-${month}`:year)).length} écritures</div>
    </div>
    <div class="kpi-card ${resultat>=0?'kc-blue':'kc-red'}">
      <div class="kpi-lbl">Bénéfice Net</div>
      <div class="kpi-val ${resultat>=0?'kv-blue':'kv-red'}">${fmt(Math.abs(resultat))}</div>
      <div class="kpi-sub">${resultat>=0?'✅ Bénéfice':'❌ Déficit'} · taux ${tx}%</div>
    </div>
    <div class="kpi-card kc-yellow" style="cursor:pointer;" onclick="go('projection')" title="Voir la projection détaillée">
      <div class="kpi-lbl">🔮 Projection si tous livrés</div>
      <div class="kpi-val kv-yellow">${fmt(Math.abs(resultatAvecEnCours))}</div>
      <div class="kpi-sub" style="display:flex;flex-direction:column;gap:2px;margin-top:6px;">
        <span>${resultatAvecEnCours>=0?'✅ Bénéfice projeté':'❌ Déficit projeté'}</span>
        <span style="color:var(--warn);">👥 ${proj.nbClients} client(s) non livrés · +${fmt(proj.marge)} marge potentielle</span>
        <span style="color:var(--accent);font-size:10px;margin-top:2px;">→ Voir le détail complet</span>
      </div>
    </div>`;

  // Chart évolution mensuelle
  const moisNoms=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const evoLabels=[], evoProd=[], evoChrg=[];
  for(let i=0;i<12;i++){
    const d = new Date(parseInt(year),i,1);
    const mm = String(i+1).padStart(2,'0');
    evoLabels.push(moisNoms[i]);
    evoProd.push(totalPaiements(year,mm)+totalLivraisons(year,mm)+totalAdhesions(year,mm));
    evoChrg.push(totalCharges(year,mm));
  }
  if(chartEvo){chartEvo.destroy();chartEvo=null;}
  const c1=document.getElementById('chart-evo');
  if(c1) chartEvo=new Chart(c1,{
    type:'line',
    data:{labels:evoLabels,datasets:[
      {label:'Produits',data:evoProd,borderColor:'#2ee8b5',backgroundColor:'rgba(46,232,181,0.08)',borderWidth:2,tension:0.35,pointRadius:3},
      {label:'Charges',data:evoChrg,borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,0.08)',borderWidth:2,tension:0.35,pointRadius:3}
    ]},
    options:{responsive:true,maintainAspectRatio:true,plugins:{legend:{labels:{color:'#6c8fff',font:{size:11}}}},scales:{x:{ticks:{color:'#5e6d99',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#5e6d99',font:{size:9},callback:v=>v>=1000000?(v/1000000)+'M':v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,0.05)'}}}}
  });

  // Donut charges
  const catMap = chargesParCat(year,month);
  const catKeys = Object.keys(catMap);
  if(chartDonut){chartDonut.destroy();chartDonut=null;}
  const c2=document.getElementById('chart-charges-donut');
  if(c2){
    if(catKeys.length===0){
      c2.parentElement.innerHTML='<div class="card-title">🥧 Répartition des charges</div><div class="emp" style="padding:40px">Aucune charge enregistrée</div>';
    } else {
      chartDonut=new Chart(c2,{
        type:'doughnut',
        data:{labels:catKeys,datasets:[{data:catKeys.map(k=>catMap[k]),backgroundColor:catKeys.map(k=>catColor(k)),borderWidth:2,borderColor:'var(--surface)'}]},
        options:{responsive:true,maintainAspectRatio:true,cutout:'65%',plugins:{legend:{position:'right',labels:{color:'#dde3f5',font:{size:10},padding:8,boxWidth:12}}}}
      });
    }
  }

  // Top produits
  const topData = [
    {label:'Épargne collectée (clients)',val:collectes,color:'#6c8fff'},
    {label:'Marge livraisons (PV−PA)',val:margeLiv,color:'#2ee8b5'},
    {label:'Adhésions',val:adhesions,color:'#f9c846'},
  ].sort((a,b)=>b.val-a.val);
  const maxVal = Math.max(...topData.map(x=>x.val),1);
  document.getElementById('dash-top-produits').innerHTML=topData.map(x=>`
    <div style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
        <span style="color:var(--text);">${x.label}</span>
        <span style="font-weight:700;color:${x.color};">${fmt(x.val)}</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:${(x.val/maxVal*100).toFixed(1)}%;background:${x.color};"></div></div>
    </div>`).join('');

  // Alertes
  const alertes = [];
  if(charges>produits) alertes.push({type:'danger',msg:'⚠️ Charges supérieures aux produits — déficit '+fmt(charges-produits)});
  if(CHARGES.length===0) alertes.push({type:'warn',msg:'📝 Aucune charge enregistrée — ajoutez vos dépenses pour un compte de résultat précis'});
  if(TDB.paiements.length===0) alertes.push({type:'warn',msg:'🔌 Aucune donnée TRIOMPHANT chargée — synchronisez avec Firebase'});
  const pEn = TDB.livraisons.filter(l=>l.statut==='en_attente').length;
  if(pEn>0) alertes.push({type:'info',msg:`🚚 ${pEn} livraison(s) en attente dans TRIOMPHANT`});
  const sAlerte = TDB.articles.filter(a=>a.stock<=a.stockMin).length;
  if(sAlerte>0) alertes.push({type:'warn',msg:`📦 ${sAlerte} article(s) en alerte de stock dans TRIOMPHANT`});
  if(alertes.length===0) alertes.push({type:'success',msg:'✅ Aucune alerte comptable pour cette période'});
  document.getElementById('dash-alertes').innerHTML=alertes.map(a=>`<div class="alert alert-${a.type}" style="margin-bottom:8px;">${a.msg}</div>`).join('');
};

/* ═══════════════════════════════════════════════════
   CHARGES
═══════════════════════════════════════════════════ */
window.renderCharges = function(){
  const month  = document.getElementById('ch-month')?.value||'';
  const cat    = document.getElementById('ch-cat')?.value||'';
  const search = (document.getElementById('ch-search')?.value||'').toLowerCase();

  let list = [...CHARGES];
  if(month) list=list.filter(c=>c.date&&c.date.startsWith(month));
  if(cat)   list=list.filter(c=>c.categorie===cat);
  if(search) list=list.filter(c=>(c.libelle||'').toLowerCase().includes(search)||(c.ref||'').toLowerCase().includes(search));
  list.sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  const total = list.reduce((a,c)=>a+Number(c.montant||0),0);
  const map   = {};
  list.forEach(c=>{ map[c.categorie]=(map[c.categorie]||0)+1; });
  const nbCats = Object.keys(map).length;

  document.getElementById('ch-kpi').innerHTML=`
    <div class="kpi-card kc-red"><div class="kpi-lbl">Total charges</div><div class="kpi-val kv-red">${fmt(total)}</div></div>
    <div class="kpi-card kc-purple"><div class="kpi-lbl">Nb d'écritures</div><div class="kpi-val kv-purple">${list.length}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Catégories</div><div class="kpi-val kv-yellow">${nbCats}</div></div>`;

  document.getElementById('tb-charges').innerHTML=list.length===0
    ? `<tr><td colspan="8" class="emp">Aucune charge trouvée</td></tr>`
    : list.map(c=>{
      const period = (c.date||'').substring(0,7);
      const locked = isPeriodeLocked(period);
      const pjCell = c.pj
        ? `<img src="${c.pj}" class="pj-thumb" onclick="viewPJ('${c._id}')" title="Voir la pièce jointe">`
        : `<span class="pj-placeholder" onclick="openModalCharge('${esc(c._id)}')" title="Ajouter une pièce jointe">📎</span>`;
      return `<tr>
        <td class="fw6">${esc(c.date)}</td>
        <td class="tm">${c.pieceNum?`<span class="piece-num">${esc(c.pieceNum)}</span>`:'—'}</td>
        <td>${esc(c.libelle)}<br><span class="tm" style="font-size:10px;">${esc(c.note||'')}</span></td>
        <td><span style="display:inline-flex;align-items:center;font-size:11px;font-weight:600;color:${catColor(c.categorie)};"><span class="type-dot" style="background:${catColor(c.categorie)}"></span>${esc(c.categorie)}</span></td>
        <td class="tm">${esc(c.mode||'—')}</td>
        <td class="tm" style="font-size:11px;">${esc(c.ref||'—')}</td>
        <td>${pjCell}</td>
        <td class="amt-neg">${fmt(c.montant)} ${locked?'<span class="lock-badge" style="font-size:9px;">🔒</span>':''}</td>
        <td class="no-print" style="white-space:nowrap;">
          ${locked ? `<span title="Période verrouillée" style="font-size:13px;opacity:0.5;">🔒</span>` : `
          <button class="btn btn-ghost btn-xs" onclick="editCharge('${esc(c._id)}')">✏️</button>
          ${(window._userRole==='admin')?`<button class="btn btn-danger btn-xs" onclick="deleteCharge('${esc(c._id)}')" style="margin-left:4px;">🗑</button>`:''}`}
        </td>
      </tr>`;
    }).join('');
};

window.openModalCharge = function(id=null){
  chargeEditId = id;
  window._pendingPJ = undefined;
  const ch = id ? CHARGES.find(c=>c._id===id) : null;
  document.getElementById('modal-charge-title').textContent = id ? '✏️ Modifier la charge' : '➕ Nouvelle charge';
  document.getElementById('ch-date').value      = ch?.date || TODAY;
  document.getElementById('ch-montant').value   = ch?.montant || '';
  document.getElementById('ch-libelle').value   = ch?.libelle || '';
  document.getElementById('ch-categorie').value = ch?.categorie || 'Personnel';
  document.getElementById('ch-mode').value      = ch?.mode || 'Espèces';
  document.getElementById('ch-ref').value       = ch?.ref || '';
  document.getElementById('ch-note').value      = ch?.note || '';
  // N° pièce auto (nouveau seulement)
  const numZone = document.getElementById('ch-num-display');
  const numVal  = document.getElementById('ch-num-val');
  if(!id){
    const n = genPieceNum();
    numVal.textContent = n;
    numZone.style.display = 'block';
  } else {
    numZone.style.display = ch?.pieceNum ? 'block' : 'none';
    if(ch?.pieceNum) numVal.textContent = ch.pieceNum;
  }
  // PJ existante
  const preview = document.getElementById('ch-pj-preview');
  const img     = document.getElementById('ch-pj-img');
  const pjName  = document.getElementById('ch-pj-name');
  const pjClear = document.getElementById('ch-pj-clear');
  if(ch?.pj){
    pjName.textContent = '1 pièce jointe';
    pjClear.style.display = 'inline';
    if(ch.pj.startsWith('data:image')){
      img.src = ch.pj; preview.style.display='block';
    } else { preview.style.display='none'; }
  } else {
    pjName.textContent = 'Aucun fichier';
    pjClear.style.display = 'none';
    preview.style.display = 'none';
    img.src = '';
  }
  // Lock warning
  checkPeriodeLock();
  document.getElementById('modal-charge').classList.remove('hidden');
};
window.editCharge = function(id){ openModalCharge(id); };
window.closeModalCharge = function(){ document.getElementById('modal-charge').classList.add('hidden'); chargeEditId=null; };

window.saveCharge = function(){
  const date     = document.getElementById('ch-date').value;
  const montant  = parseFloat(document.getElementById('ch-montant').value)||0;
  const libelle  = document.getElementById('ch-libelle').value.trim();
  const categorie= document.getElementById('ch-categorie').value;
  const mode     = document.getElementById('ch-mode').value;
  const ref      = document.getElementById('ch-ref').value.trim();
  const note     = document.getElementById('ch-note').value.trim();

  if(!date||!montant||!libelle){ notify('Remplissez les champs obligatoires','err'); return; }
  if(montant <= 0){ notify('Le montant doit être positif','err'); return; }
  if(montant > 1_000_000_000){ notify('Montant trop élevé — vérifiez la saisie','err'); return; }
  if(date > TODAY && date > CUR_YEAR+'-12-31'){ notify('Date invalide','err'); return; }
  if(libelle.length > 200){ notify('Libellé trop long (max 200 car.)','err'); return; }
  if(ref.length > 100){ notify('Référence trop longue (max 100 car.)','err'); return; }
  if(note.length > 500){ notify('Note trop longue (max 500 car.)','err'); return; }

  // Vérification verrouillage période
  const period = date.substring(0,7);
  if(!chargeEditId && isPeriodeLocked(period)){
    notify('⛔ Période verrouillée — impossible d\'ajouter une charge sur ce mois','err');
    return;
  }

  const pjData = window._pendingPJ || null;

  if(chargeEditId){
    const idx = CHARGES.findIndex(c=>c._id===chargeEditId);
    if(idx>=0){
      // Vérif lock sur la période originale aussi
      const origPeriod = (CHARGES[idx].date||'').substring(0,7);
      if(isPeriodeLocked(origPeriod)){
        notify('⛔ Période verrouillée — modification impossible','err');
        return;
      }
      CHARGES[idx]={...CHARGES[idx],date,montant,libelle,categorie,mode,ref,note,
        ...(pjData !== undefined ? {pj:pjData} : {})};
    }
    notify('Charge modifiée ✓');
  } else {
    const pieceNum = genPieceNum();
    CHARGES.push({_id:'ch_'+Date.now(),pieceNum,date,montant,libelle,categorie,mode,ref,note,pj:pjData||null});
    notify('Charge enregistrée ✓ — N° '+pieceNum);
  }
  window._pendingPJ = undefined;
  saveChargesLocal();
  closeModalCharge();
  renderCharges();
};

window.deleteCharge = function(id){
  if(window._userRole && window._userRole !== 'admin'){
    notify('Suppression réservée à l\'administrateur','err');
    return;
  }
  const ch = CHARGES.find(c=>c._id===id);
  if(!ch) return;
  const period = (ch.date||'').substring(0,7);
  if(isPeriodeLocked(period)){
    notify('⛔ Période verrouillée — suppression impossible','err');
    return;
  }
  if(!confirm(`Supprimer la charge suivante ?\n\n📅 ${ch.date}  |  ${ch.libelle}\n💰 ${fmt(ch.montant)}\n\nCette action est irréversible.`)) return;
  CHARGES = CHARGES.filter(c=>c._id!==id);
  saveChargesLocal();
  notify('Charge supprimée');
  renderCharges();
};

/* ═══════════════════════════════════════════════════
   BILAN
═══════════════════════════════════════════════════ */
window.renderBilan = function(){
  const year = document.getElementById('bilan-year')?.value||CUR_YEAR;

  // ACTIF
  const totalCollectes = totalPaiements(year,'');            // épargne clients = dette
  const totalLiv       = totalLivraisons(year,'');           // marge livraisons réalisées
  const totalAdh       = totalAdhesions(year,'');
  const projBilan      = projectionClientsRestants(year,'');
  const livEnCours     = projBilan.marge;
  const valStock       = TDB.articles.reduce((a,art)=>a+Number(art.stock||0)*Number(art.pa||0),0);
  const totalProduits  = totalLiv + totalAdh;                // vrais produits
  const totalActif     = totalProduits + valStock;
  const totalActifProj = totalActif + livEnCours;

  // PASSIF
  const totalChrg      = totalCharges(year,'');
  const detteClients   = totalCollectes;                     // épargne à reverser en produits
  const resultatNet    = totalProduits - totalChrg;
  const resultatNetProj = resultatNet + livEnCours;
  const totalPassif    = detteClients + totalChrg + Math.max(resultatNet,0);

  const row=(label,val,indent=false,accent='var(--text)')=>`
    <div class="bilan-row ${indent?'bilan-indent':''}">
      <span style="color:${indent?'var(--muted)':'var(--text)'};">${label}</span>
      <span style="font-weight:600;color:${accent};">${fmt(val)}</span>
    </div>`;

  document.getElementById('bilan-container').innerHTML=`
    <div class="card">
      <div class="card-title" style="color:var(--accent2);">🟢 ACTIF — ${year}</div>
      <div class="bilan-section">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;padding:6px 12px 2px;letter-spacing:0.7px;">Actif circulant (livrés)</div>
        ${row('Marge livraisons réalisées (PV−PA)',totalLiv,true,'var(--accent2)')}
        ${row('Adhésions perçues',totalAdh,true,'var(--accent2)')}
      </div>
      <div class="bilan-section">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;padding:6px 12px 2px;letter-spacing:0.7px;">Actif immobilisé</div>
        ${row('Valeur stock (prix d\'achat)',valStock,true,'var(--accent3)')}
      </div>
      <div class="bilan-row total-row">
        <span>TOTAL ACTIF</span>
        <span class="amt-pos">${fmt(totalActif)}</span>
      </div>
      ${livEnCours>0?`
      <div style="margin-top:10px;padding:10px 14px;background:rgba(249,200,70,0.06);border:1px solid rgba(249,200,70,0.2);border-radius:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--accent3);text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;">👥 ${projBilan.nbClients} client(s) payés non livrés — projection</div>
        ${row('Marge estimée si livrés',livEnCours,true,'var(--accent3)')}
        <div class="bilan-row" style="border-top:1px solid rgba(249,200,70,0.2);padding-top:8px;margin-top:4px;">
          <span style="font-weight:700;color:var(--accent3);">TOTAL ACTIF PROJETÉ</span>
          <span style="font-weight:700;color:var(--accent3);">${fmt(totalActifProj)}</span>
        </div>
      </div>`:''}
    </div>
    <div class="card">
      <div class="card-title" style="color:var(--red);">🔴 PASSIF — ${year}</div>
      <div class="bilan-section">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;padding:6px 12px 2px;letter-spacing:0.7px;">Charges & Dettes</div>
        ${row('Épargne clients à livrer (dette)',detteClients,true,'var(--warn)')}
        ${row('Total charges décaissées',totalChrg,true,'var(--red)')}
      </div>
      <div class="bilan-section">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;padding:6px 12px 2px;letter-spacing:0.7px;">Capitaux propres</div>
        ${row('Bénéfice net (marge − charges)',Math.max(resultatNet,0),true,resultatNet>=0?'var(--accent2)':'var(--red)')}
      </div>
      <div class="bilan-row total-row">
        <span>TOTAL PASSIF</span>
        <span class="${resultatNet>=0?'amt-pos':'amt-neg'}">${fmt(totalPassif)}</span>
      </div>
      ${livEnCours>0?`
      <div style="margin-top:10px;padding:10px 14px;background:rgba(249,200,70,0.06);border:1px solid rgba(249,200,70,0.2);border-radius:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--accent3);text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;">📊 Résultat projeté (+ en cours)</div>
        <div class="bilan-row">
          <span style="color:var(--accent3);">Bénéfice net projeté</span>
          <span style="font-weight:700;color:${resultatNetProj>=0?'var(--accent3)':'var(--red)'};">${fmt(Math.abs(resultatNetProj))}</span>
        </div>
      </div>`:''}
      <div style="margin-top:10px;" class="alert ${resultatNet>=0?'alert-success':'alert-danger'}">
        ${resultatNet>=0?'✅ Bilan équilibré — résultat bénéficiaire':'❌ Bilan déficitaire'}
      </div>
    </div>`;
  // ── En-tête impression ──
  const _php_b = document.getElementById('ph-bilan-period');
  const _phd_b = document.getElementById('ph-bilan-date');
  if(_php_b) _php_b.textContent = `Exercice ${year}`;
  if(_phd_b) _phd_b.textContent = `Édité le ${new Date().toLocaleDateString('fr-FR')}`;
};

/* ═══════════════════════════════════════════════════
   COMPTE DE RÉSULTAT
═══════════════════════════════════════════════════ */
window.renderResultat = function(){
  const year  = document.getElementById('res-year')?.value||CUR_YEAR;
  const month = document.getElementById('res-month')?.value||'';

  const recPay  = totalPaiements(year,month);
  const recLiv  = totalLivraisons(year,month);
  const recAdh  = totalAdhesions(year,month);
  const projRes       = projectionClientsRestants(year,month);
  const recLivEnCours  = projRes.marge;
  const totalProd = recPay+recLiv+recAdh;
  const totalProdAvecEnCours = totalProd+recLivEnCours;

  const catMap  = chargesParCat(year,month);
  const totalChrg = totalCharges(year,month);
  const resultat = totalProd - totalChrg;
  const resultatProj = totalProdAvecEnCours - totalChrg;
  const tx = totalProd>0 ? (resultat/totalProd*100).toFixed(1) : '—';

  const row=(label,val,indent=false,color='var(--text)')=>`
    <div class="bilan-row ${indent?'bilan-indent':''}">
      <span style="color:${color};">${label}</span>
      <span style="font-weight:600;color:${color};">${fmt(val)}</span>
    </div>`;

  document.getElementById('res-container').innerHTML=`
    <div class="card" style="margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div>
          <div class="card-title" style="color:var(--accent2);">📥 PRODUITS — ${periodLabel(year,month)}</div>
          ${row('Marge livraisons (PV − PA)',recLiv,true,'var(--accent2)')}
          ${row('Adhésions clients',recAdh,true,'var(--accent2)')}
          <div class="bilan-row total-row">
            <span>TOTAL PRODUITS (livrés)</span><span class="amt-pos">${fmt(totalProd)}</span>
          </div>
          <div style="margin-top:8px;padding:8px 14px;background:rgba(108,143,255,0.06);border:1px solid rgba(108,143,255,0.18);border-radius:8px;">
            <div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:4px;">📥 Épargne collectée (passif)</div>
            ${row('Mises clients reçues',recPay,true,'var(--muted)')}
            <div style="font-size:10px;color:var(--muted);margin-top:2px;">→ Dette envers clients, non comptabilisée en produits</div>
          </div>
          ${recLivEnCours>0?`
          <div style="margin-top:10px;padding:10px 14px;background:rgba(249,200,70,0.07);border:1px solid rgba(249,200,70,0.2);border-radius:8px;">
            <div style="font-size:10px;font-weight:700;color:var(--accent3);text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;">👥 ${projRes.nbClients} client(s) payés non livrés</div>
            ${row('Marge estimée si livrés',recLivEnCours,true,'var(--accent3)')}
            <div class="bilan-row" style="border-top:1px solid rgba(249,200,70,0.2);padding-top:8px;margin-top:4px;">
              <span style="font-weight:700;color:var(--accent3);">TOTAL PROJETÉ</span>
              <span style="font-weight:700;color:var(--accent3);">${fmt(totalProdAvecEnCours)}</span>
            </div>
          </div>`:''}
        </div>
        <div>
          <div class="card-title" style="color:var(--red);">📤 CHARGES — ${periodLabel(year,month)}</div>
          ${Object.keys(catMap).length===0
            ? '<div class="emp" style="padding:20px;font-size:12px;">Aucune charge saisie</div>'
            : Object.entries(catMap).map(([k,v])=>row(k,v,true,'var(--red)')).join('')}
          <div class="bilan-row total-row">
            <span>TOTAL CHARGES</span><span class="amt-neg">${fmt(totalChrg)}</span>
          </div>
        </div>
      </div>
      <div class="bilan-row result-row" style="margin-top:14px;">
        <span>${resultat>=0?'✅ BÉNÉFICE NET (livrés)':'❌ DÉFICIT NET'}</span>
        <span style="color:${resultat>=0?'var(--accent2)':'var(--red)'};">${fmt(Math.abs(resultat))}</span>
      </div>
      ${recLivEnCours>0?`
      <div class="bilan-row" style="margin-top:6px;padding:8px 16px;background:rgba(249,200,70,0.06);border-radius:8px;border:1px solid rgba(249,200,70,0.18);">
        <span style="color:var(--accent3);">📊 Bénéfice projeté (+ en cours)</span>
        <span style="font-weight:700;color:${resultatProj>=0?'var(--accent3)':'var(--red)'};">${fmt(Math.abs(resultatProj))}</span>
      </div>`:''}
      <div style="display:flex;gap:20px;margin-top:10px;padding:0 4px;font-size:12px;color:var(--muted);">
        <span>Taux de marge : <strong style="color:${resultat>=0?'var(--accent2)':'var(--red)'};">${tx}%</strong></span>
        <span>Charges / Produits : <strong style="color:var(--warn);">${totalProd>0?((totalChrg/totalProd)*100).toFixed(1):0}%</strong></span>
      </div>
    </div>`;

  // Graphique évolution résultat mensuel
  const moisNoms=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const labels=[], dataRes=[], colors=[];
  for(let i=0;i<12;i++){
    const mm=String(i+1).padStart(2,'0');
    const p=totalPaiements(year,mm)+totalLivraisons(year,mm)+totalAdhesions(year,mm);
    const c=totalCharges(year,mm);
    const r=p-c;
    labels.push(moisNoms[i]);
    dataRes.push(r);
    colors.push(r>=0?'rgba(46,232,181,0.75)':'rgba(239,68,68,0.75)');
  }
  if(chartResMensuel){chartResMensuel.destroy();chartResMensuel=null;}
  const c=document.getElementById('chart-resultat-mensuel');
  if(c) chartResMensuel=new Chart(c,{
    type:'bar',
    data:{labels,datasets:[{label:'Résultat mensuel',data:dataRes,backgroundColor:colors,borderRadius:6,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>(ctx.parsed.y>=0?'+':'')+Number(ctx.parsed.y).toLocaleString('fr-FR')+' FCFA'}}},scales:{x:{ticks:{color:'#5e6d99',font:{size:9.5}},grid:{display:false}},y:{ticks:{color:'#5e6d99',font:{size:9},callback:v=>v>=1000000?(v/1000000).toFixed(1)+'M':v>=1000?Math.round(v/1000)+'k':v},grid:{color:'rgba(255,255,255,0.05)'}},}}
  });

  // ── Ratios de performance ──
  renderRatios(totalProd, totalChrg, periodLabel(year,month));
  // ── En-tête impression ──
  const _php_r = document.getElementById('ph-resultat-period');
  const _phd_r = document.getElementById('ph-resultat-date');
  if(_php_r) _php_r.textContent = `Période : ${periodLabel(year,month)}`;
  if(_phd_r) _phd_r.textContent = `Édité le ${new Date().toLocaleDateString('fr-FR')}`;
};
let _jrnSolde = 0;

window.renderJournal = function(){
  const month  = document.getElementById('jrn-month')?.value||CUR_MONTH;
  const typeF  = document.getElementById('jrn-type')?.value||'';

  // Construire les écritures
  const ecritures = [];
  let pieceNum = 1;

  // Paiements → PRODUIT
  _monthlyRange(IDX.paiementsByMonth, ...month.split('-'))
    .forEach(p=>{
      const com = IDX.commerciauxById.get(p.commercialId)||{nom:'?'};
      const cl  = IDX.clientsById.get(p.clientId)||{nom:'?'};
      ecritures.push({date:p.date,piece:'PAY-'+String(pieceNum++).padStart(4,'0'),type:'recette',libelle:`Collecte – ${cl.nom} / ${com.nom}`,debit:0,credit:Number(p.montant||0)});
    });

  // Livraisons → PRODUIT (marge uniquement, statut livré)
  _monthlyRange(IDX.livraisonsByMonth, ...month.split('-'))
    .filter(l=>l.statut!=='en_attente')
    .forEach(l=>{
      const art = IDX.articlesById.get(l.articleId)||{nom:'?',pa:0};
      const cl  = IDX.clientsById.get(l.clientId)||{nom:'?'};
      const marge = margeLivraison(l);
      ecritures.push({date:l.date,piece:'LIV-'+String(pieceNum++).padStart(4,'0'),type:'livraison',libelle:`Livraison ${art.nom} – ${cl.nom} (×${l.qty}) | PV:${fmt(Number(l.montant||0))} PA:${fmt(Number(art.pa||0)*Number(l.qty||1))}`,debit:0,credit:marge});
    });

  // Adhésions → PRODUIT
  _monthlyRange(IDX.adhesionsByMonth, ...month.split('-'))
    .forEach(a=>{
      const cl  = IDX.clientsById.get(a.clientId)||{nom:'?'};
      ecritures.push({date:a.date,piece:'ADH-'+String(pieceNum++).padStart(4,'0'),type:'adhesion',libelle:`Adhésion – ${cl.nom}`,debit:0,credit:Number(a.montant||0)});
    });

  // Charges → CHARGE (utilise pieceNum stocké si disponible)
  _monthlyRange(IDX.chargesByMonth, ...month.split('-'))
    .forEach(c=>{
      ecritures.push({date:c.date,piece:c.pieceNum||c.ref||'CHG-'+String(pieceNum++).padStart(4,'0'),type:'charge',libelle:`[${c.categorie}] ${c.libelle}`,debit:Number(c.montant||0),credit:0});
    });

  ecritures.sort((a,b)=>a.date.localeCompare(b.date));

  let filtered = typeF ? ecritures.filter(e=>e.type===typeF) : ecritures;
  let solde = 0;
  let totalDebit = 0, totalCredit = 0;
  const TYPE_LABELS={recette:'Recette',livraison:'Livraison',adhesion:'Adhésion',charge:'Charge'};
  const TYPE_COLORS={recette:'var(--accent2)',livraison:'var(--accent)',adhesion:'var(--accent3)',charge:'var(--red)'};

  // KPI
  filtered.forEach(e=>{ totalDebit+=e.debit; totalCredit+=e.credit; });
  const soldeNet = totalCredit - totalDebit;
  const kpi = document.getElementById('jrn-kpi');
  if(kpi) kpi.innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total crédits</div><div class="kpi-val kv-green">${fmt(totalCredit)}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Total débits</div><div class="kpi-val kv-red">${fmt(totalDebit)}</div></div>
    <div class="kpi-card ${soldeNet>=0?'kc-blue':'kc-red'}"><div class="kpi-lbl">Solde net</div><div class="kpi-val" style="color:${soldeNet>=0?'var(--accent)':'var(--red)'};">${fmt(soldeNet)}</div></div>`;

  // Update print header period
  const moisNoms=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const [y,m] = month.split('-');
  const periodLabel = m ? `${moisNoms[parseInt(m)-1]} ${y}` : `Exercice ${y}`;
  const php = document.getElementById('ph-journaux-period');
  const phd = document.getElementById('ph-journaux-date');
  if(php) php.textContent = `Période : ${periodLabel}`;
  if(phd) phd.textContent = `Édité le ${new Date().toLocaleDateString('fr-FR')}`;

  let cumulSolde = 0;
  document.getElementById('tb-journal').innerHTML=filtered.length===0
    ? `<tr><td colspan="7" class="emp">Aucune écriture pour cette période</td></tr>`
    : filtered.map((e,i)=>{
        cumulSolde += e.credit - e.debit;
        const isLast = i===filtered.length-1;
        return `<tr class="${e.debit>0?'tr-neg':''}">
          <td class="fw6">${esc(e.date)}</td>
          <td class="tm" style="font-size:11px;"><span class="piece-num" style="font-size:10px;">${esc(e.piece)}</span></td>
          <td><span style="font-size:10px;font-weight:700;color:${TYPE_COLORS[e.type]};">${esc(TYPE_LABELS[e.type]||e.type)}</span></td>
          <td style="max-width:280px;">${esc(e.libelle)}</td>
          <td class="${e.debit>0?'amt-neg':''}">${e.debit>0?fmt(e.debit):'—'}</td>
          <td class="${e.credit>0?'amt-pos':''}">${e.credit>0?fmt(e.credit):'—'}</td>
          <td style="font-weight:700;color:${cumulSolde>=0?'var(--accent2)':'var(--red)'};">${fmt(cumulSolde)}</td>
        </tr>`;
      }).join('') +
      `<tr style="background:var(--surface3);font-weight:800;">
        <td colspan="4" style="color:var(--muted);font-size:12px;padding:8px 12px;">TOTAUX PÉRIODE</td>
        <td class="amt-neg">${fmt(totalDebit)}</td>
        <td class="amt-pos">${fmt(totalCredit)}</td>
        <td style="font-weight:800;color:${soldeNet>=0?'var(--accent2)':'var(--red)'};">${fmt(soldeNet)}</td>
      </tr>`;
};

window.exportJournal = function(){
  const month = document.getElementById('jrn-month')?.value||CUR_MONTH;
  const rows = [['Date','N° Pièce','Type','Libellé','Débit','Crédit']];
  document.querySelectorAll('#tb-journal tr').forEach(tr=>{
    const tds = [...tr.querySelectorAll('td')];
    if(tds.length>=6) rows.push(tds.slice(0,6).map(td=>'"'+td.textContent.trim().replace(/"/g,'""')+'"'));
  });
  const csv = rows.map(r=>r.join(';')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `journal_${month}.csv`;
  a.click();
  notify('Journal exporté ✓');
};

/* ═══════════════════════════════════════════════════
   AUTO-SALAIRE
═══════════════════════════════════════════════════ */

// Structure : { [year-month]: [ {id, nom, collecte, prime} ] }
let SAL_DATA = {};

function loadSalairesLocal(){
  try { SAL_DATA = JSON.parse(localStorage.getItem('triomphant_salaires')||'{}'); }
  catch(e){ SAL_DATA = {}; }
}
function saveSalairesLocal(){
  localStorage.setItem('triomphant_salaires', JSON.stringify(SAL_DATA));
  if(db_fs){
    setDoc(doc(db_fs,'salaires','data'), {data:SAL_DATA, updatedAt:serverTimestamp()})
      .catch(e=>console.warn('Sync Firestore (salaires) échouée :', e.message));
  }
}

function getSalKey(){
  const y = document.getElementById('sal-year')?.value || CUR_YEAR;
  const m = document.getElementById('sal-month')?.value || CUR_MONTH.slice(5,7);
  return `${y}-${m}`;
}

function getLignes(){
  const key = getSalKey();
  if(!SAL_DATA[key]) SAL_DATA[key] = [];
  return SAL_DATA[key];
}

/* Calcule la collecte d'un commercial depuis Firebase si disponible */
function getCollecteCommercial(nomOuId, year, month){
  // Chercher parmi les commerciaux TDB par nom ou _id
  const comm = TDB.commerciaux.find(c=>
    c._id === nomOuId ||
    (c.nom||c.name||'').toLowerCase() === nomOuId.toLowerCase()
  );
  if(!comm) return 0;
  const prefix = `${year}-${month}`;
  return TDB.paiements
    .filter(p => p.commercialId === comm._id && p.date && p.date.startsWith(prefix))
    .reduce((a,p) => a + Number(p.montant||0), 0);
}

/* Importer tous les commerciaux TDB pour le mois sélectionné */
window.calculerTousSalaires = function(){
  const key = getSalKey();
  const [year, month] = key.split('-');
  const comms = TDB.commerciaux.filter(c=>c.role==='commercial'||!c.role);
  if(comms.length===0){ notify('Aucun commercial trouvé dans les données TRIOMPHANT','err'); return; }

  // Conserver les primes et lignes manuelles existantes
  const existing = SAL_DATA[key] || [];
  const existingMap = {};
  existing.forEach(l=>{ existingMap[l.id] = l; });

  SAL_DATA[key] = comms.map(c=>{
    const id = c._id;
    const nom = c.nom || c.name || id;
    const collecte = getCollecteCommercial(id, year, month);
    const prime = existingMap[id] ? Number(existingMap[id].prime||0) : 0;
    return { id, nom, collecte, prime };
  });

  // Ajouter les lignes manuelles (celles sans _id dans TDB)
  existing.filter(l=>!comms.find(c=>c._id===l.id)).forEach(l=>{
    SAL_DATA[key].push(l);
  });

  saveSalairesLocal();
  renderSalaires();
  notify(`${comms.length} commercial(aux) importé(s) depuis TRIOMPHANT ✓`);
};

window.ajouterLigneSalaire = function(){
  const nom = document.getElementById('sal-new-nom').value.trim();
  const collecte = Number(document.getElementById('sal-new-collecte').value)||0;
  const prime = Number(document.getElementById('sal-new-prime').value)||0;
  if(!nom){ notify('Veuillez saisir le nom du commercial','err'); return; }

  const key = getSalKey();
  if(!SAL_DATA[key]) SAL_DATA[key]=[];
  SAL_DATA[key].push({ id:'man_'+Date.now(), nom, collecte, prime });
  saveSalairesLocal();

  document.getElementById('sal-new-nom').value='';
  document.getElementById('sal-new-collecte').value='';
  document.getElementById('sal-new-prime').value='';
  renderSalaires();
  notify('Commercial ajouté ✓');
};

window.supprimerLigneSalaire = function(id){
  const key = getSalKey();
  SAL_DATA[key] = (SAL_DATA[key]||[]).filter(l=>l.id!==id);
  saveSalairesLocal();
  renderSalaires();
};

window.updateSalLigne = function(id, field, val){
  const key = getSalKey();
  const ligne = (SAL_DATA[key]||[]).find(l=>l.id===id);
  if(ligne){ ligne[field] = Number(val)||0; saveSalairesLocal(); recalcRow(id); }
};

function recalcRow(id){
  const key = getSalKey();
  const taux = Number(document.getElementById('sal-taux')?.value||7)/100;
  const ligne = (SAL_DATA[key]||[]).find(l=>l.id===id);
  if(!ligne) return;
  const comm = ligne.collecte * taux;
  const total = comm + Number(ligne.prime||0);
  const row = document.querySelector(`[data-sal-id="${id}"]`);
  if(row){
    row.querySelector('.sal-comm-val').textContent = fmt(comm);
    row.querySelector('.sal-total-val').textContent = fmt(total);
  }
  updateSalKpi();
}

function updateSalKpi(){
  const key = getSalKey();
  const taux = Number(document.getElementById('sal-taux')?.value||7)/100;
  const lignes = SAL_DATA[key]||[];
  const totalCollecte = lignes.reduce((a,l)=>a+Number(l.collecte||0),0);
  const totalComm = totalCollecte * taux;
  const totalPrimes = lignes.reduce((a,l)=>a+Number(l.prime||0),0);
  const totalSalaires = totalComm + totalPrimes;

  document.getElementById('sal-kpi').innerHTML=`
    <div class="kpi-card kc-green">
      <div class="kpi-lbl">Commerciaux</div>
      <div class="kpi-val kv-green">${lignes.length}</div>
      <div class="kpi-sub">Ce mois</div>
    </div>
    <div class="kpi-card kc-blue">
      <div class="kpi-lbl">Collecte totale</div>
      <div class="kpi-val kv-blue">${fmt(totalCollecte)}</div>
      <div class="kpi-sub">Encaissements du mois</div>
    </div>
    <div class="kpi-card kc-yellow">
      <div class="kpi-lbl">Total commissions</div>
      <div class="kpi-val kv-yellow">${fmt(totalComm)}</div>
      <div class="kpi-sub">${(taux*100).toFixed(1)}% de la collecte</div>
    </div>
    <div class="kpi-card kc-purple">
      <div class="kpi-lbl">Masse salariale</div>
      <div class="kpi-val" style="color:var(--purple);">${fmt(totalSalaires)}</div>
      <div class="kpi-sub">Commissions + Primes (${fmt(totalPrimes)})</div>
    </div>`;
}

window.renderSalaires = function(){
  const key = getSalKey();
  const [year, month] = key.split('-');
  const taux = Number(document.getElementById('sal-taux')?.value||7)/100;
  const lignes = SAL_DATA[key]||[];

  // Mettre à jour l'en-tête taux
  const hdr = document.getElementById('sal-taux-hdr');
  if(hdr) hdr.textContent = (taux*100).toFixed(taux*100%1===0?0:1);

  // Notice import
  const notice = document.getElementById('sal-import-notice');
  if(notice){
    const nbTDB = TDB.commerciaux.filter(c=>c.role==='commercial'||!c.role).length;
    notice.innerHTML = nbTDB > 0
      ? `💡 ${nbTDB} commercial(aux) détecté(s) dans TRIOMPHANT — cliquez <strong>⚡ Recalculer tout</strong> pour importer automatiquement la collecte.`
      : '⚠️ Aucun commercial trouvé dans les données Firebase — ajoutez-les manuellement ci-dessus.';
  }

  // KPI
  updateSalKpi();

  // Tableau
  const tbody = document.getElementById('tb-salaires');
  if(!tbody) return;

  if(lignes.length===0){
    tbody.innerHTML=`<tr><td colspan="7" class="emp">Aucun commercial pour ce mois.<br><small>Cliquez ⚡ Recalculer tout ou ajoutez manuellement.</small></td></tr>`;
    return;
  }

  let totalCollecte=0, totalComm=0, totalPrimes=0;

  tbody.innerHTML = lignes.map((l,i)=>{
    const comm = Number(l.collecte||0) * taux;
    const total = comm + Number(l.prime||0);
    totalCollecte += Number(l.collecte||0);
    totalComm += comm;
    totalPrimes += Number(l.prime||0);
    return `
    <tr data-sal-id="${esc(l.id)}">
      <td class="tm" style="font-size:11px;">${i+1}</td>
      <td style="font-weight:700;">${esc(l.nom)}</td>
      <td>
        <input type="number" class="sal-input-inline" value="${Number(l.collecte||0)}" min="0"
          onchange="updateSalLigne('${esc(l.id)}','collecte',this.value)"
          oninput="updateSalLigne('${esc(l.id)}','collecte',this.value)">
      </td>
      <td><span class="sal-badge-comm sal-comm-val">${fmt(comm)}</span></td>
      <td>
        <input type="number" class="sal-input-inline" value="${Number(l.prime||0)}" min="0"
          onchange="updateSalLigne('${esc(l.id)}','prime',this.value)"
          oninput="updateSalLigne('${esc(l.id)}','prime',this.value)">
      </td>
      <td><span class="sal-badge-total sal-total-val">${fmt(total)}</span></td>
      <td class="no-print"><button class="btn-sal-del" onclick="supprimerLigneSalaire('${esc(l.id)}')">🗑️</button></td>
    </tr>`;
  }).join('');

  // Ligne total
  const grandTotal = totalComm + totalPrimes;
  tbody.innerHTML += `
  <tr class="sal-total-row">
    <td colspan="2" style="color:var(--muted);font-size:12px;">TOTAL</td>
    <td style="color:var(--accent2);font-weight:800;">${fmt(totalCollecte)}</td>
    <td style="color:var(--accent3);font-weight:800;">${fmt(totalComm)}</td>
    <td style="color:var(--warn);font-weight:800;">${fmt(totalPrimes)}</td>
    <td style="color:var(--accent);font-weight:800;">${fmt(grandTotal)}</td>
    <td class="no-print"></td>
  </tr>`;
};

window.exportSalaires = function(){
  const key = getSalKey();
  const taux = Number(document.getElementById('sal-taux')?.value||7)/100;
  const lignes = SAL_DATA[key]||[];
  const rows=[['Commercial','Collecte (FCFA)','Commission (FCFA)','Prime (FCFA)','Total Salaire (FCFA)']];
  let totC=0,totK=0,totP=0;
  lignes.forEach(l=>{
    const comm=Number(l.collecte||0)*taux;
    const total=comm+Number(l.prime||0);
    totC+=Number(l.collecte||0);totK+=comm;totP+=Number(l.prime||0);
    rows.push([l.nom,l.collecte||0,Math.round(comm),l.prime||0,Math.round(total)]);
  });
  rows.push(['TOTAL',totC,Math.round(totK),totP,Math.round(totK+totP)]);
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(';')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download=`salaires_${key}.csv`;
  a.click();
  notify('Export CSV salaires ✓');
};

/* ═══════════════════════════════════════════════════
   PROJECTION
═══════════════════════════════════════════════════ */
let chartProjCompare = null;

window.renderProjection = function(){
  const year  = document.getElementById('proj-year')?.value||CUR_YEAR;
  const month = document.getElementById('proj-month')?.value||'';
  const search = (document.getElementById('proj-search')?.value||'').toLowerCase();

  const prefix = month ? `${year}-${month}` : year;

  // Calculs de base
  const margeLivReelle = totalLivraisons(year,month);
  const adhesions      = totalAdhesions(year,month);
  const charges        = totalCharges(year,month);
  const produits       = margeLivReelle + adhesions;
  const resultatReel   = produits - charges;

  const proj = projectionClientsRestants(year, month);
  const resultatProj   = produits + proj.marge - charges;
  const gainPotentiel  = proj.marge;

  // KPI
  document.getElementById('proj-kpi').innerHTML=`
    <div class="kpi-card kc-green">
      <div class="kpi-lbl">Résultat réel actuel</div>
      <div class="kpi-val ${resultatReel>=0?'kv-green':'kv-red'}">${fmt(Math.abs(resultatReel))}</div>
      <div class="kpi-sub">${resultatReel>=0?'✅ Bénéfice':'❌ Déficit'} sur livrés</div>
    </div>
    <div class="kpi-card kc-yellow">
      <div class="kpi-lbl">Résultat si tout livré</div>
      <div class="kpi-val ${resultatProj>=0?'kv-yellow':'kv-red'}">${fmt(Math.abs(resultatProj))}</div>
      <div class="kpi-sub">${resultatProj>=0?'✅ Bénéfice projeté':'❌ Déficit projeté'}</div>
    </div>
    <div class="kpi-card kc-blue">
      <div class="kpi-lbl">Marge potentielle restante</div>
      <div class="kpi-val kv-blue">${fmt(gainPotentiel)}</div>
      <div class="kpi-sub">Sur ${proj.nbClients} client(s) non livrés</div>
    </div>
    <div class="kpi-card kc-purple">
      <div class="kpi-lbl">Ratio coût estimé</div>
      <div class="kpi-val kv-purple">${(proj.ratioCout*100).toFixed(0)}%</div>
      <div class="kpi-sub">Ratio PA/PV moyen articles</div>
    </div>`;

  // Graphe comparaison
  if(chartProjCompare){ chartProjCompare.destroy(); chartProjCompare=null; }
  const c = document.getElementById('chart-proj-compare');
  if(c) chartProjCompare = new Chart(c, {
    type: 'bar',
    data: {
      labels: ['Produits réels','Charges','Résultat réel','Marge potentielle','Résultat projeté'],
      datasets: [{
        data: [produits, charges, Math.max(resultatReel,0), gainPotentiel, Math.max(resultatProj,0)],
        backgroundColor: ['rgba(46,232,181,0.6)','rgba(239,68,68,0.6)','rgba(59,130,246,0.6)','rgba(249,200,70,0.6)','rgba(167,139,250,0.6)'],
        borderColor:     ['#2ee8b5','#ef4444','#3b82f6','#f9c846','#a78bfa'],
        borderWidth: 1, borderRadius: 5
      }]
    },
    options:{responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:'#5e6d99',font:{size:10}},grid:{display:false}},
              y:{ticks:{color:'#5e6d99',font:{size:9},callback:v=>v>=1000000?(v/1000000).toFixed(1)+'M':v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,0.05)'}}}}
  });

  // Résumé
  const txReel = produits>0 ? ((resultatReel/produits)*100).toFixed(1) : '—';
  const txProj = (produits+gainPotentiel)>0 ? ((resultatProj/(produits+gainPotentiel))*100).toFixed(1) : '—';
  document.getElementById('proj-summary').innerHTML=`
    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px;">
      <span>Produits réels :</span><strong style="color:var(--accent2);">${fmt(produits)}</strong>
      <span>Marge potentielle restante :</span><strong style="color:var(--accent3);">${fmt(gainPotentiel)}</strong>
      <span>Charges :</span><strong style="color:var(--red);">${fmt(charges)}</strong>
      <span>Résultat réel :</span><strong style="color:${resultatReel>=0?'var(--green)':'var(--red)'};">${fmt(Math.abs(resultatReel))} ${resultatReel>=0?'▲':'▼'}</strong>
      <span>Résultat projeté :</span><strong style="color:${resultatProj>=0?'var(--accent3)':'var(--red)'};">${fmt(Math.abs(resultatProj))} ${resultatProj>=0?'▲':'▼'}</strong>
      <span>Taux rentabilité réel :</span><strong style="color:var(--accent);">${txReel}%</strong>
      <span>Taux rentabilité projeté :</span><strong style="color:var(--purple);">${txProj}%</strong>
      <span>Clients non livrés :</span><strong style="color:var(--warn);">${proj.nbClients}</strong>
    </div>`;

  // Tableau clients non livrés
  const clientsNonLivresIds = getClientsPayesNonLivres(year, month);

  // Construire les lignes de détail
  const rows = clientsNonLivresIds.map(cid=>{
    const client = IDX.clientsById.get(cid);
    const commercial = IDX.commerciauxById.get(client?.commercialId);
    const nomClient = client?.nom || cid;
    const nomComm   = commercial?.nom || '—';

    const paiementsClient = (IDX.paiementsByClient.get(cid)||[]).filter(p=>p.date&&p.date.startsWith(prefix));
    const totalPaye = paiementsClient.reduce((s,p)=>s+Number(p.montant||0),0);
    const margeClient = totalPaye * (1 - proj.ratioCout);

    const livraisonsClient = IDX.livraisonsByClient.get(cid)||[];
    const livraisonLabel = livraisonsClient.length===0
      ? '<span class="tag tag-red">Aucune livraison</span>'
      : `<span class="tag tag-warn">${livraisonsClient.length} livraison(s) en attente</span>`;

    return { nomClient, nomComm, totalPaye, margeClient, livraisonLabel, nbPaiements: paiementsClient.length };
  }).filter(r => !search || r.nomClient.toLowerCase().includes(search) || r.nomComm.toLowerCase().includes(search));

  rows.sort((a,b)=>b.totalPaye-a.totalPaye);

  const totPaye  = rows.reduce((s,r)=>s+r.totalPaye,0);
  const totMarge = rows.reduce((s,r)=>s+r.margeClient,0);

  document.getElementById('tb-projection').innerHTML = rows.length===0
    ? `<tr><td colspan="7" class="emp">${clientsNonLivresIds.length===0?'✅ Tous les clients de la période ont été livrés !':'Aucun résultat pour cette recherche.'}</td></tr>`
    : rows.map((r,i)=>`<tr>
        <td class="tm">${i+1}</td>
        <td class="fw6">${r.nomClient}</td>
        <td class="tm">${r.nomComm}</td>
        <td class="amt-pos">${fmt(r.totalPaye)}</td>
        <td style="color:var(--accent3);font-weight:700;">${fmt(r.margeClient)}</td>
        <td>${r.livraisonLabel}</td>
        <td class="tm">${r.nbPaiements}</td>
      </tr>`).join('')
    + `<tr style="background:#0e1427;font-weight:700;border-top:2px solid var(--border2);">
        <td colspan="3" style="padding:10px 14px;font-size:12px;color:var(--muted);">TOTAL (${rows.length} clients affichés)</td>
        <td class="amt-pos">${fmt(totPaye)}</td>
        <td style="color:var(--accent3);font-weight:700;">${fmt(totMarge)}</td>
        <td colspan="2"></td>
      </tr>`;

  document.getElementById('proj-footer-note').textContent =
    `Ratio moyen PA/PV utilisé : ${(proj.ratioCout*100).toFixed(0)}% — Marge projetée = Total payé × (1 − ratio) — ${rows.length} client(s) affiché(s) sur ${clientsNonLivresIds.length} non livrés`;
};

window.exportProjection = function(){
  const year  = document.getElementById('proj-year')?.value||CUR_YEAR;
  const month = document.getElementById('proj-month')?.value||'';
  const prefix = month ? `${year}-${month}` : year;
  const proj = projectionClientsRestants(year, month);
  const clientsIds = getClientsPayesNonLivres(year, month);

  const rows = [['#','Client','Commercial','Total payé (FCFA)','Marge projetée (FCFA)','Nb paiements']];
  clientsIds.forEach((cid,i)=>{
    const client = IDX.clientsById.get(cid);
    const commercial = IDX.commerciauxById.get(client?.commercialId);
    const paiements = (IDX.paiementsByClient.get(cid)||[]).filter(p=>p.date&&p.date.startsWith(prefix));
    const totalPaye = paiements.reduce((s,p)=>s+Number(p.montant||0),0);
    const marge = totalPaye * (1 - proj.ratioCout);
    rows.push([i+1, client?.nom||cid, commercial?.nom||'—', Math.round(totalPaye), Math.round(marge), paiements.length]);
  });
  const csv = rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(';')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `projection_${year}${month?'_'+month:''}.csv`;
  a.click();
  notify('Export CSV projection ✓');
};

/* ═══════════════════════════════════════════════════
   FICHE DE PAIE
═══════════════════════════════════════════════════ */

function getFpKey(){
  const y = document.getElementById('fp-year')?.value || CUR_YEAR;
  const m = document.getElementById('fp-month')?.value || CUR_MONTH.slice(5,7);
  return `${y}-${m}`;
}

function initFichePaieSelects(){
  // Année
  const fpYear = document.getElementById('fp-year');
  if(fpYear){
    const yrs = getYears();
    fpYear.innerHTML = yrs.map(y=>`<option value="${y}"${y===CUR_YEAR?'selected':''}>${y}</option>`).join('');
  }
  // Mois courant
  const fpMonth = document.getElementById('fp-month');
  if(fpMonth) fpMonth.value = CUR_MONTH.slice(5,7);
}

function populateFpCommercials(){
  const sel = document.getElementById('fp-commercial');
  if(!sel) return;
  const prev = sel.value;

  // Commerciaux depuis TDB + lignes salaires manuelles
  const comms = TDB.commerciaux.filter(c=>c.role==='commercial'||!c.role);
  const allIds = new Set(comms.map(c=>c._id));

  // Ajouter les lignes manuelles des salaires
  Object.values(SAL_DATA).forEach(lignes=>{
    lignes.forEach(l=>{ if(!allIds.has(l.id)) allIds.add(l.id); });
  });

  let options = '<option value="">— Sélectionner —</option>';
  comms.forEach(c=>{
    const nom = c.nom||c.name||c._id;
    options += `<option value="${c._id}"${c._id===prev?'selected':''}>${nom}</option>`;
  });

  // Lignes manuelles
  const manualKey = getFpKey();
  const manualLignes = (SAL_DATA[manualKey]||[]).filter(l=>l.id.startsWith('man_'));
  manualLignes.forEach(l=>{
    options += `<option value="${l.id}"${l.id===prev?'selected':''}>${l.nom} (manuel)</option>`;
  });

  sel.innerHTML = options;
}

window.renderFichePaie = function(){
  populateFpCommercials();
  initFichePaieSelects();

  const container = document.getElementById('fp-container');
  if(!container) return;

  const commId  = document.getElementById('fp-commercial')?.value || '';
  const year    = document.getElementById('fp-year')?.value || CUR_YEAR;
  const month   = document.getElementById('fp-month')?.value || CUR_MONTH.slice(5,7);
  const taux    = Number(document.getElementById('fp-taux')?.value||7)/100;
  const primeEl = Number(document.getElementById('fp-prime')?.value||0);
  const cnss    = Number(document.getElementById('fp-cnss')?.value||0)/100;
  const its     = Number(document.getElementById('fp-its')?.value||0)/100;
  const poste   = document.getElementById('fp-poste')?.value || 'Commercial';

  if(!commId){
    container.innerHTML = '<div style="text-align:center;padding:60px 0;color:var(--muted);font-size:14px;">👆 Sélectionnez un commercial pour générer la fiche de paie</div>';
    return;
  }

  // Trouver le commercial
  let comm = TDB.commerciaux.find(c=>c._id===commId);
  let nomComm = comm ? (comm.nom||comm.name||commId) : '';
  if(!comm){
    // Chercher dans les lignes manuelles
    const key = `${year}-${month}`;
    const ligne = (SAL_DATA[key]||[]).find(l=>l.id===commId);
    if(ligne) nomComm = ligne.nom;
  }

  // Agence
  const agenceId = comm?.agenceId || '';
  const agence = TDB.agences.find(a=>a._id===agenceId);
  const nomAgence = agence ? (agence.nom||agence.name||'') : '';

  // Collecte du mois
  const key = `${year}-${month}`;
  let collecte = 0;
  const salLigne = (SAL_DATA[key]||[]).find(l=>l.id===commId);
  if(salLigne){
    collecte = Number(salLigne.collecte||0);
  } else if(comm){
    collecte = getCollecteCommercial(commId, year, month);
  }

  // Prime depuis SAL_DATA ou champ
  const primeData = salLigne ? Number(salLigne.prime||0) : 0;
  const prime = primeEl > 0 ? primeEl : primeData;

  // Calculs enrichis
  const salBase        = Number(document.getElementById('fp-salbase')?.value||0);
  const primeMotivation= Number(document.getElementById('fp-primemotiv')?.value||0);
  const primeHebdo     = Number(document.getElementById('fp-primehebdo')?.value||0);
  const avance         = Number(document.getElementById('fp-avance')?.value||0);
  const dettes         = Number(document.getElementById('fp-dettes')?.value||0);
  const caution        = Number(document.getElementById('fp-caution')?.value||0);
  const manquant       = Number(document.getElementById('fp-manquant')?.value||0);
  const epargne        = Number(document.getElementById('fp-epargne')?.value||0);
  const commission     = collecte * taux;
  // Dépenses sur le commercial = somme des dépenses (Entraide, Carburant, Vidange,
  // Réparation, Transport, Communication, Autre) enregistrées pour ce commercial
  // sur le mois/année sélectionnés, lues depuis la collection Firestore 'depenses'
  // (partagée avec l'application de gestion des commerciaux).
  const periodePrefix = `${year}-${month}`;
  const depensesCommercial = (TDB.depenses||[])
    .filter(d => d.commercialId === commId && (d.date||'').startsWith(periodePrefix))
    .reduce((sum,d) => sum + Number(d.montant||0), 0);
  const primeRendement = commission - salBase - depensesCommercial;
  const brutTotal      = salBase + primeRendement + primeMotivation + primeHebdo + prime;
  const cotCNSS        = brutTotal * cnss;
  const cotITS         = brutTotal * its;
  const totalRetenues  = cotCNSS + cotITS + avance + dettes + caution + manquant + epargne;
  const netAPayer      = brutTotal - totalRetenues;

  // Période en lettres
  const moisNoms = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const periodeStr = `${moisNoms[parseInt(month)-1]} ${year}`;

  // Numéro de fiche
  const numFiche = `FP-${year}${month}-${commId.slice(-4).toUpperCase()}`;

  // Nb paiements du mois
  const nbPaie = comm ? TDB.paiements.filter(p=>p.commercialId===commId && p.date && p.date.startsWith(`${year}-${month}`)).length : 0;

  container.innerHTML = `
  <div class="fp-doc" id="fp-printable">

    <!-- EN-TÊTE ENTREPRISE -->
    <div class="fp-header">
      <div class="fp-co-name">TRIOMPHANT MMB SERVICE</div>
      <div class="fp-co-meta">
        N°RCCM : RB/ABC/21A29550 &nbsp;|&nbsp; N°IFU : 0202112658536<br>
        TEL : (+229) 01 91 77 76 68 / (+229) 01 44 95 73 46
      </div>
      <div class="fp-title">Fiche de Paie</div>
    </div>

    <!-- INFOS EMPLOYEUR / SALARIÉ -->
    <div class="fp-info-bloc">
      <p>Nom de l'entreprise : <strong>TRIOMPHANT MMB SERVICE</strong></p>
      <p>Adresse : <strong>MENONTIN</strong></p>
    </div>
    <hr class="fp-info-sep">
    <div class="fp-info-bloc">
      <p><strong>Informations du salarié</strong></p>
      <p>Nom &amp; Prénoms : <strong>${nomComm||'—'}</strong></p>
      <p>Fonction / Poste : <strong>${poste.toUpperCase()}</strong></p>
      <p>Matricule : <strong>${numFiche}</strong></p>
      <p>Période de paie : <strong>01/${month}/${year} au ${new Date(parseInt(year), parseInt(month), 0).getDate()}/${month}/${year}</strong></p>
    </div>

    <!-- DÉTAIL RÉMUNÉRATION -->
    <div class="fp-section-head">Détail de la Rémunération</div>
    <table class="fp-off-table">
      <thead>
        <tr>
          <th>Libellé</th>
          <th class="r">Montant (FCFA)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Salaire de base</td>
          <td class="r">${Math.round(salBase).toLocaleString('fr-FR')}</td>
        </tr>
        <tr>
          <td>Prime sur rendement</td>
          <td class="r">${Math.round(primeRendement).toLocaleString('fr-FR')}</td>
        </tr>
        <tr class="no-print">
          <td style="padding-left:24px;font-size:11px;color:var(--muted);">dont dépenses déduites (carburant, vidange, entraide...)</td>
          <td class="r" style="font-size:11px;color:var(--muted);">${depensesCommercial>0?'-'+Math.round(depensesCommercial).toLocaleString('fr-FR'):'---'}</td>
        </tr>
        <tr>
          <td>Prime de motivation</td>
          <td class="r">${Math.round(primeMotivation).toLocaleString('fr-FR')}</td>
        </tr>
        <tr>
          <td>Primes hebdomadaires</td>
          <td class="r">${Math.round(primeHebdo).toLocaleString('fr-FR')}</td>
        </tr>
        <tr class="fp-total-row">
          <td>Salaire Brut</td>
          <td class="r">${Math.round(brutTotal).toLocaleString('fr-FR')}</td>
        </tr>
      </tbody>
    </table>

    <!-- RETENUES -->
    <div class="fp-section-head">Retenues</div>
    <table class="fp-off-table">
      <thead>
        <tr>
          <th>Libellé</th>
          <th class="r">Montant (FCFA)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Avance sur salaire</td>
          <td class="r">${avance>0?Math.round(avance).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr>
          <td>Dettes</td>
          <td class="r">${dettes>0?Math.round(dettes).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr>
          <td>Caution et garantie</td>
          <td class="r">${caution>0?Math.round(caution).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr>
          <td>Épargne</td>
          <td class="r">${epargne>0?Math.round(epargne).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr>
          <td>Manquant</td>
          <td class="r">${manquant>0?Math.round(manquant).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr>
          <td>Retenue CNSS ${cnss>0?'('+Number(cnss*100).toFixed(1)+'%)':''}</td>
          <td class="r">${cnss>0?Math.round(cotCNSS).toLocaleString('fr-FR'):'<span class="fp-dash">---</span>'}</td>
        </tr>
        <tr class="fp-total-row">
          <td>Total Retenues</td>
          <td class="r">${Math.round(totalRetenues).toLocaleString('fr-FR')}</td>
        </tr>
      </tbody>
    </table>

    <!-- NET À PAYER -->
    <div class="fp-net-label-off" style="font-size:13px;font-weight:900;text-transform:uppercase;text-decoration:underline;margin:10px 0 6px;">Net à Payer</div>
    <div class="fp-net-off">
      <table>
        <tr>
          <td>Salaire Net à Payer</td>
          <td class="fp-net-amount-off">${Math.round(netAPayer).toLocaleString('fr-FR')}</td>
          <td style="font-weight:700;padding:4px 8px;border:1px solid #333;">FCFA</td>
        </tr>
      </table>
    </div>

    <!-- MODE DE PAIEMENT -->
    <div class="fp-paiement">
      Mode de paiement :
      <label><input type="checkbox"> Espèces</label>
      <label><input type="checkbox"> Virement</label>
      <label><input type="checkbox"> Mobile Money</label>
    </div>

    <!-- MENTION -->
    <div class="fp-mention">BRAVO ET BON COURAGE POUR LA SUITE</div>

    <!-- SIGNATURES -->
    <div class="fp-signatures">
      <div class="fp-sig-bloc">
        <div class="fp-sig-label">Employeur</div>
        <div class="fp-sig-line">Directeur Général</div>
      </div>
      <div class="fp-sig-bloc">
        <div class="fp-sig-label">Salarié</div>
        <div class="fp-sig-line">${nomComm||''}</div>
      </div>
    </div>

  </div>`;
};

window.exportFichePaieCSV = function(){
  const commId  = document.getElementById('fp-commercial')?.value || '';
  if(!commId){ notify('Sélectionnez un commercial','err'); return; }
  const year    = document.getElementById('fp-year')?.value || CUR_YEAR;
  const month   = document.getElementById('fp-month')?.value || CUR_MONTH.slice(5,7);
  const taux    = Number(document.getElementById('fp-taux')?.value||7)/100;
  const prime   = Number(document.getElementById('fp-prime')?.value||0);
  const cnss    = Number(document.getElementById('fp-cnss')?.value||0)/100;
  const its     = Number(document.getElementById('fp-its')?.value||0)/100;
  const poste   = document.getElementById('fp-poste')?.value || 'Commercial';
  const salBase = Number(document.getElementById('fp-salbase')?.value||0);
  const primeMotivation = Number(document.getElementById('fp-primemotiv')?.value||0);
  const primeHebdo = Number(document.getElementById('fp-primehebdo')?.value||0);
  const avance = Number(document.getElementById('fp-avance')?.value||0);
  const dettes = Number(document.getElementById('fp-dettes')?.value||0);
  const caution = Number(document.getElementById('fp-caution')?.value||0);
  const manquant = Number(document.getElementById('fp-manquant')?.value||0);
  const epargne = Number(document.getElementById('fp-epargne')?.value||0);

  let comm = TDB.commerciaux.find(c=>c._id===commId);
  const nomComm = comm ? (comm.nom||comm.name||commId) : commId;
  const key = `${year}-${month}`;
  const salLigne = (SAL_DATA[key]||[]).find(l=>l.id===commId);
  const collecte = salLigne ? Number(salLigne.collecte||0) : (comm ? getCollecteCommercial(commId, year, month) : 0);
  const primeTotal = prime > 0 ? prime : (salLigne ? Number(salLigne.prime||0) : 0);
  const commission  = collecte * taux;
  // Dépenses sur le commercial, lues depuis Firestore (collection 'depenses'),
  // filtrées par commercial et par mois/année sélectionnés.
  const periodePrefix = `${year}-${month}`;
  const depensesCommercial = (TDB.depenses||[])
    .filter(d => d.commercialId === commId && (d.date||'').startsWith(periodePrefix))
    .reduce((sum,d) => sum + Number(d.montant||0), 0);
  const primeRendement = commission - salBase - depensesCommercial;
  const brut        = salBase + primeRendement + primeMotivation + primeHebdo + primeTotal;
  const retCNSS     = brut * cnss;
  const retITS      = brut * its;
  const totalRetenues = retCNSS + retITS + avance + dettes + caution + manquant + epargne;
  const net         = brut - totalRetenues;

  const moisNoms = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const rows = [
    ['BULLETIN DE PAIE - TRIOMPHANT'],
    ['Salarié', nomComm],
    ['Poste', poste],
    ['Période', `${moisNoms[parseInt(month)-1]} ${year}`],
    [],
    ['Désignation','Montant (FCFA)'],
    ['Collecte du mois', collecte],
    ['Salaire de base', Math.round(salBase)],
    [`Prime sur rendement (Commission ${(taux*100).toFixed(1)}% - Salaire de base - Dépenses commercial)`, Math.round(primeRendement)],
    ['Prime de motivation', Math.round(primeMotivation)],
    ['Primes hebdomadaires', Math.round(primeHebdo)],
    ['Prime exceptionnelle', Math.round(primeTotal)],
    ['SALAIRE BRUT', Math.round(brut)],
    [],
    [`Cotisation CNSS (${(cnss*100).toFixed(1)}%)`, -Math.round(retCNSS)],
    [`ITS (${(its*100).toFixed(1)}%)`, -Math.round(retITS)],
    ['Avance sur salaire', -Math.round(avance)],
    ['Dettes', -Math.round(dettes)],
    ['Caution et garantie', -Math.round(caution)],
    ['Épargne', -Math.round(epargne)],
    ['Manquant', -Math.round(manquant)],
    ['TOTAL RETENUES', -Math.round(totalRetenues)],
    [],
    ['NET À PAYER', Math.round(net)],
  ];
  const csv = rows.map(r=>r.map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(';')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `fiche_paie_${nomComm.replace(/\s+/g,'_')}_${key}.csv`;
  a.click();
  notify('Export CSV fiche de paie ✓');
};

/* ═══════════════════════════════════════════════════
   IMPORT / SYNC
═══════════════════════════════════════════════════ */
window.renderImport = function(){
  const cols = [
    {key:'agences',label:'Agences',color:'var(--accent)'},
    {key:'commerciaux',label:'Utilisateurs / Commerciaux',color:'var(--purple)'},
    {key:'clients',label:'Clients',color:'var(--accent2)'},
    {key:'paiements',label:'Paiements',color:'var(--green)'},
    {key:'articles',label:'Articles',color:'var(--accent3)'},
    {key:'stockMvts',label:'Mouvements stock',color:'var(--warn)'},
    {key:'livraisons',label:'Livraisons',color:'var(--blue)'},
    {key:'adhesionPays',label:'Paiements adhésions',color:'var(--accent2)'},
    {key:'mises',label:'Mises / Contrats',color:'var(--muted)'},
  ];
  const total = cols.reduce((a,c)=>a+tdbCount(c.key),0);

  document.getElementById('import-kpi').innerHTML=`
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Total enregistrements</div><div class="kpi-val kv-blue">${total}</div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">Paiements</div><div class="kpi-val kv-green">${TDB.paiements.length}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Livraisons</div><div class="kpi-val kv-yellow">${TDB.livraisons.length}</div></div>
    <div class="kpi-card kc-purple"><div class="kpi-lbl">Clients</div><div class="kpi-val kv-purple">${TDB.clients.length}</div></div>`;

  document.getElementById('tb-import').innerHTML=cols.map(c=>`
    <tr>
      <td class="fw6" style="color:${c.color};">${c.label}</td>
      <td style="font-weight:700;">${tdbCount(c.key)}</td>
      <td><span class="tag ${tdbCount(c.key)>0?'tag-green':'tag-red'}">${tdbCount(c.key)>0?'✅ Chargé':'⚠️ Vide'}</span></td>
    </tr>`).join('');

  document.getElementById('import-details').innerHTML=`
    Agences : <strong>${TDB.agences.length}</strong><br>
    Commerciaux : <strong>${TDB.commerciaux.filter(c=>c.role==='commercial').length}</strong><br>
    CA total collecté : <strong style="color:var(--accent2);">${fmt(TDB.paiements.reduce((a,p)=>a+Number(p.montant||0),0))}</strong><br>
    Total livraisons : <strong style="color:var(--accent);">${fmt(TDB.livraisons.reduce((a,l)=>a+Number(l.montant||0),0))}</strong><br>
    Valeur stock : <strong style="color:var(--accent3);">${fmt(TDB.articles.reduce((a,art)=>a+Number(art.stock||0)*Number(art.pa||0),0))}</strong><br>
    Charges locales : <strong style="color:var(--red);">${fmt(CHARGES.reduce((a,c)=>a+Number(c.montant||0),0))}</strong>`;
};

/* ═══════════════════════════════════════════════════
   GESTION DES COMPTES
═══════════════════════════════════════════════════ */
window.renderComptes = function(){
  const cur = getCurrentUser();
  const isAdmin = cur && cur.role === 'admin';

  document.getElementById('restricted-notice').style.display = isAdmin ? 'none' : 'block';
  document.getElementById('add-account-panel').style.display = isAdmin ? 'block' : 'none';

  // Comptes réels stockés dans Firestore 'commerciaux' (même base que TRIOMPHANT),
  // filtrés sur les rôles pertinents pour l'app comptabilité.
  const accounts = (TDB.commerciaux||[]).filter(a=>a.role==='admin'||a.role==='comptable');
  const listEl = document.getElementById('account-list');

  // KPI
  const admins = accounts.filter(a=>a.role==='admin').length;
  const comptables = accounts.filter(a=>a.role==='comptable').length;
  document.getElementById('comptes-kpi').innerHTML = `
    <span class="tag tag-blue">📊 ${comptables} Comptable${comptables>1?'s':''}</span>
    <span class="tag tag-warn">🛡️ ${admins} Admin${admins>1?'s':''}</span>`;

  if(accounts.length===0){
    listEl.innerHTML = '<div class="empty-accounts">Aucun compte enregistré.</div>';
    return;
  }

  listEl.innerHTML = accounts.map(a=>{
    const isSelf = cur && cur.id === a._id;
    const name = a.nom || a.email || '—';
    const initials = esc(name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2));
    const createdDate = a.createdAt?.toDate ? a.createdAt.toDate().toLocaleDateString('fr-FR') : '—';
    return `
    <div class="account-item">
      <div class="user-avatar ${a.role==='admin'?'avatar-admin':'avatar-comptable'}" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;">${initials}</div>
      <div class="account-item-info">
        <div class="account-item-name">${esc(name)} ${isSelf?'<span style="font-size:11px;color:var(--muted);">(vous)</span>':''}</div>
        <div class="account-item-email">${esc(a.email||'—')}</div>
        <span class="account-item-role ${a.role==='admin'?'role-pill-admin':'role-pill-comptable'}">${a.role==='admin'?'🛡️ Administrateur':'📊 Comptable'}</span>
      </div>
      <div style="font-size:11px;color:var(--muted);text-align:right;margin-right:10px;">Créé le<br>${esc(createdDate)}</div>
      ${isAdmin && !isSelf ? `<div class="account-item-actions"><button class="btn-delete-acct" onclick="deleteAccount('${esc(a._id)}')">🗑️ Supprimer</button></div>` : ''}
    </div>`;
  }).join('');
};


function startApp(){
  // En mode démo (pas de Firebase), on charge depuis le cache local.
  // En mode connecté, CHARGES/SAL_DATA ont déjà été chargées depuis
  // Firestore par loadComptaData() — ne pas les écraser ici.
  if(!db_fs){
    loadChargesLocal();
    loadSalairesLocal();
  }
  populateYearSelects();
  document.getElementById('dash-month').value = '';
  document.getElementById('ch-month').value = CUR_MONTH;
  document.getElementById('jrn-month').value = CUR_MONTH;

  // Initialiser proj-month
  const projMonth = document.getElementById('proj-month');
  if(projMonth) projMonth.value = '';

  // Initialiser les sélecteurs de la page salaires
  const salYear = document.getElementById('sal-year');
  const salMonth = document.getElementById('sal-month');
  if(salYear){
    const yrs = getYears();
    salYear.innerHTML = yrs.map(y=>`<option value="${y}"${y===CUR_YEAR?'selected':''}>${y}</option>`).join('');
  }
  if(salMonth) salMonth.value = CUR_MONTH.slice(5,7);

  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Appliquer session utilisateur si connecté
  const user = getCurrentUser();
  if(user) applyUserSession(user);

  setSyncStatus(true);
  // Page de démarrage selon le rôle
  const _startUser = getCurrentUser();
  if(_startUser && _startUser.role !== 'admin'){
    go('charges');
  } else {
    renderDashboard();
  }

  // [OPTIM LECTURES] Auto-sync : un seul minuteur, toutes les 30 min (au lieu de 5),
  // et UNIQUEMENT si l'onglet est visible (un onglet oublié ne consomme plus rien).
  _appStarted = true;
  _bootInProgress = false;
  if(db_fs && !_autoSyncTimer){
    const autoSync = async()=>{
      if(document.visibilityState !== 'visible') return;
      if(Date.now() - _lastFullSync < AUTO_SYNC_MS - 1000) return;
      await loadTDBData();
      setSyncStatus(true);
      populateYearSelects();
      if(curPg) renderPg(curPg);
    };
    _autoSyncTimer = setInterval(autoSync, AUTO_SYNC_MS);
    // Au retour sur l'onglet, rattrape une sync seulement si la dernière date de +30 min
    document.addEventListener('visibilitychange', autoSync);
  }
}

/* ═══════════════════════════════════════════════════
   AUTO-CONNECT
═══════════════════════════════════════════════════ */
/* ─── old init now handled by auth script ─── */

// ═══════════════════════════════════════════════════
//  1. N° PIÈCE AUTOMATIQUE
// ═══════════════════════════════════════════════════
function genPieceNum(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const seq = (CHARGES.filter(c=>(c.date||'').startsWith(y+'-'+m)).length + 1);
  return `CH-${y}${m}-${String(seq).padStart(3,'0')}`;
}

// ═══════════════════════════════════════════════════
//  2. VERROUILLAGE DE PÉRIODE
// ═══════════════════════════════════════════════════
function getLockedPeriods(){ try{ return JSON.parse(localStorage.getItem('triomphant_locked_periods')||'[]'); }catch(e){return[];} }
function saveLockedPeriods(arr){
  localStorage.setItem('triomphant_locked_periods', JSON.stringify(arr));
  if(db_fs){
    setDoc(doc(db_fs,'periodesVerrouillees','data'), {items:arr, updatedAt:serverTimestamp()})
      .catch(e=>console.warn('Sync Firestore (périodes verrouillées) échouée :', e.message));
  }
}

/* Charge CHARGES / SAL_DATA / périodes verrouillées depuis Firestore
   (avec repli automatique sur le cache localStorage hors-ligne). */
async function loadComptaData(){
  try {
    const chSnap = await getDoc(doc(db_fs,'charges','data'));
    CHARGES = chSnap.exists() ? (chSnap.data().items||[]) : [];
    localStorage.setItem('triomphant_compta_charges', JSON.stringify(CHARGES));
  } catch(e){ console.warn('Lecture Firestore (charges) échouée, repli local :', e.message); loadChargesLocal(); }

  try {
    const salSnap = await getDoc(doc(db_fs,'salaires','data'));
    SAL_DATA = salSnap.exists() ? (salSnap.data().data||{}) : {};
    localStorage.setItem('triomphant_salaires', JSON.stringify(SAL_DATA));
  } catch(e){ console.warn('Lecture Firestore (salaires) échouée, repli local :', e.message); loadSalairesLocal(); }

  try {
    const lockSnap = await getDoc(doc(db_fs,'periodesVerrouillees','data'));
    const items = lockSnap.exists() ? (lockSnap.data().items||[]) : [];
    localStorage.setItem('triomphant_locked_periods', JSON.stringify(items));
  } catch(e){ console.warn('Lecture Firestore (périodes verrouillées) échouée, repli local :', e.message); }
  buildIndexes();
}
function isPeriodeLocked(period){ return getLockedPeriods().includes(period); }

window.checkPeriodeLock = function(){
  const date = document.getElementById('ch-date')?.value||'';
  const period = date.substring(0,7);
  const warn = document.getElementById('ch-lock-warn');
  if(!warn) return;
  warn.style.display = (period && isPeriodeLocked(period)) ? 'block' : 'none';
};

window.toggleLock = function(period){
  if(window._userRole !== 'admin'){ notify('Réservé à l\'administrateur','err'); return; }
  const locked = getLockedPeriods();
  const idx = locked.indexOf(period);
  if(idx>=0){
    if(!confirm(`Déverrouiller la période ${period} ?\nLes modifications des charges redeviendront possibles.`)) return;
    locked.splice(idx,1);
    notify(`🔓 Période ${period} déverrouillée`);
  } else {
    if(!confirm(`Verrouiller la période ${period} ?\nAucune charge ne pourra être ajoutée, modifiée ou supprimée pour ce mois.`)) return;
    locked.push(period);
    notify(`🔒 Période ${period} verrouillée`);
  }
  saveLockedPeriods(locked);
  renderPeriodes();
  renderCharges();
};

window.renderPeriodes = function(){
  const yrs = getYears();
  const year = yrs[0] || CUR_YEAR;
  const label = document.getElementById('lock-year-label');
  if(label) label.textContent = year;
  const locked = getLockedPeriods();
  const moisNoms=['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const list = document.getElementById('lock-list');
  if(!list) return;
  list.innerHTML = moisNoms.map((nom,i)=>{
    const m = String(i+1).padStart(2,'0');
    const period = `${year}-${m}`;
    const isLocked = locked.includes(period);
    const nbCharges = CHARGES.filter(c=>(c.date||'').startsWith(period)).length;
    return `<div class="lock-row">
      <div>
        <strong style="font-size:13px;">${nom} ${year}</strong>
        <span class="tm" style="font-size:11px;margin-left:10px;">${nbCharges} charge(s)</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="lock-badge ${isLocked?'':'unlocked'}">${isLocked?'🔒 Verrouillé':'🔓 Ouvert'}</span>
        ${window._userRole==='admin'?`<button class="btn ${isLocked?'btn-ghost':'btn-danger'} btn-sm" onclick="toggleLock('${period}')">${isLocked?'Déverrouiller':'Verrouiller'}</button>`:''}
      </div>
    </div>`;
  }).join('');
};

// ═══════════════════════════════════════════════════
//  3. PIÈCES JOINTES
// ═══════════════════════════════════════════════════
window.handlePJUpload = function(input){
  const file = input.files[0];
  if(!file) return;
  if(file.size > 2*1024*1024){ notify('Fichier trop lourd (max 2 Mo)','err'); return; }
  const reader = new FileReader();
  reader.onload = function(e){
    window._pendingPJ = e.target.result;
    document.getElementById('ch-pj-name').textContent = file.name;
    document.getElementById('ch-pj-clear').style.display = 'inline';
    const preview = document.getElementById('ch-pj-preview');
    const img = document.getElementById('ch-pj-img');
    if(file.type.startsWith('image/')){
      img.src = e.target.result;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
};

window.clearPJ = function(){
  window._pendingPJ = null;
  document.getElementById('ch-pj-name').textContent = 'Aucun fichier';
  document.getElementById('ch-pj-clear').style.display = 'none';
  document.getElementById('ch-pj-preview').style.display = 'none';
  document.getElementById('ch-pj-img').src = '';
  document.getElementById('ch-pj-input').value = '';
};

window.viewPJ = function(id){
  const ch = CHARGES.find(c=>c._id===id);
  if(!ch||!ch.pj) return;
  const modal = document.getElementById('modal-pj-viewer');
  const img = document.getElementById('pj-viewer-img');
  const pdf = document.getElementById('pj-viewer-pdf');
  const link = document.getElementById('pj-viewer-link');
  if(ch.pj.startsWith('data:image')){
    img.src = ch.pj; img.style.display='block'; pdf.style.display='none';
  } else {
    img.style.display='none'; pdf.style.display='block';
    link.href = ch.pj;
  }
  modal.classList.remove('hidden');
};

// ═══════════════════════════════════════════════════
//  4. RATIOS & SEUIL DE RENTABILITÉ (Compte de résultat)
// ═══════════════════════════════════════════════════
function renderRatios(produits, charges, periodeLabel){
  const zone = document.getElementById('res-ratios');
  if(!zone) return;
  if(!produits && !charges){ zone.innerHTML=''; return; }
  const resultat = produits - charges;
  const txRenta  = produits > 0 ? (resultat/produits*100) : 0;
  const txCharges = produits > 0 ? (charges/produits*100) : 0;
  const seuilRenta = charges; // simplifié : seuil = charges fixes (pas de var. ici)
  const couverture = produits > 0 ? Math.min(100, produits/Math.max(seuilRenta,1)*100) : 0;
  const barColor = couverture >= 100 ? '#22c55e' : couverture >= 60 ? '#f9c846' : '#ef4444';

  zone.innerHTML = `
  <div class="card">
    <div class="card-title">📐 Indicateurs de performance — ${esc(periodeLabel)}</div>
    <div class="ratio-grid">
      <div class="ratio-card">
        <div class="ratio-lbl">Taux de rentabilité</div>
        <div class="ratio-val" style="color:${txRenta>=0?'var(--accent2)':'var(--red)'};">${txRenta.toFixed(1)}%</div>
        <div class="ratio-sub">Résultat / Produits totaux</div>
      </div>
      <div class="ratio-card">
        <div class="ratio-lbl">Ratio charges / produits</div>
        <div class="ratio-val" style="color:${txCharges<70?'var(--accent2)':txCharges<90?'var(--accent3)':'var(--red)'};">${txCharges.toFixed(1)}%</div>
        <div class="ratio-sub">${txCharges<70?'✅ Sain':txCharges<90?'⚠️ À surveiller':'🔴 Critique'}</div>
      </div>
      <div class="ratio-card">
        <div class="ratio-lbl">Résultat net</div>
        <div class="ratio-val" style="color:${resultat>=0?'var(--accent2)':'var(--red)'};">${fmt(resultat)}</div>
        <div class="ratio-sub">${resultat>=0?'Bénéfice':'Déficit'}</div>
      </div>
      <div class="ratio-card">
        <div class="ratio-lbl">Couverture des charges</div>
        <div class="ratio-val" style="color:${barColor};">${couverture.toFixed(0)}%</div>
        <div class="seuil-bar"><div class="seuil-fill" style="width:${Math.min(couverture,100)}%;background:${barColor};"></div></div>
        <div class="ratio-sub">Seuil atteint à ${couverture.toFixed(0)}%</div>
      </div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════
//  5. TRÉSORERIE (CASH FLOW)
// ═══════════════════════════════════════════════════
window.renderTresorerie = function(){
  const year  = document.getElementById('cf-year')?.value  || CUR_YEAR;
  const month = document.getElementById('cf-month')?.value || '';
  const filter = month ? year+'-'+month : year;

  // ENTRÉES
  const entPaiements  = totalPaiements(year, month);
  const entLivraisons = _monthlyRange(IDX.livraisonsByMonth, year, month).filter(l=>l.statut!=='en_attente').reduce((a,l)=>a+Number(l.montant||0),0);
  const entAdhesions  = totalAdhesions(year, month);
  const totalEntrees  = entPaiements + entLivraisons + entAdhesions;

  // SORTIES
  const chargesPeriode= _monthlyRange(IDX.chargesByMonth, year, month);
  const sortCharges   = chargesPeriode.reduce((a,c)=>a+Number(c.montant||0),0);
  const sortPersonnel = chargesPeriode.filter(c=>c.categorie==='Personnel').reduce((a,c)=>a+Number(c.montant||0),0);
  const totalSorties  = sortCharges;
  const fluxNet       = totalEntrees - totalSorties;

  // KPI
  const kpi = document.getElementById('cf-kpi');
  if(kpi) kpi.innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total entrées</div><div class="kpi-val kv-green">${fmt(totalEntrees)}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Total sorties</div><div class="kpi-val kv-red">${fmt(totalSorties)}</div></div>
    <div class="kpi-card ${fluxNet>=0?'kc-blue':'kc-red'}"><div class="kpi-lbl">Flux net</div><div class="kpi-val" style="color:${fluxNet>=0?'var(--accent)':'var(--red)'};">${fmt(fluxNet)}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Masse salariale</div><div class="kpi-val kv-yellow">${fmt(sortPersonnel)}</div></div>`;

  // Entrées détail
  const entreesEl = document.getElementById('cf-entrees');
  if(entreesEl) entreesEl.innerHTML=`
    <div class="cf-row"><span>💰 Cotisations clients</span><span class="cf-in">${fmt(entPaiements)}</span></div>
    <div class="cf-row"><span>📦 Produits livraisons</span><span class="cf-in">${fmt(entLivraisons)}</span></div>
    <div class="cf-row"><span>🤝 Adhésions</span><span class="cf-in">${fmt(entAdhesions)}</span></div>
    <div class="cf-row cf-total"><span>TOTAL ENTRÉES</span><span class="cf-net-pos">${fmt(totalEntrees)}</span></div>`;

  // Sorties détail par catégorie
  const catMap={};
  chargesPeriode.forEach(c=>{ catMap[c.categorie]=(catMap[c.categorie]||0)+Number(c.montant||0); });
  const sortiesEl = document.getElementById('cf-sorties');
  if(sortiesEl) sortiesEl.innerHTML=
    Object.entries(catMap).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>
      `<div class="cf-row"><span style="color:${catColor(cat)};">● ${esc(cat)}</span><span class="cf-out">−${fmt(amt)}</span></div>`
    ).join('') +
    `<div class="cf-row cf-total"><span>TOTAL SORTIES</span><span class="cf-net-neg">−${fmt(totalSorties)}</span></div>`;

  // Graphe mensuel
  const moisNoms=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const labels=[], dataIn=[], dataOut=[], dataNet=[];
  for(let i=0;i<12;i++){
    const m=String(i+1).padStart(2,'0');
    const ein = totalPaiements(year,m)
              + _monthlyRange(IDX.livraisonsByMonth, year, m).filter(l=>l.statut!=='en_attente').reduce((a,l)=>a+Number(l.montant||0),0)
              + totalAdhesions(year,m);
    const eout= totalCharges(year,m);
    labels.push(moisNoms[i]); dataIn.push(ein); dataOut.push(eout); dataNet.push(ein-eout);
  }
  const ctx=document.getElementById('chart-cashflow');
  if(ctx){
    if(ctx._chartInst) ctx._chartInst.destroy();
    ctx._chartInst = new Chart(ctx,{type:'bar',data:{labels,datasets:[
      {label:'Entrées',data:dataIn,backgroundColor:'rgba(46,232,181,0.5)',borderColor:'rgba(46,232,181,0.9)',borderWidth:1},
      {label:'Sorties',data:dataOut,backgroundColor:'rgba(239,68,68,0.5)',borderColor:'rgba(239,68,68,0.9)',borderWidth:1},
      {label:'Flux net',data:dataNet,type:'line',borderColor:'rgba(108,143,255,0.9)',backgroundColor:'transparent',borderWidth:2,pointRadius:3}
    ]},options:{responsive:true,plugins:{legend:{labels:{color:'#dde3f5',font:{size:11}}}},scales:{x:{ticks:{color:'#5e6d99'}},y:{ticks:{color:'#5e6d99'}}}}});
  }

  // Print header
  const moisLabel = month ? moisNoms[parseInt(month)-1]+' '+year : 'Exercice '+year;
  const php = document.getElementById('ph-tresorerie-period');
  const phd = document.getElementById('ph-tresorerie-date');
  if(php) php.textContent = `Période : ${moisLabel}`;
  if(phd) phd.textContent = `Édité le ${new Date().toLocaleDateString('fr-FR')}`;
};

// ═══════════════════════════════════════════════════
//  5bis. AUTONOMIE DE L'ENTREPRISE
// ═══════════════════════════════════════════════════
function tauxSalaireGlobal(){
  return Number(document.getElementById('sal-taux')?.value||7)/100;
}
function totalSalairesTous(){
  const taux = tauxSalaireGlobal();
  let total = 0;
  Object.values(SAL_DATA||{}).forEach(lignes=>{
    (lignes||[]).forEach(l=>{ total += Number(l.collecte||0)*taux + Number(l.prime||0); });
  });
  return total;
}
function valeurStockTotal(){
  return TDB.articles.reduce((a,art)=>a+Number(art.stock||0)*Number(art.pa||0),0);
}
function soldeTresorerieCumule(){
  const entrees = TDB.paiements.reduce((a,p)=>a+Number(p.montant||0),0)
                + TDB.livraisons.filter(l=>l.statut!=='en_attente').reduce((a,l)=>a+Number(l.montant||0),0)
                + (TDB.adhesionPays||[]).reduce((a,x)=>a+Number(x.montant||0),0);
  const sorties = CHARGES.reduce((a,c)=>a+Number(c.montant||0),0);
  return entrees - sorties;
}
function ratioCoutMoyenArticles(){
  const arts = TDB.articles.filter(a=>Number(a.pv||0)>0);
  return arts.length>0
    ? arts.reduce((s,a)=>s+(Number(a.pa||0)/Number(a.pv||1)),0)/arts.length
    : 0.6;
}
function coutLivraisonsDuesTotal(){
  // Tous les clients ayant payé un jour, sans aucune livraison "livrée", tous historiques confondus
  const clientsIds = getClientsPayesNonLivres('','');
  const ratioCout = ratioCoutMoyenArticles();
  let totalPaye = 0;
  clientsIds.forEach(cid=>{
    totalPaye += (IDX.paiementsByClient.get(cid)||[]).reduce((s,p)=>s+Number(p.montant||0),0);
  });
  return { cout: totalPaye*ratioCout, nbClients: clientsIds.length, totalPaye, ratioCout };
}
function rythmeMensuelMoyen(){
  // Moyenne des flux mensuels réels depuis janvier de l'année en cours
  const now = new Date();
  const year = String(now.getFullYear());
  const curMonth = now.getMonth()+1; // nb de mois écoulés (janvier compte comme 1)
  let entreesTot=0, sortiesChargesTot=0;
  for(let m=1;m<=curMonth;m++){
    const key = year+'-'+String(m).padStart(2,'0');
    entreesTot += totalLivraisons(year, String(m).padStart(2,'0')) + totalAdhesions(year, String(m).padStart(2,'0'));
    sortiesChargesTot += totalCharges(year, String(m).padStart(2,'0'));
  }
  // Salaires moyens : moyenne sur les mois de l'année en cours qui ont des données, sinon moyenne globale
  const moisAnneeAvecSalaire = Object.keys(SAL_DATA||{}).filter(k=>k.startsWith(year+'-'));
  const taux = tauxSalaireGlobal();
  let salairesMoy = 0;
  if(moisAnneeAvecSalaire.length>0){
    let sTot=0;
    moisAnneeAvecSalaire.forEach(k=>{
      (SAL_DATA[k]||[]).forEach(l=>{ sTot += Number(l.collecte||0)*taux + Number(l.prime||0); });
    });
    salairesMoy = sTot/moisAnneeAvecSalaire.length;
  } else {
    const allKeys = Object.keys(SAL_DATA||{});
    salairesMoy = allKeys.length>0 ? totalSalairesTous()/allKeys.length : 0;
  }
  const entreesMoy = entreesTot/curMonth;
  const sortiesMoy = (sortiesChargesTot/curMonth) + salairesMoy;
  return { entreesMoy, sortiesMoy, fluxNetMoy: entreesMoy-sortiesMoy, curMonth, year };
}

window.renderAutonomie = function(){
  const valStock   = valeurStockTotal();
  const solde      = soldeTresorerieCumule();
  const capital    = solde + valStock;
  const liv        = coutLivraisonsDuesTotal();
  const chargesTot = totalCharges('','');
  const salairesTot= totalSalairesTous();
  const rythme     = rythmeMensuelMoyen();

  const capitalNetApresLivraisons = capital - liv.cout;

  // KPIs capital
  const kpi = document.getElementById('auto-kpi-capital');
  if(kpi) kpi.innerHTML = `
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Trésorerie cumulée</div><div class="kpi-val" style="color:var(--accent);">${fmt(solde)}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Valeur du stock (PA)</div><div class="kpi-val kv-yellow">${fmt(valStock)}</div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">Capital actuel total</div><div class="kpi-val kv-green">${fmt(capital)}</div></div>
    <div class="kpi-card ${capitalNetApresLivraisons>=0?'kc-blue':'kc-red'}"><div class="kpi-lbl">Capital net après livraisons</div><div class="kpi-val" style="color:${capitalNetApresLivraisons>=0?'var(--accent)':'var(--red)'};">${fmt(capitalNetApresLivraisons)}</div></div>`;

  // Bloc 1 : livraisons + charges à couvrir
  const bloc1 = document.getElementById('auto-livraisons');
  if(bloc1) bloc1.innerHTML = `
    <div class="cf-row"><span>👥 Clients payés, non livrés</span><span>${liv.nbClients}</span></div>
    <div class="cf-row"><span>💸 Montant total encaissé (dette)</span><span>${fmt(liv.totalPaye)}</span></div>
    <div class="cf-row"><span>📦 Coût d'achat estimé à livrer (PA)</span><span class="cf-out">−${fmt(liv.cout)}</span></div>
    <div class="cf-row"><span>🧾 Charges saisies (historique)</span><span class="cf-out">−${fmt(chargesTot)}</span></div>
    <div class="cf-row"><span>👤 Salaires calculés (historique)</span><span class="cf-out">−${fmt(salairesTot)}</span></div>
    <div class="cf-row cf-total"><span>CAPITAL NET (après coût des livraisons)</span><span class="${capitalNetApresLivraisons>=0?'cf-net-pos':'cf-net-neg'}">${fmt(capitalNetApresLivraisons)}</span></div>
    <div style="font-size:11px;margin-top:6px;">Ratio coût moyen (PA/PV) utilisé : ${(liv.ratioCout*100).toFixed(1)}%</div>`;

  // Bloc 2 : autonomie dans le temps
  const bloc2 = document.getElementById('auto-duree');
  let dureeHTML;
  if(rythme.fluxNetMoy>=0){
    dureeHTML = `
      <div class="cf-row"><span>📈 Revenus mensuels moyens (${rythme.year})</span><span class="cf-in">${fmt(rythme.entreesMoy)}</span></div>
      <div class="cf-row"><span>📉 Dépenses mensuelles moyennes</span><span class="cf-out">−${fmt(rythme.sortiesMoy)}</span></div>
      <div class="cf-row cf-total"><span>FLUX NET MENSUEL</span><span class="cf-net-pos">+${fmt(rythme.fluxNetMoy)}</span></div>
      <div class="alert alert-info" style="margin-top:10px;">✅ L'entreprise s'autofinance : les revenus mensuels moyens couvrent les dépenses. Autonomie illimitée au rythme actuel.</div>`;
  } else {
    const moisAutonomie = capital / Math.abs(rythme.fluxNetMoy);
    const dateEpuis = new Date();
    dateEpuis.setMonth(dateEpuis.getMonth()+Math.floor(moisAutonomie));
    dureeHTML = `
      <div class="cf-row"><span>📈 Revenus mensuels moyens (${rythme.year})</span><span class="cf-in">${fmt(rythme.entreesMoy)}</span></div>
      <div class="cf-row"><span>📉 Dépenses mensuelles moyennes</span><span class="cf-out">−${fmt(rythme.sortiesMoy)}</span></div>
      <div class="cf-row cf-total"><span>DÉFICIT MENSUEL MOYEN</span><span class="cf-net-neg">−${fmt(Math.abs(rythme.fluxNetMoy))}</span></div>
      <div class="alert alert-warn" style="margin-top:10px;">⚠️ Au rythme actuel, le capital de <strong>${fmt(capital)}</strong> permet de tenir environ <strong>${moisAutonomie.toFixed(1)} mois</strong>, soit jusqu'à environ <strong>${dateEpuis.toLocaleDateString('fr-FR',{month:'long',year:'numeric'})}</strong> sans nouvelles recettes.</div>`;
  }
  if(bloc2) bloc2.innerHTML = dureeHTML;

  // Graphe : projection du capital net sur 12 mois
  const labels=[], dataCapital=[];
  let cap = capitalNetApresLivraisons;
  const now = new Date();
  for(let i=0;i<=12;i++){
    const d = new Date(now.getFullYear(), now.getMonth()+i, 1);
    labels.push(d.toLocaleDateString('fr-FR',{month:'short',year:'2-digit'}));
    dataCapital.push(Math.round(cap));
    cap += rythme.fluxNetMoy;
  }
  const ctx=document.getElementById('chart-autonomie');
  if(ctx){
    if(ctx._chartInst) ctx._chartInst.destroy();
    ctx._chartInst = new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'Capital net projeté',data:dataCapital,borderColor:'rgba(108,143,255,0.9)',backgroundColor:'rgba(108,143,255,0.15)',fill:true,tension:0.25,pointRadius:3}
    ]},options:{responsive:true,plugins:{legend:{labels:{color:'#dde3f5',font:{size:11}}}},scales:{x:{ticks:{color:'#5e6d99'}},y:{ticks:{color:'#5e6d99'}}}}});
  }

  const footer = document.getElementById('auto-footer-note');
  if(footer) footer.textContent = `Calculé le ${new Date().toLocaleDateString('fr-FR')} — Rythme basé sur ${rythme.curMonth} mois écoulés en ${rythme.year}.`;
};

// ═══════════════════════════════════════════════════
//  6. EXPORT PDF / IMPRESSION DES ÉTATS FINANCIERS
// ═══════════════════════════════════════════════════
window.printPage = function(page){
  // Marque la page comme cible d'impression et déclenche
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('print-target'));
  const el = document.getElementById('page-'+page);
  if(!el) return;
  el.classList.add('print-target');
  window.print();
  setTimeout(()=>el.classList.remove('print-target'), 1000);
};

window.exportBilanCSV = function(){
  const year = document.getElementById('bilan-year')?.value||CUR_YEAR;
  const rows = [['BILAN COMPTABLE — '+year],[''],['ACTIF','Montant'],['PASSIF','Montant']];
  document.querySelectorAll('#bilan-container .tw table tr').forEach(tr=>{
    const tds=[...tr.querySelectorAll('td,th')];
    if(tds.length>=2) rows.push(tds.map(td=>'"'+td.textContent.trim().replace(/"/g,'""')+'"'));
  });
  const csv=rows.map(r=>r.join(';')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download=`bilan_${year}.csv`; a.click();
};

window.exportResultatCSV = function(){
  const year = document.getElementById('res-year')?.value||CUR_YEAR;
  const month= document.getElementById('res-month')?.value||'';
  const period = month ? year+'-'+month : year;
  const rows = [['COMPTE DE RÉSULTAT — '+period],[''],['Libellé','Montant']];
  document.querySelectorAll('#res-container table tr').forEach(tr=>{
    const tds=[...tr.querySelectorAll('td,th')];
    if(tds.length>=2) rows.push(tds.map(td=>'"'+td.textContent.trim().replace(/"/g,'""')+'"'));
  });
  const csv=rows.map(r=>r.join(';')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download=`resultat_${period}.csv`; a.click();
};

// ═══════════════════════════════════════════════════
//  9. STATUT SYNC ENRICHI — date + heure précises
//     (patch appliqué directement dans setSyncStatus original)
// ═══════════════════════════════════════════════════


if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(err=>console.warn('SW registration failed', err));
  });
}
