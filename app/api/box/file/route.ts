import { NextRequest, NextResponse } from 'next/server';
import { fetchBoxFileContent, getBoxAuthFromCookies, refreshBoxToken, setBoxTokenCookies } from '@/lib/box';

export async function GET(req: NextRequest) {
  const fileId = req.nextUrl.searchParams.get('fileId');
  if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });

  const auth = await getBoxAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Non authentifie Box - veuillez vous reconnecter.' }, { status: 401 });
  }

  let accessToken = auth.accessToken;
  let refreshedTokens = auth.refreshedTokens;
  let boxRes = await fetchBoxFileContent(fileId, accessToken);

  if (boxRes.status === 401 && auth.refreshToken) {
    const tokens = await refreshBoxToken(auth.refreshToken);
    if (!tokens.access_token) {
      return NextResponse.json({ error: 'Session Box expiree - veuillez vous reconnecter.' }, { status: 401 });
    }

    accessToken = tokens.access_token;
    refreshedTokens = tokens;
    boxRes = await fetchBoxFileContent(fileId, accessToken);
  }

  if (!boxRes.ok) {
    const text = await boxRes.text();
    return NextResponse.json({ error: text }, { status: boxRes.status });
  }

  const response = new NextResponse(await boxRes.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="model.ifc"',
    },
  });

  if (refreshedTokens) setBoxTokenCookies(response, refreshedTokens);
  return response;
}
