import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const clientId = process.env.BOX_CLIENT_ID!;
  const redirectUri = process.env.BOX_REDIRECT_URI!;
  const popup = req.nextUrl.searchParams.get('popup') === '1';

  const url = new URL('https://account.box.com/api/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  // Si popup, on ajoute ?popup=1 au redirect_uri pour que le callback le sache  url.searchParams.set('redirect_uri', redirectUri);
  // On passe popup dans state pour ne pas modifier le redirect_uri enregistré sur Box
  url.searchParams.set('state', popup ? 'popup' : 'ifc-audit');

  return NextResponse.redirect(url.toString());
}
