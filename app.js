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
};
const NATURES_REVENU = ["salaire", "dividendes", "autre"];
const NATURES_HORS_BUDGET = ["compte_courant", "desepargne", "remboursement"];
const TYPES = {
  depense: "Dépense", entree: "Entrée", virement_interne: "Virement interne", epargne: "Épargne",
  compte_courant: "Compte courant d'associé", desepargne: "Désépargne", remboursement: "Remboursement reçu",
};

function lireMode() {
  try { return localStorage.getItem("mode") === "paie" ? "paie" : "mois"; } catch { return "mois"; }
}

const etat = {
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
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const eurosRonds = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

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
  const categories = parCategorie();
  const max = categories.length ? categories[0][1] : 0;
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
    ${nb ? `<button class="bandeau" data-action="onglet" data-onglet="a-classer"><span>${nb} opération${nb > 1 ? "s" : ""} à classer</span>${ICONES.suivant.replace("<svg", '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"')}</button>` : ""}
    <h2 class="titre-section">Dépenses par catégorie</h2>
    ${categories.length ? `<div class="carte">${categories.map(([nom, montant]) => `
      <button class="ligne-cat" data-action="filtrer" data-categorie="${echapper(nom)}">
        <div class="haut"><span>${echapper(nom)}</span><span>${eurosRonds.format(montant)}</span></div>
        <div class="jauge ${nom === A_CLASSER ? "a-classer" : ""}"><div style="width:${max ? Math.max(2, Math.round((montant / max) * 100)) : 0}%"></div></div>
      </button>`).join("")}</div>` : `<p class="vide">Aucune dépense ce mois-ci.</p>`}
    ${carteHorsBudget()}
    ${etat.comptesCourants.length ? `
    <h2 class="titre-section espace">Comptes courants d'associé</h2>
    <div class="carte">${etat.comptesCourants.map((c) => {
      const connu = c.solde !== null;
      const valeur = Number(connu ? c.solde : c.net);
      const etiquette = connu ? (valeur >= 0 ? "te doit" : "trop perçu") : (valeur >= 0 ? "net apporté" : "net reçu");
      return `
      <button class="ligne-compte" data-action="societe" data-societe="${echapper(c.societe)}">
        <span><span class="nom">${echapper(c.societe)}</span><span class="detail">${eurosRonds.format(c.apports)} apportés · ${eurosRonds.format(c.remboursements)} remboursés</span></span>
        <span class="du">${etiquette} <strong>${eurosRonds.format(Math.abs(valeur))}</strong></span>
      </button>`;
    }).join("")}
      <p class="note">Hors budget. Mouvements depuis ${etat.comptesCourants[0].historique_depuis ? libelleMois(etat.comptesCourants[0].historique_depuis).toLowerCase() : "le début de l'historique"} seulement : ce n'est pas le solde réel du compte courant, les apports antérieurs manquent.</p>
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
  const categories = [...parCat.entries()].sort((a, b) => b[1] - a[1]).map(([nom]) => nom);
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

// Ce qui a bougé sur le compte sans être une dépense ni un revenu
function carteHorsBudget() {
  const somme = (type, sens) => etat.operations
    .filter((o) => o.type_flux === type && (!sens || o.sens === sens))
    .reduce((s, o) => s + Number(o.montant), 0);
  const lignes = [
    ["Épargne mise de côté", "epargne", "sortie"],
    ["Désépargne", "desepargne", "entree"],
    ["Apports en compte courant", "compte_courant", "sortie"],
    ["Remboursements de compte courant", "compte_courant", "entree"],
    ["Remboursements reçus", "remboursement", "entree"],
  ].map(([nom, type, sens]) => ({ nom, type, sens, montant: somme(type, sens) })).filter((l) => l.montant > 0);
  if (!lignes.length) return "";

  // Repère : les remboursements reçus devraient correspondre aux dépenses ramenées à ta part
  const ajustements = depenses().filter((o) => o.est_ajustee).reduce((s, o) => s + Number(o.montant_original) - Number(o.montant), 0);
  const aDesRemboursements = lignes.some((l) => l.type === "remboursement");

  return `
    <h2 class="titre-section espace">Hors budget</h2>
    <div class="carte">${lignes.map((l) => `
      <button class="ligne-hors" data-action="filtrer-type" data-type="${l.type}" data-sens="${l.sens}" data-nom="${echapper(l.nom)}">
        <span>${echapper(l.nom)}</span><span>${l.sens === "entree" ? "+" : "-"}${eurosRonds.format(l.montant)}</span>
      </button>`).join("")}
      ${aDesRemboursements ? `<p class="note">Dépenses ramenées à ta part (« Montant réel ») : ${eurosRonds.format(ajustements)}.</p>` : ""}
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
  const estDepense = o.type_flux === "depense" || o.type_flux === "epargne";
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
            <input type="text" name="montant" inputmode="decimal" placeholder="${String(o.montant_original).replace(".", ",")}" aria-label="Montant réel en euros">
            <button class="bouton" type="submit">Ajuster</button>
          </form>
          <p class="note">Pour une dépense partagée ou remboursée en partie. Le montant d'origine est conservé.</p>
          ${o.est_ajustee ? `<button class="lien" data-action="annuler-ajustement">Annuler l'ajustement</button>` : ""}
        ` : estQualifiable ? `
          <h3>C'est un revenu</h3>
          <div class="categories">${boutonsNature(NATURES_REVENU)}</div>
          <p class="note">Compté dans tes entrées. Un salaire ouvre une nouvelle période de paie.</p>
          <h3>Ce n'est pas un revenu</h3>
          <div class="categories">${boutonsNature(NATURES_HORS_BUDGET)}</div>
          <p class="note">Hors budget : argent que tu récupères (apport remboursé par une société, retrait d'épargne, avance remboursée par un proche).</p>
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
  racine.innerHTML = `
    ${entete()}
    ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
    ${corps}
    ${barreOnglets()}
    ${etat.fiche !== null ? ficheOperation() : ""}
    ${etat.message ? `<div class="message" role="status">${echapper(etat.message)}</div>` : ""}`;

  if (rechercheActive) {
    const champ = document.getElementById("recherche");
    champ.focus();
    champ.setSelectionRange(champ.value.length, champ.value.length);
  }
}

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
      rendre();
      break;
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
