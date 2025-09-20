// api/stream.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 官方 streaming 端点（SSE）
const API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { conversationHistory, generationConfig, thinkingConfig } = req.body || {};
  if (!conversationHistory) return res.status(400).json({ error: 'Missing conversationHistory' });

  // 和你现有 generate-text.ts 的配置保持一致
  const finalGenerationConfig = {
    ...generationConfig,
    thinkingConfig,
  };

  // 告诉浏览器：我要持续往外写
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
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

    if (!upstream.body) {
      res.write(`data: ${JSON.stringify({ error: 'No upstream body' })}\n\n`);
      return res.end();
    }

    const reader = (upstream as any).body.getReader
      ? (upstream as any).body.getReader()
      : null;

    // Vercel Node 运行时也支持 for-await 读取
    const decoder = new TextDecoder();
    if ((upstream as any).body[Symbol.asyncIterator]) {
      for await (const chunk of (upstream as any).body as any) {
        const text = decoder.decode(chunk);
        // 直接转发上游 SSE。前端会解析以 "data:" 开头的行。
        res.write(text);
      }
    } else if (reader) {
      // 保险兜底
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value));
      }
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Unsupported stream' })}\n\n`);
    }
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: String(err?.message || err) })}\n\n`);
    res.end();
  }
}
