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
  storeys: { name: string; elevation: number | null }[];
}

function extractIfcFacts(raw: string, projectNgfOffsetMm?: number): IfcFacts {
  const index = buildEntityIndex(raw);
  const facts: IfcFacts = { project: null, site: null, siteCoords: null, mapConversion: null, building: null, siteAddress: null, storeys: [] };

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

  // IFCSITE — pos 5 = ObjectPlacement, pos 12 = RefElevation (NGF en mètres, IFC2x3/IFC4)
  let sitePlacementRef: string | null = null;
  let siteRefElevationMm: number | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCSITE(')) {
      const args = parseArgs(body);
      facts.site = {
        name:        stepStr(args[2] ?? ''),
        description: stepStr(args[3] ?? ''),
      };
      sitePlacementRef = args[5] ?? null;
      // args[11] = RefElevation (NGF du projet en mètres, IFC2x3 et IFC4)
      const refElev = parseFloat(args[11] ?? '$');
      if (!isNaN(refElev)) siteRefElevationMm = Math.round(refElev * 1000);
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


  // IFCBUILDING - Name (critere 4.1) + ref BuildingAddress (critere 4.2)
  let buildingAddressRef: string | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDING(')) {
      const args = parseArgs(body);
      facts.building = { name: stepStr(args[2] ?? '') };
      // args[11] = BuildingAddress (ref vers IFCPOSTALADDRESS)
      const ref = (args[11] ?? '').trim();
      if (ref && ref !== '$') buildingAddressRef = ref;
      break;
    }
  }

  // Utilitaire : parse une entite IFCPOSTALADDRESS depuis son body
  function parsePostalAddress(body: string): string | null {
    const args = parseArgs(body);
    const addrLines = args[4];
    const town    = stepStr(args[6] ?? '');
    const zip     = stepStr(args[8] ?? '');
    const country = stepStr(args[9] ?? '');
    const lineMatch = addrLines ? addrLines.match(/\(([^)]+)\)/) : null;
    const streetParts = lineMatch ? lineMatch[1].split(',').map((s: string) => stepStr(s.trim())).filter(Boolean) : [];
    const parts = [...streetParts, town, zip, country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  // IFCPOSTALADDRESS - critere 4.2
  // Priorite 1 : reference directe depuis IFCBUILDING.BuildingAddress
  if (buildingAddressRef && index.has(buildingAddressRef)) {
    const addrBody = index.get(buildingAddressRef)!;
    if (addrBody.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
      facts.siteAddress = parsePostalAddress(addrBody);
    }
  }
  // Priorite 2 : fallback sur la premiere IFCPOSTALADDRESS du fichier
  if (!facts.siteAddress) {
    for (const [, body] of index) {
      if (body.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
        facts.siteAddress = parsePostalAddress(body);
        break;
      }
    }
  }

  // IFCBUILDINGSTOREY — niveaux NGF (critère 5.x)
  // args[2] = Name, args[9] = Elevation RELATIVE au projet (en mètres)
  // NGF = élévation relative (mm) + offset NGF du projet (mm)
  // Priorité : RefElevation de IFCSITE > IFCMAPCONVERSION.height > 0
  const zOffsetMm: number =
    siteRefElevationMm !== null
      ? siteRefElevationMm
      : facts.mapConversion?.height != null
      ? Math.round(facts.mapConversion.height * 1000)
      : facts.siteCoords?.z != null
      ? facts.siteCoords.z
      : projectNgfOffsetMm != null && !isNaN(projectNgfOffsetMm)
      ? projectNgfOffsetMm
      : 0;

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDINGSTOREY(')) {
      const args = parseArgs(body);
      const name = stepStr(args[2] ?? '');
      const elevRaw = args[9] ?? '$';
      const elevRelM = elevRaw === '$' ? null : parseFloat(elevRaw);
      const elevNgfMm = elevRelM === null || isNaN(elevRelM)
        ? null
        : Math.round(elevRelM * 1000) + zOffsetMm;
      facts.storeys.push({ name, elevation: elevNgfMm });
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
    const { fileId, fileName, discipline, criteria, ngfOffsetMm } = await req.json();
    type Criterion = { id: string; label: string; expected: string };

    // Dériver l'offset NGF depuis le critère 3.5 (Élévation Z attendue = niveau NGF du projet)
    // Priorité : paramètre explicite ngfOffsetMm > critère 3.5 attendu
    const criteriaList: Criterion[] = Array.isArray(criteria) && criteria.length > 0 ? criteria : [];
    const crit35 = criteriaList.find(c => c.id === '3.5');
    const crit35Mm = crit35 ? parseFloat(crit35.expected) : NaN;
    const resolvedNgfOffsetMm: number | undefined =
      typeof ngfOffsetMm === 'number' && !isNaN(ngfOffsetMm)
        ? ngfOffsetMm
        : !isNaN(crit35Mm)
        ? crit35Mm
        : undefined;
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

    const facts = extractIfcFacts(raw, resolvedNgfOffsetMm);
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
      '### IFCBUILDING :',
      `- Name (critere 4.1)        : ${facts.building ? (facts.building.name ? `"${facts.building.name}"` : '(vide)') : 'non trouve'}`,
      `- BuildingAddress (critere 4.2) : ${facts.siteAddress ? `"${facts.siteAddress}"` : '(vide)'}`,
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
      '',
      '### IFCBUILDINGSTOREY — Altimetries NGF calculees par le parser (criteres 5.x) :',
      '⚠️ ATTENTION : Ces valeurs sont en mm NGF (altitude absolue = elevation relative IFC + offset NGF du site). Ne pas confondre avec les elevations relatives brutes du fichier IFC.',
      facts.storeys.length > 0
        ? facts.storeys.map(s => `- Niveau "${s.name}" : ${s.elevation !== null ? `${s.elevation} mm NGF` : '(elevation non definie)'}`).join('\n')
        : '- Aucun niveau trouve',
    ].join('\n');

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
- Pour les criteres 2.x, 3.x et 4.x : utilise UNIQUEMENT les faits extraits ci-dessus, jamais l extrait IFC brut.
- Pour les criteres 5.x : utilise UNIQUEMENT les altimetries NGF de la section IFCBUILDINGSTOREY ci-dessus (valeurs en mm NGF calculees par le parser). NE JAMAIS utiliser les elevations brutes de l extrait IFC. Tolerance : ±50 mm.
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
