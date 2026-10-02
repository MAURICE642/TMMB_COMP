/* ═══════════════════════════════════════════════════
   DIAGNOSTIC FIRESTORE — LECTURE SEULE
   Ne fait AUCUNE écriture. Affiche uniquement des nombres, des noms
   de champs et des types (jamais les valeurs des documents).
═══════════════════════════════════════════════════ */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, limit, orderBy, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyATa_tOvEbGROCIZ9xZgkAsr_--d2vYIjc",
  authDomain: "triomphant-v2.firebaseapp.com",
  projectId: "triomphant-v2",
  storageBucket: "triomphant-v2.firebasestorage.app",
  messagingSenderId: "908578874554",
  appId: "1:908578874554:web:5c008fba39204ce6c24e83"
};
const app  = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
const db   = getFirestore(app);
const auth = getAuth(app);

// Collections lues par l'application de comptabilité
const COLS = ['agences','commerciaux','clients','paiements','articles','stockMvts','livraisons','adhesionPays','depenses'];
// V2 : analyse ciblée du champ « _ts » repéré dans le 1er diagnostic.
const F = '_ts';

/* Convertit une valeur de _ts en Date, quel que soit son type (sans supposer le format). */
function toDate(v){
  if(v == null) return null;
  if(typeof v?.toDate === 'function') return v.toDate();
  if(typeof v === 'number') return new Date(v > 1e12 ? v : v*1000); // ms ou secondes
  if(typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
}
/* Construit une valeur seuil du même type que _ts (Firestore ne compare que des valeurs de même type). */
function threshold(sampleValue, date){
  if(typeof sampleValue?.toDate === 'function') return date;           // Timestamp : le SDK accepte une Date
  if(typeof sampleValue === 'number') return sampleValue > 1e12 ? date.getTime() : Math.floor(date.getTime()/1000);
  if(typeof sampleValue === 'string') return date.toISOString();
  return null;
}
const fmtD = d => d ? d.toISOString().replace('T',' ').slice(0,16) + ' UTC' : '—';

const $ = id => document.getElementById(id);
const log = m => { $('log').textContent += m + '\n'; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function typeOf(v){
  if(v === undefined) return 'absent';
  if(v === null) return 'null';
  if(typeof v?.toDate === 'function') return 'Timestamp';
  if(typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? 'texte (date ISO)' : 'texte';
  if(typeof v === 'number') return 'nombre';
  return typeof v;
}

async function count(q){
  const snap = await getCountFromServer(q);
  return snap.data().count;
}

onAuthStateChanged(auth, async user => {
  if(!user){
    $('who').innerHTML = '<span class="err">Non connecté.</span> Ouvrez l\'application de comptabilité, connectez-vous en administrateur, puis rechargez cette page.';
    return;
  }
  try{
    const p = await getDoc(doc(db,'commerciaux', user.uid));
    const role = p.exists() ? p.data().role : null;
    if(role !== 'admin'){
      $('who').innerHTML = `<span class="err">Accès refusé</span> — rôle « ${esc(role || 'inconnu')} ». Réservé aux administrateurs.`;
      return;
    }
    $('who').innerHTML = `Connecté : <strong>${esc(user.email)}</strong> <span class="ok">(admin)</span>`;
    $('run').disabled = false;
  }catch(e){
    $('who').innerHTML = `<span class="err">Erreur de lecture du profil :</span> ${esc(e.message)}`;
  }
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  $('res').innerHTML = '';
  $('log').textContent = '';
  const report = [];

  for(const col of COLS){
    log(`Analyse de « ${col} »…`);
    const r = { collection: col };
    try{
      r.total  = await count(collection(db, col));
      r.avecTs = await count(query(collection(db, col), where(F,'!=',null)));
      r.sansTs = r.total - r.avecTs;

      if(r.avecTs > 0){
        // Le plus ancien et le plus récent _ts : si les types diffèrent => types mélangés
        const oldest = (await getDocs(query(collection(db, col), orderBy(F,'asc'),  limit(1)))).docs[0]?.data()[F];
        const newest = (await getDocs(query(collection(db, col), orderBy(F,'desc'), limit(1)))).docs[0]?.data()[F];
        r.typeAncien = typeOf(oldest); r.typeRecent = typeOf(newest);
        r.plusAncien = fmtD(toDate(oldest)); r.plusRecent = fmtD(toDate(newest));

        // Activité : nb de docs écrits/modifiés ces dernières 24 h et 7 jours
        // (= coût approximatif d'une synchro incrémentale sur ces périodes)
        for(const [lbl, ms] of [['modifies24h', 864e5], ['modifies7j', 7*864e5]]){
          const t = threshold(newest, new Date(Date.now()-ms));
          if(t !== null){
            try{ r[lbl] = await count(query(collection(db, col), where(F,'>',t))); }
            catch(e){ log(`  (comptage ${lbl} impossible : ${e.message})`); }
          }
        }
      }

      // Contrôle qualité spécifique à 'commerciaux' (champs en double repérés au 1er diagnostic)
      if(col === 'commerciaux'){
        r.qualite = {};
        for(const f of ['role','role ','agenceId','agencID','zone','ZONE']){
          try{ r.qualite[f] = await count(query(collection(db, col), where(f,'!=',null))); }
          catch(e){ r.qualite[f] = 'erreur'; }
        }
      }

      if(r.avecTs === 0)                     r.verdict = 'Pas de _ts';
      else if(r.typeAncien !== r.typeRecent) r.verdict = 'Types mélangés';
      else if(r.sansTs > 0)                  r.verdict = `${r.sansTs} doc(s) sans _ts`;
      else                                   r.verdict = 'Couverture complète';
    }catch(e){
      r.erreur = e.message; r.verdict = 'Erreur';
    }
    report.push(r);

    const cls = r.verdict === 'Couverture complète' ? 'ok' : (r.verdict === 'Erreur' || r.verdict === 'Pas de _ts') ? 'err' : 'warn';
    $('res').insertAdjacentHTML('beforeend', `<tr>
      <td><strong>${esc(col)}</strong></td>
      <td>${r.total ?? '—'}</td>
      <td>${r.avecTs ?? '—'} / sans : ${r.sansTs ?? '—'}</td>
      <td>${esc(r.typeAncien||'—')}${r.typeRecent && r.typeRecent!==r.typeAncien ? ' → '+esc(r.typeRecent) : ''}<br><span style="font-size:11px;color:var(--muted);">${esc(r.plusAncien||'')} → ${esc(r.plusRecent||'')}</span></td>
      <td>${r.modifies24h ?? '—'} / ${r.modifies7j ?? '—'}</td>
      <td class="${cls}">${esc(r.verdict)}${r.erreur?`<br><span style="font-size:11px;">${esc(r.erreur)}</span>`:''}</td>
    </tr>`);
  }

  log('\nTerminé.');
  $('out').value = JSON.stringify({ version: 2, date: new Date().toISOString(), collections: report }, null, 2);
  $('run').disabled = false;
});
