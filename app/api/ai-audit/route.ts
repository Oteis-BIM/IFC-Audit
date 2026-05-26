import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import OpenAI from 'openai';

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

function buildEntityIndex(raw: string): Map<string, string> {
  const index = new Map<string, string>();
  const entityRegex = /(#\d+)\s*=\s*([^;]+);/g;
  let match;
  while ((match = entityRegex.exec(raw)) !== null) {
    index.set(match[1], match[2].trim());
  }
  return index;
}

function parseArgs(entityBody: string): string[] {
  const start = entityBody.indexOf('(');
  if (start === -1) return [];
  const inner = entityBody.slice(start + 1, entityBody.lastIndexOf(')'));
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function stepStr(val: string): string {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '');
}

interface IfcFacts {
  project: { name: string; longName: string; description: string; phase: string } | null;
  site: { name: string; description: string } | null;
  siteCoords: { x: number | null; y: number | null; z: number | null; src: string } | null;
  mapConversion: { easting: number | null; northing: number | null; height: number | null } | null;
  building: { name: string } | null;
  siteAddress: string | null;
}

function extractIfcFacts(raw: string): IfcFacts {
  const index = buildEntityIndex(raw);
  const facts: IfcFacts = { project: null, site: null, siteCoords: null, mapConversion: null, building: null, siteAddress: null };

  // IFCPROJECT
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCPROJECT(')) {
      const args = parseArgs(body);
      facts.project = {
        name:        stepStr(args[2] ?? ''),
        description: stepStr(args[3] ?? ''),
        longName:    stepStr(args[5] ?? ''),
        phase:       stepStr(args[6] ?? ''),
      };
      break;
    }
  }

  // IFCSITE — pos 5 = ObjectPlacement
  let sitePlacementRef: string | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCSITE(')) {
      const args = parseArgs(body);
      facts.site = {
        name:        stepStr(args[2] ?? ''),
        description: stepStr(args[3] ?? ''),
      };
      sitePlacementRef = args[5] ?? null;
      break;
    }
  }

  // IFCMAPCONVERSION (IFC4)
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCMAPCONVERSION(')) {
      const args = parseArgs(body);
      facts.mapConversion = {
        easting:  isNaN(parseFloat(args[2])) ? null : parseFloat(args[2]),
        northing: isNaN(parseFloat(args[3])) ? null : parseFloat(args[3]),
        height:   isNaN(parseFloat(args[4])) ? null : parseFloat(args[4]),
      };
      break;
    }
  }

  // Utilitaire : IFCAXIS2PLACEMENT3D -> IFCCARTESIANPOINT -> {x,y,z}
  function readCoordsFromAxis2(axis2Ref: string): { x: number | null; y: number | null; z: number | null } | null {
    if (!axis2Ref || !index.has(axis2Ref)) return null;
    const axis2Body = index.get(axis2Ref)!;
    if (!axis2Body.toUpperCase().startsWith('IFCAXIS2PLACEMENT3D(')) return null;
    const axis2Args = parseArgs(axis2Body);
    const ptRef = axis2Args[0];
    if (!ptRef || !index.has(ptRef)) return null;
    const ptBody = index.get(ptRef)!;
    if (!ptBody.toUpperCase().startsWith('IFCCARTESIANPOINT(')) return null;
    const m1 = ptBody.match(/\(\(([^)]+)\)\)/);
    const m2 = ptBody.match(/\(([^)]+)\)/);
    const coordStr = (m1 ?? m2)?.[1];
    if (!coordStr) return null;
    const parts = coordStr.split(',').map((s: string) => parseFloat(s.trim()));
    return {
      x: isNaN(parts[0]) ? null : Math.round(parts[0] * 1000),
      y: isNaN(parts[1]) ? null : Math.round(parts[1] * 1000),
      z: isNaN(parts[2]) ? null : Math.round(parts[2] * 1000),
    };
  }

  // Strategie 1 : IFCGEOMETRICREPRESENTATIONCONTEXT -> WorldCoordinateSystem
  // Revit IFC2x3 stocke les coords Lambert93 ici
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCGEOMETRICREPRESENTATIONCONTEXT(')) {
      const args = parseArgs(body);
      const wcsRef = args[4];
      if (wcsRef && wcsRef !== '$') {
        const coords = readCoordsFromAxis2(wcsRef);
        if (coords && (Math.abs(coords.x ?? 0) > 10000 || Math.abs(coords.y ?? 0) > 10000)) {
          facts.siteCoords = { ...coords, src: 'IFCGEOMETRICREPRESENTATIONCONTEXT->WorldCoordinateSystem' };
          break;
        }
      }
    }
  }

  // Strategie 2 : remontee chaine IFCLOCALPLACEMENT depuis IFCSITE
  // garde le placement avec les plus grandes coordonnees absolues
  if (!facts.siteCoords && sitePlacementRef && index.has(sitePlacementRef)) {
    let currentRef: string | null = sitePlacementRef;
    let bestCoords: { x: number | null; y: number | null; z: number | null } | null = null;
    const visited = new Set<string>();
    while (currentRef && index.has(currentRef) && !visited.has(currentRef)) {
      visited.add(currentRef);
      const placBody = index.get(currentRef)!;
      if (!placBody.toUpperCase().startsWith('IFCLOCALPLACEMENT(')) break;
      const placArgs = parseArgs(placBody);
      const parentRef = placArgs[0];
      const axis2Ref  = placArgs[1];
      if (axis2Ref) {
        const coords = readCoordsFromAxis2(axis2Ref);
        if (coords) {
          const mag     = Math.abs(coords.x ?? 0) + Math.abs(coords.y ?? 0);
          const bestMag = Math.abs(bestCoords?.x ?? 0) + Math.abs(bestCoords?.y ?? 0);
          if (mag > bestMag) bestCoords = coords;
        }
      }
      if (!parentRef || parentRef === '$') break;
      currentRef = parentRef;
    }
    if (bestCoords) facts.siteCoords = { ...bestCoords, src: 'IFCLOCALPLACEMENT(chaine)->IFCAXIS2PLACEMENT3D->IFCCARTESIANPOINT' };
  }


  // IFCBUILDING - Name (critere 4.1)
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDING(')) {
      const args = parseArgs(body);
      facts.building = { name: stepStr(args[2] ?? '') };
      break;
    }
  }

  // IFCPOSTALADDRESS - adresse du site (critere 4.2)
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
      const args = parseArgs(body);
      const addrLines = args[4];
      const town     = stepStr(args[6] ?? '');
      const zip      = stepStr(args[8] ?? '');
      const country  = stepStr(args[9] ?? '');
      const lineMatch = addrLines ? addrLines.match(/\(([^)]+)\)/) : null;
      const streetParts = lineMatch ? lineMatch[1].split(',').map((s: string) => stepStr(s.trim())).filter(Boolean) : [];
      const parts = [...streetParts, town, zip, country].filter(Boolean);
      facts.siteAddress = parts.length > 0 ? parts.join(', ') : null;
      break;
    }
  }
  return facts;
}

function extractIfcContent(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  kept.push(...lines.slice(0, 60));
  const keywords = [
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
    'IFCORGANIZATION', 'IFCAPPLICATION', 'IFCGEOMETRICREPRESENTATIONCONTEXT',
    'IFCUNITASSIGNMENT', 'IFCPOSTALADDRESS', 'IFCRELAGGREGATES',
    'FILE_DESCRIPTION', 'FILE_NAME', 'FILE_SCHEMA', 'IFCMAPCONVERSION',
  ];
  for (let i = 60; i < lines.length && kept.length < 250; i++) {
    const upper = lines[i].toUpperCase();
    if (keywords.some(k => upper.includes(k))) kept.push(lines[i]);
  }
  return kept.join('\n').slice(0, MAX_IFC_CHARS);
}

export async function POST(req: NextRequest) {
  try {
    const { fileId, fileName, discipline, criteria } = await req.json();
    type Criterion = { id: string; label: string; expected: string };
    if (!fileId || !fileName) {
      return NextResponse.json({ error: 'fileId et fileName requis' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configuree' }, { status: 500 });
    }
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });

    const cookieStore = await cookies();
    let accessToken = cookieStore.get('box_access_token')?.value;
    const refreshToken = cookieStore.get('box_refresh_token')?.value;
    if (!accessToken && refreshToken) {
      const tokens = await refreshAccessToken(refreshToken);
      accessToken = tokens.access_token;
    }
    if (!accessToken) {
      return NextResponse.json({ error: 'Non authentifie sur Box' }, { status: 401 });
    }

    const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!boxRes.ok) {
      return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });
    }

    const buffer = await boxRes.arrayBuffer();
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    const facts = extractIfcFacts(raw);
    const ifcContent = extractIfcContent(raw);

    const coords = facts.mapConversion
      ? {
          x: facts.mapConversion.easting,
          y: facts.mapConversion.northing,
          z: facts.mapConversion.height,
          src: 'IFCMAPCONVERSION',
        }
      : facts.siteCoords
      ? {
          x: facts.siteCoords.x,
          y: facts.siteCoords.y,
          z: facts.siteCoords.z,
          src: facts.siteCoords.src,
        }
      : null;

    const factsBlock = [
      '## Faits extraits par le parser serveur (valeurs 100% fiables) :',
      '',
      '### IFCPROJECT :',
      `- Name (critere 2.1)        : ${facts.project ? (facts.project.name ? `"${facts.project.name}"` : '(vide)') : 'non trouve'}`,
      `- LongName (critere 2.2)    : ${facts.project ? (facts.project.longName ? `"${facts.project.longName}"` : '(vide)') : 'non trouve'}`,
      `- Description (critere 2.3) : ${facts.project ? (facts.project.description ? `"${facts.project.description}"` : '(vide)') : 'non trouve'}`,
      `- Phase (critere 2.4)       : ${facts.project ? (facts.project.phase ? `"${facts.project.phase}"` : '(vide)') : 'non trouve'}`,
      '',
      '### IFCSITE :',
      `- Name (critere 3.1)        : ${facts.site ? (facts.site.name ? `"${facts.site.name}"` : '(vide)') : 'non trouve'}`,
      `- Description (critere 3.2) : ${facts.site ? (facts.site.description ? `"${facts.site.description}"` : '(vide)') : 'non trouve'}`,
      '',
      '### Coordonnees georeferenceees IFCSITE :',
      coords
        ? [
            `- Global Y / Nord-Sud  (critere 3.3) : ${coords.x} mm`,
            `- Global X / Est-Ouest (critere 3.4) : ${coords.y} mm`,
            `- Global Z / Elevation (critere 3.5) : ${coords.z} mm`,
            `- Source : ${coords.src}`,
          ].join('\n')
        : '- Coordonnees non trouvees dans le fichier',
    ].join('\n');

    const criteriaList: Criterion[] = Array.isArray(criteria) && criteria.length > 0 ? criteria : [];
    const criteriaText = criteriaList.map(c => `- ${c.id} | ${c.label} | Attendu : ${c.expected}`).join('\n');
    const criteriaIds = criteriaList.map(c => c.id).join(', ');

    const systemPrompt = `Tu es un expert BIM et auditeur de maquettes IFC selon le referentiel OTEIS.
Tu recois des faits extraits directement du fichier IFC par un parser cote serveur (valeurs 100% fiables).
Compare ces valeurs aux criteres attendus et retourne un statut de conformite.

Statuts possibles :
- "ok"      : valeur trouvee conforme a l attendu
- "warning" : partiellement conforme ou present mais incomplet
- "error"   : non conforme, absent ou vide
- "na"      : non applicable pour cette discipline
- "unclear" : impossible a verifier

Regles de comparaison :
- Champs texte (Name, LongName, Description, Phase) : compare exactement la valeur extraite a la valeur attendue. Vide ou absent -> "error".
- Coordonnees numeriques (en mm) : si l attendu est un nombre, compare numeriquement (ignorer les decimales si l entier est identique). Egal -> "ok", different -> "error".
- Pour les criteres 2.x et 3.x : utilise UNIQUEMENT les faits extraits ci-dessus, jamais l extrait IFC brut.
- Toujours indiquer dans le commentaire : la valeur trouvee ET la valeur attendue.
- IDs numeriques uniquement : "2.1", "3.3", jamais "B2.1" ou "C3.3".

Format de reponse JSON strict :
{
  "2.1": { "status": "ok",    "comment": "Name : '100024' conforme a l attendu '100024'." },
  "3.3": { "status": "ok",    "comment": "Global Y : 1371437363 mm conforme a l attendu 1371437363 mm." },
  "3.5": { "status": "error", "comment": "Global Z : 0 mm - attendu : 47300 mm." }
}`;

    const userPrompt = `Fichier : ${fileName} | Discipline : ${discipline || 'non precisee'}

${factsBlock}

Criteres a evaluer (ID | Libelle | Attendu) :
${criteriaText}

Extrait IFC brut (pour les criteres hors 2.x et 3.x uniquement) :
\`\`\`
${ifcContent}
\`\`\`

Retourne le JSON de conformite pour : ${criteriaIds}.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
      return NextResponse.json({ error: 'Reponse IA invalide', raw: content }, { status: 500 });
    }

    return NextResponse.json({
      results,
      facts,
      model: completion.model,
      tokensUsed: completion.usage?.total_tokens ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
