import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.json({ error: 'No code' }, { status: 400 });

  const clientId = process.env.BOX_CLIENT_ID!;
  const clientSecret = process.env.BOX_CLIENT_SECRET!;
  const redirectUri = process.env.BOX_REDIRECT_URI!;

  // Échange du code contre les tokens
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  const tokens = await res.json();
  if (!tokens.access_token) {
    return NextResponse.json({ error: 'Token exchange failed', details: tokens }, { status: 400 });
  }

  // Redirige vers l'app avec les tokens en cookies
  const response = NextResponse.redirect(new URL('/', req.nextUrl.origin));
  response.cookies.set('box_access_token', tokens.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: tokens.expires_in,
    path: '/',
  });
  response.cookies.set('box_refresh_token', tokens.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 24 * 60 * 60, // 60 jours
    path: '/',
  });

  return response;
}
