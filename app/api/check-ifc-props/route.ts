import { NextRequest, NextResponse } from 'next/server';
import { fetchBoxFileContent, getBoxAuthFromCookies, setBoxTokenCookies } from '@/lib/box';
import { extractPropsFromIfc, type PropCheckRequest } from '@/lib/ifc-props';

export const runtime = 'nodejs';
export const maxDuration = 300;

type PropCheckPayload = {
  fileId: string;
  requests: PropCheckRequest[];
};

type PropCheckResponse = {
  results: unknown[];
  engine?: string;
  warning?: string;
  error?: string;
};

async function runVercelPythonCheck(
  req: NextRequest,
  payload: PropCheckPayload,
  accessToken: string
): Promise<PropCheckResponse> {
  const pythonUrl = new URL('/api/check-ifc-props-python', req.nextUrl.origin);
  const response = await fetch(pythonUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, accessToken }),
  });

  const text = await response.text();
  let data: PropCheckResponse;
  try {
    data = JSON.parse(text) as PropCheckResponse;
  } catch {
    throw new Error(text || `Reponse Python invalide (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(data.error || `Erreur Python ${response.status}`);
  }

  return data;
}

async function runTypescriptFallback(
  fileId: string,
  accessToken: string,
  requests: PropCheckRequest[],
  pythonErr: unknown
) {
  const boxRes = await fetchBoxFileContent(fileId, accessToken);
  if (!boxRes.ok) {
    return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });
  }

  const buffer = await boxRes.arrayBuffer();
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return NextResponse.json({
    results: extractPropsFromIfc(raw, requests),
    engine: 'typescript',
    warning: `Fallback TypeScript utilise : ${pythonErr instanceof Error ? pythonErr.message : String(pythonErr)}`,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as PropCheckPayload;
    const { fileId, requests } = body;

    if (!fileId) return NextResponse.json({ error: 'fileId requis' }, { status: 400 });
    if (!requests?.length) return NextResponse.json({ results: [] });

    const auth = await getBoxAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Non authentifie sur Box' }, { status: 401 });

    try {
      const pythonPayload = await runVercelPythonCheck(req, { fileId, requests }, auth.accessToken);
      const response = NextResponse.json({ results: pythonPayload.results, engine: 'ifcopenshell' });
      if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
      return response;
    } catch (pythonErr) {
      const response = await runTypescriptFallback(fileId, auth.accessToken, requests, pythonErr);
      if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
      return response;
    }
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
