import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

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

/**
 * Extrait toutes les valeurs "Nom du type" d'un fichier IFC.
 *
 * Stratégie :
 * 1. Parcourt toutes les IFCPROPERTYSINGLEVALUE dont Name = 'Nom du type' (ou 'TypeName', 'IfcType')
 *    et collecte leur NominalValue.
 * 2. Parcourt les entités "type" IFC (IFCWALLTYPE, IFCSLABTYPE, etc.) et collecte leur Name.
 * 3. Parcourt IFCELEMENTTYPE et sous-types, collecte Name.
 *
 * Retourne un tableau de chaînes dédupliqué et trié.
 */
function extractTypeNames(raw: string): string[] {
  const index = buildEntityIndex(raw);
  const typeNames = new Set<string>();

  // Noms IFC des propriétés "Nom du type" (Revit FR/EN)
  const propNameVariants = new Set([
    'NOM DU TYPE',
    'TYPE NAME',
    'TYPENAME',
    'NOM_DU_TYPE',
    'IFCTYPE',
    'TYPE IFC',
  ]);

  for (const [, body] of index) {
    const upper = body.toUpperCase();

    // IFCPROPERTYSINGLEVALUE(Name, ..., NominalValue, ...)
    if (upper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
      const args = parseArgs(body);
      const propName = stepStr(args[0] ?? '').toUpperCase();
      if (propNameVariants.has(propName)) {
        // args[2] = NominalValue → IFCLABEL('...') ou IFCTEXT('...')
        const nomVal = args[2] ?? '';
        const m = nomVal.match(/IFCLABEL\('(.+?)'\)|IFCTEXT\('(.+?)'\)|IFCIDENTIFIER\('(.+?)'\)|'(.+?)'/i);
        const val = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') : stepStr(nomVal);
        if (val) typeNames.add(val);
      }
    }

    // Entités *TYPE IFC (IFCWALLTYPE, IFCSLABTYPE, IFCCOLUMNTYPE, etc.)
    if (upper.match(/^IFC[A-Z]+TYPE\(/) || upper.startsWith('IFCELEMENTTYPE(')) {
      const args = parseArgs(body);
      const name = stepStr(args[2] ?? ''); // args[2] = Name
      if (name) typeNames.add(name);
    }
  }

  return [...typeNames].sort((a, b) => a.localeCompare(b, 'fr'));
}

export async function POST(req: NextRequest) {
  try {
    const { fileId } = await req.json();
    if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });

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

    const typeNames = extractTypeNames(raw);
    return NextResponse.json({ typeNames });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
