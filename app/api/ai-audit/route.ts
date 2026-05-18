import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Taille max du texte IFC extrait envoyé à l'IA (pour rester dans les limites de tokens)
const MAX_IFC_CHARS = 18000;

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

  for (let i = 60; i < lines.length && kept.length < 300; i++) {
    const upper = lines[i].toUpperCase();
    if (keywords.some(k => upper.includes(k))) kept.push(lines[i]);
  }

  return kept.join('\n').slice(0, MAX_IFC_CHARS);
}

export async function POST(req: NextRequest) {
  try {
    const { fileId, fileName, discipline } = await req.json();
    if (!fileId || !fileName) {
      return NextResponse.json({ error: 'fileId et fileName requis' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 });
    }

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
    const ifcContent = extractIfcContent(raw);

    // ── Prompt système OTEIS ─────────────────────────────────────────────────
    const systemPrompt = `Tu es un expert BIM et auditeur de maquettes IFC selon le référentiel OTEIS.
Tu analyses un extrait d'un fichier IFC (format STEP ISO 10303-21) et tu évalues la conformité de chaque critère de contrôle qualité OTEIS.

Pour chaque critère, tu retournes OBLIGATOIREMENT un statut parmi :
- "ok" : critère conforme
- "warning" : critère partiellement conforme ou impossible à vérifier précisément (présent mais incomplet)
- "error" : critère non conforme ou absent
- "na" : critère non applicable pour cette discipline/fichier

Tu retournes UNIQUEMENT un objet JSON valide, sans aucun texte autour, avec cette structure exacte :
{
  "B1.2": { "status": "ok", "comment": "..." },
  "B3.1": { "status": "warning", "comment": "..." },
  ...
}

Règles métier OTEIS :
- B1.2 : Format doit être IFC2X3 (FILE_SCHEMA dans l'en-tête STEP)
- B3.1 : IfcProject doit avoir une description de localisation du projet
- B3.2 : Le code phase (EXE, PRO, DCE, APD, AVP…) doit être renseigné dans IfcProject
- B3.3 : Description du contenu du fichier doit être renseignée dans IfcProject
- B3.4 : La phase du projet doit être renseignée dans IfcProject
- B4.1 : IfcSite doit avoir un nom
- B4.2 : IfcSite doit avoir une description
- B4.3 : IfcSite doit avoir des coordonnées géographiques (RefLatitude, RefLongitude)
- B4.4 : IfcSite doit avoir une élévation (RefElevation)
- B5.1 : IfcBuilding doit avoir un nom
- B5.2 : IfcBuilding doit avoir une description
- B5.3 : IfcBuilding doit avoir des coordonnées
- B5.4 : IfcBuilding doit avoir une élévation de référence (ElevationOfRefHeight)
- B6.1 : Les IfcBuildingStorey doivent avoir des noms conformes (RDC, R+1, SS1…)
- B6.2 : Les IfcBuildingStorey doivent avoir une description
- B6.3 : Les IfcBuildingStorey doivent avoir une élévation NGF renseignée
- C1.1 : Aucun IfcBuildingElementProxy ne doit être présent`;

    const userPrompt = `Fichier IFC à analyser :
Nom du fichier : ${fileName}
Discipline : ${discipline || 'non précisée'}

Extrait du contenu IFC :
\`\`\`
${ifcContent}
\`\`\`

Analyse ce fichier IFC et retourne le JSON de conformité pour les critères B1.2, B3.1, B3.2, B3.3, B3.4, B4.1, B4.2, B4.3, B4.4, B5.1, B5.2, B5.3, B5.4, B6.1, B6.2, B6.3, C1.1.`;

    // ── Appel OpenAI ─────────────────────────────────────────────────────────
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 1200,
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
