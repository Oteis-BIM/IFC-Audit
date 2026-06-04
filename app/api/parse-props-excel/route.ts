import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx') as typeof import('xlsx');

  const contentType = req.headers.get('content-type') ?? '';

  // ── Mode "parse" : FormData avec fichier → retourne feuilles + en-têtes ──
  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'Fichier manquant.' }, { status: 400 });

      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });

      const sheets = wb.SheetNames.map((sheetName: string) => {
        const ws = wb.Sheets[sheetName];
        const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const headers = ((rows[0] ?? []) as unknown[]).map((h) => String(h ?? '').trim()).filter(Boolean);
        const preview = rows.slice(1, 6).map(row =>
          headers.map((_, ci) => String((row as unknown[])[ci] ?? '').trim())
        );
        return { sheetName, headers, preview };
      });

      return NextResponse.json({ sheets, fileName: file.name });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Erreur de lecture : ${msg}` }, { status: 500 });
    }
  }

  // ── Mode "extract" : JSON avec base64 + colonnes choisies → retourne mapping ──
  try {
    const body = await req.json() as {
      fileBase64: string;
      sheetName: string;
      colCategorie: string;
      colsProprietes: string[];
    };

    const buffer = Buffer.from(body.fileBase64, 'base64');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[body.sheetName];
    if (!ws) return NextResponse.json({ error: `Feuille "${body.sheetName}" introuvable.` }, { status: 404 });

    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const headers = ((rows[0] ?? []) as unknown[]).map((h) => String(h ?? '').trim());

    const catIdx = headers.indexOf(body.colCategorie);
    const propIdxs = body.colsProprietes.map((p: string) => headers.indexOf(p)).filter((i: number) => i >= 0);

    if (catIdx === -1) {
      return NextResponse.json({ error: `Colonne catégorie "${body.colCategorie}" introuvable.` }, { status: 422 });
    }

    const mapping: Record<string, string[]> = {};
    const seen: Record<string, Set<string>> = {};

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as unknown[];
      const cat = String(row[catIdx] ?? '').trim();
      if (!cat) continue;
      if (!seen[cat]) { seen[cat] = new Set(); mapping[cat] = []; }
      for (const pi of propIdxs) {
        const val = String(row[pi] ?? '').trim();
        if (val && !seen[cat].has(val)) {
          seen[cat].add(val);
          mapping[cat].push(val);
        }
      }
    }

    return NextResponse.json({ mapping });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Erreur : ${msg}` }, { status: 500 });
  }
}
