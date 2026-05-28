"""
extract_ifc_quantities.py
=========================
Extrait les BaseQuantities (surfaces, volumes, longueurs, etc.) d un fichier IFC
et produit un rapport JSON + CSV, sans dependance a Supabase.

Dependances :
    pip install ifcopenshell

Usage :
    python scripts/extract_ifc_quantities.py chemin/vers/maquette.ifc
    python scripts/extract_ifc_quantities.py chemin/vers/maquette.ifc --output rapport.json
    python scripts/extract_ifc_quantities.py chemin/vers/maquette.ifc --csv
    python scripts/extract_ifc_quantities.py chemin/vers/maquette.ifc --resume
"""

import argparse
import csv
import json
import sys
from pathlib import Path
from collections import defaultdict

try:
    import ifcopenshell
    import ifcopenshell.util.element as ifc_util
except ImportError:
    print("[ERREUR] ifcopenshell n est pas installe.")
    print("         Executez : pip install ifcopenshell")
    sys.exit(1)

# Types IFC a analyser
IFC_TYPES_CIBLES = [
    "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcColumn", "IfcBeam",
    "IfcDoor", "IfcWindow", "IfcStair", "IfcRoof", "IfcFooting", "IfcPile",
    "IfcSpace", "IfcCovering", "IfcRamp", "IfcPlate", "IfcMember",
]

# Unites standards par nom de propriete (cle = minuscule)
UNITS = {
    "length": "mm", "width": "mm", "height": "mm", "depth": "mm", "perimeter": "mm",
    "grosssidearea": "m2", "netsidearea": "m2",
    "grossfloorarea": "m2", "netfloorarea": "m2",
    "grosscrosssectionarea": "m2", "netcrosssectionarea": "m2",
    "outersurfacearea": "m2", "grosssurface": "m2", "netsurface": "m2",
    "grossvolume": "m3", "netvolume": "m3",
    "grossweight": "kg", "netweight": "kg",
}


def get_level(element, ifc_file) -> str:
    """Retourne le nom du niveau (IfcBuildingStorey) rattache a l element."""
    try:
        for rel in getattr(element, "ContainedInStructure", []):
            container = rel.RelatingStructure
            if container.is_a("IfcBuildingStorey"):
                return container.Name or "(sans nom)"
            if container.is_a("IfcBuilding"):
                return "Batiment"
    except Exception:
        pass
    return "(niveau inconnu)"


def extraire_quantites(element) -> dict:
    """Extrait les BaseQuantities numeriques d un element IFC."""
    quantites = {}
    try:
        qtos = ifc_util.get_psets(element, qtos_only=True)
        for pset_name, props in qtos.items():
            for prop_name, valeur in props.items():
                if isinstance(valeur, (int, float)):
                    cle = f"{pset_name}.{prop_name}"
                    quantites[cle] = round(float(valeur), 6)
    except Exception:
        pass
    return quantites


def traiter_fichier(chemin_ifc: str) -> dict:
    """Charge le fichier IFC et extrait toutes les BaseQuantities."""
    print(f"[info] Chargement de : {chemin_ifc}")
    ifc_file = ifcopenshell.open(chemin_ifc)

    elements = []
    stats_type = defaultdict(int)
    aggr_global = defaultdict(lambda: defaultdict(list))   # type -> prop -> [vals]
    aggr_niveau = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))  # type -> niveau -> prop -> [vals]

    for ifc_type in IFC_TYPES_CIBLES:
        for el in ifc_file.by_type(ifc_type):
            stats_type[ifc_type] += 1
            niveau = get_level(el, ifc_file)
            quantites = extraire_quantites(el)

            elements.append({
                "globalId": el.GlobalId,
                "ifcType": ifc_type,
                "name": el.Name or "",
                "level": niveau,
                "quantities": quantites,
            })

            for prop, val in quantites.items():
                aggr_global[ifc_type][prop].append(val)
                aggr_niveau[ifc_type][niveau][prop].append(val)

    # Calcul des agregats
    def agreger(accum):
        result = {}
        for type_key, props in accum.items():
            result[type_key] = {}
            for prop, vals in props.items():
                total = sum(vals)
                result[type_key][prop] = {
                    "total": round(total, 3),
                    "avg": round(total / len(vals), 3),
                    "count": len(vals),
                    "unit": UNITS.get(prop.split(".")[-1].lower(), ""),
                }
        return result

    def agreger_niveau(accum):
        result = {}
        for type_key, niveaux in accum.items():
            result[type_key] = {}
            for niveau, props in niveaux.items():
                result[type_key][niveau] = {}
                for prop, vals in props.items():
                    total = sum(vals)
                    result[type_key][niveau][prop] = {
                        "total": round(total, 3),
                        "avg": round(total / len(vals), 3),
                        "count": len(vals),
                        "unit": UNITS.get(prop.split(".")[-1].lower(), ""),
                    }
        return result

    nb_avec_qty = sum(1 for e in elements if e["quantities"])
    print(f"[info] Elements trouves : {len(elements)} ({nb_avec_qty} avec BaseQuantities)")

    return {
        "fichier": Path(chemin_ifc).name,
        "totalElements": len(elements),
        "elementsAvecQuantites": nb_avec_qty,
        "comptageParType": dict(stats_type),
        "agregatsGlobaux": agreger(aggr_global),
        "agregatsParNiveau": agreger_niveau(aggr_niveau),
        "elements": elements,
    }


def afficher_resume(data: dict):
    """Affiche un resume lisible dans le terminal."""
    print(f"\n{'='*60}")
    print(f"RAPPORT DE QUANTITES IFC — {data['fichier']}")
    print(f"{'='*60}")
    print(f"Total elements : {data['totalElements']} ({data['elementsAvecQuantites']} avec BaseQuantities)\n")

    print("COMPTAGE PAR TYPE :")
    for t, n in sorted(data["comptageParType"].items(), key=lambda x: -x[1]):
        print(f"  {t:<35} {n}")

    if data["agregatsGlobaux"]:
        print("\nTOTAUX GLOBAUX PAR TYPE (toutes niveaux) :")
        for ifc_type, props in data["agregatsGlobaux"].items():
            n = data["comptageParType"].get(ifc_type, 0)
            print(f"\n  {ifc_type} ({n} elements) :")
            for prop, agg in props.items():
                unite = f" {agg['unit']}" if agg["unit"] else ""
                print(f"    {prop:<50} total={agg['total']}{unite:5}  moy={agg['avg']}{unite:5}  nb={agg['count']}")

        print("\nDETAIL PAR NIVEAU :")
        for ifc_type, niveaux in data["agregatsParNiveau"].items():
            print(f"\n  {ifc_type} :")
            for niveau, props in sorted(niveaux.items()):
                print(f"    Niveau : {niveau}")
                for prop, agg in props.items():
                    unite = f" {agg['unit']}" if agg["unit"] else ""
                    print(f"      {prop:<45} total={agg['total']}{unite}")
    else:
        print("\n[avertissement] Aucune BaseQuantity trouvee dans ce fichier.")
        print("  Verifiez que les quantites ont bien ete exportees depuis votre outil BIM.")

    print(f"\n{'='*60}\n")


def exporter_csv(data: dict, chemin_csv: str):
    """Exporte le detail par element dans un fichier CSV."""
    rows = []
    for el in data["elements"]:
        base = {
            "globalId": el["globalId"],
            "ifcType": el["ifcType"],
            "name": el["name"],
            "level": el["level"],
        }
        if el["quantities"]:
            for prop, val in el["quantities"].items():
                rows.append({**base, "property": prop, "value": val})
        else:
            rows.append({**base, "property": "", "value": ""})

    with open(chemin_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["globalId", "ifcType", "name", "level", "property", "value"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"[info] CSV exporte : {chemin_csv} ({len(rows)} lignes)")


def main():
    parser = argparse.ArgumentParser(
        description="Extrait les BaseQuantities d un fichier IFC (surfaces, volumes, longueurs)."
    )
    parser.add_argument("ifc", help="Chemin vers le fichier IFC")
    parser.add_argument("--output", "-o", help="Chemin du fichier JSON de sortie (defaut: <nom>.quantities.json)")
    parser.add_argument("--csv", action="store_true", help="Exporter aussi un CSV detaille par element")
    parser.add_argument("--resume", action="store_true", help="Afficher uniquement le resume terminal, sans ecrire de fichier")
    args = parser.parse_args()

    ifc_path = Path(args.ifc)
    if not ifc_path.exists():
        print(f"[ERREUR] Fichier introuvable : {args.ifc}")
        sys.exit(1)

    data = traiter_fichier(str(ifc_path))
    afficher_resume(data)

    if args.resume:
        return

    # Sortie JSON
    json_path = args.output or str(ifc_path.with_suffix(".quantities.json"))
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[info] JSON exporte : {json_path}")

    # Sortie CSV optionnelle
    if args.csv:
        csv_path = str(ifc_path.with_suffix(".quantities.csv"))
        exporter_csv(data, csv_path)


if __name__ == "__main__":
    main()