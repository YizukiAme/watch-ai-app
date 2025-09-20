// File: api/generate-text-stream.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 把 Google 的 SSE 原封不动转发给前端（POST 进来，流出去）
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    // 前端把 { conversationHistory, generationConfig, thinkingConfig } POST 过来
    const { conversationHistory, generationConfig, thinkingConfig } = req.body || {};
    if (!conversationHistory) return res.status(400).json({ error: 'Missing conversationHistory' });

    const API_URL =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse';

    const finalGenerationConfig = {
      ...(generationConfig || {}),
      thinkingConfig: thinkingConfig || undefined,
    };

    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: conversationHistory,
        generationConfig: finalGenerationConfig,
      }),
    });

    // 转发头：SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, body: errText })}\n\n`);
      return res.end();
    }

    // 把 Google 的 SSE body 逐块写回客户端
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (e: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(e?.message || e) })}\n\n`);
    res.end();
  }
}
