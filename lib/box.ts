import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

export type BoxTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export type BoxAuthState = {
  accessToken: string;
  refreshToken?: string;
  refreshedTokens?: BoxTokenResponse;
};

export function getBoxFolderId(): string {
  return process.env.BOX_FOLDER_ID || '0';
}

export async function refreshBoxToken(refreshToken: string): Promise<BoxTokenResponse> {
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

export async function getBoxAuthFromCookies(): Promise<BoxAuthState | null> {
  const cookieStore = await cookies();
  let accessToken = cookieStore.get('box_access_token')?.value;
  const refreshToken = cookieStore.get('box_refresh_token')?.value;

  if (accessToken) return { accessToken, refreshToken };
  if (!refreshToken) return null;

  const refreshedTokens = await refreshBoxToken(refreshToken);
  accessToken = refreshedTokens.access_token;
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: refreshedTokens.refresh_token ?? refreshToken,
    refreshedTokens,
  };
}

export function setBoxTokenCookies(response: NextResponse, tokens: BoxTokenResponse): void {
  if (!tokens.access_token) return;

  response.cookies.set('box_access_token', tokens.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: tokens.expires_in ?? 3600,
    path: '/',
  });

  if (tokens.refresh_token) {
    response.cookies.set('box_refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 24 * 60 * 60,
      path: '/',
    });
  }
}

export async function fetchBoxFileContent(fileId: string, accessToken: string): Promise<Response> {
  return fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'follow',
  });
}

export async function fetchBoxFileInfo(fileId: string, accessToken: string): Promise<Response> {
  return fetch(`https://api.box.com/2.0/files/${fileId}?fields=name,size,created_at,modified_at`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function deleteBoxFile(fileId: string, accessToken: string): Promise<Response> {
  return fetch(`https://api.box.com/2.0/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
