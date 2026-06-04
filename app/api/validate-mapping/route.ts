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
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            "Tu es un expert BIM. Tu vérifies la cohérence sémantique entre des types d'objets IFC Revit et leur catégorie MOA (classification TND française du bâtiment).\n" +
            'Réponds UNIQUEMENT par un objet JSON : {"0":"Validé","1":"Non validé : raison",...}\n' +
            'Règles : "Validé" si cohérent, "Non validé : [raison max 10 mots]" sinon. Clés = index fournis.',
        },
        {
          role: 'user',
          content: `Lignes (index | Nom du type | Type | Catégorie MOA) :\n${lignes}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as Record<string, string>;

    const results = rows.map(r => ({
      index: r.index,
      validation: parsed[String(r.index)] ?? '',
    }));

    return NextResponse.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
