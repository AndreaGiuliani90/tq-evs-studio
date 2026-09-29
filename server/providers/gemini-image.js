// Provider immagini "gemini-image" = Nano Banana di Google (API Gemini). Serve GEMINI_API_KEY nel file .env
// (chiave gratuita da https://aistudio.google.com/apikey; oltre la quota gratuita si paga a consumo).
// Modelli: gemini-3.1-flash-image (Nano Banana 2, predefinito) · gemini-3-pro-image (Pro) · gemini-2.5-flash-image
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const RATIOS = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3', '1792x1024': '16:9', '1024x1792': '9:16' };

export class GeminiImageProvider {
  constructor({ apiKey, model, fetchImpl } = {}) {
    this.id = 'gemini-image';
    this.kind = 'image';
    this.label = 'Google Nano Banana (Gemini)';
    this.apiKey = apiKey ?? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    this.model = model || process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async available() {
    return this.apiKey ? { ok: true, model: this.model } : { ok: false, reason: 'GEMINI_API_KEY non impostata nel file .env dello Studio (chiave da aistudio.google.com/apikey)' };
  }

  // references: percorsi di immagini (sprite esistenti, reference dell'utente) per tenere lo stile coerente
  async generate({ prompt, size = '1024x1024', references = [] }) {
    if (!this.apiKey) return { ok: false, error: 'GEMINI_API_KEY non impostata', code: 'PROVIDER_UNAVAILABLE' };
    const parts = [{ text: prompt }];
    for (const r of references.slice(0, 6)) {
      try { parts.push({ inline_data: { mime_type: MIME[path.extname(r).toLowerCase()] || 'image/png', data: fs.readFileSync(r).toString('base64') } }); } catch { /* reference mancante: si va avanti */ }
    }
    const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: RATIOS[size] || '1:1' } } };
    try {
      const r = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) return { ok: false, error: `API ${r.status}: ${j?.error?.message || ''}` };
      for (const c of j.candidates || []) for (const p of c.content?.parts || []) {
        const d = p.inlineData || p.inline_data;
        if (d?.data) return { ok: true, png: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type, revisedPrompt: null };
      }
      const why = j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'nessuna immagine nella risposta';
      return { ok: false, error: `Gemini: ${why}` };
    } catch (e) { return { ok: false, error: `rete: ${e.message}` }; }
  }
}
