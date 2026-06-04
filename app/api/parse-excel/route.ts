import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // require() : webpack + serverExternalPackages chargent xlsx via Node.js natif
  // evite le bundling statique Turbopack qui ne supporte pas les modules CJS purs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx') as typeof import('xlsx');

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Fichier manquant.' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (rows.length < 2) {
      return NextResponse.json({ error: 'Fichier vide ou sans donnees.' }, { status: 422 });
    }

    const headers = rows[0].map((h: unknown) => String(h ?? '').trim());
    // Normalise : supprime accents (NFD + strip combining), met en minuscules, retire non-alphanumériques
    const normalise = (s: string) =>
      s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const colNom  = headers.findIndex((h: string) => normalise(h) === normalise('Nom du type'));
    const colType = headers.findIndex((h: string) => normalise(h) === normalise('Type'));
    // Accepte : "Catégorie MOA", "Catégorie TND", "Par composants TND", "CategorieMOA"…
    const colTnd  = headers.findIndex((h: string) => {
      const n = normalise(h);
      return n.includes('categoriemoa') || n.includes('categorietnd') || n.includes('parcomposantstnd') || n.includes('categorymoa');
    });

    if (colNom === -1 || colType === -1 || colTnd === -1) {
      const missing = [
        colNom  === -1 ? '"Nom du type"'                          : null,
        colType === -1 ? '"Type"'                                 : null,
        colTnd  === -1 ? '"Catégorie MOA" / "Catégorie TND"'     : null,
      ].filter(Boolean).join(', ');
      return NextResponse.json({
        error: `Colonnes introuvables : ${missing}. En-têtes détectés : ${headers.join(', ')}`,
      }, { status: 422 });
    }

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
      return NextResponse.json({ error: 'Aucune ligne valide trouvee.' }, { status: 422 });
    }

    const tndOptions = Array.from(new Set(parsed.map(r => r.categorieTnd).filter(Boolean))).sort();
    return NextResponse.json({ rows: parsed, tndOptions, fileName: file.name });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Erreur de lecture : ${msg}` }, { status: 500 });
  }
}
