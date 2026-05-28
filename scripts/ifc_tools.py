"""
ifc_tools.py
============
Outils Python pour l audit de maquettes IFC via Function Calling (onglet LLM).

Dependances :
    pip install ifcopenshell

Usage (depuis le Function Calling OpenAI) :
    from scripts.ifc_tools import verifier_propriete_ifc
    result = verifier_propriete_ifc("maquette.ifc", "IfcFlowTerminal", "INF_Protection")
"""

import ifcopenshell
import ifcopenshell.util.element as ifc_util


def verifier_propriete_ifc(chemin_ifc: str, type_objet: str, nom_propriete: str) -> dict:
    """
    Verifie si une propriete donnee est presente sur tous les elements d un type IFC.

    Arguments:
        chemin_ifc    (str) : Chemin absolu ou relatif vers le fichier .ifc.
        type_objet    (str) : Type IFC a cibler, ex: "IfcWall", "IfcFlowTerminal".
        nom_propriete (str) : Nom exact de la propriete a rechercher dans les Psets,
                              ex: "INF_Protection", "LoadBearing", "FireRating".

    Retourne:
        dict avec les cles suivantes :
            - type_objet        (str)  : Le type IFC analyse.
            - propriete         (str)  : La propriete recherchee.
            - total_elements    (int)  : Nombre total d elements de ce type dans le modele.
            - elements_conformes(int)  : Nombre d elements possedant la propriete.
            - taux_conformite   (str)  : Pourcentage de conformite, ex: "87.5%".
            - tous_conformes    (bool) : True si tous les elements ont la propriete.
            - exemples_manquants(list) : Liste des noms/IDs des elements sans la propriete
                                        (limitee a 5 exemples maximum).
            - erreur            (str)  : Message d erreur si le fichier est inaccessible
                                        (None si pas d erreur).
    """

    # ── Initialisation du resultat ────────────────────────────────────────────
    resultat = {
        "type_objet": type_objet,
        "propriete": nom_propriete,
        "total_elements": 0,
        "elements_conformes": 0,
        "taux_conformite": "0%",
        "tous_conformes": False,
        "exemples_manquants": [],
        "erreur": None,
    }

    # ── Ouverture du fichier IFC ──────────────────────────────────────────────
    try:
        modele = ifcopenshell.open(chemin_ifc)
    except Exception as e:
        # Fichier introuvable, corrompu ou format non supporte
        resultat["erreur"] = f"Impossible d ouvrir le fichier IFC : {e}"
        return resultat

    # ── Recuperation des elements du type demande ─────────────────────────────
    elements = modele.by_type(type_objet)

    if not elements:
        resultat["erreur"] = (
            f"Aucun element de type '{type_objet}' trouve dans le fichier. "
            f"Verifiez l orthographe du type IFC (ex: IfcWall, IfcFlowTerminal)."
        )
        return resultat

    resultat["total_elements"] = len(elements)

    # ── Analyse element par element ───────────────────────────────────────────
    elements_manquants = []  # Liste des elements sans la propriete

    for element in elements:

        # Recuperer tous les Property Sets (Psets) de l element,
        # y compris les Quantity Sets (qtos) via qtos_only=False (defaut).
        psets = ifc_util.get_psets(element)

        # Verifier si la propriete est presente dans l un des Psets
        propriete_trouvee = False
        for pset_nom, pset_props in psets.items():
            if isinstance(pset_props, dict) and nom_propriete in pset_props:
                # La propriete existe — verifier qu elle n est pas vide/None
                valeur = pset_props[nom_propriete]
                if valeur is not None and valeur != "":
                    propriete_trouvee = True
                    break

        if propriete_trouvee:
            resultat["elements_conformes"] += 1
        else:
            # Stocker le nom ou l identifiant de l element non conforme
            # Priorite : Name > GlobalId > Tag
            nom_element = (
                getattr(element, "Name", None)
                or getattr(element, "Tag", None)
                or element.GlobalId
            )
            elements_manquants.append(str(nom_element))

    # ── Calcul du taux de conformite ──────────────────────────────────────────
    total = resultat["total_elements"]
    conformes = resultat["elements_conformes"]

    if total > 0:
        taux = (conformes / total) * 100
        resultat["taux_conformite"] = f"{taux:.1f}%"
        resultat["tous_conformes"] = conformes == total
    else:
        resultat["taux_conformite"] = "N/A"

    # Limiter la liste d exemples a 5 pour ne pas surcharger la reponse
    resultat["exemples_manquants"] = elements_manquants[:5]

    return resultat