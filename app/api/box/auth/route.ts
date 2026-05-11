import { NextResponse } from 'next/server';

export async function GET() {
  const clientId = process.env.BOX_CLIENT_ID!;
  const redirectUri = process.env.BOX_REDIRECT_URI!;

  const url = new URL('https://account.box.com/api/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 'ifc-audit');

  return NextResponse.redirect(url.toString());
}
