import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  try {
    const { prompt, systemPrompt, model } = await req.json();

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt requis' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY non configurée' }, { status: 500 });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt?.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: prompt.trim() });

    const completion = await openai.chat.completions.create({
      model: model ?? 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 4000,
      messages,
    });

    const content = completion.choices[0]?.message?.content ?? '';

    return NextResponse.json({
      content,
      model: completion.model,
      tokensUsed: completion.usage?.total_tokens ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
