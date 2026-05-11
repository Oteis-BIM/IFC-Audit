import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
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
  }  // Si ouvert en popup (state=popup), on ferme la fenêtre via une page HTML
  const isPopup = state === 'popup';  if (isPopup) {
    // La popup pose les cookies puis se ferme — la page parente fait du polling sur /api/box/token
    const html = `<!DOCTYPE html><html><head><title>Box Auth</title></head><body><p>✅ Authentification réussie, fermeture automatique...</p><script>window.close();</script></body></html>`;
    const popupResponse = new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
    popupResponse.cookies.set('box_access_token', tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: tokens.expires_in,
      path: '/',
    });
    popupResponse.cookies.set('box_refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 24 * 60 * 60,
      path: '/',
    });
    return popupResponse;
  }

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
