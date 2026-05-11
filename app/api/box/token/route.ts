import { NextRequest, NextResponse } from 'next/server';

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
  let accessToken = req.cookies.get('box_access_token')?.value;
  const refreshToken = req.cookies.get('box_refresh_token')?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: 'Non authentifié sur Box.' }, { status: 401 });
  }

  let newAccessToken: string | null = null;
  let newRefreshToken: string | null = null;

  if (!accessToken && refreshToken) {
    const tokens = await refreshAccessToken(refreshToken);
    if (!tokens.access_token) {
      return NextResponse.json({ error: 'Session Box expirée. Reconnectez-vous.' }, { status: 401 });
    }
    accessToken = tokens.access_token;
    newAccessToken = tokens.access_token;
    newRefreshToken = tokens.refresh_token;
  }

  const response = NextResponse.json({
    accessToken,
    folderId: process.env.BOX_FOLDER_ID || '0',
  });

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
