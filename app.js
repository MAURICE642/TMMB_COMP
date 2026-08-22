/* ═══════════════════════════════════════════════════
   SÉCURITÉ — UTILITAIRES CRYPTOGRAPHIQUES
   Hachage PBKDF2 via Web Crypto API (natif navigateur)
═══════════════════════════════════════════════════ */

/* ─── Échappement HTML (protection XSS) ─── */
function esc(s){
  if(s==null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/* ─── Session courante (cache non-sensible : jamais de mot de passe) ───
   La véritable authentification est gérée par Firebase Auth (voir plus bas,
   fonctions doLogin/doLogout/onAuthStateChanged). Ce cache sessionStorage
   ne sert qu'à l'UI (nom, rôle) et est reconstruit à chaque connexion. */
function getCurrentUser(){
  try{ return JSON.parse(sessionStorage.getItem('triomphant_current_user')||'null'); }
  catch(e){ return null; }
}
function setCurrentUser(user){
  if(user) sessionStorage.setItem('triomphant_current_user', JSON.stringify(user));
  else sessionStorage.removeItem('triomphant_current_user');
}
/* doLogin, doLogout et le verrou anti-brute-force double couche sont
   définis plus bas, dans le bloc <script type="module"> Firebase,
   afin d'avoir accès à auth/db_fs (voir section FIREBASE). */

/* ─── Appliquer la session ─── */
/* Pages autorisées par rôle */
let curPg = 'dashboard';
const PAGES_COMPTABLE = ['charges','journaux','salaires','fiche-paie','import'];
const PAGES_ADMIN     = ['dashboard','charges','bilan','resultat','journaux','salaires','fiche-paie','projection','import','comptes'];

function applyUserSession(user){
  // Badge topbar
  const badge = document.getElementById('user-badge');
  const avatar = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-badge-name');
  if(badge && nameEl && avatar){
    const initials = user.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    avatar.textContent = initials;
    avatar.className = 'user-avatar ' + (user.role==='admin' ? 'avatar-admin' : 'avatar-comptable');
    nameEl.textContent = user.name + (user.role==='admin' ? ' 🛡️' : ' 📊');
  }

  const isAdmin = user.role === 'admin';
  const allowedPages = isAdmin ? PAGES_ADMIN : PAGES_COMPTABLE;

  // Afficher/masquer items de navigation selon le rôle
  const navMap = {
    dashboard:'nav-dashboard', charges:'nav-charges', bilan:'nav-bilan',
    resultat:'nav-resultat', journaux:'nav-journaux', salaires:'nav-salaires',
    'fiche-paie':'nav-fiche-paie', projection:'nav-projection', import:'nav-import', comptes:'nav-comptes'
  };
  Object.entries(navMap).forEach(([pg, navId])=>{
    const el = document.getElementById(navId);
    if(el) el.style.display = allowedPages.includes(pg) ? '' : 'none';
  });

  // Section admin dans la sidebar
  document.getElementById('nav-section-admin').style.display = isAdmin ? '' : 'none';
  // Section dashboard visible admin seulement
  const secDash = document.getElementById('nav-section-dashboard');
  if(secDash) secDash.style.display = isAdmin ? '' : 'none';

  // Si la page courante n'est pas autorisée, rediriger vers la première autorisée
  if(!allowedPages.includes(curPg)){
    go(allowedPages[0]);
  }

  // Masquer bouton supprimer charge pour comptable
  applyChargePermissions(user.role);
}

function applyChargePermissions(role){
  // Appliqué à chaque rendu de la page charges
  window._userRole = role;
}

/* Vérification d'accès intégrée dans go() */
const _goBase = window.go;
window.go = function(pg){
  const user = getCurrentUser();
  if(user){
    const allowed = user.role === 'admin' ? PAGES_ADMIN : PAGES_COMPTABLE;
    if(!allowed.includes(pg)){
      notify('Acces refuse - page reservee a l administrateur', 'err');
      return;
    }
  }
  _goBase(pg);
};

/* ─── Créer un compte depuis le panel admin ───
   Crée un VRAI compte Firebase Auth + le document Firestore 'commerciaux'
   correspondant (même projet que l'app TRIOMPHANT). Implémentation complète
   plus bas, dans le bloc <script type="module"> (nécessite createUserWithEmailAndPassword). */

/* ─── Init au chargement ───
   L'affichage initial (écran de connexion vs application) et la reconnexion
   automatique éventuelle (session Firebase persistée) sont entièrement gérés
   par onAuthStateChanged() dans le bloc <script type="module"> plus bas —
   il n'y a plus besoin d'un DOMContentLoaded ici. */
