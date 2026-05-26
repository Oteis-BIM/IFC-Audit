import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import OpenAI from 'openai';

// Taille max du texte IFC extrait envoyé à l'IA (pour rester dans les limites de tokens)
const MAX_IFC_CHARS = 18000;

// NOTE: openai client est instancié DANS le handler POST pour éviter les erreurs de build
// quand OPENAI_API_KEY n'est pas définie au moment du build Vercel.

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BOX_CLIENT_ID!,
      client_secret: process.env.BOX_CLIENT_SECRET!,
    }),
  });
  return res.json();
}

// Extrait les lignes pertinentes d'un fichier IFC pour l'analyse
// On garde l'en-tête FILE_DESCRIPTION/FILE_NAME/FILE_SCHEMA + les entités clés
function extractIfcContent(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];

  // Toujours garder les 60 premières lignes (header STEP)
  kept.push(...lines.slice(0, 60));

  // Chercher les entités importantes
  const keywords = [
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
    'IFCORGANIZATION', 'IFCAPPLICATION', 'IFCGEOMETRICREPRESENTATIONCONTEXT',
    'IFCUNITASSIGNMENT', 'IFCPOSTALADDRESS', 'IFCRELAGGREGATES',
    'FILE_DESCRIPTION', 'FILE_NAME', 'FILE_SCHEMA',
  ];
  // Priorité : s'assurer que IFCPROJECT et IFCSITE sont toujours inclus en entier
  const priorityLines: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (
      upper.includes('IFCPROJECT(') ||
      upper.includes('IFCSITE(') ||
      upper.includes('IFCLOCALPLACEMENT(') ||
      upper.includes('IFCAXIS2PLACEMENT3D(') ||
      upper.includes('IFCCARTESIANPOINT(')
    ) {
      priorityLines.push(line);
    }
  }

  for (let i = 60; i < lines.length && kept.length < 300; i++) {
    const upper = lines[i].toUpperCase();
    if (keywords.some(k => upper.includes(k))) kept.push(lines[i]);
  }
  // Ajouter les lignes prioritaires si pas déjà présentes
  for (const l of priorityLines) {
    if (!kept.includes(l)) kept.push(l);
  }

  return kept.join('\n').slice(0, MAX_IFC_CHARS);
}

export async function POST(req: NextRequest) {
  try {
    const { fileId, fileName, discipline, criteria } = await req.json();
    type Criterion = { id: string; label: string; expected: string };
    if (!fileId || !fileName) {
      return NextResponse.json({ error: 'fileId et fileName requis' }, { status: 400 });
    }    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 });
    }    // Instanciation ici pour éviter un crash au build si la clé est absente
    // Supporte OpenAI ET GitHub Models (via OPENAI_BASE_URL)
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });

    // ── Récupérer le fichier IFC depuis Box ──────────────────────────────────
    const cookieStore = await cookies();
    let accessToken = cookieStore.get('box_access_token')?.value;
    const refreshToken = cookieStore.get('box_refresh_token')?.value;

    if (!accessToken && refreshToken) {
      const tokens = await refreshAccessToken(refreshToken);
      accessToken = tokens.access_token;
    }
    if (!accessToken) {
      return NextResponse.json({ error: 'Non authentifié sur Box' }, { status: 401 });
    }

    const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!boxRes.ok) {
      return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });
    }

    const buffer = await boxRes.arrayBuffer();
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    const ifcContent = extractIfcContent(raw);    // ── Prompt système OTEIS ─────────────────────────────────────────────────
    // Construire la liste des critères depuis ce qui est passé par le client
    const criteriaList: Criterion[] = Array.isArray(criteria) && criteria.length > 0
      ? criteria
      : [];

    const criteriaText = criteriaList.map(c =>
      `- ${c.id} | ${c.label} | Attendu : ${c.expected}`
    ).join('\n');

    const criteriaIds = criteriaList.map(c => c.id).join(', ');    const systemPrompt = `Tu es un expert BIM et auditeur de maquettes IFC selon le référentiel OTEIS.
Tu analyses un extrait d'un fichier IFC (format STEP ISO 10303-21) et tu évalues la conformité de chaque critère fourni.

Pour chaque critère, tu retournes OBLIGATOIREMENT un statut parmi :
- "ok" : critère conforme à l'attendu
- "warning" : critère partiellement conforme, présent mais incomplet, ou vérification partielle possible
- "error" : critère non conforme ou absent
- "na" : critère non applicable pour cette discipline ou ce type de fichier
- "unclear" : l'attendu est trop vague ou le critère ne peut pas être vérifié depuis un fichier IFC (ex : vérification visuelle, clash détection, règles de modélisation subjectives)

IMPORTANT :
- Utilise "unclear" si l'attendu nécessite une intervention humaine ou une vérification visuelle
- Utilise "na" uniquement si le critère est clairement hors périmètre pour cette discipline
- Ne devine pas : si tu ne peux pas vérifier depuis l'extrait IFC, dis "unclear"
- Le commentaire doit expliquer précisément ce que tu as trouvé (ou pas trouvé) dans le fichier

## Analyse de l'entité IFCPROJECT (critères 2.1, 2.2, 2.3, 2.4)

L'entité IFCPROJECT dans un fichier IFC STEP a la forme :
  #N= IFCPROJECT('GlobalId',OwnerHistory,'Name','Description','ObjectType','LongName','Phase',(...),(#...));

Les positions des champs (0-based après la parenthèse ouvrante) :
  2 = Name        → critère 2.1 "Code (Name)"
  3 = Description → critère 2.3
  5 = LongName    → critère 2.2
  6 = Phase       → critère 2.4

Pour les critères 2.1, 2.2, 2.3, 2.4 :
- Extrais la valeur réelle du champ correspondant dans la ligne IFCPROJECT (entre apostrophes)
- Compare-la à la valeur "Attendu" fournie (valeur exacte saisie par l'utilisateur)
- Valeur conforme → "ok" ; présente mais différente → "error" ; vide ('') ou $ → "error"
- Toujours indiquer dans le commentaire : valeur trouvée et valeur attendue

## Analyse de l'entité IFCSITE (critères 3.1, 3.2, 3.3, 3.4, 3.5)

L'entité IFCSITE dans un fichier IFC STEP a la forme :
  #N= IFCSITE('GlobalId',OwnerHistory,'Name','Description','ObjectType','LongName',#Placement,#Representation,'SiteAddress',CompositionType,RefLatitude,RefLongitude,RefElevation,'LandTitleNumber',PostalAddress);

Les positions des champs :
  2 = Name        → critère 3.1 "Nom (Name)"
  3 = Description → critère 3.2 "Description"
  7 = ObjectPlacement (référence #N vers IFCLOCALPLACEMENT)

Pour les coordonnées Global X, Y, Z (critères 3.3, 3.4, 3.5) — MÉTHODE STRICTE :
Étape 1 : Trouve la ligne IFCSITE dans l'extrait. Note le numéro de référence en position 7 (ObjectPlacement), ex: si la ligne est "#10= IFCSITE(...,#42,...)" → le placement est #42.
Étape 2 : Trouve la ligne "#42= IFCLOCALPLACEMENT(...)". Dans cette ligne, note la référence du placement relatif (2e argument), ex: "#43= IFCAXIS2PLACEMENT3D(...)".
Étape 3 : Trouve la ligne "#43= IFCAXIS2PLACEMENT3D(#44,...)". Note la référence du point (1er argument), ex: #44.
Étape 4 : Trouve la ligne "#44= IFCCARTESIANPOINT((X.,Y.,Z.))". Les coordonnées X, Y, Z sont en MILLIMÈTRES.
  - Y = Global Y (Nord/Sud)   → critère 3.3
  - X = Global X (Est/Ouest)  → critère 3.4
  - Z = Global Z (Élévation)  → critère 3.5

ATTENTION : Ne pas prendre n'importe quel IFCCARTESIANPOINT. Suivre STRICTEMENT la chaîne depuis IFCSITE.
- Si la valeur "Attendu" est un nombre (ex: "1371437363"), compare-la numériquement à la valeur trouvée (en mm)
- Si les valeurs sont égales → "ok" ; si différentes → "error" avec les deux valeurs dans le commentaire
- Si coordonnées toutes à 0 → "warning" (peut être volontaire ou erreur)
- Toujours indiquer dans le commentaire : la valeur exacte trouvée dans le fichier et la valeur attendue

Tu retournes UNIQUEMENT un objet JSON valide, sans aucun texte autour, avec cette structure exacte :
{
  "1.2": { "status": "ok", "comment": "FILE_SCHEMA indique IFC2X3, conforme." },
  "2.1": { "status": "ok", "comment": "Name trouvé : 'OTEIS_PRJ_001' — correspond à la valeur attendue." },
  "2.2": { "status": "error", "comment": "LongName vide ('') — attendu : 'Projet Hôpital Nord'." },
  "6.1": { "status": "unclear", "comment": "Vérification visuelle requise, impossible depuis l'extrait IFC." },
  ...
}

IMPORTANT : Les IDs des critères sont NUMÉRIQUES (ex: "1.1", "2.3", "6.7"), PAS des lettres (pas de "B1.1" ni "C2.3").
Utilise EXACTEMENT les IDs qui te sont fournis dans la liste des critères, sans les modifier.`;    const userPrompt = `Fichier IFC à analyser :
Nom du fichier : ${fileName}
Discipline : ${discipline || 'non précisée'}

Critères à évaluer (ID | Libellé | Attendu) :
${criteriaText}

Instructions de lecture du fichier IFC :
- Critères 2.1/2.2/2.3/2.4 : cherche la ligne IFCPROJECT, extrais Name (pos 2), LongName (pos 5), Description (pos 3), Phase (pos 6) et compare aux valeurs attendues.
- Critères 3.1/3.2 : cherche la ligne IFCSITE, extrais Name (pos 2) et Description (pos 3) et compare aux valeurs attendues.
- Critères 3.3/3.4/3.5 : cherche IFCSITE → note la ref #N en pos 7 → cherche cette ligne IFCLOCALPLACEMENT → note la ref IFCAXIS2PLACEMENT3D → note la ref IFCCARTESIANPOINT → lis les coordonnées ((X,Y,Z)) en mm. Y=Nord/Sud (3.3), X=Est/Ouest (3.4), Z=Élévation (3.5). NE PAS utiliser un IFCCARTESIANPOINT aléatoire.

Extrait du contenu IFC :
\`\`\`
${ifcContent}
\`\`\`

Analyse ce fichier IFC et retourne le JSON de conformité pour les critères : ${criteriaIds}.`;

    // ── Appel OpenAI ─────────────────────────────────────────────────────────
    const completion = await openai.chat.completions.create({      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content ?? '{}';
    let results: Record<string, { status: string; comment: string }>;
    try {
      results = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: 'Réponse IA invalide', raw: content }, { status: 500 });
    }

    return NextResponse.json({
      results,
      model: completion.model,
      tokensUsed: completion.usage?.total_tokens ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
