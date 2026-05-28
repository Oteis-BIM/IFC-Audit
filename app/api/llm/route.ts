import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import OpenAI from 'openai';
import { extractIfcFacts, buildFactsBlock, countIfcType } from '@/lib/ifc-parser';
import { getSupabase } from '@/lib/supabase';

async function refreshBoxToken(refreshToken: string) {
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

async function fetchIfcRaw(fileId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } catch { return null; }
}

async function fetchGeometryFromSupabase(fileName: string): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('ifc_geometry')
      .select('stats_by_type, total_elements, elements_with_geometry, geometry_data')
      .ilike('file_name', `%${fileName.replace('.ifc', '')}%`)
      .order('extracted_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return null;

    // Construire un résumé géométrique lisible pour le LLM
    const lines: string[] = [];
    lines.push(`- Éléments totaux : ${data.total_elements}`);
    lines.push(`- Éléments avec géométrie : ${data.elements_with_geometry}`);
    if (data.stats_by_type) {
      lines.push('- Comptage par type :');
      for (const [type, count] of Object.entries(data.stats_by_type as Record<string, number>)) {
        if (count > 0) lines.push(`    • ${type} : ${count}`);
      }
    }

    // Agrégats des BaseQuantities (sommes + moyennes par type)
    const geoData = data.geometry_data as { elements?: { ifc_type: string; base_quantities: Record<string, number> }[] };
    if (geoData?.elements?.length) {
      const agregats: Record<string, Record<string, number[]>> = {};
      for (const el of geoData.elements) {
        if (!el.base_quantities || Object.keys(el.base_quantities).length === 0) continue;
        const type = el.ifc_type;
        if (!agregats[type]) agregats[type] = {};
        for (const [key, val] of Object.entries(el.base_quantities)) {
          if (!agregats[type][key]) agregats[type][key] = [];
          agregats[type][key].push(val);
        }
      }
      lines.push('- Agrégats géométriques (BaseQuantities) :');
      for (const [type, props] of Object.entries(agregats)) {
        lines.push(`    ${type} :`);
        for (const [prop, vals] of Object.entries(props)) {
          const sum = vals.reduce((a, b) => a + b, 0);
          const avg = sum / vals.length;
          const shortProp = prop.split('.').pop() ?? prop;
          lines.push(`      • ${shortProp} — total: ${sum.toFixed(3)}, moy: ${avg.toFixed(3)}, nb: ${vals.length}`);
        }
      }
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

const COUNTED_TYPES = [
  'IfcLightFixture','IfcFlowTerminal','IfcOutlet','IfcSensor',
  'IfcWall','IfcWallStandardCase','IfcColumn','IfcBeam','IfcSlab',
  'IfcDoor','IfcWindow','IfcStair','IfcRoof','IfcPile','IfcFooting',
  'IfcFlowSegment','IfcDistributionFlowElement','IfcElectricDistributionBoard',
  'IfcSpace','IfcOpeningElement','IfcCovering','IfcFurnishingElement',
];

export async function POST(req: NextRequest) {
  try {
    const { prompt, systemPrompt: userSystemPrompt, model, maquettes } = await req.json();
    const maquettesList: { fileId: string; fileName: string; discipline: string }[] =
      Array.isArray(maquettes) ? maquettes : [];    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt requis' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });

    // Token Box pour télécharger les fichiers IFC
    const cookieStore = await cookies();
    let accessToken = cookieStore.get('box_access_token')?.value;
    const refreshToken = cookieStore.get('box_refresh_token')?.value;
    if (!accessToken && refreshToken) {
      const tokens = await refreshBoxToken(refreshToken);
      accessToken = tokens.access_token;
    }

    // Parser chaque maquette en parallèle
    const contextParts = await Promise.all(
      maquettesList.map(async (m) => {
        if (!m.fileId || !accessToken) {
          return `### Maquette : "${m.fileName}" | Discipline : ${m.discipline}\n- (non accessible — non connecté à Box)`;
        }
        const raw = await fetchIfcRaw(m.fileId, accessToken);
        if (!raw) return `### Maquette : "${m.fileName}" | Discipline : ${m.discipline}\n- (fichier inaccessible)`;        const facts = extractIfcFacts(raw);
        const factsBlock = buildFactsBlock(facts, m.fileName, m.discipline);
        const counts = COUNTED_TYPES
          .map(t => ({ type: t, count: countIfcType(raw, t) }))
          .filter(c => c.count > 0)
          .map(c => `    • ${c.type} : ${c.count}`)
          .join('\n');

        // Données géométriques enrichies depuis Supabase (script Python ifcopenshell)
        const geoFromSupabase = await fetchGeometryFromSupabase(m.fileName);
        const geoBlock = geoFromSupabase
          ? `\n- Données géométriques détaillées (ifcopenshell) :\n${geoFromSupabase}`
          : '\n- Données géométriques détaillées : non disponibles (script Python non exécuté)';

        return factsBlock + (counts ? `\n- Objets IFC comptés :\n${counts}` : '') + geoBlock;
      })
    );

    const maquettesContext = contextParts.length > 0
      ? `## Données extraites des maquettes IFC :\n\n${contextParts.join('\n\n---\n\n')}`
      : `## Aucune maquette chargée.`;

    const systemContent = [
      `Tu es un expert BIM intégré à l'application ifc-audit d'OTEIS.`,
      `Réponds uniquement aux questions portant sur les maquettes IFC chargées ci-dessous.`,
      `Si une question ne concerne pas ces maquettes ou le domaine BIM/IFC, réponds exactement : "Je ne peux répondre qu'aux questions relatives aux maquettes chargées dans cette application."`,
      `Réponds en français, de manière précise et structurée. Élévations en mm NGF sauf mention contraire.`,
      ``,
      maquettesContext,
      userSystemPrompt?.trim() ? `\nInstructions supplémentaires :\n${userSystemPrompt.trim()}` : '',
    ].filter(s => s !== '').join('\n');

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt.trim() },
    ];

    const completion = await openai.chat.completions.create({
      model: model ?? 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 4000,
      messages,
    });

    return NextResponse.json({
      content: completion.choices[0]?.message?.content ?? '',
      model: completion.model,
      tokensUsed: completion.usage?.total_tokens ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
