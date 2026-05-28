"""
agent_ifc.py
============
Script principal d orchestration du Function Calling IFC.

Ce script connecte trois composants :
    1. L utilisateur (question en langage naturel)
    2. Le LLM OpenAI (GPT-4o) qui decide quand et comment appeler l outil
    3. L outil Python verifier_propriete_ifc qui interroge le fichier IFC reel

Flux d execution (Function Calling en 2 passes) :
    Question user
        --> [1ere passe] LLM decide d appeler un outil
            --> Execution Python de l outil (lecture fichier IFC)
                --> [2eme passe] LLM formule la reponse finale en langage naturel
                    --> Reponse affichee

Dependances :
    pip install openai ifcopenshell

Configuration :
    Definir la variable d environnement OPENAI_API_KEY avant d executer ce script.
    Modifier CHEMIN_MAQUETTE pour pointer vers votre fichier IFC local.

Usage :
    python scripts/agent_ifc.py
    python scripts/agent_ifc.py --question "Tous les IfcWall ont-ils la propriete FireRating ?"
    python scripts/agent_ifc.py --ifc chemin/vers/maquette.ifc
"""

import os
import json
import argparse
import sys

# Import du client OpenAI
from openai import OpenAI

# Import de notre outil IFC et de son schema (depuis le meme dossier scripts/)
# Si execute depuis la racine du projet : python scripts/agent_ifc.py
sys.path.insert(0, os.path.dirname(__file__))
from ifc_tools import verifier_propriete_ifc, outils_disponibles


# =============================================================================
# CONFIGURATION GLOBALE
# =============================================================================

# Chemin vers le fichier IFC local a auditer.
# Peut etre override via --ifc en ligne de commande ou la variable d env IFC_PATH.
CHEMIN_MAQUETTE = os.environ.get("IFC_PATH", "maquette.ifc")

# Modele OpenAI a utiliser (supporte le Function Calling)
MODELE_LLM = "gpt-4o-mini"

# Prompt systeme : donne le contexte BIM au LLM
PROMPT_SYSTEME = (
    "Tu es un expert BIM (Building Information Modeling) specialise dans l audit de maquettes IFC. "
    "Tu as acces a un outil Python qui peut interroger directement un fichier IFC pour verifier "
    "la presence de proprietes sur des elements. "
    "Utilise cet outil chaque fois qu un utilisateur te demande de verifier une propriete sur des elements IFC. "
    "Presente les resultats de facon claire, en expliquant le taux de conformite et en citant "
    "les elements non conformes si necessaire. "
    "Reponds toujours en francais."
)


# =============================================================================
# FONCTION PRINCIPALE - poser_question_au_batiment
# =============================================================================

def poser_question_au_batiment(question_utilisateur: str, chemin_ifc: str = CHEMIN_MAQUETTE) -> str:
    """
    Orchestre le dialogue entre l utilisateur, le LLM et l outil IFC.

    Flux :
        1. Envoie la question au LLM avec la liste des outils disponibles
        2. Si le LLM decide d appeler un outil : execute la fonction Python et renvoie
           le resultat au LLM pour une reponse finale en langage naturel
        3. Si le LLM repond directement (sans outil) : retourne la reponse telle quelle

    Arguments:
        question_utilisateur (str) : Question posee en langage naturel.
        chemin_ifc           (str) : Chemin vers le fichier IFC a auditer.

    Retourne:
        str : Reponse finale du LLM en langage naturel.
    """

    # Verification de la cle API
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return "[ERREUR] Variable d environnement OPENAI_API_KEY non definie."

    # Initialisation du client OpenAI
    client = OpenAI(api_key=api_key)

    print(f"\n[Agent IFC] Question : {question_utilisateur}")
    print(f"[Agent IFC] Maquette : {chemin_ifc}")
    print("-" * 60)

    # Construction de l historique des messages (commence avec la question utilisateur)
    messages = [
        {"role": "system", "content": PROMPT_SYSTEME},
        {"role": "user",   "content": question_utilisateur},
    ]

    # -------------------------------------------------------------------------
    # ETAPE A : 1ere passe — envoi de la question au LLM avec les outils
    # Le LLM peut soit repondre directement, soit demander l execution d un outil
    # -------------------------------------------------------------------------
    print("[1/2] Envoi de la question au LLM...")

    reponse_1 = client.chat.completions.create(
        model=MODELE_LLM,
        messages=messages,
        tools=outils_disponibles,   # Schema des outils disponibles
        tool_choice="auto",         # Le LLM decide seul s il utilise un outil
        temperature=0.2,
    )

    message_llm = reponse_1.choices[0].message
    raison_fin  = reponse_1.choices[0].finish_reason

    # -------------------------------------------------------------------------
    # ETAPE B : Verifier si le LLM a demande l execution d un outil
    # finish_reason == "tool_calls" signifie que le LLM veut appeler un outil
    # -------------------------------------------------------------------------
    if raison_fin != "tool_calls" or not message_llm.tool_calls:
        # ETAPE D : Aucun outil appele — le LLM a repondu directement
        reponse_directe = message_llm.content or "(reponse vide)"
        print("[Agent IFC] Reponse directe (pas d appel d outil) :")
        print(reponse_directe)
        return reponse_directe

    # -------------------------------------------------------------------------
    # ETAPE C : Un ou plusieurs outils ont ete demandes par le LLM
    # On ajoute le message du LLM dans l historique (obligatoire pour OpenAI)
    # -------------------------------------------------------------------------
    messages.append(message_llm)   # Message assistant avec tool_calls

    print(f"[Agent IFC] Le LLM a demande {len(message_llm.tool_calls)} appel(s) d outil.")

    # Traitement de chaque appel d outil (le LLM peut en demander plusieurs)
    for tool_call in message_llm.tool_calls:
        nom_fonction = tool_call.function.name
        print(f"[2/2] Execution de l outil : {nom_fonction}")

        # Verifier que c est bien notre outil IFC (securite)
        if nom_fonction != "verifier_propriete_ifc":
            resultat_json = json.dumps({"erreur": f"Outil inconnu : {nom_fonction}"})
        else:
            # Extraire les arguments fournis par le LLM (format JSON texte)
            try:
                arguments = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError as e:
                resultat_json = json.dumps({"erreur": f"Arguments invalides : {e}"})
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": resultat_json,
                })
                continue

            type_objet    = arguments.get("type_objet", "")
            nom_propriete = arguments.get("nom_propriete", "")
            print(f"     type_objet    = {type_objet}")
            print(f"     nom_propriete = {nom_propriete}")

            # Execution reelle de la fonction Python sur le fichier IFC
            resultat = verifier_propriete_ifc(
                chemin_ifc=chemin_ifc,
                type_objet=type_objet,
                nom_propriete=nom_propriete,
            )
            resultat_json = json.dumps(resultat, ensure_ascii=False)
            print(f"     Resultat : {resultat_json[:200]}{'...' if len(resultat_json) > 200 else ''}")

        # Ajouter le resultat de l outil dans l historique (role "tool")
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,   # Lien obligatoire avec le tool_call du LLM
            "content": resultat_json,
        })

    # -------------------------------------------------------------------------
    # 2eme passe : renvoyer l historique complet au LLM pour la reponse finale
    # Le LLM connait maintenant les resultats reels et peut formuler sa synthese
    # -------------------------------------------------------------------------
    print("[Agent IFC] 2eme passe : formulation de la reponse finale...")

    reponse_finale = client.chat.completions.create(
        model=MODELE_LLM,
        messages=messages,
        temperature=0.3,
    )

    contenu_final = reponse_finale.choices[0].message.content or "(reponse vide)"

    print("\n[Agent IFC] Reponse finale :")
    print("=" * 60)
    print(contenu_final)
    print("=" * 60)

    return contenu_final


# =============================================================================
# POINT D ENTREE — Exemple d utilisation et mode CLI
# =============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Agent IFC : pose des questions en langage naturel sur une maquette IFC."
    )
    parser.add_argument(
        "--question", "-q",
        default="Peux-tu m indiquer si tous les IfcFlowTerminal ont la propriete INF_Protection ?",
        help="Question a poser sur la maquette IFC."
    )
    parser.add_argument(
        "--ifc", "-i",
        default=CHEMIN_MAQUETTE,
        help=f"Chemin vers le fichier IFC (defaut: {CHEMIN_MAQUETTE})."
    )
    args = parser.parse_args()


    reponse = poser_question_au_batiment(
        question_utilisateur=args.question,
        chemin_ifc=args.ifc,
    )
    
    # Écrit la réponse finale brute à la toute fin pour que Node.js puisse la capturer
    sys.stdout.write(f"\nRESULTAT_FINAL:{reponse}")