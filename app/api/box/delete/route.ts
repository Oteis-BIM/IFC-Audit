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

export async function DELETE(req: NextRequest) {
  const { fileId } = await req.json();
  if (!fileId) return NextResponse.json({ error: 'fileId manquant' }, { status: 400 });

  const cookieStore = await cookies();
  let accessToken = cookieStore.get('box_access_token')?.value;
  const refreshToken = cookieStore.get('box_refresh_token')?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: 'Non authentifié à Box' }, { status: 401 });
  }

  // Refresh si nécessaire
  if (!accessToken && refreshToken) {
    const tokens = await refreshAccessToken(refreshToken);
    if (!tokens.access_token) return NextResponse.json({ error: 'Refresh token invalide' }, { status: 401 });
    accessToken = tokens.access_token;
  }

  let res = await fetch(`https://api.box.com/2.0/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Retry avec refresh si 401
  if (res.status === 401 && refreshToken) {
    const tokens = await refreshAccessToken(refreshToken);
    if (!tokens.access_token) return NextResponse.json({ error: 'Session Box expirée' }, { status: 401 });
    accessToken = tokens.access_token;
    res = await fetch(`https://api.box.com/2.0/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  // Box renvoie 204 No Content en cas de succès
  if (res.status === 204 || res.status === 200) {
    return NextResponse.json({ success: true });
  }

  const text = await res.text();
  return NextResponse.json({ error: text }, { status: res.status });
}
