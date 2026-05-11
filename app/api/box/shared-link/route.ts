import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const accessToken = req.cookies.get('box_access_token')?.value;
  if (!accessToken) {
    return NextResponse.json({ error: 'Non authentifié.' }, { status: 401 });
  }

  const { fileId } = await req.json();
  if (!fileId) {
    return NextResponse.json({ error: 'fileId manquant' }, { status: 400 });
  }

  const res = await fetch(`https://api.box.com/2.0/files/${fileId}?fields=shared_link`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shared_link: { access: 'open', permissions: { can_download: true } },
    }),
  });

  const data = await res.json();
  const downloadUrl = data.shared_link?.download_url || null;

  return NextResponse.json({ downloadUrl, boxFileId: fileId });
}
