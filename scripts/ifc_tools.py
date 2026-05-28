"""
ifc_tools.py
============
Outils Python pour l audit de maquettes IFC via Function Calling (onglet LLM).

Dependances :
    pip install ifcopenshell

Usage (depuis le Function Calling OpenAI) :
    from scripts.ifc_tools import verifier_propriete_ifc, outils_disponibles, executer_outil
"""

import json
import ifcopenshell
import ifcopenshell.util.element as ifc_util


# =============================================================================
# FONCTION PRINCIPALE - verifier_propriete_ifc
# =============================================================================

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
            - type_objet         (str)  : Le type IFC analyse.
            - propriete          (str)  : La propriete recherchee.
            - total_elements     (int)  : Nombre total d elements de ce type dans le modele.
            - elements_conformes (int)  : Nombre d elements possedant la propriete.
            - taux_conformite    (str)  : Pourcentage de conformite, ex: "87.5%".
            - tous_conformes     (bool) : True si tous les elements ont la propriete.
            - exemples_manquants (list) : Liste des noms/IDs des elements sans la propriete
                                         (limitee a 5 exemples maximum).
            - erreur             (str)  : Message d erreur si le fichier est inaccessible
                                         (None si pas d erreur).
    """

    # Initialisation du resultat par defaut
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

    # Ouverture du fichier IFC avec gestion d erreur
    try:
        modele = ifcopenshell.open(chemin_ifc)
    except Exception as e:
        resultat["erreur"] = f"Impossible d ouvrir le fichier IFC : {e}"
        return resultat

    # Recuperation de tous les elements du type demande
    elements = modele.by_type(type_objet)
    if not elements:
        resultat["erreur"] = (
            f"Aucun element de type '{type_objet}' trouve dans le fichier. "
            f"Verifiez l orthographe du type IFC (ex: IfcWall, IfcFlowTerminal)."
        )
        return resultat

    resultat["total_elements"] = len(elements)

    # Analyse element par element
    elements_manquants = []

    for element in elements:
        # Recuperer tous les Property Sets (Psets) de l element
        psets = ifc_util.get_psets(element)

        # Verifier si la propriete est presente et non vide dans l un des Psets
        propriete_trouvee = False
        for pset_nom, pset_props in psets.items():
            if isinstance(pset_props, dict) and nom_propriete in pset_props:
                valeur = pset_props[nom_propriete]
                if valeur is not None and valeur != "":
                    propriete_trouvee = True
                    break

        if propriete_trouvee:
            resultat["elements_conformes"] += 1
        else:
            # Stocker le nom ou l identifiant de l element non conforme
            nom_element = (
                getattr(element, "Name", None)
                or getattr(element, "Tag", None)
                or element.GlobalId
            )
            elements_manquants.append(str(nom_element))

    # Calcul du taux de conformite
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


# =============================================================================
# SCHEMA OPENAI TOOLS - outils_disponibles
# Format standard pour le parametre `tools=` de openai.chat.completions.create()
# =============================================================================

outils_disponibles = [
    {
        # Type obligatoire impose par l API OpenAI pour le Function Calling
        "type": "function",

        "function": {
            # Nom exact de la fonction Python qui sera appelee par le LLM
            "name": "verifier_propriete_ifc",

            # Description destinee au LLM : lui permet de comprendre quand
            # et pourquoi appeler cet outil pendant une conversation d audit BIM
            "description": (
                "Audite une maquette IFC en verifiant si un type d objet specifique "
                "(ex: IfcWall, IfcFlowTerminal, IfcDoor) possede bien une propriete "
                "technique precise (ex: INF_Protection, FireRating, LoadBearing) dans "
                "ses Property Sets. "
                "Retourne le nombre total d elements analyses, le nombre d elements "
                "conformes, le taux de conformite en pourcentage, un booleen indiquant "
                "si tous les elements sont conformes, et une liste d exemples d elements "
                "manquants (limitee a 5). "
                "Utiliser cet outil des qu un utilisateur demande si une propriete est "
                "renseignee sur des elements IFC, ou pour verifier la conformite d un "
                "parametre BIM sur l ensemble d un type d objet dans la maquette."
            ),

            # Definition des parametres attendus (schema JSON Schema)
            "parameters": {
                "type": "object",

                "properties": {
                    # Parametre 1 : le type IFC a cibler dans la maquette
                    "type_objet": {
                        "type": "string",
                        "description": (
                            "La classe ou le type IFC des elements a analyser dans la maquette. "
                            "Doit respecter la casse exacte du standard IFC, par exemple : "
                            "'IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcDoor', "
                            "'IfcWindow', 'IfcFlowTerminal', 'IfcLightFixture', 'IfcSpace'. "
                            "Ce parametre est sensible a la casse (IfcWall != IFCWALL)."
                        ),
                    },

                    # Parametre 2 : le nom de la propriete a verifier dans les Psets
                    "nom_propriete": {
                        "type": "string",
                        "description": (
                            "Le nom exact de la propriete ou du parametre technique a rechercher "
                            "dans les Property Sets (Psets) des elements IFC cibles. "
                            "Exemples : 'INF_Protection', 'FireRating', 'LoadBearing', "
                            "'ThermalTransmittance', 'AcousticRating', 'Reference'. "
                            "La recherche est sensible a la casse et porte sur le nom de la "
                            "propriete tel qu il est defini dans le fichier IFC."
                        ),
                    },
                },

                # Les deux parametres sont obligatoires pour executer la fonction
                "required": ["type_objet", "nom_propriete"],

                # Interdire les proprietes supplementaires non declarees
                "additionalProperties": False,
            },
        },
    }
]


# =============================================================================
# DISPATCHER - executer_outil
# Appele dans la boucle de traitement des reponses OpenAI apres un tool_call
# =============================================================================

def executer_outil(chemin_ifc: str, tool_call) -> str:
    """
    Execute la fonction demandee par le LLM suite a un tool_call OpenAI.

    Arguments:
        chemin_ifc (str) : Chemin vers le fichier IFC actif dans la session.
        tool_call        : Objet tool_call retourne par l API OpenAI
                           (contient .function.name et .function.arguments).

    Retourne:
        str : Le resultat serialise en JSON, a renvoyer au LLM comme message "tool".

    Exemple d utilisation dans une boucle de conversation :
        response = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=outils_disponibles,
            tool_choice="auto",
        )
        for tool_call in response.choices[0].message.tool_calls or []:
            result_json = executer_outil(chemin_ifc, tool_call)
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result_json,
            })
    """
    nom_fonction = tool_call.function.name
    arguments = json.loads(tool_call.function.arguments)

    if nom_fonction == "verifier_propriete_ifc":
        resultat = verifier_propriete_ifc(
            chemin_ifc=chemin_ifc,
            type_objet=arguments["type_objet"],
            nom_propriete=arguments["nom_propriete"],
        )
        return json.dumps(resultat, ensure_ascii=False)

    # Fonction inconnue : retourner une erreur explicite au LLM
    return json.dumps({"erreur": f"Fonction inconnue : {nom_fonction}"})