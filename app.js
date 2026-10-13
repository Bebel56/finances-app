// Application finances : lit les vues du schéma public de Supabase et enregistre
// les recatégorisations / ajustements via les fonctions classer_operation, ajuster_operation…
// Les droits sont appliqués par la base : sans connexion, l'API refuse tout.

const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
const racine = document.getElementById("app");

const A_CLASSER = "Autres / Divers";
const MOIS_ABREGES = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS_COURTS = ["jan", "fév", "mar", "avr", "mai", "jun", "jul", "aoû", "sep", "oct", "nov", "déc"];
const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

// Nature d'une entrée d'argent. Les revenus comptent dans le budget ; le reste n'est ni revenu ni dépense.
const NATURES = {
  salaire: "Salaire", dividendes: "Dividendes", autre: "Autre revenu",
  compte_courant: "Compte courant d'associé", desepargne: "Désépargne", remboursement: "Remboursement reçu",
  emprunt: "Emprunt",
};
const NATURES_REVENU = ["salaire", "dividendes", "autre"];
const NATURES_HORS_BUDGET = ["compte_courant", "desepargne", "remboursement", "emprunt"];
const TYPES = {
  depense: "Dépense", entree: "Entrée", virement_interne: "Virement interne", epargne: "Épargne", emprunt: "Emprunt",
  compte_courant: "Compte courant d'associé", desepargne: "Désépargne", remboursement: "Remboursement reçu",
};

function lireMode() {
  // Par défaut, de salaire à salaire : un salaire versé fin de mois finance le mois suivant
  try { return localStorage.getItem("mode") === "mois" ? "mois" : "paie"; } catch { return "paie"; }
}

function lireMasque() {
  try { return localStorage.getItem("masque") === "1"; } catch { return false; }
}

const etat = {
  masque: lireMasque(),    // montants remplacés par XXX (bouton œil, ou deux secousses du téléphone)
  mode: lireMode(),        // "mois" (calendrier) | "paie" (de salaire à salaire)
  session: null,
  ecran: null,             // null (application) | "code" | "activation"
  doubleAuthActive: false,
  mfa: null,               // activation en cours : { factorId, qr, secret, uri }
  onglet: "synthese",      // synthese | evolution | operations | a-classer
  flux: new Map(),         // mois → { entrees, depenses, solde }
  depensesMensuelles: [],  // { mois, categorie, montant } sur la fenêtre affichée
  finFenetre: null,        // dernier mois de la fenêtre de 12 mois de l'écran Évolution
  cleEvolution: null,      // fenêtre déjà chargée (évite de recharger pour rien)
  categorieEvolution: null,
  listeMois: [],           // "2026-09-01", du plus ancien au plus récent
  mois: null,
  operations: [],          // opérations du mois affiché
  categories: [],
  comptesCourants: [],     // { societe, apports, remboursements, solde }
  emprunts: null,          // { emprunte, rembourse, reste_du, nb_mouvements }
  aVenir: [],              // paiements attendus : { source, cle, transaction_id, libelle, date_prevue, montant, detail }
  ficheAVenir: null,       // index du paiement à venir ouvert
  salairePrecedent: null,  // vue par mois : salaire versé fin du mois d'avant { date_operation, montant }
  societe: null,           // société dont on consulte les mouvements (toutes dates)
  mouvementsSociete: [],
  recherche: "",
  filtreCategorie: null,
  filtreType: null,        // { type, sens, nom } : mouvements hors budget d'un type donné
  fiche: null,             // transaction_id de l'opération ouverte
  message: null,
  erreur: null,
  occupe: false,
};

// ── Utilitaires ────────────────────────────────────────────────────────────────
// Tous les montants affichés passent par ces deux formats : c'est ici qu'ils sont masqués
function formatEuros(options) {
  const format = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", ...options });
  return { format: (valeur) => (etat.masque ? "XXX €" : format.format(valeur)) };
}
const euros = formatEuros({});
const eurosRonds = formatEuros({ maximumFractionDigits: 0 });

function echapper(texte) {
  return String(texte ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function libelleMois(mois) {
  const [annee, m] = mois.split("-");
  return `${MOIS[Number(m) - 1]} ${annee}`;
}

function jourEnLettres(date) {
  const [, m, j] = date.split("-");
  return `${Number(j)} ${MOIS_ABREGES[Number(m) - 1]}`;
}

function dateIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const aujourdhui = () => dateIso(new Date());

function ajouterJours(date, jours) {
  const [a, m, j] = date.split("-").map(Number);
  return dateIso(new Date(a, m - 1, j + jours));
}

// Même jour le mois suivant, moins un jour : la veille du prochain salaire attendu
function veilleMoisSuivant(date) {
  const [a, m, j] = date.split("-").map(Number);
  return dateIso(new Date(a, m, j - 1));
}

function finDeMois(mois) {
  const [a, m] = mois.split("-").map(Number);
  return dateIso(new Date(a, m, 0));
}

const libelleCourt = (libelle) => libelle.replace(/^CARTE \d{2}\/\d{2} /, "");

// En mode « paie », les données sont rangées par période et non par mois du calendrier
const cle = () => (etat.mode === "paie" ? "periode" : "mois");

function jourMois(date) {
  const [, m, j] = date.split("-");
  return `${j}/${m}`;
}

const ICONES = {
  synthese: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  evolution: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 6-8M3 21h18"/></svg>',
  operations: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  "a-classer": '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.2"/></svg>',
  precedent: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  suivant: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  sortir: '<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  fermer: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  oeil: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  oeilBarre: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.3A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
};

function afficherMessage(texte) {
  etat.message = texte;
  rendre();
  clearTimeout(afficherMessage.minuteur);
  afficherMessage.minuteur = setTimeout(() => { etat.message = null; rendre(); }, 2500);
}

// ── Double authentification ────────────────────────────────────────────────────
// Après le mot de passe : si un code est attendu, on le demande avant tout chargement.
// La base applique la même règle, l'application ne fait que guider.
async function apresConnexion() {
  racine.innerHTML = '<p class="chargement">Chargement…</p>';
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) {
    console.error(error);
    await sb.auth.signOut();
    return;
  }
  etat.doubleAuthActive = data.nextLevel === "aal2";
  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    etat.ecran = "code";
    etat.erreur = null;
    rendre();
    return;
  }
  etat.ecran = null;
  await toutCharger();
}

async function demarrerActivation() {
  // Une activation abandonnée laisse un facteur non vérifié : on repart de zéro
  const { data: existants } = await sb.auth.mfa.listFactors();
  for (const facteur of existants?.all ?? []) {
    if (facteur.status !== "verified") await sb.auth.mfa.unenroll({ factorId: facteur.id });
  }
  const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Application de codes", issuer: "Finances" });
  if (error) {
    console.error(error);
    afficherMessage("Activation impossible pour le moment");
    return;
  }
  etat.mfa = { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  etat.ecran = "activation";
  etat.erreur = null;
  rendre();
}

async function abandonnerActivation() {
  if (etat.mfa) await sb.auth.mfa.unenroll({ factorId: etat.mfa.factorId });
  etat.mfa = null;
  etat.ecran = null;
  etat.erreur = null;
  rendre();
}

function lireCode(formulaire) {
  return String(new FormData(formulaire).get("code")).replace(/\D/g, "");
}

// ── Données ────────────────────────────────────────────────────────────────────
// Totaux par mois ou par période de paie, selon le mode
async function chargerFlux() {
  const requete = etat.mode === "paie"
    ? sb.from("flux_periodes").select("periode, est_periode_de_paie, debut, fin, en_cours, nb_jours, entrees, depenses, solde").order("periode")
    : sb.from("flux_mensuels").select("mois, entrees, depenses, solde").order("mois");
  const { data, error } = await requete;
  if (error) throw error;
  etat.flux = new Map(data.map((l) => [l[cle()], { ...l, entrees: Number(l.entrees), depenses: Number(l.depenses), solde: Number(l.solde) }]));
  etat.listeMois = data.map((l) => l[cle()]);
}

async function chargerComptesCourants() {
  const { data, error } = await sb.from("comptes_courants").select("societe, apports, remboursements, net, solde, historique_depuis").order("societe");
  if (error) throw error;
  etat.comptesCourants = data;
  const aVenir = await sb.from("a_venir").select("*").order("date_prevue");
  if (aVenir.error) throw aVenir.error;
  etat.aVenir = aVenir.data;
  const emprunts = await sb.from("emprunts").select("emprunte, rembourse, reste_du, nb_mouvements").maybeSingle();
  if (emprunts.error) throw emprunts.error;
  etat.emprunts = emprunts.data;
  if (etat.societe) {
    const mouvements = await sb.from("transactions").select("*").eq("type_flux", "compte_courant")
      .eq("societe", etat.societe).order("date_operation", { ascending: false });
    if (mouvements.error) throw mouvements.error;
    etat.mouvementsSociete = mouvements.data;
  }
}

async function chargerReferences() {
  const [, categories] = await Promise.all([
    chargerFlux(),
    sb.from("categories").select("categorie").order("categorie"),
    chargerComptesCourants(),
  ]);
  if (categories.error) throw categories.error;

  etat.categories = categories.data.map((l) => l.categorie);
  if (!etat.mois || !etat.listeMois.includes(etat.mois)) {
    etat.mois = etat.listeMois[etat.listeMois.length - 1] ?? null;
  }
}

async function chargerMois() {
  if (!etat.mois) { etat.operations = []; return; }
  const { data, error } = await sb
    .from("transactions")
    .select("*")
    .eq(cle(), etat.mois)
    .order("date_operation", { ascending: false })
    .order("transaction_id", { ascending: false });
  if (error) throw error;
  etat.operations = data;
  await chargerSalairePrecedent();
}

// Vue par mois : un salaire versé à partir du 25 compte dans son mois de versement, et le mois
// suivant paraît sans revenu. On le repère pour l'expliquer à l'écran.
async function chargerSalairePrecedent() {
  etat.salairePrecedent = null;
  if (etat.mode !== "mois" || !etat.mois) return;
  if (etat.operations.some((o) => o.nature_entree === "salaire")) return;
  const debut = new Date(`${etat.mois}T00:00:00Z`);
  debut.setUTCMonth(debut.getUTCMonth() - 1);
  const depuis = `${debut.toISOString().slice(0, 8)}25`;
  const { data, error } = await sb.from("transactions").select("date_operation, montant")
    .eq("nature_entree", "salaire").gte("date_operation", depuis).lt("date_operation", etat.mois)
    .order("date_operation", { ascending: false }).limit(1);
  if (error) throw error;
  etat.salairePrecedent = data[0] ?? null;
}

// Les 12 mois affichés dans Évolution. La fenêtre ne glisse que si le mois choisi en sort.
function fenetre12() {
  const dernier = etat.listeMois.length - 1;
  const i = etat.listeMois.indexOf(etat.mois);
  let fin = etat.listeMois.indexOf(etat.finFenetre);
  if (fin < 0) fin = dernier;
  if (i > fin) fin = i;
  if (i < fin - 11) fin = Math.min(dernier, i + 11);
  etat.finFenetre = etat.listeMois[fin];
  return etat.listeMois.slice(Math.max(0, fin - 11), fin + 1);
}

// Charge les totaux mensuels et les dépenses par catégorie de la fenêtre, si nécessaire
async function chargerEvolution(forcer = false) {
  const mois = fenetre12();
  if (!mois.length) return;
  const cleFenetre = `${etat.mode}|${mois[0]}|${mois[mois.length - 1]}`;
  if (!forcer && cleFenetre === etat.cleEvolution) return;

  const vue = etat.mode === "paie" ? "depenses_periodes" : "depenses_mensuelles";
  const [, depenses] = await Promise.all([
    chargerFlux(),
    sb.from(vue).select(`${cle()}, categorie, montant`).gte(cle(), mois[0]).lte(cle(), mois[mois.length - 1]),
  ]);
  if (depenses.error) throw depenses.error;

  etat.depensesMensuelles = depenses.data.map((l) => ({ mois: l[cle()], categorie: l.categorie, montant: Number(l.montant) }));
  etat.cleEvolution = cleFenetre;
}

async function toutCharger() {
  try {
    etat.erreur = null;
    await chargerReferences();
    await chargerMois();
  } catch (e) {
    etat.erreur = "Impossible de charger les données. Vérifie ta connexion.";
    console.error(e);
  }
  rendre();
}

async function changerMois(decalage) {
  const i = etat.listeMois.indexOf(etat.mois) + decalage;
  if (i < 0 || i >= etat.listeMois.length) return;
  etat.mois = etat.listeMois[i];
  etat.filtreCategorie = null;
  etat.filtreType = null;
  await afficherMois();
}

async function afficherMois() {
  try {
    await chargerMois();
    if (etat.onglet === "evolution") await chargerEvolution();
  } catch (e) {
    etat.erreur = "Impossible de charger ce mois.";
    console.error(e);
  }
  rendre();
}

// Appelle une fonction de la base puis recharge le mois affiché
async function enregistrer(fonction, parametres, messageOk) {
  if (etat.occupe) return;
  etat.occupe = true;
  const { error } = await sb.rpc(fonction, parametres);
  etat.occupe = false;
  if (error) {
    console.error(error);
    afficherMessage(error.message || "Enregistrement impossible");
    return;
  }
  // Qualifier un salaire peut créer ou supprimer une période : on recharge aussi la liste
  await chargerFlux();
  if (!etat.listeMois.includes(etat.mois)) etat.mois = etat.listeMois[etat.listeMois.length - 1] ?? null;
  await Promise.all([chargerMois(), chargerComptesCourants()]);
  etat.cleEvolution = null;   // les totaux ont changé : à recharger à la prochaine visite d'Évolution
  afficherMessage(messageOk);
}

// ── Calculs sur le mois affiché ────────────────────────────────────────────────
const depenses = () => etat.operations.filter((o) => o.type_flux === "depense");
// À traiter : dépenses sans catégorie et entrées dont la nature reste à préciser
const aClasser = () => etat.operations.filter((o) => (o.type_flux === "depense" && o.categorie === A_CLASSER) || o.a_qualifier);

function totaux() {
  const somme = (type) => etat.operations.filter((o) => o.type_flux === type).reduce((s, o) => s + Number(o.montant), 0);
  const entrees = somme("entree");
  const sorties = somme("depense");
  return { entrees, sorties, solde: entrees - sorties };
}

function parCategorie() {
  const cumul = new Map();
  for (const o of depenses()) cumul.set(o.categorie, (cumul.get(o.categorie) ?? 0) + Number(o.montant));
  return [...cumul.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Écrans ─────────────────────────────────────────────────────────────────────
function ecranConnexion() {
  return `
    <form class="connexion" id="connexion">
      <h1>Finances</h1>
      <p>Connecte-toi pour voir tes comptes.</p>
      ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
      <label class="champ"><span>Adresse e-mail</span>
        <input type="email" name="email" autocomplete="username" inputmode="email" autocapitalize="none" required></label>
      <label class="champ"><span>Mot de passe</span>
        <input type="password" name="password" autocomplete="current-password" required></label>
      <button class="bouton" type="submit" ${etat.occupe ? "disabled" : ""}>${etat.occupe ? "Connexion…" : "Se connecter"}</button>
    </form>`;
}

function champCode() {
  return `
    <label class="champ"><span>Code à 6 chiffres</span>
      <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" required></label>`;
}

function ecranCode() {
  return `
    <form class="connexion" id="code">
      <h1>Vérification</h1>
      <p>Saisis le code affiché dans ton application de codes.</p>
      ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
      ${champCode()}
      <button class="bouton" type="submit" ${etat.occupe ? "disabled" : ""}>${etat.occupe ? "Vérification…" : "Valider"}</button>
      <button class="lien" type="button" data-action="deconnexion">Se déconnecter</button>
    </form>`;
}

function ecranActivation() {
  return `
    <form class="connexion activation" id="activation">
      <h1>Double authentification</h1>
      <p>Ajoute ce compte dans une application de codes (Mots de passe d'Apple, Google Authenticator, 1Password…), puis saisis le code qu'elle affiche.</p>
      <div class="qr"><img src="${echapper(etat.mfa.qr)}" alt="QR code à scanner avec l'application de codes"></div>
      <p class="note">Sur ce téléphone, sans pouvoir scanner : <a class="lien" href="${echapper(etat.mfa.uri)}">ouvrir dans l'application de codes</a>, ou saisis cette clé à la main.</p>
      <p class="cle">${echapper(etat.mfa.secret)}</p>
      ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
      ${champCode()}
      <button class="bouton" type="submit" ${etat.occupe ? "disabled" : ""}>${etat.occupe ? "Vérification…" : "Activer"}</button>
      <button class="lien" type="button" data-action="abandonner-2fa">Plus tard</button>
    </form>`;
}

function entete() {
  const i = etat.listeMois.indexOf(etat.mois);
  return `
    <header class="entete">
      <h1>${etat.mois ? libelleMois(etat.mois) : "Finances"}</h1>
      <div class="actions">
        <button class="icone" data-action="mois" data-decalage="-1" aria-label="Mois précédent" ${i <= 0 ? "disabled" : ""}>${ICONES.precedent}</button>
        <button class="icone" data-action="mois" data-decalage="1" aria-label="Mois suivant" ${i >= etat.listeMois.length - 1 ? "disabled" : ""}>${ICONES.suivant}</button>
        <button class="icone" data-action="masquer" aria-label="${etat.masque ? "Afficher les montants" : "Masquer les montants"}" aria-pressed="${etat.masque}">${etat.masque ? ICONES.oeilBarre : ICONES.oeil}</button>
        <button class="icone" data-action="deconnexion" aria-label="Se déconnecter">${ICONES.sortir}</button>
      </div>
    </header>
    <div class="sous-entete">
      <div class="bascule" role="group" aria-label="Découpage">
        <button class="${etat.mode === "mois" ? "actif" : ""}" data-action="mode" data-mode="mois">Par mois</button>
        <button class="${etat.mode === "paie" ? "actif" : ""}" data-action="mode" data-mode="paie">Par paie</button>
      </div>
      <span class="dates">${echapper(datesPeriode())}</span>
    </div>`;
}

// « 28 août → 28 sept. · 32 jours » pour une période de paie
function datesPeriode() {
  const p = etat.flux.get(etat.mois);
  if (etat.mode !== "paie" || !p?.est_periode_de_paie) return "";
  return p.en_cours
    ? `Depuis le ${jourEnLettres(p.debut)} · ${p.nb_jours} jours`
    : `${jourEnLettres(p.debut)} → ${jourEnLettres(p.fin)} · ${p.nb_jours} jours`;
}

function ecranSynthese() {
  const t = totaux();
  const categories = etat.masque ? parCategorie().sort((a, b) => a[0].localeCompare(b[0], "fr")) : parCategorie();
  const max = Math.max(0, ...categories.map(([, montant]) => montant));
  const nb = aClasser().length;
  const periode = etat.flux.get(etat.mois);
  const parJour = etat.mode === "paie" && periode?.est_periode_de_paie && periode.nb_jours > 0
    ? `<p class="par-jour">Dépense moyenne : ${eurosRonds.format(t.sorties / periode.nb_jours)} par jour</p>` : "";

  return `
    <div class="chiffres">
      <div class="chiffre"><div class="nom">Entrées</div><div class="valeur">${eurosRonds.format(t.entrees)}</div></div>
      <div class="chiffre"><div class="nom">Dépenses</div><div class="valeur">${eurosRonds.format(t.sorties)}</div></div>
      <div class="chiffre"><div class="nom">Solde</div><div class="valeur ${t.solde >= 0 ? "positif" : "negatif"}">${t.solde >= 0 ? "+" : ""}${eurosRonds.format(t.solde)}</div></div>
    </div>
    ${parJour}
    ${etat.salairePrecedent ? `<button class="bandeau info" data-action="mode" data-mode="paie"><span>Ton salaire de ${eurosRonds.format(etat.salairePrecedent.montant)} a été versé le ${jourEnLettres(etat.salairePrecedent.date_operation)} : il compte dans le mois précédent. Voir de salaire à salaire</span>${ICONES.suivant.replace("<svg", '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"')}</button>` : ""}
    ${nb ? `<button class="bandeau" data-action="onglet" data-onglet="a-classer"><span>${nb} opération${nb > 1 ? "s" : ""} à classer</span>${ICONES.suivant.replace("<svg", '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"')}</button>` : ""}
    ${carteAVenir()}
    <h2 class="titre-section ${paiementsAVenir().length ? "espace" : ""}">Dépenses par catégorie</h2>
    ${categories.length ? `<div class="carte">${categories.map(([nom, montant]) => `
      <button class="ligne-cat" data-action="filtrer" data-categorie="${echapper(nom)}">
        <div class="haut"><span>${echapper(nom)}</span><span>${eurosRonds.format(montant)}</span></div>
        <div class="jauge ${nom === A_CLASSER ? "a-classer" : ""}"><div style="width:${max ? Math.max(2, Math.round((montant / max) * 100)) : 0}%"></div></div>
      </button>`).join("")}</div>` : `<p class="vide">Aucune dépense ce mois-ci.</p>`}
    ${carteVariation()}
    ${etat.comptesCourants.length ? `
    <h2 class="titre-section espace">Comptes courants d'associé</h2>
    <div class="carte">${etat.comptesCourants.map((c) => {
      const connu = c.solde !== null;
      const valeur = Number(connu ? c.solde : c.net);
      const etiquette = etat.masque ? "net" : connu ? (valeur >= 0 ? "te doit" : "trop perçu") : (valeur >= 0 ? "net apporté" : "net reçu");
      return `
      <button class="ligne-compte" data-action="societe" data-societe="${echapper(c.societe)}">
        <span><span class="nom">${echapper(c.societe)}</span><span class="detail">${eurosRonds.format(c.apports)} apportés · ${eurosRonds.format(c.remboursements)} remboursés</span></span>
        <span class="du">${etiquette} <strong>${eurosRonds.format(Math.abs(valeur))}</strong></span>
      </button>`;
    }).join("")}
      <p class="note">Hors budget. Mouvements depuis ${etat.comptesCourants[0].historique_depuis ? libelleMois(etat.comptesCourants[0].historique_depuis).toLowerCase() : "le début de l'historique"} seulement : ce n'est pas le solde réel du compte courant, les apports antérieurs manquent.</p>
    </div>` : ""}
    ${etat.emprunts && Number(etat.emprunts.nb_mouvements) > 0 ? `
    <h2 class="titre-section espace">Emprunts à des proches</h2>
    <div class="carte">
      <div class="ligne-compte fixe">
        <span><span class="nom">Toutes dates confondues</span><span class="detail">${eurosRonds.format(etat.emprunts.emprunte)} empruntés · ${eurosRonds.format(etat.emprunts.rembourse)} remboursés</span></span>
        <span class="du">${etat.masque ? "solde" : Number(etat.emprunts.reste_du) > 0 ? "reste dû" : Number(etat.emprunts.reste_du) < 0 ? "trop remboursé" : "soldé"} <strong>${eurosRonds.format(Math.abs(etat.emprunts.reste_du))}</strong></span>
      </div>
      <p class="note">Hors budget. Un prêt se marque « Emprunt » sur le virement reçu, et chaque mensualité se classe en « Remboursement d'emprunt ».</p>
    </div>` : ""}`;
}

function colonnes(mois, valeurs, max, etiquette) {
  return mois.map((m, i) => {
    const [annee, numero] = m.split("-");
    const barres = valeurs(i).map(([classe, v]) => `<div class="barre ${classe}" style="height:${v > 0 ? Math.max(2, Math.round((v / max) * 130)) : 0}px"></div>`).join("");
    return `
      <button class="colonne ${m === etat.mois ? "choisie" : ""}" data-action="choisir-mois" data-mois="${m}" aria-label="${echapper(`${libelleMois(m)} : ${etiquette(i)}`)}">
        <div class="barres">${barres}</div>
        <span>${MOIS_COURTS[Number(numero) - 1]}</span>
        <span class="annee">${numero === "01" || i === 0 ? annee : "&nbsp;"}</span>
      </button>`;
  }).join("");
}

function ecranEvolution() {
  const mois = fenetre12();
  if (etat.cleEvolution === null) return `<p class="chargement">Chargement…</p>`;

  const flux = mois.map((m) => etat.flux.get(m) ?? { entrees: 0, depenses: 0, solde: 0 });
  const maxFlux = Math.max(1, ...flux.flatMap((f) => [f.entrees, f.depenses]));
  const n = mois.length;
  const total = (cle) => flux.reduce((s, f) => s + f[cle], 0);
  const soldeCumule = total("solde");

  // Catégories de la fenêtre, de la plus lourde à la plus légère
  const parCat = new Map();
  for (const l of etat.depensesMensuelles) parCat.set(l.categorie, (parCat.get(l.categorie) ?? 0) + l.montant);
  const categories = [...parCat.entries()]
    .sort((a, b) => (etat.masque ? a[0].localeCompare(b[0], "fr") : b[1] - a[1]))
    .map(([nom]) => nom);
  if (!categories.includes(etat.categorieEvolution)) etat.categorieEvolution = categories[0] ?? null;
  const cat = etat.categorieEvolution;
  const serie = mois.map((m) => etat.depensesMensuelles.find((l) => l.mois === m && l.categorie === cat)?.montant ?? 0);
  const maxCat = Math.max(1, ...serie);
  const moyenneCat = serie.reduce((s, v) => s + v, 0) / n;
  const moisChoisi = mois.indexOf(etat.mois);

  return `
    <h2 class="titre-section">Entrées et dépenses sur ${n} mois</h2>
    <div class="carte">
      <div class="graphe">${colonnes(mois, (i) => [["entree", flux[i].entrees], ["depense", flux[i].depenses]], maxFlux, (i) => `entrées ${eurosRonds.format(flux[i].entrees)}, dépenses ${eurosRonds.format(flux[i].depenses)}`)}</div>
      <div class="legende"><span><i class="point entree"></i>Entrées</span><span><i class="point depense"></i>Dépenses</span></div>
    </div>
    <div class="chiffres sous-graphe">
      <div class="chiffre"><div class="nom">Entrées moy.</div><div class="valeur">${eurosRonds.format(total("entrees") / n)}</div></div>
      <div class="chiffre"><div class="nom">Dépenses moy.</div><div class="valeur">${eurosRonds.format(total("depenses") / n)}</div></div>
      <div class="chiffre"><div class="nom">Solde cumulé</div><div class="valeur ${soldeCumule >= 0 ? "positif" : "negatif"}">${soldeCumule >= 0 ? "+" : ""}${eurosRonds.format(soldeCumule)}</div></div>
    </div>

    <h2 class="titre-section">Une catégorie dans le temps</h2>
    ${cat ? `
    <div class="carte">
      <select class="choix" id="categorie-evolution" aria-label="Catégorie à suivre">
        ${categories.map((c) => `<option value="${echapper(c)}" ${c === cat ? "selected" : ""}>${echapper(c)}</option>`).join("")}
      </select>
      <div class="graphe simple">${colonnes(mois, (i) => [[cat === A_CLASSER ? "a-classer" : "depense", serie[i]]], maxCat, (i) => eurosRonds.format(serie[i]))}</div>
      <div class="resume">
        <span>${libelleMois(etat.mois)} : <strong>${eurosRonds.format(serie[moisChoisi] ?? 0)}</strong></span>
        <span>Moyenne : ${eurosRonds.format(moyenneCat)} / mois</span>
      </div>
      <button class="bouton secondaire" data-action="filtrer" data-categorie="${echapper(cat)}">Voir les opérations de ${libelleMois(etat.mois).toLowerCase()}</button>
    </div>` : `<p class="vide">Aucune dépense sur la période.</p>`}`;
}

// Dernier jour de la période affichée si elle est en cours, sinon null (pas de prévision sur le passé)
function horizonPrevisions() {
  const jour = aujourdhui();
  const p = etat.flux.get(etat.mois);
  if (etat.mode === "paie" && p?.est_periode_de_paie) {
    if (!p.en_cours) return null;
    const fin = veilleMoisSuivant(p.debut);
    // Salaire en retard par rapport au mois dernier : on regarde une semaine devant
    return fin >= jour ? fin : ajouterJours(jour, 7);
  }
  return etat.mois === `${jour.slice(0, 7)}-01` ? finDeMois(etat.mois) : null;
}

const paiementsAVenir = () => {
  const horizon = horizonPrevisions();
  return horizon ? etat.aVenir.filter((a) => a.date_prevue <= horizon) : [];
};

// Paiements attendus d'ici la fin de la période, et solde une fois qu'ils seront passés
function carteAVenir() {
  const horizon = horizonPrevisions();
  const liste = paiementsAVenir();
  if (!horizon || !liste.length) return "";

  const jour = aujourdhui();
  const reste = liste.reduce((s, a) => s + Number(a.montant), 0);
  const resteBudget = liste.filter((a) => a.type_flux === "depense").reduce((s, a) => s + Number(a.montant), 0);
  const projete = totaux().solde - resteBudget;

  return `
    <h2 class="titre-section">À venir d'ici le ${jourEnLettres(horizon)}</h2>
    <div class="carte">${liste.map((a) => `
      <button class="ligne-venir" data-action="ouvrir-a-venir" data-index="${etat.aVenir.indexOf(a)}">
        <span><span class="nom">${echapper(libelleCourt(a.libelle))}</span><span class="detail">${a.date_prevue < jour ? "attendu le" : "le"} ${jourEnLettres(a.date_prevue)} · ${a.source === "echeancier" ? `mensualité ${echapper(a.detail)}` : "chaque mois"}</span></span>
        <span class="montant">-${euros.format(a.montant)}</span>
      </button>`).join("")}
      <div class="ligne-hors fixe total"><span>Reste à payer</span><span>-${eurosRonds.format(reste)}</span></div>
      <div class="ligne-hors fixe"><span>Solde projeté</span><span class="${projete >= 0 ? "positif" : "negatif"}">${projete >= 0 ? "+" : "-"}${eurosRonds.format(Math.abs(projete))}</span></div>
      <p class="note">Prévision des paiements réguliers et des mensualités déclarées. Les dépenses variables (courses, sorties) n'y sont pas. Une ligne disparaît quand le paiement passe sur le compte.</p>
    </div>`;
}

function ficheAVenir() {
  const a = etat.aVenir[etat.ficheAVenir];
  if (!a) return "";
  return `
    <div class="voile" data-action="fermer">
      <section class="fiche" role="dialog" aria-modal="true" aria-label="Paiement à venir">
        <div class="tete">
          <h2>${echapper(libelleCourt(a.libelle))}</h2>
          <button class="icone" data-action="fermer" aria-label="Fermer">${ICONES.fermer}</button>
        </div>
        <p class="sous">Prévu le ${jourEnLettres(a.date_prevue)} · ${a.source === "echeancier" ? `mensualité ${echapper(a.detail)}` : "paiement régulier, repéré dans ton historique"}</p>
        <p class="gros">${euros.format(a.montant)}</p>
        ${a.source === "echeancier"
          ? `<p class="note">Calculé à partir de la première mensualité. Il disparaîtra quand un paiement du même montant au même commerçant passera sur le compte.</p>
             <button class="bouton secondaire" data-action="retirer-echeancier">Ce n'est plus un paiement en plusieurs fois</button>`
          : `<p class="note">Même montant que le mois dernier, un mois plus tard. Si ce paiement s'est arrêté (abonnement résilié, prêt soldé), retire-le des prévisions.</p>
             <button class="bouton secondaire" data-action="ignorer-recurrent">Ne plus prévoir ce paiement</button>`}
      </section>
    </div>`;
}

// Du solde du budget à ce que le compte a réellement gagné ou perdu, tous mouvements confondus
function carteVariation() {
  const signe = (o) => (o.sens === "entree" ? 1 : -1);
  const somme = (type, sens) => etat.operations
    .filter((o) => o.type_flux === type && o.sens === sens)
    .reduce((s, o) => s + Number(o.montant), 0);
  const t = totaux();

  const lignes = [
    ["Épargne mise de côté", "epargne", "sortie"],
    ["Désépargne", "desepargne", "entree"],
    ["Apports en compte courant", "compte_courant", "sortie"],
    ["Remboursements de compte courant", "compte_courant", "entree"],
    ["Emprunts reçus", "emprunt", "entree"],
    ["Remboursements d'emprunt", "emprunt", "sortie"],
    ["Remboursements reçus", "remboursement", "entree"],
    ["Virements internes reçus", "virement_interne", "entree"],
    ["Virements internes émis", "virement_interne", "sortie"],
  ].map(([nom, type, sens]) => ({ nom, type, sens, montant: somme(type, sens) })).filter((l) => l.montant > 0);

  // Les dépenses ramenées à ta part ont quand même été débitées en entier
  const avance = depenses().reduce((s, o) => s + Number(o.montant_original) - Number(o.montant), 0);
  // Ce que le compte a réellement gagné ou perdu : toutes les opérations, à leur montant débité ou crédité
  const variation = etat.operations.reduce((s, o) => s + signe(o) * Number(o.montant_original), 0);
  const montantSigne = (v) => `${v >= 0 ? "+" : "-"}${eurosRonds.format(Math.abs(v))}`;

  return `
    <h2 class="titre-section espace">Variation du compte</h2>
    <div class="carte">
      <div class="ligne-hors fixe"><span>Solde du budget</span><span>${montantSigne(t.solde)}</span></div>
      ${avance > 0.005 ? `<div class="ligne-hors fixe"><span>Avancé pour d'autres ou remboursé</span><span>${montantSigne(-avance)}</span></div>` : ""}
      ${lignes.map((l) => `
      <button class="ligne-hors" data-action="filtrer-type" data-type="${l.type}" data-sens="${l.sens}" data-nom="${echapper(l.nom)}">
        <span>${echapper(l.nom)}</span><span>${montantSigne(l.sens === "entree" ? l.montant : -l.montant)}</span>
      </button>`).join("")}
      <div class="ligne-hors fixe total"><span>${etat.masque ? "Variation du compte" : `Ton compte a ${variation >= 0 ? "gagné" : "perdu"}`}</span><span class="${variation >= 0 ? "positif" : "negatif"}">${montantSigne(variation)}</span></div>
      <p class="note">Le solde du budget dit si tu as dépensé plus que tes revenus. La variation du compte ajoute tout le reste : épargne, emprunts, comptes courants, remboursements.</p>
    </div>`;
}

function ligneOperation(o) {
  const signe = o.sens === "entree" ? "+" : "-";
  let etiquette = "";
  if (o.type_flux === "depense") {
    etiquette = `<span class="etiquette ${o.categorie === A_CLASSER ? "a-classer" : ""}">${echapper(o.categorie === A_CLASSER ? "À classer" : o.categorie)}</span>`;
  } else if (o.type_flux !== "entree") {
    etiquette = `<span class="etiquette">${echapper(TYPES[o.type_flux] ?? o.type_flux)}</span>`;
  } else if (o.a_qualifier) {
    etiquette = `<span class="etiquette a-classer">À qualifier</span>`;
  } else if (o.nature_entree) {
    etiquette = `<span class="etiquette">${echapper(NATURES[o.nature_entree] ?? o.nature_entree)}</span>`;
  }
  return `
    <button class="operation" data-action="ouvrir" data-id="${o.transaction_id}">
      <div class="texte">
        <div class="libelle">${echapper(o.libelle)}</div>
        <div class="detail"><span>${etat.societe ? o.date_operation.split("-").reverse().join("/") : jourMois(o.date_operation)}</span>${etiquette}${o.est_ajustee ? '<span class="etiquette">Ajustée</span>' : ""}</div>
      </div>
      <div class="montant ${o.type_flux === "entree" ? "positif" : ""}">${signe}${euros.format(o.montant)}</div>
    </button>`;
}

function ecranOperations() {
  const q = etat.recherche.trim().toLowerCase();
  let liste = etat.societe ? etat.mouvementsSociete : etat.operations;
  if (etat.filtreCategorie) liste = liste.filter((o) => o.type_flux === "depense" && o.categorie === etat.filtreCategorie);
  if (etat.filtreType) liste = liste.filter((o) => o.type_flux === etat.filtreType.type && o.sens === etat.filtreType.sens);
  if (q) liste = liste.filter((o) => o.libelle.toLowerCase().includes(q));

  return `
    <input class="recherche" id="recherche" type="search" placeholder="Leclerc, SNCF, café" aria-label="Rechercher une opération" value="${echapper(etat.recherche)}">
    ${etat.societe ? `<div class="filtre"><span>Compte courant · ${echapper(etat.societe)} · toutes dates</span><button data-action="societe" data-societe="">Revenir au mois</button></div>` : ""}
    ${etat.filtreType ? `<div class="filtre"><span>${echapper(etat.filtreType.nom)}</span><button data-action="filtrer" data-categorie="">Tout afficher</button></div>` : ""}
    ${etat.filtreCategorie ? `<div class="filtre"><span>${echapper(etat.filtreCategorie)}</span><button data-action="filtrer" data-categorie="">Tout afficher</button></div>` : ""}
    ${liste.length ? `<div class="operations">${liste.map(ligneOperation).join("")}</div>` : `<p class="vide">Aucune opération ne correspond.</p>`}`;
}

function ecranAClasser() {
  // Les entrées à qualifier d'abord, puis les dépenses de la plus grosse à la plus petite
  const liste = aClasser().sort((a, b) => (b.a_qualifier ? 1 : 0) - (a.a_qualifier ? 1 : 0) || Number(b.montant) - Number(a.montant));
  return liste.length
    ? `<div class="operations">${liste.map(ligneOperation).join("")}</div>`
    : `<p class="vide">Tout est classé pour ${libelleMois(etat.mois).toLowerCase()}.</p>`;
}

function ficheOperation() {
  const o = [...etat.operations, ...etat.mouvementsSociete].find((x) => x.transaction_id === etat.fiche);
  if (!o) return "";
  // L'épargne se classe et s'ajuste comme une dépense : c'est sa catégorie qui la sort du budget
  const estDepense = o.sens === "sortie" && ["depense", "epargne", "emprunt"].includes(o.type_flux);
  // Toute entrée d'argent peut être qualifiée, sauf un virement entre tes propres comptes
  const estQualifiable = o.sens === "entree" && o.type_flux !== "virement_interne";
  const type = TYPES[o.type_flux] ?? o.type_flux;
  const boutonsNature = (liste) => liste.map((valeur) => `
            <button class="categorie ${valeur === o.nature_entree ? "choisie" : ""}" data-action="qualifier" data-nature="${valeur}">${NATURES[valeur]}</button>`).join("");

  return `
    <div class="voile" data-action="fermer">
      <section class="fiche" role="dialog" aria-modal="true" aria-label="Détail de l'opération">
        <div class="tete">
          <h2>${echapper(o.libelle)}</h2>
          <button class="icone" data-action="fermer" aria-label="Fermer">${ICONES.fermer}</button>
        </div>
        <p class="sous">${type} du ${jourMois(o.date_operation)}${o.date_effective !== o.date_operation ? ` · comptée en ${libelleMois(o[cle()]).toLowerCase()}` : ""}</p>
        <p class="gros">${euros.format(o.montant)}</p>
        ${o.est_ajustee ? `<p class="note">Montant d'origine : ${euros.format(o.montant_original)}</p>` : ""}

        ${estDepense ? `
          <h3>Catégorie</h3>
          <div class="categories">${etat.categories.filter((c) => c !== A_CLASSER).map((c) => `
            <button class="categorie ${c === o.categorie ? "choisie" : ""}" data-action="classer" data-categorie="${echapper(c)}">${echapper(c)}</button>`).join("")}
          </div>
          ${o.est_recategorisee ? `<button class="lien" data-action="annuler-classement">Revenir à la catégorie automatique</button>` : ""}

          <h3>Montant réel</h3>
          <form class="ajustement" id="ajustement">
            <input type="text" name="montant" inputmode="decimal" placeholder="${etat.masque ? "Montant" : String(o.montant_original).replace(".", ",")}" aria-label="Montant réel en euros">
            <button class="bouton" type="submit">Ajuster</button>
          </form>
          <p class="note">Pour une dépense partagée ou remboursée en partie. Le montant d'origine est conservé.</p>
          ${o.est_ajustee ? `<button class="lien" data-action="annuler-ajustement">Annuler l'ajustement</button>` : ""}

          <h3>Paiement en plusieurs fois</h3>
          <div class="fois">${[2, 3, 4, 6, 10, 12].map((n) => `
            <button class="categorie ${o.nb_echeances === n ? "choisie" : ""}" data-action="echeancier" data-nombre="${n}">${n} fois</button>`).join("")}
          </div>
          <p class="note">À indiquer sur la première mensualité. Les suivantes sont prévues au même montant, un mois plus tard chacune, dans « À venir ».</p>
          ${o.nb_echeances ? `<button class="lien" data-action="annuler-echeancier">Ce n'est pas un paiement en plusieurs fois</button>` : ""}
        ` : estQualifiable ? `
          <h3>C'est un revenu</h3>
          <div class="categories">${boutonsNature(NATURES_REVENU)}</div>
          <p class="note">Compté dans tes entrées. Un salaire ouvre une nouvelle période de paie.</p>
          <h3>Ce n'est pas un revenu</h3>
          <div class="categories">${boutonsNature(NATURES_HORS_BUDGET)}</div>
          <p class="note">Hors budget : argent que tu récupères (apport remboursé par une société, retrait d'épargne, avance remboursée par un proche) ou que tu devras rendre (emprunt).</p>
          ${o.nature_entree ? `<button class="lien" data-action="annuler-qualification">Retirer la nature</button>` : ""}
        ` : o.type_flux === "compte_courant" ? `<p class="note">Apport en compte courant${o.societe ? ` à ${echapper(o.societe)}` : ""} : hors budget, suivi dans les comptes courants d'associé.</p>`
          : `<p class="note">Virement entre tes comptes : il ne compte ni dans les entrées ni dans les dépenses.</p>`}
      </section>
    </div>`;
}

function barreOnglets() {
  const nb = aClasser().length;
  const onglet = (id, nom) => `
    <button class="onglet ${etat.onglet === id ? "actif" : ""}" data-action="onglet" data-onglet="${id}">
      ${ICONES[id]}<span>${nom}</span>${id === "a-classer" && nb ? `<span class="pastille">${nb}</span>` : ""}
    </button>`;
  return `<nav class="onglets"><div class="interieur">${onglet("synthese", "Synthèse")}${onglet("evolution", "Évolution")}${onglet("operations", "Opérations")}${onglet("a-classer", "À classer")}</div></nav>`;
}

function rendre() {
  if (!etat.session) { racine.innerHTML = ecranConnexion(); return; }
  if (etat.ecran === "code") { racine.innerHTML = ecranCode(); return; }
  if (etat.ecran === "activation") { racine.innerHTML = ecranActivation(); return; }

  // Conserver la saisie en cours dans la recherche lors d'un nouveau rendu
  const rechercheActive = document.activeElement?.id === "recherche";

  const corps = { synthese: ecranSynthese, evolution: ecranEvolution, operations: ecranOperations, "a-classer": ecranAClasser }[etat.onglet]();
  racine.classList.toggle("masque", etat.masque);
  const html = `
    ${entete()}
    ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
    ${corps}
    ${barreOnglets()}
    ${etat.fiche !== null ? ficheOperation() : ""}
    ${etat.ficheAVenir !== null ? ficheAVenir() : ""}
    ${etat.message ? `<div class="message" role="status">${echapper(etat.message)}</div>` : ""}`;
  // Montants masqués : on retire aussi le signe, qui dirait si le solde est positif ou négatif
  racine.innerHTML = etat.masque ? html.replace(/[+-](?=XXX €)/g, "") : html;

  if (rechercheActive) {
    const champ = document.getElementById("recherche");
    champ.focus();
    champ.setSelectionRange(champ.value.length, champ.value.length);
  }
}

// ── Masquage des montants ──────────────────────────────────────────────────────
function basculerMasque() {
  etat.masque = !etat.masque;
  try { localStorage.setItem("masque", etat.masque ? "1" : "0"); } catch { /* le choix vaut pour cette session */ }
  rendre();
}

// Deux secousses rapprochées du téléphone masquent ou réaffichent les montants.
// Sur iPhone, l'accès aux mouvements doit être autorisé après un geste : on le demande
// au premier appui sur le bouton œil.
const secousse = { ecoute: false, dernier: null, instants: [] };

function surMouvement(evenement) {
  const a = evenement.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const precedent = secousse.dernier;
  secousse.dernier = { x: a.x, y: a.y, z: a.z };
  if (!precedent) return;

  const variation = Math.abs(a.x - precedent.x) + Math.abs(a.y - precedent.y) + Math.abs(a.z - precedent.z);
  const maintenant = Date.now();
  // Une secousse franche, comptée une seule fois même si elle dure quelques mesures
  if (variation < 28 || maintenant - (secousse.instants.at(-1) ?? 0) < 300) return;

  secousse.instants = [...secousse.instants.filter((t) => maintenant - t < 1500), maintenant];
  if (secousse.instants.length >= 2) {
    secousse.instants = [];
    basculerMasque();
  }
}

async function activerSecousse() {
  if (secousse.ecoute || typeof DeviceMotionEvent === "undefined") return;
  try {
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      if ((await DeviceMotionEvent.requestPermission()) !== "granted") return;
    }
    window.addEventListener("devicemotion", surMouvement);
    secousse.ecoute = true;
    try { localStorage.setItem("secousse", "1"); } catch { /* sans importance */ }
  } catch (e) {
    console.error(e);
  }
}
// Android et navigateurs sans demande d'autorisation : actif tout de suite
if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission !== "function") activerSecousse();

// iPhone : l'autorisation est redemandée à chaque lancement de l'application. Si la secousse a
// déjà été activée une fois, on la réactive au premier appui, où qu'il soit.
document.addEventListener("click", () => {
  let dejaActivee = false;
  try { dejaActivee = localStorage.getItem("secousse") === "1"; } catch { /* sans importance */ }
  if (dejaActivee) activerSecousse();
}, { once: true });

// ── Interactions ───────────────────────────────────────────────────────────────
racine.addEventListener("click", async (evenement) => {
  const cible = evenement.target.closest("[data-action]");
  if (!cible) return;
  // Un clic dans la fiche ne doit pas la fermer via le voile
  if (cible.dataset.action === "fermer" && cible.classList.contains("voile") && evenement.target !== cible) return;

  switch (cible.dataset.action) {
    case "onglet":
      etat.onglet = cible.dataset.onglet;
      if (etat.onglet !== "operations") { etat.filtreCategorie = null; etat.filtreType = null; etat.societe = null; etat.mouvementsSociete = []; }
      window.scrollTo(0, 0);
      rendre();
      if (etat.onglet === "evolution") {
        try { await chargerEvolution(); } catch (e) { etat.erreur = "Impossible de charger l'évolution."; console.error(e); }
        rendre();
      }
      break;
    case "choisir-mois":
      if (cible.dataset.mois !== etat.mois) {
        etat.mois = cible.dataset.mois;
        await afficherMois();
      }
      break;
    case "mois":
      await changerMois(Number(cible.dataset.decalage));
      break;
    case "filtrer-type":
      Object.assign(etat, { societe: null, mouvementsSociete: [], filtreCategorie: null, recherche: "", onglet: "operations" });
      etat.filtreType = { type: cible.dataset.type, sens: cible.dataset.sens, nom: cible.dataset.nom };
      window.scrollTo(0, 0);
      rendre();
      break;
    case "filtrer":
      etat.societe = null;
      etat.mouvementsSociete = [];
      etat.filtreType = null;
      etat.filtreCategorie = cible.dataset.categorie || null;
      etat.onglet = "operations";
      etat.recherche = "";
      window.scrollTo(0, 0);
      rendre();
      break;
    case "societe":
      etat.societe = cible.dataset.societe || null;
      etat.mouvementsSociete = [];
      etat.filtreCategorie = null;
      etat.filtreType = null;
      etat.recherche = "";
      if (etat.societe) {
        etat.onglet = "operations";
        try { await chargerComptesCourants(); } catch (e) { etat.erreur = "Impossible de charger les mouvements."; console.error(e); }
      }
      window.scrollTo(0, 0);
      rendre();
      break;
    case "ouvrir":
      etat.fiche = Number(cible.dataset.id);
      rendre();
      break;
    case "fermer":
      etat.fiche = null;
      etat.ficheAVenir = null;
      rendre();
      break;
    case "ouvrir-a-venir":
      etat.ficheAVenir = Number(cible.dataset.index);
      rendre();
      break;
    case "ignorer-recurrent": {
      const a = etat.aVenir[etat.ficheAVenir];
      etat.ficheAVenir = null;
      await enregistrer("ignorer_recurrent", { p_cle: a.cle }, "Paiement retiré des prévisions");
      break;
    }
    case "retirer-echeancier": {
      const a = etat.aVenir[etat.ficheAVenir];
      etat.ficheAVenir = null;
      await enregistrer("annuler_echeancier", { p_transaction_id: a.transaction_id }, "Paiement en plusieurs fois retiré");
      break;
    }
    case "echeancier": {
      const nombre = Number(cible.dataset.nombre);
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("declarer_echeancier", { p_transaction_id: id, p_nombre: nombre }, `Paiement en ${nombre} fois enregistré`);
      break;
    }
    case "annuler-echeancier": {
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("annuler_echeancier", { p_transaction_id: id }, "Paiement en plusieurs fois retiré");
      break;
    }
    case "classer": {
      const categorie = cible.dataset.categorie;
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("classer_operation", { p_transaction_id: id, p_categorie: categorie }, `Classée dans ${categorie}`);
      break;
    }
    case "annuler-classement": {
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("annuler_classement", { p_transaction_id: id }, "Catégorie automatique rétablie");
      break;
    }
    case "annuler-ajustement": {
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("annuler_ajustement", { p_transaction_id: id }, "Ajustement annulé");
      break;
    }
    case "qualifier": {
      const nature = cible.dataset.nature;
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("qualifier_entree", { p_transaction_id: id, p_nature: nature }, `Entrée marquée : ${NATURES[nature].toLowerCase()}`);
      break;
    }
    case "annuler-qualification": {
      const id = etat.fiche;
      etat.fiche = null;
      await enregistrer("annuler_qualification", { p_transaction_id: id }, "Nature retirée");
      break;
    }
    case "mode":
      if (cible.dataset.mode !== etat.mode) {
        etat.mode = cible.dataset.mode;
        try { localStorage.setItem("mode", etat.mode); } catch { /* stockage indisponible : le choix vaut pour cette session */ }
        Object.assign(etat, { filtreCategorie: null, filtreType: null, cleEvolution: null, finFenetre: null, fiche: null });
        await toutCharger();
        if (etat.onglet === "evolution") {
          try { await chargerEvolution(); } catch (e) { etat.erreur = "Impossible de charger l'évolution."; console.error(e); }
          rendre();
        }
      }
      break;
    case "activer-2fa":
      await demarrerActivation();
      break;
    case "abandonner-2fa":
      await abandonnerActivation();
      break;
    case "masquer":
      basculerMasque();
      activerSecousse();
      break;
    case "deconnexion":
      await sb.auth.signOut();
      break;
  }
});

racine.addEventListener("input", (evenement) => {
  if (evenement.target.id !== "recherche") return;
  etat.recherche = evenement.target.value;
  rendre();
});

racine.addEventListener("change", (evenement) => {
  if (evenement.target.id !== "categorie-evolution") return;
  etat.categorieEvolution = evenement.target.value;
  rendre();
});

racine.addEventListener("submit", async (evenement) => {
  evenement.preventDefault();
  const formulaire = evenement.target;

  if (formulaire.id === "connexion") {
    const donnees = new FormData(formulaire);
    etat.occupe = true;
    etat.erreur = null;
    const { error } = await sb.auth.signInWithPassword({ email: donnees.get("email"), password: donnees.get("password") });
    etat.occupe = false;
    if (error) {
      etat.erreur = "E-mail ou mot de passe incorrect.";
      rendre();
    }
    return;
  }

  if (formulaire.id === "code" || formulaire.id === "activation") {
    const code = lireCode(formulaire);
    if (code.length !== 6) {
      etat.erreur = "Le code comporte 6 chiffres.";
      rendre();
      return;
    }
    let factorId = etat.mfa?.factorId;
    if (formulaire.id === "code") {
      const { data } = await sb.auth.mfa.listFactors();
      factorId = data?.totp?.[0]?.id;
    }
    etat.occupe = true;
    const { error } = factorId
      ? await sb.auth.mfa.challengeAndVerify({ factorId, code })
      : { error: new Error("Aucun facteur") };
    etat.occupe = false;
    if (error) {
      etat.erreur = "Code incorrect ou expiré. Réessaie avec le code suivant.";
      rendre();
      return;
    }
    const activation = formulaire.id === "activation";
    etat.mfa = null;
    await apresConnexion();
    if (activation) afficherMessage("Double authentification activée");
    return;
  }

  if (formulaire.id === "ajustement") {
    const saisie = String(new FormData(formulaire).get("montant")).trim().replace(/\s/g, "").replace(",", ".");
    const montant = Number(saisie);
    if (saisie === "" || !Number.isFinite(montant) || montant < 0) {
      afficherMessage("Saisis un montant, par exemple 12,50");
      return;
    }
    const id = etat.fiche;
    etat.fiche = null;
    await enregistrer("ajuster_operation", { p_transaction_id: id, p_montant_reel: montant }, `Montant ajusté à ${euros.format(montant)}`);
  }
});

// ── Démarrage ──────────────────────────────────────────────────────────────────
sb.auth.onAuthStateChange((evenement, session) => {
  const etaitConnecte = Boolean(etat.session);
  etat.session = session;
  if (session && !etaitConnecte) {
    racine.innerHTML = '<p class="chargement">Chargement…</p>';
    // Hors du rappel d'authentification, pour ne pas bloquer le client Supabase
    setTimeout(apresConnexion, 0);
  } else if (!session) {
    Object.assign(etat, { operations: [], listeMois: [], mois: null, fiche: null, onglet: "synthese", ecran: null, mfa: null, doubleAuthActive: false, flux: new Map(), depensesMensuelles: [], finFenetre: null, cleEvolution: null });
    rendre();
  }
});
