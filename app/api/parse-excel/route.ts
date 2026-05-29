import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {  // Import dynamique pour éviter le bundling statique par Turbopack (xlsx est CommonJS)
  // Avec esModuleInterop + CJS, les exports peuvent être sous .default ou au niveau racine
  const xlsxMod = await import('xlsx');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX: typeof import('xlsx') = (xlsxMod as any).default ?? xlsxMod;
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Fichier manquant.' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (rows.length < 2) {
      return NextResponse.json({ error: 'Fichier vide ou sans données.' }, { status: 422 });
    }

    // ── Repérage des colonnes par nom d'en-tête ──
    const headers = rows[0].map((h: unknown) => String(h ?? '').trim());
    const colNom  = headers.findIndex((h: string) => h.toLowerCase() === 'nom du type');
    const colType = headers.findIndex((h: string) => h.toLowerCase() === 'type');
    const colTnd  = headers.findIndex((h: string) => h.toLowerCase().includes('par composants tnd'));

    if (colNom === -1 || colType === -1 || colTnd === -1) {
      const missing = [
        colNom  === -1 ? '"Nom du type"'          : null,
        colType === -1 ? '"Type"'                  : null,
        colTnd  === -1 ? '"Par composants TND"'    : null,
      ].filter(Boolean).join(', ');
      return NextResponse.json({ error: `Colonnes introuvables : ${missing}.` }, { status: 422 });
    }

    // ── Extraction + déduplication ──
    const seen = new Set<string>();
    const parsed: { nomDuType: string; type: string; categorieTnd: string }[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const nom = String(r[colNom]  ?? '').trim();
      const typ = String(r[colType] ?? '').trim();
      const tnd = String(r[colTnd]  ?? '').trim();
      if (!nom && !typ) continue;
      const key = `${nom}||${typ}||${tnd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push({ nomDuType: nom, type: typ, categorieTnd: tnd });
    }

    if (parsed.length === 0) {
      return NextResponse.json({ error: 'Aucune ligne valide trouvée.' }, { status: 422 });
    }

    const tndOptions = Array.from(new Set(parsed.map(r => r.categorieTnd).filter(Boolean))).sort();

    return NextResponse.json({ rows: parsed, tndOptions, fileName: file.name });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Erreur de lecture : ${msg}` }, { status: 500 });
  }
}
