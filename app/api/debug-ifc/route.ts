// Route de diagnostic temporaire — analyse complète structure IFC (TypeObject HasPropertySets)
// GET /api/debug-ifc?fileId=XXX&name=LUM_BP_Simple
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

function stepStr(val: string): string {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '');
}
function parseArgs(body: string): string[] {
  const start = body.indexOf('(');
  if (start === -1) return [];
  const inner = body.slice(start + 1, body.lastIndexOf(')'));
  const args: string[] = []; let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
function normalise(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function parseRefList(raw: string): string[] {
  return raw.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(s => s.startsWith('#'));
}

export async function GET(req: NextRequest) {
  const fileId  = req.nextUrl.searchParams.get('fileId');
  const target  = req.nextUrl.searchParams.get('name') ?? 'LUM_BP_Simple';
  if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });

  const cookieStore  = await cookies();
  let accessToken    = cookieStore.get('box_access_token')?.value;
  const refreshToken = cookieStore.get('box_refresh_token')?.value;
  if (!accessToken && refreshToken) {
    const res = await fetch('https://api.box.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: process.env.BOX_CLIENT_ID!, client_secret: process.env.BOX_CLIENT_SECRET! }),
    });
    accessToken = (await res.json()).access_token;
  }
  if (!accessToken) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!boxRes.ok) return NextResponse.json({ error: `Box ${boxRes.status}` }, { status: 502 });
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(await boxRes.arrayBuffer());
  const first200Lines = raw.split('\n').slice(0, 200).join('\n');

  // Build index
  const dataStart = raw.indexOf('DATA;');
  const content = dataStart >= 0 ? raw.slice(dataStart) : raw;
  const index = new Map<string, string>();
  const re = /(#\d+)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) index.set(m[1], m[2].trim());

  const targetNorm = normalise(target);

  // Cherche les entités matchant le nom
  const found: { id: string; entityType: string; name: string }[] = [];
  for (const [id, body] of index) {
    const args = parseArgs(body);
    const name = stepStr(args[2] ?? '');
    if (name && normalise(name).includes(targetNorm)) {
      found.push({ id, entityType: body.split('(')[0], name });
    }
  }
  // IfcRelDefinesByProperties
  const entityToProps = new Map<string, string[]>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    const psetRef = (args[5] ?? '').trim();
    if (!psetRef.startsWith('#')) continue;
    for (const rid of parseRefList(args[4] ?? '')) {
      if (!entityToProps.has(rid)) entityToProps.set(rid, []);
      entityToProps.get(rid)!.push(psetRef);
    }
  }

  // TypeObject HasPropertySets (IFC 2x3 : args[5] = HasPropertySets) — C'est ici que les
  // propriétés sont stockées sur les TypeObjects (IfcElectricApplianceType, etc.)
  for (const [id, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (!entityTypeName.startsWith('IFCREL') && entityTypeName.endsWith('TYPE')) {
      const args = parseArgs(body);
      const psetListRaw = (args[5] ?? '').trim();
      if (psetListRaw && psetListRaw !== '$') {
        for (const ref of parseRefList(psetListRaw)) {
          if (!entityToProps.has(id)) entityToProps.set(id, []);
          if (!entityToProps.get(id)!.includes(ref)) entityToProps.get(id)!.push(ref);
        }
      }
    }
  }

  // IfcRelDefinesByType
  const instanceToType = new Map<string, string>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYTYPE(')) continue;
    const args = parseArgs(body);
    const typeRef = (args[5] ?? '').trim();
    if (!typeRef.startsWith('#')) continue;
    for (const rid of parseRefList(args[4] ?? '')) instanceToType.set(rid, typeRef);
  }
  // Psets — gère SingleValue, EnumeratedValue, Quantities
  const psetValues = new Map<string, Map<string, string>>();
  for (const [psetId, body] of index) {
    if (!body.toUpperCase().startsWith('IFCPROPERTYSET(')) continue;
    const propMap = new Map<string, string>();
    for (const propRef of parseRefList(parseArgs(body)[4] ?? '')) {
      const pb = index.get(propRef);
      if (!pb) continue;
      const pbUpper = pb.toUpperCase();
      const pa = parseArgs(pb);
      const propName = stepStr(pa[0] ?? '');
      if (!propName) continue;
      if (pbUpper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
        const nom = pa[2] ?? '$';
        let val = '';
        if (nom && nom !== '$') { const inner = nom.match(/\(([^)]*)\)/); val = inner ? stepStr(inner[1]) : stepStr(nom); }
        propMap.set(propName, val);
      } else if (pbUpper.startsWith('IFCPROPERTYENUMERATEDVALUE(')) {
        const enumValsRaw = pa[2] ?? '$';
        const vals = [...enumValsRaw.matchAll(/\(([^)]*)\)/g)].map(mv => stepStr(mv[1])).filter(Boolean);
        propMap.set(propName, vals.join(', '));
      }
    }
    psetValues.set(psetId, propMap);
  }
  // Rapport pour les 3 premières entités trouvées
  const report = found.slice(0, 5).map(f => {
    const typeId   = instanceToType.get(f.id);
    const typeBody = typeId ? index.get(typeId) : null;
    const typeName = typeBody ? stepStr(parseArgs(typeBody)[2] ?? '') : null;
    const typeEntityType = typeBody ? typeBody.split('(')[0] : null;
    // HasPropertySets brut sur le TypeObject
    const typeHasPsetsRaw: string[] = [];
    if (typeBody) {
      const tArgs = parseArgs(typeBody);
      const raw5 = (tArgs[5] ?? '').trim();
      if (raw5 && raw5 !== '$') typeHasPsetsRaw.push(...parseRefList(raw5));
    }

    const instancePsetIds = entityToProps.get(f.id) ?? [];
    const typePsetIds     = typeId ? (entityToProps.get(typeId) ?? []) : [];

    const getPsetDetail = (psetId: string) => {
      const psetBody = index.get(psetId);
      if (!psetBody) return { id: psetId, error: 'non trouvé dans index' };
      const pArgs = parseArgs(psetBody);
      const psetName = stepStr(pArgs[2] ?? '');
      const props = psetValues.get(psetId) ? Object.fromEntries(psetValues.get(psetId)!) : {};
      return { id: psetId, psetType: psetBody.split('(')[0], name: psetName, propCount: Object.keys(props).length, props };
    };

    return {
      id:              f.id,
      entityType:      f.entityType,
      name:            f.name,
      rawBody:         index.get(f.id)?.slice(0, 300),
      typeId,
      typeName,
      typeEntityType,
      typeRawBody:     typeBody?.slice(0, 500),
      typeHasPsetsRaw,
      instancePsets:   instancePsetIds.map(getPsetDetail),
      typePsets:       typePsetIds.map(getPsetDetail),
    };
  });

  // Echantillon noms de propriétés
  const samplePropNames: string[] = [];
  for (const pm of psetValues.values()) {
    for (const k of pm.keys()) {
      if (samplePropNames.length >= 60) break;
      if (!samplePropNames.includes(k)) samplePropNames.push(k);
    }
    if (samplePropNames.length >= 60) break;
  }

  // TypeObjects détectés
  const typeObjects: { id: string; entityType: string; name: string; psetCount: number }[] = [];
  for (const [id, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (!entityTypeName.startsWith('IFCREL') && entityTypeName.endsWith('TYPE')) {
      const args = parseArgs(body);
      const name = stepStr(args[2] ?? '');
      const hasPsets = parseRefList((args[5] ?? '').replace(/[()]/g, ''));
      if (typeObjects.length < 20) typeObjects.push({ id, entityType: entityTypeName, name, psetCount: hasPsets.length });
    }
  }

  return NextResponse.json({
    totalEntities:    index.size,
    target,
    targetNorm,
    foundCount:       found.length,
    allFoundNames:    found.slice(0, 20).map(f => `${f.id} [${f.entityType}] "${f.name}"`),
    detailedReport:   report,
    globalStats: {
      entitiesWithDirectOrTypePset: entityToProps.size,
      entitiesWithTypeLink:         instanceToType.size,
      totalPsets:                   psetValues.size,
      typeObjectsCount:             typeObjects.length,
    },
    sampleTypeObjects: typeObjects,
    samplePropNamesInAllPsets: samplePropNames,
    first200LinesOfIfc: first200Lines,
  });
}
