export const RAPPORT_CATEGORIES: { section: string; category: string; items: { id: string; label: string; expected: string }[] }[] = [
  // ── SECTION : FICHIER IFC ────────────────────────────────────────────────────
  {
    section: "FICHIER IFC",
    category: "1 — FORMAT DE FICHIER",
    items: [
      { id: "1.1", label: "Nom du fichier", expected: "Conforme à la convention de nommage OTEIS (code projet_discipline_phase)" },
      { id: "1.2", label: "Format IFC 2°3", expected: "Export IFC 2x3 (IFC2X3)" },
      { id: "1.3", label: "Taille du fichier", expected: "< 500 Mo par fichier IFC" },
    ],
  },  {
    section: "FICHIER IFC",
    category: "2 — ATTRIBUTS PROJET (IfcProject)",
    items: [      { id: "2.1", label: "Code (Name)", expected: "Code du projet (ex: OTEIS_PRJ_001)" },
      { id: "2.2", label: "LongName", expected: "Nom long du projet renseigné" },
      { id: "2.3", label: "Description (Description)", expected: "Description explicite du contenu du fichier" },
      { id: "2.4", label: "Phase (Phase)", expected: "Phase du projet renseignée" },
    ],
  },
  {    section: "FICHIER IFC",
    category: "3 — ATTRIBUTS SITE (IfcSite)",
    items: [
      { id: "3.1", label: "Nom (Name)", expected: "Nom du site renseigné" },
      { id: "3.2", label: "Description (Description)", expected: "Description du site renseignée" },      { id: "3.3", label: "Coordonnées N/S (Global Y) (en mm)", expected: "Coordonnée Nord/Sud renseignée (RGF93 / Lambert 93)" },
      { id: "3.4", label: "Coordonnées E/O (Global X) (en mm)", expected: "Coordonnée Est/Ouest renseignée (RGF93 / Lambert 93)" },
      { id: "3.5", label: "Elevation (Élévation Z) (en mm)", expected: "Élévation NGF renseignée" },
    ],
  },
  {
    section: "FICHIER IFC",
    category: "4 — ATTRIBUTS BATIMENT (IfcBuilding)",
    items: [      { id: "4.1", label: "Nom (Name)", expected: "" },
      { id: "4.2", label: "Adresse", expected: "" },
    ],
  },  {
    section: "FICHIER IFC",
    category: "5 — ATTRIBUTS NIVEAUX (IfcBuildingStorey)",
    items: [],
  },
  {
    section: "FICHIER IFC",
    category: "6 — COHÉRENCE / CONFORMITÉ",
    items: [
      { id: "6.1", label: "Vérification visuelle de l'assemblage des modèles (Cohérence générale des maquettes assemblées)", expected: "Modèles correctement positionnés et superposés sans décalage" },
      { id: "6.2", label: "Contrôle visuel de la modélisation - Respect des règles de modélisation à maîtriser", expected: "Respect des règles de modélisation OTEIS (éléments non doublés, pas de géométrie parasite)" },
      { id: "6.3", label: "Rattachement / Modélisation des objets aux Bons niveaux", expected: "Chaque objet est rattaché au niveau auquel il appartient" },
      { id: "6.4", label: "Conformité maquette et Maquette architecture", expected: "Cohérence géométrique avec la maquette architecture de référence" },
      { id: "6.5", label: "Contrôle de la connexion des objets", expected: "Objets correctement connectés (murs, dalles, poteaux…)" },
      { id: "6.6", label: "Contrôle des conflits internes", expected: "0 conflit interne à la maquette (clash détection)" },
      { id: "6.7", label: "Contrôle des conflits externes", expected: "0 conflit critique inter-maquettes (clash détection fédérée)" },
      { id: "6.8", label: "Contrôle des sustènes", expected: "Systèmes de sustentation correctement modélisés et rattachés" },
    ],
  },
  // ── SECTION : FAMILLES ──────────────────────────────────────────────────────
  {
    section: "FAMILLES",
    category: "7 — IFCBUILDINGELEMENT PROXY",
    items: [
      { id: "7.1", label: "Utilisation / limite des IfcBuildingElementProxy (aucun exception acceptée)", expected: "0 objet IfcBuildingElementProxy dans le fichier" },
    ],
  },
  {
    section: "FAMILLES",
    category: "8 — PIÈCES",
    items: [
      { id: "8.1", label: "Classification IFC", expected: "Pièces classifiées en IfcSpace avec type correct" },
      { id: "8.2", label: "Données non courantes", expected: "Pas de données redondantes ou incohérentes sur les pièces" },
      { id: "8.3", label: "Nommage des pièces", expected: "Nommage conforme (code fonction + numéro selon convention)" },
      { id: "8.4", label: "Intersection de pièces", expected: "0 intersection / chevauchement entre pièces" },
      { id: "8.5", label: "Pset_IFC", expected: "Pset_SpaceCommon renseigné (IsExternal, GrossFloorArea…)" },
      { id: "8.6", label: "Propriétés", expected: "Propriétés métier renseignées (surface, usage, programme)" },
    ],
  },
  {
    section: "FAMILLES",
    category: "9 — FAMILLES OBJET 1 (Ex : MUR3)",
    items: [
      { id: "9.1", label: "Dénomination IFC", expected: "Type IFC correct (IfcWall, IfcColumn, IfcBeam…)" },
      { id: "9.2", label: "Niveau de détail", expected: "LOD conforme à la phase (LOD 200 minimum en PRO)" },
      { id: "9.3", label: "Combinaison sur l'instance", expected: "Pas de combinaison de familles non prévue par la convention" },
      { id: "9.4", label: "Dimensions", expected: "Dimensions paramétriques correctement renseignées" },
      { id: "9.5", label: "Nom des objets", expected: "Nommage conforme à la convention OTEIS" },
      { id: "9.6", label: "Matériaux", expected: "Matériaux renseignés et conformes à la charte matériaux" },
      { id: "9.7", label: "Pset_app", expected: "Pset applicatif métier renseigné" },
      { id: "9.8", label: "Prop élec", expected: "Propriétés électriques renseignées (si applicable)" },
      { id: "9.9", label: "Prop méca", expected: "Propriétés mécaniques renseignées (si applicable)" },
    ],
  },
];
