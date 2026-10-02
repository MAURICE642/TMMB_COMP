/* ═══════════════════════════════════════════════════
   DIAGNOSTIC FIRESTORE — LECTURE SEULE
   Ne fait AUCUNE écriture. Affiche uniquement des nombres, des noms
   de champs et des types (jamais les valeurs des documents).
═══════════════════════════════════════════════════ */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, limit, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
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
const COLS = ['agences','commerciaux','clients','paiements','articles','stockMvts','livraisons','adhesionPays','mises','depenses'];
// Noms possibles pour un champ « date de modification » (on ne suppose pas lequel est utilisé)
const CANDIDATES = ['updatedAt','updated_at','modifiedAt','lastModified','dateModification','createdAt','timestamp'];

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
  let totalDocs = 0;

  for(const col of COLS){
    log(`Analyse de « ${col} »…`);
    const row = { collection: col };
    try{
      row.total = await count(collection(db, col));
      // stockMvts et mises ne sont plus téléchargés (seulement comptés) depuis l'optimisation
      if(!['stockMvts','mises'].includes(col)) totalDocs += row.total;

      // Échantillon de 3 documents : noms de champs + type des candidats (pas les valeurs)
      const sample = await getDocs(query(collection(db, col), limit(3)));
      const fieldNames = new Set();
      sample.docs.forEach(d => Object.keys(d.data()).forEach(k => fieldNames.add(k)));
      row.champsEchantillon = [...fieldNames].sort();

      // Comptage des documents possédant chaque champ candidat (!= null => champ présent et non nul)
      row.candidats = {};
      for(const f of CANDIDATES){
        try{
          const n = await count(query(collection(db, col), where(f, '!=', null)));
          if(n > 0) row.candidats[f] = n;
        }catch(e){ log(`  (comptage ${f} impossible : ${e.message})`); }
      }

      // Meilleur candidat : un champ de MODIFICATION de préférence, sinon de création
      const modifFields = ['updatedAt','updated_at','modifiedAt','lastModified','dateModification'];
      const best = modifFields.find(f => row.candidats[f]) ||
                   Object.keys(row.candidats).sort((a,b)=>row.candidats[b]-row.candidats[a])[0] || null;
      row.champRetenu = best;
      row.sansChamp = best ? row.total - row.candidats[best] : row.total;
      row.typesEchantillon = best ? [...new Set(sample.docs.map(d => typeOf(d.data()[best])))] : [];

      if(!best){
        row.verdict = 'AUCUN champ de date';
      } else if(!modifFields.includes(best)){
        row.verdict = 'Seulement une date de création (insuffisant pour les modifications)';
      } else if(row.sansChamp > 0){
        row.verdict = `${row.sansChamp} doc(s) sans « ${best} » — rattrapage nécessaire`;
      } else if(row.typesEchantillon.length > 1){
        row.verdict = 'Types mélangés — à harmoniser';
      } else {
        row.verdict = 'OK pour une synchro incrémentale';
      }
    }catch(e){
      row.erreur = e.message;
      row.verdict = 'Erreur (règles Firestore ?)';
    }
    report.push(row);

    const cls = row.verdict.startsWith('OK') ? 'ok' : (row.erreur || row.verdict.startsWith('AUCUN')) ? 'err' : 'warn';
    $('res').insertAdjacentHTML('beforeend', `<tr>
      <td><strong>${esc(col)}</strong></td>
      <td>${row.total ?? '—'}</td>
      <td>${esc(row.champRetenu || '—')}${row.candidats && Object.keys(row.candidats).length>1 ? `<br><span style="color:var(--muted);font-size:11px;">autres : ${esc(Object.keys(row.candidats).filter(k=>k!==row.champRetenu).join(', '))}</span>`:''}</td>
      <td>${row.sansChamp ?? '—'}</td>
      <td>${esc((row.typesEchantillon||[]).join(', ') || '—')}</td>
      <td class="${cls}">${esc(row.verdict)}${row.erreur?`<br><span style="font-size:11px;">${esc(row.erreur)}</span>`:''}</td>
    </tr>`);
  }

  log(`\nTerminé. Total : ${totalDocs} documents téléchargés par la comptabilité (hors stockMvts et mises, seulement comptés).`);
  log(`=> Une synchronisation complète coûte donc environ ${totalDocs} lectures.`);
  $('out').value = JSON.stringify({ date: new Date().toISOString(), totalDocs, collections: report }, null, 2);
  $('run').disabled = false;
});
