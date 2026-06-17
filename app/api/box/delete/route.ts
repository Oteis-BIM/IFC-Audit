import { NextRequest, NextResponse } from 'next/server';
import { deleteBoxFile, getBoxAuthFromCookies, refreshBoxToken, setBoxTokenCookies } from '@/lib/box';

export async function DELETE(req: NextRequest) {
  const { fileId } = await req.json();
  if (!fileId) return NextResponse.json({ error: 'fileId manquant' }, { status: 400 });

  const auth = await getBoxAuthFromCookies();
  if (!auth) return NextResponse.json({ error: 'Non authentifie a Box' }, { status: 401 });

  let boxRes = await deleteBoxFile(fileId, auth.accessToken);
  let refreshedTokens = auth.refreshedTokens;

  if (boxRes.status === 401 && auth.refreshToken) {
    const tokens = await refreshBoxToken(auth.refreshToken);
    if (!tokens.access_token) return NextResponse.json({ error: 'Session Box expiree' }, { status: 401 });

    refreshedTokens = tokens;
    boxRes = await deleteBoxFile(fileId, tokens.access_token);
  }

  if (boxRes.status === 204 || boxRes.status === 200) {
    const response = NextResponse.json({ success: true });
    if (refreshedTokens) setBoxTokenCookies(response, refreshedTokens);
    return response;
  }

  const text = await boxRes.text();
  return NextResponse.json({ error: text }, { status: boxRes.status });
}
