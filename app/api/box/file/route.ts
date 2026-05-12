import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BOX_CLIENT_ID!,
      client_secret: process.env.BOX_CLIENT_SECRET!,
    }),
  });
  return res.json();
}

export async function GET(req: NextRequest) {
  const fileId = req.nextUrl.searchParams.get('fileId');
  if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });

  const cookieStore = await cookies();
  let accessToken = cookieStore.get('box_access_token')?.value;
  const refreshToken = cookieStore.get('box_refresh_token')?.value;

  // Si pas de access token, on tente un refresh
  let newAccessToken: string | null = null;
  let newRefreshToken: string | null = null;

  if (!accessToken) {
    if (!refreshToken) {
      return NextResponse.json({ error: 'Non authentifié Box — veuillez vous reconnecter.' }, { status: 401 });
    }
    const tokens = await refreshAccessToken(refreshToken);
    if (!tokens.access_token) {
      return NextResponse.json({ error: 'Session Box expirée — veuillez vous reconnecter.' }, { status: 401 });
    }
    accessToken = tokens.access_token;
    newAccessToken = tokens.access_token;
    newRefreshToken = tokens.refresh_token;
  }

  // Télécharge le fichier depuis Box
  const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'follow',
  });

  // Si 401 avec le token actuel, on tente un refresh une fois
  if (boxRes.status === 401 && refreshToken) {
    const tokens = await refreshAccessToken(refreshToken);
    if (!tokens.access_token) {
      return NextResponse.json({ error: 'Session Box expirée — veuillez vous reconnecter.' }, { status: 401 });
    }
    newAccessToken = tokens.access_token;
    newRefreshToken = tokens.refresh_token;

    const retryRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${newAccessToken}` },
      redirect: 'follow',
    });

    if (!retryRes.ok) {
      const text = await retryRes.text();
      return NextResponse.json({ error: text }, { status: retryRes.status });
    }

    const buffer = await retryRes.arrayBuffer();
    const response = new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="model.ifc"`,
      },
    });
    // Mise à jour des cookies avec les nouveaux tokens
    response.cookies.set('box_access_token', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 3600,
      path: '/',
    });
    response.cookies.set('box_refresh_token', newRefreshToken!, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 24 * 60 * 60,
      path: '/',
    });
    return response;
  }

  if (!boxRes.ok) {
    const text = await boxRes.text();
    return NextResponse.json({ error: text }, { status: boxRes.status });
  }

  const buffer = await boxRes.arrayBuffer();
  const response = new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="model.ifc"`,
    },
  });

  // Mise à jour des cookies si on a rafraîchi le token
  if (newAccessToken) {
    response.cookies.set('box_access_token', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 3600,
      path: '/',
    });
    response.cookies.set('box_refresh_token', newRefreshToken!, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 24 * 60 * 60,
      path: '/',
    });
  }

  return response;
}
