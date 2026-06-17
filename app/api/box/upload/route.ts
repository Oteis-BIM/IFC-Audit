import { NextRequest, NextResponse } from 'next/server';
import { getBoxFolderId, refreshBoxToken, setBoxTokenCookies } from '@/lib/box';

export const maxDuration = 300;

// Upload simple <= 50 MB
async function simpleUpload(accessToken: string, file: File, folderId: string) {
  const boxForm = new FormData();
  boxForm.append('attributes', JSON.stringify({ name: file.name, parent: { id: folderId } }));
  boxForm.append('file', file);
  const res = await fetch('https://upload.box.com/api/2.0/files/content', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: boxForm,
  });
  return res.json();
}

// Upload chunked > 50 MB
async function chunkedUpload(accessToken: string, file: File, folderId: string) {
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const fileSize = file.size;

  const sessionRes = await fetch('https://upload.box.com/api/2.0/files/upload_sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId, file_size: fileSize, file_name: file.name }),
  });
  const session = await sessionRes.json();
  if (!session.id) throw new Error(`Session Box échouée : ${JSON.stringify(session)}`);

  const uploadUrl = session.session_endpoints?.upload_part;
  const fileBuffer = await file.arrayBuffer();
  const parts: { part_id: string; offset: number; size: number }[] = [];

  for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, fileSize);
    const chunk = fileBuffer.slice(offset, end);
    const hashBuffer = await crypto.subtle.digest('SHA-1', chunk);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha1Base64 = btoa(hashArray.map(b => String.fromCharCode(b)).join(''));

    const partRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${end - 1}/${fileSize}`,
        Digest: `sha=` + sha1Base64,
      },
      body: chunk,
    });
    const partData = await partRes.json();
    if (!partData.part) throw new Error(`Erreur chunk : ${JSON.stringify(partData)}`);
    parts.push(partData.part);
  }

  const fullHash = await crypto.subtle.digest('SHA-1', fileBuffer);
  const fullHashArray = Array.from(new Uint8Array(fullHash));
  const fullSha1Base64 = btoa(fullHashArray.map(b => String.fromCharCode(b)).join(''));

  const commitRes = await fetch(session.session_endpoints?.commit, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Digest: `sha=` + fullSha1Base64,
    },
    body: JSON.stringify({ parts: parts.map(p => ({ part_id: p.part_id, offset: p.offset, size: p.size })) }),
  });

  if (commitRes.status === 202) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`https://upload.box.com/api/2.0/files/upload_sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return statusRes.json();
  }
  return commitRes.json();
}

async function createSharedLink(accessToken: string, fileId: string) {
  const res = await fetch(`https://api.box.com/2.0/files/${fileId}?fields=shared_link`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_link: { access: 'open', permissions: { can_download: true } } }),
  });
  return res.json();
}

export async function POST(req: NextRequest) {
  let accessToken = req.cookies.get('box_access_token')?.value;
  const refreshToken = req.cookies.get('box_refresh_token')?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: 'Non authentifié sur Box.' }, { status: 401 });
  }

  let newAccessToken: string | null = null;
  let newRefreshToken: string | undefined;

  if (!accessToken && refreshToken) {
    const tokens = await refreshBoxToken(refreshToken);
    if (!tokens.access_token) {
      return NextResponse.json({ error: 'Session Box expirée. Reconnectez-vous.' }, { status: 401 });
    }
    accessToken = tokens.access_token;
    newAccessToken = tokens.access_token;
    newRefreshToken = tokens.refresh_token;
  }

  const folderId = getBoxFolderId();
  const formData = await req.formData();
  const file = formData.get('file') as File;
  if (!file) return NextResponse.json({ error: 'Aucun fichier' }, { status: 400 });

  try {
    const CHUNKED_THRESHOLD = 50 * 1024 * 1024;
    const uploadData = file.size > CHUNKED_THRESHOLD
      ? await chunkedUpload(accessToken!, file, folderId)
      : await simpleUpload(accessToken!, file, folderId);

    const boxFile = uploadData.entries?.[0] ?? uploadData;
    const boxFileId = boxFile?.id;
    if (!boxFileId) return NextResponse.json({ error: 'Upload Box échoué', details: uploadData }, { status: 400 });

    const sharedLinkData = await createSharedLink(accessToken!, boxFileId);
    const downloadUrl = sharedLinkData.shared_link?.download_url || null;

    const response = NextResponse.json({ success: true, boxFileId, fileName: file.name, downloadUrl });

    if (newAccessToken) setBoxTokenCookies(response, { access_token: newAccessToken, refresh_token: newRefreshToken ?? undefined });
    return response;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
