import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Normalise une chaîne pour la comparaison : minuscules, sans accents, sans ponctuation
function normalise(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx') as typeof import('xlsx');

  const contentType = req.headers.get('content-type') ?? '';

  // ── Mode "parse" : FormData avec fichier ──────────────────────────────────
  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'Fichier manquant.' }, { status: 400 });

      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });

      // ── Détection du format ──────────────────────────────────────────────
      // Format LONG : 1 ligne par propriété, colonnes "Catégorie d'objet" + "Propriété"
      // Format LARGE : plusieurs feuilles, 1 onglet = 1 catégorie      // ── Cherche un onglet au format long parmi toutes les feuilles ──────────
      // Format long : colonne "Catégories MOA" (ou "Catégorie d'objet") + "Propriété - Paramètre IFC"
      let longSheetRows: unknown[][] | null = null;

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const hdrs = ((rows[0] ?? []) as unknown[]).map(h => normalise(String(h ?? '')));
        const hasCat  = hdrs.some(h => h.includes('categorie') && (h.includes('moa') || h.includes('objet')));
        const hasProp = hdrs.some(h => h.includes('propriete') || h.includes('parametre'));
        if (hasCat && hasProp) { longSheetRows = rows; break; }
      }

      const isLongFormat = longSheetRows !== null;

      if (isLongFormat && longSheetRows) {
        // ── FORMAT LONG : 1 feuille, 1 ligne par propriété ──────────────────
        const headers = ((longSheetRows[0] ?? []) as unknown[]).map(h => String(h ?? '').trim());
        const rawHeaders = headers.map(h => normalise(h));
        // Accepte "Catégories MOA", "Catégorie d'objet", etc.
        const colCat  = rawHeaders.findIndex(h => h.includes('categorie') && (h.includes('moa') || h.includes('objet')));
        const colIfc  = rawHeaders.findIndex(h => (h.includes('classe') || h.includes('entite')) && h.includes('ifc'));
        const colProp = rawHeaders.findIndex(h => h.includes('propriete') || h.includes('parametre'));

        if (colCat === -1 || colProp === -1) {
          return NextResponse.json({ error: 'Colonnes "Catégorie d\'objet" et "Propriété" introuvables.' }, { status: 422 });
        }

        type CatData = { ifcClasses: Set<string>; properties: string[] };
        const result: Record<string, CatData> = {};        for (let i = 1; i < longSheetRows.length; i++) {
          const row = longSheetRows[i] as unknown[];
          const cat  = String(row[colCat]  ?? '').trim();
          const ifc  = colIfc >= 0 ? String(row[colIfc] ?? '').trim() : '';
          const prop = String(row[colProp] ?? '').trim();
          if (!cat || !prop) continue;

          if (!result[cat]) result[cat] = { ifcClasses: new Set(), properties: [] };
          if (ifc) result[cat].ifcClasses.add(ifc);
          if (!result[cat].properties.includes(prop)) result[cat].properties.push(prop);
        }

        const categories = Object.entries(result).map(([name, data]) => ({
          name,
          nameNormalised: normalise(name),
          ifcClasses: Array.from(data.ifcClasses),
          properties: data.properties,
        }));

        return NextResponse.json({ format: 'long', categories });
      }

      // ── FORMAT LARGE : plusieurs feuilles, 1 onglet = 1 catégorie ─────────
      const sheets = wb.SheetNames.map((sheetName: string) => {
        const ws = wb.Sheets[sheetName];
        const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const headers = ((rows[0] ?? []) as unknown[]).map(h => String(h ?? '').trim()).filter(Boolean);
        const preview = rows.slice(1, 6).map(row =>
          headers.map((_, ci) => String((row as unknown[])[ci] ?? '').trim())
        );
        // Nettoie le nom de l'onglet : supprime préfixe numérique (ex: "02-Chemins de cables" → "Chemins de cables")
        const categoryName = sheetName.replace(/^[\dxX]+[-_\s]+/, '').trim();
        return { sheetName, categoryName, categoryNameNormalised: normalise(categoryName), headers, preview };
      });

      return NextResponse.json({ format: 'wide', sheets });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Erreur de lecture : ${msg}` }, { status: 500 });
    }
  }

  // ── Mode "extract" JSON (format large) ────────────────────────────────────
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
    const headers = ((rows[0] ?? []) as unknown[]).map(h => String(h ?? '').trim());
    const catIdx  = headers.indexOf(body.colCategorie);
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
        if (val && !seen[cat].has(val)) { seen[cat].add(val); mapping[cat].push(val); }
      }
    }

    return NextResponse.json({ mapping });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Erreur : ${msg}` }, { status: 500 });
  }
}
