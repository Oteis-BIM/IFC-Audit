import { writeFileSync } from 'fs';

const code = `import { NextRequest, NextResponse } from 'next/server';
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
  const entityRegex = /(#\\d+)\\s*=\\s*([^;]+);/g;
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
  siteCoords: { x: number | null; y: number | null; z: number | null } | null;
  mapConversion: { easting: number | null; northing: number | null; height: number | null } | null;
  building: { name: string } | null;
  siteAddress: string | null;
}

function extractIfcFacts(raw: string): IfcFacts {
  const index = buildEntityIndex(raw);
  const facts: IfcFacts = { project: null, site: null, siteCoords: null, mapConversion: null, building: null, siteAddress: null };

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

  let sitePlacementRef: string | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCSITE(')) {
      const args = parseArgs(body);
      facts.site = { name: stepStr(args[2] ?? ''), description: stepStr(args[3] ?? '') };
      sitePlacementRef = args[5] ?? null;
      break;
    }
  }

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

  function readCoordsFromAxis2(axis2Ref: string): { x: number | null; y: number | null; z: number | null } | null {
    if (!axis2Ref || !index.has(axis2Ref)) return null;
    const axis2Body = index.get(axis2Ref)!;
    if (!axis2Body.toUpperCase().startsWith('IFCAXIS2PLACEMENT3D(')) return null;
    const axis2Args = parseArgs(axis2Body);
    const ptRef = axis2Args[0];
    if (!ptRef || !index.has(ptRef)) return null;
    const ptBody = index.get(ptRef)!;
    if (!ptBody.toUpperCase().startsWith('IFCCARTESIANPOINT(')) return null;
    const m1 = ptBody.match(/\\(\\(([^)]+)\\)\\)/);
    const m2 = ptBody.match(/\\(([^)]+)\\)/);
    const coordStr = (m1 ?? m2)?.[1];
    if (!coordStr) return null;
    const parts = coordStr.split(',').map(s => parseFloat(s.trim()));
    return {
      x: isNaN(parts[0]) ? null : Math.round(parts[0] * 1000),
      y: isNaN(parts[1]) ? null : Math.round(parts[1] * 1000),
      z: isNaN(parts[2]) ? null : Math.round(parts[2] * 1000),
    };
  }

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCGEOMETRICREPRESENTATIONCONTEXT(')) {
      const args = parseArgs(body);
      const wcsRef = args[4];
      if (wcsRef && wcsRef !== '$') {
        const coords = readCoordsFromAxis2(wcsRef);
        if (coords && (Math.abs(coords.x ?? 0) > 10000 || Math.abs(coords.y ?? 0) > 10000)) {
          facts.siteCoords = coords;
          break;
        }
      }
    }
  }

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
    if (bestCoords) facts.siteCoords = bestCoords;
  }

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDING(')) {
      const args = parseArgs(body);
      facts.building = { name: stepStr(args[2] ?? '') };
      break;
    }
  }

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
      const args = parseArgs(body);
      const addressLines = args[4]?.startsWith('(')
        ? args[4].slice(1, -1).split(',').map(s => stepStr(s.trim())).filter(Boolean)
        : [];
      const town       = stepStr(args[5] ?? '');
      const postalCode = stepStr(args[7] ?? '');
      const country    = stepStr(args[8] ?? '');
      const parts = [...addressLines, town, postalCode, country].filter(Boolean);
      facts.siteAddress = parts.length > 0 ? parts.join(' \\u2013 ') : null;
      break;
    }
  }

  return facts;
}

function extractIfcContent(raw: string): string {
  const lines = raw.split('\\n');
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
  return kept.join('\\n').slice(0, MAX_IFC_CHARS);
}

type EvalResult = { status: string; comment: string };

function evaluateParsedCriteria(
  criteriaList: { id: string; label: string; expected: string }[],
  facts: IfcFacts,
  coords: { x: number | null; y: number | null; z: number | null; src: string } | null
): Record<string, EvalResult> {
  const out: Record<string, EvalResult> = {};

  function textResult(id: string, label: string, found: string | null | undefined, expected: string): EvalResult {
    if (found === null || found === undefined) {
      return { status: 'error', comment: \`\${label} : non trouv\\u00e9 dans le fichier \\u2014 attendu : '\${expected}'.\` };
    }
    if (!expected) {
      return found
        ? { status: 'ok',    comment: \`\${label} : '\${found}' \\u2014 pr\\u00e9sent.\` }
        : { status: 'error', comment: \`\${label} : vide.\` };
    }
    if (found === expected) {
      return { status: 'ok', comment: \`\${label} : '\${found}' \\u2014 conforme \\u00e0 l'attendu '\${expected}'.\` };
    }
    if (found.toLowerCase() === expected.toLowerCase()) {
      return { status: 'warning', comment: \`\${label} : '\${found}' \\u2014 conforme \\u00e0 la casse pr\\u00e8s (attendu '\${expected}').\` };
    }
    if (id === '4.2' && found.toLowerCase().includes(expected.toLowerCase())) {
      return { status: 'warning', comment: \`Adresse : '\${found}' partiellement conforme \\u00e0 l'attendu '\${expected}'.\` };
    }
    return { status: 'error', comment: \`\${label} : '\${found}' \\u2014 attendu : '\${expected}'.\` };
  }

  function numResult(_id: string, label: string, found: number | null | undefined, expected: string): EvalResult {
    if (found === null || found === undefined) {
      return { status: 'error', comment: \`\${label} : non trouv\\u00e9 \\u2014 attendu : \${expected}.\` };
    }
    if (!expected) return { status: 'ok', comment: \`\${label} : \${found} mm \\u2014 pr\\u00e9sent.\` };
    const exp = parseFloat(expected);
    if (isNaN(exp)) return { status: 'unclear', comment: \`\${label} : \${found} mm \\u2014 attendu non num\\u00e9rique : '\${expected}'.\` };
    if (Math.round(found) === Math.round(exp)) return { status: 'ok', comment: \`\${label} : \${found} mm \\u2014 conforme \\u00e0 l'attendu \${exp} mm.\` };
    return { status: 'error', comment: \`\${label} : \${found} mm \\u2014 attendu : \${exp} mm.\` };
  }

  for (const c of criteriaList) {
    switch (c.id) {
      case '2.1': out[c.id] = textResult(c.id, 'Name',             facts.project?.name,        c.expected); break;
      case '2.2': out[c.id] = textResult(c.id, 'LongName',         facts.project?.longName,    c.expected); break;
      case '2.3': out[c.id] = textResult(c.id, 'Description',      facts.project?.description, c.expected); break;
      case '2.4': out[c.id] = textResult(c.id, 'Phase',            facts.project?.phase,       c.expected); break;
      case '3.1': out[c.id] = textResult(c.id, 'Site Name',        facts.site?.name,           c.expected); break;
      case '3.2': out[c.id] = textResult(c.id, 'Site Description', facts.site?.description,    c.expected); break;
      case '3.3': out[c.id] = numResult( c.id, 'Global Y / Nord-Sud',  coords?.y,              c.expected); break;
      case '3.4': out[c.id] = numResult( c.id, 'Global X / Est-Ouest', coords?.x,              c.expected); break;
      case '3.5': out[c.id] = numResult( c.id, 'Global Z / Elevation', coords?.z,              c.expected); break;
      case '4.1': out[c.id] = textResult(c.id, 'Building Name',    facts.building?.name,       c.expected); break;
      case '4.2': out[c.id] = textResult(c.id, 'Adresse',          facts.siteAddress,          c.expected); break;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const { fileId, fileName, discipline, criteria } = await req.json();
    type Criterion = { id: string; label: string; expected: string };
    if (!fileId || !fileName) {
      return NextResponse.json({ error: 'fileId et fileName requis' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 });
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
      return NextResponse.json({ error: 'Non authentifié sur Box' }, { status: 401 });
    }

    const boxRes = await fetch(\`https://api.box.com/2.0/files/\${fileId}/content\`, {
      headers: { Authorization: \`Bearer \${accessToken}\` },
    });
    if (!boxRes.ok) {
      return NextResponse.json({ error: \`Erreur Box \${boxRes.status}\` }, { status: 502 });
    }

    const buffer = await boxRes.arrayBuffer();
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    const facts = extractIfcFacts(raw);
    const ifcContent = extractIfcContent(raw);

    const coords = facts.mapConversion
      ? { x: facts.mapConversion.easting, y: facts.mapConversion.northing, z: facts.mapConversion.height, src: 'IFCMAPCONVERSION' }
      : facts.siteCoords
      ? { x: facts.siteCoords.x, y: facts.siteCoords.y, z: facts.siteCoords.z, src: 'IFCLOCALPLACEMENT\\u2192IFCAXIS2PLACEMENT3D\\u2192IFCCARTESIANPOINT' }
      : null;

    const criteriaList: Criterion[] = Array.isArray(criteria) && criteria.length > 0 ? criteria : [];

    const PARSED_IDS = new Set(['2.1','2.2','2.3','2.4','3.1','3.2','3.3','3.4','3.5','4.1','4.2']);
    const parsedCriteria = criteriaList.filter(c => PARSED_IDS.has(c.id));
    const aiCriteria     = criteriaList.filter(c => !PARSED_IDS.has(c.id));

    const serverResults = evaluateParsedCriteria(parsedCriteria, facts, coords);

    if (aiCriteria.length === 0) {
      return NextResponse.json({ results: serverResults, facts, model: 'server-parser', tokensUsed: 0 });
    }

    const factsBlock = [
      '## Faits extraits par le parser serveur :',
      '',
      '### IFCPROJECT :',
      \`- Name (2.1)        : \${facts.project ? (facts.project.name        ? \`"\${facts.project.name}"\`        : '(vide)') : 'non trouvé'}\`,
      \`- LongName (2.2)    : \${facts.project ? (facts.project.longName    ? \`"\${facts.project.longName}"\`    : '(vide)') : 'non trouvé'}\`,
      \`- Description (2.3) : \${facts.project ? (facts.project.description ? \`"\${facts.project.description}"\` : '(vide)') : 'non trouvé'}\`,
      \`- Phase (2.4)       : \${facts.project ? (facts.project.phase       ? \`"\${facts.project.phase}"\`       : '(vide)') : 'non trouvé'}\`,
      '',
      '### IFCSITE :',
      \`- Name (3.1)        : \${facts.site ? (facts.site.name        ? \`"\${facts.site.name}"\`        : '(vide)') : 'non trouvé'}\`,
      \`- Description (3.2) : \${facts.site ? (facts.site.description ? \`"\${facts.site.description}"\` : '(vide)') : 'non trouvé'}\`,
      '',
      '### Coordonnées :',
      coords
        ? \`- Y/Nord-Sud (3.3): \${coords.y} mm\\n- X/Est-Ouest (3.4): \${coords.x} mm\\n- Z/Elevation (3.5): \${coords.z} mm\`
        : '- non trouvées',
      '',
      '### IFCBUILDING :',
      \`- Name (4.1) : \${facts.building ? (facts.building.name ? \`"\${facts.building.name}"\` : '(vide)') : 'non trouvé'}\`,
      \`- Adresse (4.2) : \${facts.siteAddress ? \`"\${facts.siteAddress}"\` : 'non trouvée'}\`,
    ].join('\\n');

    const criteriaText = aiCriteria.map(c => \`- \${c.id} | \${c.label} | Attendu : \${c.expected}\`).join('\\n');
    const criteriaIds  = aiCriteria.map(c => c.id).join(', ');

    const systemPrompt = \`Tu es un expert BIM auditeur IFC OTEIS. Retourne un JSON de conformité.
Statuts : "ok", "warning", "error", "na", "unclear".
Les critères 2.x/3.x/4.x sont déjà évalués côté serveur, tu ne les recevras pas.
Pour les autres critères, utilise l'extrait IFC brut.
Toujours indiquer valeur trouvée ET valeur attendue dans le commentaire.
Format : { "1.1": { "status": "ok", "comment": "..." } }\`;

    const userPrompt = \`Fichier : \${fileName} | Discipline : \${discipline || 'non précisée'}

\${factsBlock}

Critères à évaluer :
\${criteriaText}

Extrait IFC brut :
\\\`\\\`\\\`
\${ifcContent}
\\\`\\\`\\\`

Retourne le JSON pour : \${criteriaIds}.\`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content ?? '{}';
    let aiResults: Record<string, { status: string; comment: string }>;
    try {
      aiResults = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: 'Réponse IA invalide', raw: content }, { status: 500 });
    }

    return NextResponse.json({
      results: { ...serverResults, ...aiResults },
      facts,
      model: completion.model,
      tokensUsed: completion.usage?.total_tokens ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
`;

writeFileSync('app/api/ai-audit/route.ts', code, 'utf8');
console.log('Done. Lines:', code.split('\n').length);
