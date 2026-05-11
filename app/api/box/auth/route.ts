import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const clientId = process.env.BOX_CLIENT_ID!;
  // Fallback hardcodé si la variable d'env n'est pas définie sur Vercel
  const redirectUri = process.env.BOX_REDIRECT_URI || 'https://ifc-audit.vercel.app/api/box/callback';
  const popup = req.nextUrl.searchParams.get('popup') === '1';

  const url = new URL('https://account.box.com/api/oauth2/authorize');  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', popup ? 'popup' : 'ifc-audit');

  return NextResponse.redirect(url.toString());
}
