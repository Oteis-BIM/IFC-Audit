import { NextRequest, NextResponse } from 'next/server';
import { fetchBoxFileContent, getBoxAuthFromCookies, setBoxTokenCookies } from '@/lib/box';
import { buildEntityIndex, parseArgs, stepStr } from '@/lib/ifc-parser';

function extractNominalString(rawValue: string): string {
  const match = rawValue.match(/IFCLABEL\('(.+?)'\)|IFCTEXT\('(.+?)'\)|IFCIDENTIFIER\('(.+?)'\)|'(.+?)'/i);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '') : stepStr(rawValue);
}

function extractTypeNames(raw: string): string[] {
  const index = buildEntityIndex(raw);
  const typeNames = new Set<string>();
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

    if (upper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
      const args = parseArgs(body);
      const propName = stepStr(args[0] ?? '').toUpperCase();
      if (propNameVariants.has(propName)) {
        const value = extractNominalString(args[2] ?? '');
        if (value) typeNames.add(value);
      }
    }

    if (upper.match(/^IFC[A-Z]+TYPE\(/) || upper.startsWith('IFCELEMENTTYPE(')) {
      const name = stepStr(parseArgs(body)[2] ?? '');
      if (name) typeNames.add(name);
    }
  }

  return [...typeNames].sort((a, b) => a.localeCompare(b, 'fr'));
}

export async function POST(req: NextRequest) {
  try {
    const { fileId } = await req.json();
    if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });

    const auth = await getBoxAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Non authentifie sur Box' }, { status: 401 });

    const boxRes = await fetchBoxFileContent(fileId, auth.accessToken);
    if (!boxRes.ok) {
      return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });
    }

    const raw = new TextDecoder('utf-8', { fatal: false }).decode(await boxRes.arrayBuffer());
    const response = NextResponse.json({ typeNames: extractTypeNames(raw) });

    if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
