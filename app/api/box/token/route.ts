import { NextResponse } from 'next/server';
import { getBoxAuthFromCookies, getBoxFolderId, setBoxTokenCookies } from '@/lib/box';

export async function GET() {
  const auth = await getBoxAuthFromCookies();
  if (!auth) return NextResponse.json({ error: 'Non authentifie sur Box.' }, { status: 401 });

  const response = NextResponse.json({
    accessToken: auth.accessToken,
    folderId: getBoxFolderId(),
  });

  if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
  return response;
}
