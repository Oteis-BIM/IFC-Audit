"""
extract_ifc_geometry.py
=======================
Extrait les données géométriques (BaseQuantities) d'un fichier IFC
et envoie le JSON résultant dans la table `ifc_geometry` de Supabase.

Dépendances :
    pip install ifcopenshell supabase python-dotenv

Usage :
    python scripts/extract_ifc_geometry.py --ifc maquette.ifc [--project-name "Mon Projet"]

La variable SUPABASE_URL et SUPABASE_KEY peuvent être définies :
  - dans le fichier .env.local du projet (chargé automatiquement)
  - ou via des variables d'environnement système
"""

import argparse
import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

# ── Chargement de .env.local ─────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)
        print(f"[info] Variables d'environnement chargées depuis {env_path}")
except ImportError:
    pass  # python-dotenv optionnel

# ── Imports requis ────────────────────────────────────────────────────────────
try:
    import ifcopenshell
    import ifcopenshell.util.element as ifc_util
except ImportError:
    print("[erreur] ifcopenshell n'est pas installé.")
    print("         Exécutez : pip install ifcopenshell")
    sys.exit(1)

try:
    from supabase import create_client
except ImportError:
    print("[erreur] supabase-py n'est pas installé.")
    print("         Exécutez : pip install supabase")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────
# Modifier cette variable pour pointer vers votre fichier IFC
chemin_ifc = "maquette.ifc"

# Types IFC à analyser
IFC_TYPES_CIBLES = [
    "IfcWall",
    "IfcSlab",
    "IfcColumn",
    "IfcBeam",
    "IfcDoor",
    "IfcWindow",
    "IfcStair",
    "IfcRoof",
    "IfcFooting",
    "IfcPile",
    "IfcSpace",
]

# Unités attendues par nom de propriété (pour annotation du JSON)
UNITS_HINTS = {
    "length": "mm", "width": "mm", "height": "mm", "depth": "mm",
    "perimeter": "mm", "grosssidearea": "m²", "netsidearea": "m²",
    "grossfloorarea": "m²", "netfloorarea": "m²", "grossvolume": "m³",
    "netvolume": "m³", "grosscrosssectionarea": "m²", "netcrosssectionarea": "m²",
    "outersurfacearea": "m²", "grosssurface": "m²", "netsurface": "m²",
}


def extraire_quantites(element) -> dict:
    """
    Extrait les BaseQuantities numériques d'un élément IFC.
    Retourne un dict plat { nom_propriété: valeur_numérique }.
    """
    quantites = {}
    try:
        psets = ifc_util.get_psets(element, qtos_only=True)
        for pset_name, props in psets.items():
            for prop_name, valeur in props.items():
                if isinstance(valeur, (int, float)):
                    cle = f"{pset_name}.{prop_name}"
                    quantites[cle] = round(float(valeur), 6)
    except Exception as e:
        pass  # Élément sans quantités géométriques — ignoré silencieusement
    return quantites


def extraire_proprietes_ifc(element) -> dict:
    """
    Extrait les Psets (non-qto) d'un élément pour enrichir le contexte.
    Retourne uniquement les valeurs scalaires (str, int, float, bool).
    """
    props = {}
    try:
        psets = ifc_util.get_psets(element, qtos_only=False)
        for pset_name, pset_props in psets.items():
            if not isinstance(pset_props, dict):
                continue
            for k, v in pset_props.items():
                if isinstance(v, (str, int, float, bool)):
                    props[f"{pset_name}.{k}"] = v
    except Exception:
        pass
    return props


def traiter_fichier_ifc(chemin: str) -> dict:
    """
    Charge le fichier IFC et extrait toutes les données géométriques.
    Retourne un dict structuré prêt pour Supabase.
    """
    chemin = Path(chemin)
    if not chemin.exists():
        raise FileNotFoundError(f"Fichier IFC introuvable : {chemin}")

    print(f"[info] Chargement du fichier IFC : {chemin.name} ({chemin.stat().st_size // 1024} Ko)")
    ifc = ifcopenshell.open(str(chemin))

    resume = {
        "fichier": chemin.name,
        "schema": ifc.schema,
        "date_extraction": datetime.now(timezone.utc).isoformat(),
        "total_elements": 0,
        "elements_avec_geometrie": 0,
        "elements": [],
    }

    stats_par_type: dict[str, int] = {}

    for ifc_type in IFC_TYPES_CIBLES:
        try:
            elements = ifc.by_type(ifc_type)
        except Exception:
            continue

        print(f"[info]   {ifc_type} : {len(elements)} élément(s) trouvé(s)")
        stats_par_type[ifc_type] = len(elements)

        for element in elements:
            resume["total_elements"] += 1
            quantites = extraire_quantites(element)
            props = extraire_proprietes_ifc(element)

            # Nom du niveau (storey) de rattachement
            niveau = None
            try:
                for rel in getattr(element, "ContainedInStructure", []):
                    relating = getattr(rel, "RelatingStructure", None)
                    if relating:
                        niveau = getattr(relating, "Name", None)
                        break
            except Exception:
                pass

            fiche = {
                "global_id": getattr(element, "GlobalId", None),
                "ifc_type": element.is_a(),
                "name": getattr(element, "Name", None) or "",
                "level": niveau,
                "base_quantities": quantites,
                "properties": props,
            }

            if quantites:
                resume["elements_avec_geometrie"] += 1

            resume["elements"].append(fiche)

    resume["stats_par_type"] = stats_par_type
    return resume


def envoyer_supabase(donnees: dict, nom_projet: str) -> None:
    """
    Insère ou met à jour les données dans la table `ifc_geometry` de Supabase.
    La table doit exister avec au minimum les colonnes :
        id (int8, PK), project_name (text), file_name (text),
        extracted_at (timestamptz), geometry_data (jsonb)
    """
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")

    if not url or not key:
        print("[avertissement] Variables SUPABASE_URL / SUPABASE_KEY non trouvées.")
        print("                Les données ne seront PAS envoyées à Supabase.")
        print("                Résultat sauvegardé localement uniquement.")
        return

    try:
        client = create_client(url, key)
        payload = {
            "project_name": nom_projet,
            "file_name": donnees["fichier"],
            "schema": donnees["schema"],
            "extracted_at": donnees["date_extraction"],
            "total_elements": donnees["total_elements"],
            "elements_with_geometry": donnees["elements_avec_geometrie"],
            "stats_by_type": donnees["stats_par_type"],
            "geometry_data": donnees,
        }
        # Upsert sur (project_name, file_name)
        res = (
            client.table("ifc_geometry")
            .upsert(payload, on_conflict="project_name,file_name")
            .execute()
        )
        print(f"[succès] Données envoyées à Supabase — table ifc_geometry")
        if hasattr(res, "data") and res.data:
            print(f"         Ligne(s) affectée(s) : {len(res.data)}")
    except Exception as e:
        print(f"[erreur Supabase] {e}")
        print("                  Les données ont été sauvegardées localement.")


def sauvegarder_json(donnees: dict, chemin_sortie: str) -> None:
    """Sauvegarde le JSON en local avec une indentation lisible."""
    with open(chemin_sortie, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=2)
    print(f"[info] JSON sauvegardé : {chemin_sortie}")


# ── Point d'entrée ────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Extrait les données géométriques d'un fichier IFC et les envoie à Supabase."
    )
    parser.add_argument(
        "--ifc",
        default=chemin_ifc,
        help=f"Chemin vers le fichier IFC (défaut : {chemin_ifc})",
    )
    parser.add_argument(
        "--project-name",
        default=None,
        help="Nom du projet Supabase (défaut : nom du fichier IFC sans extension)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Chemin du fichier JSON de sortie (défaut : <nom_ifc>_geometry.json)",
    )
    parser.add_argument(
        "--no-supabase",
        action="store_true",
        help="Ne pas envoyer à Supabase, sauvegarder uniquement en local",
    )
    args = parser.parse_args()

    ifc_path = Path(args.ifc)
    nom_projet = args.project_name or ifc_path.stem
    sortie_json = args.output or str(ifc_path.parent / f"{ifc_path.stem}_geometry.json")

    # Extraction
    try:
        donnees = traiter_fichier_ifc(str(ifc_path))
    except FileNotFoundError as e:
        print(f"[erreur] {e}")
        sys.exit(1)

    print(f"\n[résumé]")
    print(f"  Éléments analysés        : {donnees['total_elements']}")
    print(f"  Avec données géométriques: {donnees['elements_avec_geometrie']}")
    print(f"  Stats par type           : {donnees['stats_par_type']}")

    # Sauvegarde locale
    sauvegarder_json(donnees, sortie_json)

    # Envoi Supabase
    if not args.no_supabase:
        envoyer_supabase(donnees, nom_projet)

    print("\n[terminé]")


if __name__ == "__main__":
    main()

