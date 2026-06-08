import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PropCheckResult = {
  /** ex: "ELE_EQE_SOL_Baie:Baie Info" */
  nomDuType: string;
  /** ex: "ELE_EQE_SOL_Baie:Baie Info" — valeur de l'attribut Name dans le fichier IFC */
  ifcName: string;
  /** Nombre d'instances de ce type dans le fichier */
  instanceCount: number;
  /** Pour chaque propriété : valeur trouvée (string) ou null si manquante */
  props: Record<string, string | null>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stepStr(val: string): string {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '').replace(/\\n/g, '\n');
}

/**
 * Parse le DATA SECTION d'un fichier IFC STEP.
 * Retourne un Map : id → body (ex: "#123" → "IFCWALL(...)")
 */
function buildEntityIndex(raw: string): Map<string, string> {
  const index = new Map<string, string>();
  // Cherche les lignes de la section DATA
  const dataStart = raw.indexOf('DATA;');
  const content = dataStart >= 0 ? raw.slice(dataStart) : raw;
  const entityRegex = /(#\d+)\s*=\s*([^;]+);/g;
  let match;
  while ((match = entityRegex.exec(content)) !== null) {
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

/** Normalise : minuscules, sans accents, sans ponctuation */
function normalise(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Extraction principale ────────────────────────────────────────────────────

/**
 * Pour chaque nomDuType demandé :
 *  1. Trouve toutes les instances IFC dont l'attribut Name correspond
 *  2. Remonte les IfcPropertySet associés via IfcRelDefinesByProperties
 *  3. Cherche chaque propriété attendue (IfcPropertySingleValue)
 *  4. Retourne la valeur trouvée ou null
 */
function extractPropsFromIfc(
  raw: string,
  requests: { nomDuType: string; properties: string[] }[],
): PropCheckResult[] {
  const index = buildEntityIndex(raw);

  // ── 1. Index des types nommés : Name → liste d'IDs ──────────────────────
  // On cherche tous les objets IFC (IFCFLOWTERMINAL, IFCCABLEFITTING, etc.)
  // et on les indexe par leur attribut Name (args[2])
  const typeNameToInstances = new Map<string, string[]>(); // name_normalised → [#id, ...]

  for (const [id, body] of index) {
    const upper = body.toUpperCase();
    // On filtre sur les objets physiques IFC (pas les types, pas les relations)
    if (
      !upper.startsWith('IFC') ||
      upper.startsWith('IFCREL') ||
      upper.startsWith('IFCPROPERTY') ||
      upper.startsWith('IFCPRODUCTDEFINITIONSHAPE') ||
      upper.startsWith('IFCSHAPEREPRESENTATION') ||
      upper.startsWith('IFCGEOMETRIC') ||
      upper.startsWith('IFCAXIS') ||
      upper.startsWith('IFCCARTESIAN') ||
      upper.startsWith('IFCBOUNDED') ||
      upper.startsWith('IFCFACETED') ||
      upper.startsWith('IFCTRIANGULATED') ||
      upper.startsWith('IFCREPRESENTATION') ||
      upper.startsWith('IFCMATERIAL') ||
      upper.startsWith('IFCSTYLEDITEM') ||
      upper.startsWith('IFCPRESENTATION') ||
      upper.startsWith('IFCCOLOUR') ||
      upper.startsWith('IFCOWNER') ||
      upper.startsWith('IFCORGANIZATION') ||
      upper.startsWith('IFCPERSON') ||
      upper.startsWith('IFCAPPLICATION') ||
      upper.startsWith('IFCUNIT') ||
      upper.startsWith('IFCSIUNIT') ||
      upper.startsWith('IFCCONVERSIONBASED') ||
      upper.startsWith('IFCPROJECT(') ||
      upper.startsWith('IFCSITE(') ||
      upper.startsWith('IFCBUILDING(') ||
      upper.startsWith('IFCBUILDINGSTOREY(')
    ) {
      // Pour les entités physiques, extraire le Name (args[2])
      const args = parseArgs(body);
      const name = stepStr(args[2] ?? '');
      if (name) {
        const key = normalise(name);
        if (!typeNameToInstances.has(key)) typeNameToInstances.set(key, []);
        typeNameToInstances.get(key)!.push(id);
      }
      continue;
    }
  }

  // ── 2. Construire le graph IfcRelDefinesByProperties ──────────────────────
  // RelatedObjects → PropertySet
  const instanceToProps = new Map<string, string[]>(); // instanceId → [psetId, ...]

  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    // args[4] = (#id1, #id2, ...) — les objets liés
    // args[5] = #psetId
    const relatedStr = args[4] ?? '';
    const psetRef = (args[5] ?? '').trim();
    // Parse la liste des objets liés
    const relatedIds = relatedStr.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    for (const rid of relatedIds) {
      if (!instanceToProps.has(rid)) instanceToProps.set(rid, []);
      instanceToProps.get(rid)!.push(psetRef);
    }
  }

  // ── 3. Index des PropertySets : psetId → Map<propName, value> ───────────
  const psetValues = new Map<string, Map<string, string>>(); // psetId → {propName → value}

  for (const [psetId, body] of index) {
    const upper = body.toUpperCase();
    if (!upper.startsWith('IFCPROPERTYSET(')) continue;
    const args = parseArgs(body);
    // args[4] = (#prop1, #prop2, ...)
    const propsStr = args[4] ?? '';
    const propRefs = propsStr.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    const propMap = new Map<string, string>();

    for (const propRef of propRefs) {
      const propBody = index.get(propRef);
      if (!propBody) continue;
      const pUpper = propBody.toUpperCase();
      if (!pUpper.startsWith('IFCPROPERTYSINGLEVALUE(')) continue;
      const pArgs = parseArgs(propBody);
      const propName = stepStr(pArgs[0] ?? '');
      // args[2] = NominalValue (ex: IFCTEXT('valeur'), IFCBOOLEAN(.T.), IFCREAL(1.5))
      const nominalRaw = pArgs[2] ?? '$';
      let value = '';
      if (nominalRaw === '$' || nominalRaw === '') {
        value = '';
      } else {
        // Extrait la valeur entre parenthèses : IFCTEXT('hello') → 'hello' → hello
        const innerMatch = nominalRaw.match(/\(([^)]*)\)/);
        value = innerMatch ? stepStr(innerMatch[1]) : stepStr(nominalRaw);
      }
      if (propName) propMap.set(propName, value);
    }
    psetValues.set(psetId, propMap);
  }

  // ── 4. Pour chaque requête, résoudre les propriétés ───────────────────────
  const results: PropCheckResult[] = [];

  for (const req of requests) {
    const keyNorm = normalise(req.nomDuType);

    // Cherche les instances : correspondance exacte d'abord, puis partielle
    let instanceIds: string[] = [];
    if (typeNameToInstances.has(keyNorm)) {
      instanceIds = typeNameToInstances.get(keyNorm)!;
    } else {
      // Recherche partielle : le nom IFC contient la clé ou vice versa
      for (const [k, ids] of typeNameToInstances) {
        if (k.includes(keyNorm) || keyNorm.includes(k)) {
          instanceIds = [...instanceIds, ...ids];
        }
      }
    }

    // Collecte les valeurs de propriétés pour toutes les instances
    // On prend le premier objet qui a la propriété renseignée
    const propValues: Record<string, string | null> = {};
    for (const prop of req.properties) {
      propValues[prop] = null;
    }

    let foundInIfc = false;
    let ifcName = req.nomDuType;

    for (const instanceId of instanceIds) {
      // Récupère le nom réel depuis le fichier IFC
      const instanceBody = index.get(instanceId);
      if (instanceBody) {
        const iArgs = parseArgs(instanceBody);
        const realName = stepStr(iArgs[2] ?? '');
        if (realName) { ifcName = realName; foundInIfc = true; }
      }

      const psetIds = instanceToProps.get(instanceId) ?? [];
      for (const psetId of psetIds) {
        const propMap = psetValues.get(psetId);
        if (!propMap) continue;
        for (const prop of req.properties) {
          if (propValues[prop] !== null) continue; // déjà trouvé
          if (propMap.has(prop)) {
            const val = propMap.get(prop)!;
            propValues[prop] = val !== '' ? val : null;
          }
        }
      }
    }

    // Si aucune instance trouvée, on garde les valeurs à null mais on marque
    if (!foundInIfc && instanceIds.length === 0) {
      // type non trouvé dans le fichier IFC — résultats null
    }

    results.push({
      nomDuType: req.nomDuType,
      ifcName,
      instanceCount: instanceIds.length,
      props: propValues,
    });
  }

  return results;
}

// ─── Refresh token Box ────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
  const data = await res.json();
  return data.access_token ?? null;
}

// ─── Route POST ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      fileId: string;
      requests: { nomDuType: string; properties: string[] }[];
    };

    const { fileId, requests } = body;
    if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });
    if (!requests?.length) return NextResponse.json({ results: [] });

    // Auth Box
    const cookieStore = await cookies();
    let accessToken = cookieStore.get('box_access_token')?.value;
    const refreshToken = cookieStore.get('box_refresh_token')?.value;
    if (!accessToken && refreshToken) {
      accessToken = await refreshAccessToken(refreshToken) ?? undefined;
    }
    if (!accessToken) {
      return NextResponse.json({ error: 'Non authentifié sur Box' }, { status: 401 });
    }

    // Télécharge le fichier IFC
    const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!boxRes.ok) {
      return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });
    }

    const buffer = await boxRes.arrayBuffer();
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    // Extraction des propriétés
    const results = extractPropsFromIfc(raw, requests);

    return NextResponse.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
