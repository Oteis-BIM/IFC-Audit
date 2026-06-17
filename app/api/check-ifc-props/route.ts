import { NextRequest, NextResponse } from 'next/server';
import { fetchBoxFileContent, getBoxAuthFromCookies, setBoxTokenCookies } from '@/lib/box';
import { extractPropsFromIfc, type PropCheckRequest } from '@/lib/ifc-props';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      fileId: string;
      requests: PropCheckRequest[];
    };
    const { fileId, requests } = body;

    if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });
    if (!requests?.length) return NextResponse.json({ results: [] });

    const auth = await getBoxAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Non authentifie sur Box' }, { status: 401 });

    const boxRes = await fetchBoxFileContent(fileId, auth.accessToken);
    if (!boxRes.ok) return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });

    const raw = new TextDecoder('utf-8', { fatal: false }).decode(await boxRes.arrayBuffer());
    const response = NextResponse.json({ results: extractPropsFromIfc(raw, requests) });

    if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
    return response;
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
