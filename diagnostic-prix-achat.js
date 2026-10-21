/* DIAGNOSTIC PRIX D'ACHAT — LECTURE SEULE (aucune écriture) */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const app = getApps().length ? getApp() : initializeApp({
  apiKey: "AIzaSyATa_tOvEbGROCIZ9xZgkAsr_--d2vYIjc", authDomain: "triomphant-v2.firebaseapp.com",
  projectId: "triomphant-v2", storageBucket: "triomphant-v2.firebasestorage.app",
  messagingSenderId: "908578874554", appId: "1:908578874554:web:5c008fba39204ce6c24e83" });
const db = getFirestore(app), auth = getAuth(app);
const $ = id => document.getElementById(id);
const log = m => { $('log').textContent += m + '\n'; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PRIX = /(^|_)(pa|pv|prix|cout|cost|achat|vente|tarif|montant)/i;

function typeOf(v){
  if(v === null) return 'null';
  if(Array.isArray(v)) return 'liste[' + (v.length ? typeOf(v[0]) : 'vide') + ']';
  if(typeof v?.toDate === 'function') return 'Timestamp';
  if(typeof v === 'object') return 'objet{' + Object.keys(v).slice(0,8).join(',') + '}';
  return typeof v;
}
/* Structure d'un document : nom -> type ; valeur montrée seulement pour un nombre « prix ». */
function structure(data){
  const out = {};
  for(const [k,v] of Object.entries(data||{})){
    out[k] = typeOf(v) + ((typeof v === 'number' && PRIX.test(k)) ? ` = ${v}` : '');
  }
  return out;
}
async function echantillon(col, n){
  try{
    const snap = await getDocs(query(collection(db, col), limit(n)));
    return { nb: snap.size, champs: snap.docs.map(d => structure(d.data())) };
  }catch(e){ return { erreur: e.code || e.message }; }
}
async function existe(col, id){
  try{ const d = await getDoc(doc(db, col, id)); return d.exists() ? d.data() : null; }
  catch(e){ return { __erreur: e.code || e.message }; }
}

onAuthStateChanged(auth, async user => {
  if(!user){ $('who').innerHTML = '<span class="err">Non connecté.</span> Connectez-vous à l\'application de comptabilité (admin), puis rechargez cette page.'; return; }
  try{
    const p = await getDoc(doc(db, 'commerciaux', user.uid));
    if(!p.exists() || p.data().role !== 'admin'){ $('who').innerHTML = '<span class="err">Réservé aux administrateurs.</span>'; return; }
    $('who').innerHTML = `Connecté : <strong>${esc(user.email)}</strong> <span class="ok">(admin)</span>`;
    $('run').disabled = false;
  }catch(e){ $('who').innerHTML = `<span class="err">Erreur :</span> ${esc(e.message)}`; }
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true; $('log').textContent = '';
  const R = { version: 3, date: new Date().toISOString() };
  log('Lecture des 30 livraisons les plus récentes…');
  let livs = [];
  try{ livs = (await getDocs(query(collection(db,'livraisons'), orderBy('_ts','desc'), limit(30)))).docs.map(d=>({id:d.id, ...d.data()})); }
  catch(e){ R.erreurLivraisons = e.code || e.message; }
  R.livraisons_champs = livs.length ? structure(livs[0]) : null;
  const ids = [...new Set(livs.map(l => l.produitId).filter(Boolean))];
  R.livraisons_lues = livs.length;
  R.livraisons_sans_produitId = livs.filter(l => !l.produitId).length;
  R.produitId_distincts = ids.length;
  log(`${livs.length} livraisons, ${ids.length} produitId distincts. Recherche dans les collections…`);
  const trouves = { produits:0, produitsPrive:0, articles:0 }, erreurs = {};
  const exemples = {};
  for(const id of ids){
    for(const col of ['produits','produitsPrive','articles']){
      const d = await existe(col, id);
      if(d && d.__erreur){ erreurs[col] = d.__erreur; continue; }
      if(d){ trouves[col]++; if(!exemples[col]) exemples[col] = structure(d); }
    }
  }
  R.produitId_trouve_dans = trouves;
  R.erreurs_lecture = erreurs;
  R.structure_document_trouve = exemples;
  // Cohérence PV : montant ÷ qty vs pvFige
  R.controle_montant = livs.slice(0,10).map(l => ({ qty: l.qty, pvFige: l.pvFige, montant: l.montant, montant_egal_pvFige_x_qty: Number(l.pvFige)*Number(l.qty) === Number(l.montant) }));
  log('Échantillons des collections…');
  R.produits_echantillon      = await echantillon('produits', 3);
  R.produitsPrive_echantillon = await echantillon('produitsPrive', 3);
  R.articles_echantillon      = await echantillon('articles', 3);
  $('out').value = JSON.stringify(R, null, 2);
  log('Terminé.');
  $('run').disabled = false;
});
