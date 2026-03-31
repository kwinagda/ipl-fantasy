export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt } = req.body;

    // Add up to 3 keys in Vercel env vars — only GEMINI_API_KEY_1 is required
    const keys = [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
    ].filter(Boolean);

    if (!keys.length) {
      return res.status(500).json({ error: 'No API keys configured' });
    }

    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-lite'];

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
    };

    // Try every key + model combination until one works
    for (const key of keys) {
      for (const model of models) {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );

        const data = await response.json();

        if (response.status === 429 || response.status === 403) {
          console.log(`${model} quota/auth issue, trying next...`);
          continue;
        }

        if (!response.ok) {
          console.error(`${model} error:`, JSON.stringify(data));
          continue;
        }

        const text = data.candidates?.[0]?.content?.parts
          ?.filter(p => p.text)
          ?.map(p => p.text)
          ?.join('\n') || '';

        console.log(`Success: ${model}`);
        return res.status(200).json({ text });
      }
    }

    return res.status(429).json({ error: 'quota_exceeded' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
