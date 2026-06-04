import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as {
      rows: { index: number; nomDuType: string; type: string; categorieMoa: string }[];
    };

    const rows = body.rows ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const lignes = rows
      .map(r => `${r.index} | ${r.nomDuType} | ${r.type} | ${r.categorieMoa}`)
      .join('\n');    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            "Tu es un expert BIM. Tu vérifies la cohérence sémantique entre des types d'objets IFC Revit et leur catégorie MOA (classification TND française du bâtiment).\n" +
            'Réponds UNIQUEMENT par un objet JSON dont CHAQUE clé est l\'index entier fourni : {"0":"Validé","1":"Non validé : raison courte","2":"Validé",...}\n' +
            'Règles STRICTES :\n' +
            '- Réponds exactement "Validé" (sans rien d\'autre) si le Nom du type / Type sont sémantiquement cohérents avec la Catégorie MOA.\n' +
            '- Réponds "Non validé : [explication en 5 à 15 mots]" si incohérent. Exemple : "Non validé : luminaire classé en chemin de câbles"\n' +
            '- Tu DOIS produire une entrée pour CHAQUE index fourni, sans exception.\n' +
            '- Les clés JSON sont des entiers sous forme de chaîne ("0", "1", "2"…).',
        },
        {
          role: 'user',
          content: `Analyse ces ${rows.length} lignes (index | Nom du type | Type | Catégorie MOA) :\n${lignes}\n\nRéponds avec exactement ${rows.length} entrées JSON.`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as Record<string, string>;

    // Normalise les clés (trim espaces) et fallback si manquante
    const results = rows.map(r => ({
      index: r.index,
      validation: parsed[String(r.index)]?.trim() ?? parsed[` ${r.index}`]?.trim() ?? 'Non analysé',
    }));

    return NextResponse.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
