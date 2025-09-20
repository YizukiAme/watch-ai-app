// File: api/generate-text.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { conversationHistory, generationConfig, thinkingConfig } = req.body || {};
  if (!conversationHistory) return res.status(400).json({ error: 'Missing conversationHistory' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  // 正确的模型 + 正确的 v1beta generateContent 路径
  const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';


  const finalGenerationConfig = {
    ...generationConfig,
    thinkingConfig: thinkingConfig,
  };

  try {
    const geminiResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY, // 比 query 参数更稳
      },
      body: JSON.stringify({
        contents: conversationHistory,
        generationConfig: finalGenerationConfig,
      }),
    });

    const data = await geminiResponse.json();
    if (!geminiResponse.ok) {
      // 把 Google 错误结构原样透出，方便你定位
      return res.status(geminiResponse.status).json(data);
    }

    const geminiText =
      data.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text ??
      "I'm sorry, I couldn't generate a response.";

    return res.status(200).json({ text: geminiText });
  } catch (error: any) {
    console.error('Error proxying Gemini API:', error);
    return res.status(500).json({ error: String(error?.message || error) });
  }
}
