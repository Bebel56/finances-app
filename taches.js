// Section « Tâches » de l'assistant : liste des tâches Perso, Molie et Hexabel.
// S'appuie sur les outils de app.js (sb, etat, rendre, echapper, dates…), chargé avant ce fichier.

const ESPACES = { perso: "Perso", molie: "Molie", hexabel: "Hexabel" };
const STATUTS_TACHE = { a_faire: "À faire", en_cours: "En cours", fait: "Fait", abandonne: "Abandonnée" };
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function lireSection() {
  try { return localStorage.getItem("section") === "finances" ? "finances" : "taches"; } catch { return "taches"; }
}

function lireEspaceAjout() {
  try { return ESPACES[localStorage.getItem("espace")] ? localStorage.getItem("espace") : "perso"; } catch { return "perso"; }
}

Object.assign(etat, {
  section: lireSection(),       // "taches" | "finances"
  taches: [],
  ongletTaches: "aujourdhui",   // aujourdhui | a-venir | toutes
  filtreEspace: null,           // vue « Toutes » : un espace ou tous
  afficherTerminees: false,
  espaceAjout: lireEspaceAjout(),
  ficheTache: null,             // id de la tâche ouverte
});

// ── Données ────────────────────────────────────────────────────────────────────
// Les tâches ouvertes, et celles terminées depuis moins de 14 jours
async function chargerTaches() {
  const depuis = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data, error } = await sb.from("taches").select("*")
    .or(`statut.in.(a_faire,en_cours),termine_le.gte.${depuis}`)
    .order("echeance", { ascending: true, nullsFirst: false })
    .order("cree_le", { ascending: true });
  if (error) throw error;
  etat.taches = data;
}

async function enregistrerTache(fonction, parametres, messageOk) {
  if (etat.occupe) return false;
  etat.occupe = true;
  const { error } = await sb.rpc(fonction, parametres);
  etat.occupe = false;
  if (error) {
    console.error(error);
    afficherMessage(error.message || "Enregistrement impossible");
    return false;
  }
  try { await chargerTaches(); } catch (e) { console.error(e); }
  afficherMessage(messageOk);
  return true;
}

// ── Classement ─────────────────────────────────────────────────────────────────
const estOuverte = (t) => t.statut === "a_faire" || t.statut === "en_cours";
const estEnRetard = (t) => estOuverte(t) && t.echeance && t.echeance < aujourdhui();

// En retard, prévues aujourd'hui, en cours, ou prioritaires sans date
function tachesDuJour() {
  const jour = aujourdhui();
  return etat.taches.filter((t) => estOuverte(t) && (
    (t.echeance && t.echeance <= jour) || t.statut === "en_cours" || (t.prioritaire && !t.echeance)
  ));
}

function dateLongue(date) {
  const [a, m, j] = date.split("-").map(Number);
  const d = new Date(a, m - 1, j);
  return `${JOURS[d.getDay()]} ${j} ${MOIS[m - 1].toLowerCase()}`;
}

function libelleEcheance(date) {
  const jour = aujourdhui();
  if (date === jour) return "aujourd'hui";
  if (date === ajouterJours(jour, 1)) return "demain";
  if (date === ajouterJours(jour, -1)) return "hier";
  if (date > jour && date <= ajouterJours(jour, 6)) return JOURS[new Date(`${date}T12:00:00`).getDay()];
  return jourEnLettres(date);
}

// ── Écrans ─────────────────────────────────────────────────────────────────────
function navigationSections() {
  return `
    <nav class="sections" aria-label="Sections">
      <button class="${etat.section === "taches" ? "actif" : ""}" data-action="section" data-section="taches">Tâches</button>
      <button class="${etat.section === "finances" ? "actif" : ""}" data-action="section" data-section="finances">Finances</button>
    </nav>`;
}

function enteteTaches() {
  const titre = { aujourdhui: "Aujourd'hui", "a-venir": "À venir", toutes: "Toutes les tâches" }[etat.ongletTaches];
  return `
    ${navigationSections()}
    <header class="entete">
      <h1>${titre}</h1>
      <div class="actions">
        <button class="icone" data-action="deconnexion" aria-label="Se déconnecter">${ICONES.sortir}</button>
      </div>
    </header>
    <p class="dates">${dateLongue(aujourdhui()).replace(/^./, (c) => c.toUpperCase())}</p>`;
}

function formulaireAjout() {
  return `
    <form class="ajout-tache" id="nouvelle-tache" autocomplete="off">
      <input type="text" name="titre" maxlength="300" placeholder="Ajouter une tâche" aria-label="Nouvelle tâche" required>
      <div class="ajout-options">
        <div class="espaces" role="group" aria-label="Espace">${Object.entries(ESPACES).map(([cle, nom]) => `
          <button type="button" class="espace-choix ${cle} ${etat.espaceAjout === cle ? "actif" : ""}" data-action="espace-ajout" data-espace="${cle}" aria-pressed="${etat.espaceAjout === cle}">${nom}</button>`).join("")}
        </div>
        <input type="date" name="echeance" aria-label="Échéance (facultative)" min="${ajouterJours(aujourdhui(), -365)}">
      </div>
      <button class="bouton" type="submit">Ajouter</button>
    </form>`;
}

function ligneTache(t) {
  const fini = !estOuverte(t);
  const details = [
    `<span class="badge-espace ${t.espace}">${ESPACES[t.espace]}</span>`,
    t.echeance ? `<span class="${estEnRetard(t) ? "en-retard" : ""}">${estEnRetard(t) ? "en retard · " : ""}${libelleEcheance(t.echeance)}</span>` : "",
    t.statut === "en_cours" ? "<span>en cours</span>" : "",
    t.statut === "abandonne" ? "<span>abandonnée</span>" : "",
    t.source === "intranet" ? "<span>intranet</span>" : "",
    t.note ? "<span>note</span>" : "",
  ].filter(Boolean).join("");
  return `
    <div class="tache ${fini ? "finie" : ""}">
      <button class="coche-tache ${t.statut === "fait" ? "faite" : ""}" data-action="cocher-tache" data-id="${t.id}"
        role="checkbox" aria-checked="${t.statut === "fait"}" aria-label="${t.statut === "fait" ? "Rouvrir" : "Marquer comme faite"} : ${echapper(t.titre)}">${t.statut === "fait" ? "✓" : ""}</button>
      <button class="contenu-tache" data-action="ouvrir-tache" data-id="${t.id}">
        <span class="titre-tache">${t.prioritaire && !fini ? '<span class="etoile" aria-label="prioritaire">★</span>' : ""}${echapper(t.titre)}</span>
        <span class="details-tache">${details}</span>
      </button>
    </div>`;
}

const listeTaches = (taches) => `<div class="liste-taches">${taches.map(ligneTache).join("")}</div>`;

function groupe(titre, taches) {
  return taches.length ? `<h2 class="titre-section">${titre} <span class="compte">${taches.length}</span></h2>${listeTaches(taches)}` : "";
}

function ecranAujourdhui() {
  const jour = aujourdhui();
  const duJour = tachesDuJour();
  const enRetard = duJour.filter((t) => t.echeance && t.echeance < jour);
  const aujourdhuiMeme = duJour.filter((t) => t.echeance === jour);
  const autres = duJour.filter((t) => !t.echeance || t.echeance > jour);
  const faitesAujourdhui = etat.taches.filter((t) => t.statut === "fait" && t.termine_le && dateIso(new Date(t.termine_le)) === jour);

  if (!duJour.length && !faitesAujourdhui.length) {
    return `<p class="vide">Rien de prévu aujourd'hui.<br>Les tâches datées d'aujourd'hui, en retard, en cours ou prioritaires apparaissent ici.</p>`;
  }
  return `
    ${groupe("En retard", enRetard)}
    ${groupe("Aujourd'hui", aujourdhuiMeme)}
    ${groupe("En cours et prioritaires", autres)}
    ${groupe("Faites aujourd'hui", faitesAujourdhui)}`;
}

function ecranAVenir() {
  const jour = aujourdhui();
  const ouvertes = etat.taches.filter((t) => estOuverte(t) && t.echeance && t.echeance > jour);
  const sansDate = etat.taches.filter((t) => estOuverte(t) && !t.echeance);
  const parJour = new Map();
  for (const t of ouvertes.filter((t) => t.echeance <= ajouterJours(jour, 13))) {
    parJour.set(t.echeance, [...(parJour.get(t.echeance) ?? []), t]);
  }
  const plusTard = ouvertes.filter((t) => t.echeance > ajouterJours(jour, 13));

  const blocs = [...parJour.entries()].map(([date, taches]) => {
    const libelle = libelleEcheance(date);
    return groupe(`${libelle.replace(/^./, (c) => c.toUpperCase())}${/^\d/.test(libelle) ? "" : ` · ${jourEnLettres(date)}`}`, taches);
  }).join("");
  const contenu = `${blocs}${groupe("Plus tard", plusTard)}${groupe("Sans date", sansDate)}`;
  return contenu || `<p class="vide">Aucune tâche à venir.</p>`;
}

function ecranToutes() {
  const filtre = (t) => !etat.filtreEspace || t.espace === etat.filtreEspace;
  const ouvertes = etat.taches.filter((t) => estOuverte(t) && filtre(t));
  const finies = etat.taches.filter((t) => !estOuverte(t) && filtre(t))
    .sort((a, b) => (b.termine_le ?? "").localeCompare(a.termine_le ?? ""));
  const espaces = etat.filtreEspace ? [etat.filtreEspace] : Object.keys(ESPACES);

  return `
    <div class="filtres-espaces" role="group" aria-label="Espace">
      <button class="${!etat.filtreEspace ? "actif" : ""}" data-action="filtre-espace" data-espace="">Tous</button>
      ${Object.entries(ESPACES).map(([cle, nom]) => `<button class="${etat.filtreEspace === cle ? "actif" : ""}" data-action="filtre-espace" data-espace="${cle}">${nom}</button>`).join("")}
    </div>
    ${espaces.map((e) => groupe(ESPACES[e], ouvertes.filter((t) => t.espace === e))).join("") || ""}
    ${!ouvertes.length ? `<p class="vide">Aucune tâche ouverte${etat.filtreEspace ? ` dans ${ESPACES[etat.filtreEspace]}` : ""}.</p>` : ""}
    ${finies.length ? `<button class="lien centre" data-action="afficher-terminees">${etat.afficherTerminees ? "Masquer" : "Afficher"} les tâches terminées (${finies.length})</button>` : ""}
    ${etat.afficherTerminees ? listeTaches(finies) : ""}`;
}

function ficheTache() {
  const t = etat.taches.find((x) => x.id === etat.ficheTache);
  if (!t) return "";
  const intranet = t.source === "intranet";
  return `
    <div class="voile" data-action="fermer-tache">
      <section class="fiche" role="dialog" aria-modal="true" aria-label="Tâche">
        <div class="tete">
          <h2>${intranet ? echapper(t.titre) : "Modifier la tâche"}</h2>
          <button class="icone" data-action="fermer-tache" aria-label="Fermer">${ICONES.fermer}</button>
        </div>
        ${intranet ? `<p class="note">Tâche recopiée de l'intranet Molie : elle se modifie dans l'intranet.${t.source_url ? ` <a class="lien" href="${echapper(t.source_url)}" target="_blank" rel="noopener">Ouvrir dans l'intranet</a>` : ""}</p>` : `
        <form id="modifier-tache" autocomplete="off">
          <label class="champ"><span>Titre</span>
            <input type="text" name="titre" maxlength="300" value="${echapper(t.titre)}" required></label>
          <h3>Espace</h3>
          <div class="espaces">${Object.entries(ESPACES).map(([cle, nom]) => `
            <label class="espace-choix ${cle}"><input type="radio" name="espace" value="${cle}" ${t.espace === cle ? "checked" : ""}> ${nom}</label>`).join("")}
          </div>
          <label class="champ"><span>Échéance</span>
            <input type="date" name="echeance" value="${t.echeance ?? ""}"></label>
          <label class="option-ligne"><input type="checkbox" name="prioritaire" ${t.prioritaire ? "checked" : ""}> Prioritaire</label>
          <label class="champ"><span>Note</span>
            <textarea name="note" rows="4" maxlength="4000" placeholder="Détails, liens, contacts">${echapper(t.note ?? "")}</textarea></label>
          <button class="bouton" type="submit">Enregistrer</button>
        </form>`}
        <h3>Statut</h3>
        <div class="statuts">${Object.entries(STATUTS_TACHE).map(([cle, nom]) => `
          <button class="categorie ${t.statut === cle ? "choisie" : ""}" data-action="statut-tache" data-statut="${cle}" ${intranet ? "disabled" : ""}>${nom}</button>`).join("")}
        </div>
        <p class="note">Créée le ${dateLongue(dateIso(new Date(t.cree_le)))}${t.termine_le ? `, terminée le ${dateLongue(dateIso(new Date(t.termine_le)))}` : ""}.</p>
        ${intranet ? "" : `<button class="lien danger" data-action="supprimer-tache">Supprimer la tâche</button>`}
      </section>
    </div>`;
}

function barreOngletsTaches() {
  const nb = tachesDuJour().length;
  const onglet = (id, nom, icone) => `
    <button class="onglet ${etat.ongletTaches === id ? "actif" : ""}" data-action="onglet-taches" data-onglet="${id}">
      ${icone}<span>${nom}</span>${id === "aujourdhui" && nb ? `<span class="pastille">${nb}</span>` : ""}
    </button>`;
  return `<nav class="onglets"><div class="interieur">
    ${onglet("aujourdhui", "Aujourd'hui", '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')}
    ${onglet("a-venir", "À venir", '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>')}
    ${onglet("toutes", "Toutes", '<svg viewBox="0 0 24 24"><path d="M9 6h12M9 12h12M9 18h12M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>')}
  </div></nav>`;
}

function ecranTaches() {
  const corps = { aujourdhui: ecranAujourdhui, "a-venir": ecranAVenir, toutes: ecranToutes }[etat.ongletTaches]();
  return `
    ${enteteTaches()}
    ${etat.erreur ? `<p class="erreur">${echapper(etat.erreur)}</p>` : ""}
    ${formulaireAjout()}
    ${corps}
    ${barreOngletsTaches()}
    ${etat.ficheTache !== null ? ficheTache() : ""}
    ${etat.message ? `<div class="message" role="status">${echapper(etat.message)}</div>` : ""}`;
}

// ── Interactions (appelées par les gestionnaires de app.js) ───────────────────
// Renvoie true si l'action concernait les tâches
async function actionTaches(cible) {
  const id = Number(cible.dataset.id);
  switch (cible.dataset.action) {
    case "section":
      etat.section = cible.dataset.section;
      try { localStorage.setItem("section", etat.section); } catch { /* le choix vaut pour cette session */ }
      window.scrollTo(0, 0);
      rendre();
      return true;
    case "onglet-taches":
      etat.ongletTaches = cible.dataset.onglet;
      window.scrollTo(0, 0);
      rendre();
      return true;
    case "espace-ajout":
      etat.espaceAjout = cible.dataset.espace;
      try { localStorage.setItem("espace", etat.espaceAjout); } catch { /* sans importance */ }
      // Garder ce qui est déjà saisi dans le formulaire
      memoriserSaisieAjout();
      rendre();
      restaurerSaisieAjout();
      return true;
    case "filtre-espace":
      etat.filtreEspace = cible.dataset.espace || null;
      rendre();
      return true;
    case "afficher-terminees":
      etat.afficherTerminees = !etat.afficherTerminees;
      rendre();
      return true;
    case "cocher-tache": {
      const t = etat.taches.find((x) => x.id === id);
      if (!t) return true;
      if (t.source === "intranet") { afficherMessage("Cette tâche se termine dans l'intranet Molie"); return true; }
      const fait = t.statut !== "fait";
      // Affichage immédiat, confirmé par la base juste après
      t.statut = fait ? "fait" : "a_faire";
      t.termine_le = fait ? new Date().toISOString() : null;
      rendre();
      await enregistrerTache("modifier_tache", { p_id: id, p_statut: t.statut }, fait ? "Tâche faite" : "Tâche rouverte");
      return true;
    }
    case "ouvrir-tache":
      etat.ficheTache = id;
      rendre();
      return true;
    case "fermer-tache":
      etat.ficheTache = null;
      rendre();
      return true;
    case "statut-tache": {
      const idTache = etat.ficheTache;
      const statut = cible.dataset.statut;
      etat.ficheTache = null;
      await enregistrerTache("modifier_tache", { p_id: idTache, p_statut: statut }, `Tâche : ${STATUTS_TACHE[statut].toLowerCase()}`);
      return true;
    }
    case "supprimer-tache": {
      const idTache = etat.ficheTache;
      if (!confirm("Supprimer définitivement cette tâche ?")) return true;
      etat.ficheTache = null;
      await enregistrerTache("supprimer_tache", { p_id: idTache }, "Tâche supprimée");
      return true;
    }
    default:
      return false;
  }
}

// Renvoie true si le formulaire concernait les tâches
async function soumettreTaches(formulaire) {
  if (formulaire.id === "nouvelle-tache") {
    const donnees = new FormData(formulaire);
    const titre = String(donnees.get("titre") || "").trim();
    if (!titre) return true;
    const ok = await enregistrerTache("creer_tache", {
      p_titre: titre, p_espace: etat.espaceAjout, p_echeance: donnees.get("echeance") || null,
    }, `Ajoutée dans ${ESPACES[etat.espaceAjout]}`);
    if (ok) document.querySelector("#nouvelle-tache input[name=titre]")?.focus();
    return true;
  }
  if (formulaire.id === "modifier-tache") {
    const donnees = new FormData(formulaire);
    const echeance = donnees.get("echeance") || null;
    const idTache = etat.ficheTache;
    etat.ficheTache = null;
    await enregistrerTache("modifier_tache", {
      p_id: idTache,
      p_titre: String(donnees.get("titre") || "").trim(),
      p_espace: donnees.get("espace"),
      p_echeance: echeance,
      p_effacer_echeance: !echeance,
      p_prioritaire: donnees.get("prioritaire") === "on",
      p_note: String(donnees.get("note") || ""),
    }, "Tâche enregistrée");
    return true;
  }
  return false;
}

let saisieAjout = null;
function memoriserSaisieAjout() {
  const f = document.getElementById("nouvelle-tache");
  saisieAjout = f ? { titre: f.titre.value, echeance: f.echeance.value } : null;
}
function restaurerSaisieAjout() {
  const f = document.getElementById("nouvelle-tache");
  if (!f || !saisieAjout) return;
  f.titre.value = saisieAjout.titre;
  f.echeance.value = saisieAjout.echeance;
  f.titre.focus();
  saisieAjout = null;
}
