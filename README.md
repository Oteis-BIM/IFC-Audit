# 🚀 IFC-AUDIT
> Une application web pour controler des maquettes au format IFC, moderne et performante propulsée par Next.js et déployée sur Vercel.

---

## 📌 Objectifs du Projet
* [ ] Mettre en place une application web pour controler des maquettes au format .ifc
* [ ] Créer une interface utilisateur fluide et rapide avec Next.js
* [ ] Les controles devront etre définis et une IA devra s'assurer de la conformité (ou non) des maquettes.
* [ ] Assurer un déploiement continu et des performances optimales sur Vercel.

## 🛠️ Stack Technique & Hébergement
- **Framework :** [Next.js 15](https://nextjs.org) (App Router) & React 19
- **Hébergement & CI/CD :** [Vercel](https://vercel.com)
- **Backend / Base de données :** Supabase (PostgreSQL) & Prisma ORM
- **Gestion d'état :** Zustand
- **Styling :** TailwindCSS & Shadcn/ui
- **Langage :** TypeScript (Mode strict activé)

---

## 📂 Architecture du Projet
Pour garder un code propre, on respecte scrupuleusement cette structure :
- `/app` : Pages, layouts et routes de l'API Next.js.
- `/components/ui` : Composants graphiques atomiques et réutilisables (Shadcn/ui).
- `/hooks` : Custom hooks React pour la logique réutilisable.
- `/prisma` : Schémas et migrations de la base de données.
- `/store` : Gestion d'état globale (Zustand).

---

## 🎨 Conventions de Code (Strictes)
- **Langue :** Écris le code (variables, fonctions, composants) en **anglais**, mais rédige tous les commentaires et messages de commit en **français**.
- **Composants :** Utilise des composants fonctionnels avec des flèches (`const MonComposant = () => {}`).
- **Typage :** Interdiction d'utiliser le type `any`. Crée des `interface` ou des `type` TypeScript explicites pour chaque donnée.
- **Styles :** Utilise exclusivement les classes utilitaires de TailwindCSS. Ne crée pas de fichiers CSS séparés.

---

## 🗺️ Feuille de Route (Roadmap)



---

## ⚙️ Prise en main en Local

Pour lancer le serveur de développement local :
```bash
npm run dev