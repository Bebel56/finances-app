// Application finances : lit les vues du schéma public de Supabase et enregistre
// les recatégorisations / ajustements via les fonctions classer_operation, ajuster_operation…
// Les droits sont appliqués par la base : sans connexion, l'API refuse tout.

const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
const racine = document.getElementById("app");

const A_CLASSER = "Autres / Divers";
const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

const etat = {
  session: null,
  ecran: null,             // null (application) | "code" | "activation"
  doubleAuthActive: false,
  mfa: null,               // activation en cours : { factorId, qr, secret, uri }
  onglet: "synthese",      // synthese | operations | a-classer
  listeMois: [],           // "2026-09-01", du plus ancien au plus récent
  mois: null,
  operations: [],          // opérations du mois affiché
  categories: [],
  recherche: "",
  filtreCategorie: null,
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

function jourMois(date) {
  const [, m, j] = date.split("-");
  return `${j}/${m}`;
}

const ICONES = {
  synthese: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
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
async function chargerReferences() {
  const [flux, categories] = await Promise.all([
    sb.from("flux_mensuels").select("mois").order("mois"),
    sb.from("categories").select("categorie").order("categorie"),
  ]);
  if (flux.error) throw flux.error;
  if (categories.error) throw categories.error;

  etat.listeMois = flux.data.map((l) => l.mois);
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
    .eq("mois", etat.mois)
    .order("date_operation", { ascending: false })
    .order("transaction_id", { ascending: false });
  if (error) throw error;
  etat.operations = data;
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
  try { await chargerMois(); } catch (e) { etat.erreur = "Impossible de charger ce mois."; console.error(e); }
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
  await chargerMois();
  afficherMessage(messageOk);
}

// ── Calculs sur le mois affiché ────────────────────────────────────────────────
const depenses = () => etat.operations.filter((o) => o.type_flux === "depense");
const aClasser = () => depenses().filter((o) => o.categorie === A_CLASSER);

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
    </header>`;
}

function ecranSynthese() {
  const t = totaux();
  const categories = parCategorie();
  const max = categories.length ? categories[0][1] : 0;
  const nb = aClasser().length;

  return `
    <div class="chiffres">
      <div class="chiffre"><div class="nom">Entrées</div><div class="valeur">${eurosRonds.format(t.entrees)}</div></div>
      <div class="chiffre"><div class="nom">Dépenses</div><div class="valeur">${eurosRonds.format(t.sorties)}</div></div>
      <div class="chiffre"><div class="nom">Solde</div><div class="valeur ${t.solde >= 0 ? "positif" : "negatif"}">${t.solde >= 0 ? "+" : ""}${eurosRonds.format(t.solde)}</div></div>
    </div>
    ${nb ? `<button class="bandeau" data-action="onglet" data-onglet="a-classer"><span>${nb} opération${nb > 1 ? "s" : ""} à classer</span>${ICONES.suivant.replace("<svg", '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"')}</button>` : ""}
    <h2 class="titre-section">Dépenses par catégorie</h2>
    ${categories.length ? `<div class="carte">${categories.map(([nom, montant]) => `
      <button class="ligne-cat" data-action="filtrer" data-categorie="${echapper(nom)}">
        <div class="haut"><span>${echapper(nom)}</span><span>${eurosRonds.format(montant)}</span></div>
        <div class="jauge ${nom === A_CLASSER ? "a-classer" : ""}"><div style="width:${max ? Math.max(2, Math.round((montant / max) * 100)) : 0}%"></div></div>
      </button>`).join("")}</div>` : `<p class="vide">Aucune dépense ce mois-ci.</p>`}`;
}

function ligneOperation(o) {
  const signe = o.type_flux === "entree" ? "+" : o.type_flux === "depense" ? "-" : "";
  let etiquette = "";
  if (o.type_flux === "depense") {
    etiquette = `<span class="etiquette ${o.categorie === A_CLASSER ? "a-classer" : ""}">${echapper(o.categorie === A_CLASSER ? "À classer" : o.categorie)}</span>`;
  } else if (o.type_flux === "virement_interne") {
    etiquette = `<span class="etiquette">Virement interne</span>`;
  }
  return `
    <button class="operation" data-action="ouvrir" data-id="${o.transaction_id}">
      <div class="texte">
        <div class="libelle">${echapper(o.libelle)}</div>
        <div class="detail"><span>${jourMois(o.date_operation)}</span>${etiquette}${o.est_ajustee ? '<span class="etiquette">Ajustée</span>' : ""}</div>
      </div>
      <div class="montant ${o.type_flux === "entree" ? "positif" : ""}">${signe}${euros.format(o.montant)}</div>
    </button>`;
}

function ecranOperations() {
  const q = etat.recherche.trim().toLowerCase();
  let liste = etat.operations;
  if (etat.filtreCategorie) liste = liste.filter((o) => o.type_flux === "depense" && o.categorie === etat.filtreCategorie);
  if (q) liste = liste.filter((o) => o.libelle.toLowerCase().includes(q));

  return `
    <input class="recherche" id="recherche" type="search" placeholder="Leclerc, SNCF, café" aria-label="Rechercher une opération" value="${echapper(etat.recherche)}">
    ${etat.filtreCategorie ? `<div class="filtre"><span>${echapper(etat.filtreCategorie)}</span><button data-action="filtrer" data-categorie="">Tout afficher</button></div>` : ""}
    ${liste.length ? `<div class="operations">${liste.map(ligneOperation).join("")}</div>` : `<p class="vide">Aucune opération ne correspond.</p>`}`;
}

function ecranAClasser() {
  const liste = aClasser().sort((a, b) => Number(b.montant) - Number(a.montant));
  return liste.length
    ? `<div class="operations">${liste.map(ligneOperation).join("")}</div>`
    : `<p class="vide">Tout est classé pour ${libelleMois(etat.mois).toLowerCase()}.</p>`;
}

function ficheOperation() {
  const o = etat.operations.find((x) => x.transaction_id === etat.fiche);
  if (!o) return "";
  const estDepense = o.type_flux === "depense";
  const type = { depense: "Dépense", entree: "Entrée", virement_interne: "Virement interne" }[o.type_flux];

  return `
    <div class="voile" data-action="fermer">
      <section class="fiche" role="dialog" aria-modal="true" aria-label="Détail de l'opération">
        <div class="tete">
          <h2>${echapper(o.libelle)}</h2>
          <button class="icone" data-action="fermer" aria-label="Fermer">${ICONES.fermer}</button>
        </div>
        <p class="sous">${type} du ${jourMois(o.date_operation)}${o.date_effective !== o.date_operation ? ` · comptée en ${libelleMois(o.mois).toLowerCase()}` : ""}</p>
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
        ` : `<p class="note">${o.type_flux === "virement_interne" ? "Virement entre tes comptes : il ne compte ni dans les entrées ni dans les dépenses." : "Les entrées ne se classent pas."}</p>`}
      </section>
    </div>`;
}

function barreOnglets() {
  const nb = aClasser().length;
  const onglet = (id, nom) => `
    <button class="onglet ${etat.onglet === id ? "actif" : ""}" data-action="onglet" data-onglet="${id}">
      ${ICONES[id]}<span>${nom}</span>${id === "a-classer" && nb ? `<span class="pastille">${nb}</span>` : ""}
    </button>`;
  return `<nav class="onglets"><div class="interieur">${onglet("synthese", "Synthèse")}${onglet("operations", "Opérations")}${onglet("a-classer", "À classer")}</div></nav>`;
}

function rendre() {
  if (!etat.session) { racine.innerHTML = ecranConnexion(); return; }
  if (etat.ecran === "code") { racine.innerHTML = ecranCode(); return; }
  if (etat.ecran === "activation") { racine.innerHTML = ecranActivation(); return; }

  // Conserver la saisie en cours dans la recherche lors d'un nouveau rendu
  const rechercheActive = document.activeElement?.id === "recherche";

  const corps = { synthese: ecranSynthese, operations: ecranOperations, "a-classer": ecranAClasser }[etat.onglet]();
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
      if (etat.onglet !== "operations") etat.filtreCategorie = null;
      window.scrollTo(0, 0);
      rendre();
      break;
    case "mois":
      await changerMois(Number(cible.dataset.decalage));
      break;
    case "filtrer":
      etat.filtreCategorie = cible.dataset.categorie || null;
      etat.onglet = "operations";
      etat.recherche = "";
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
    Object.assign(etat, { operations: [], listeMois: [], mois: null, fiche: null, onglet: "synthese", ecran: null, mfa: null, doubleAuthActive: false });
    rendre();
  }
});
