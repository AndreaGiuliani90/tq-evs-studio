// Provider immagini "openai-image" (per Cosetta): API Images di OpenAI. Serve OPENAI_API_KEY in .env dello Studio.
// Se la chiave manca, lo Studio funziona lo stesso: le richieste di immagini restano come brief in attesa.
export class OpenAIImageProvider {
  constructor({ apiKey, model, fetchImpl } = {}) {
    this.id = 'openai-image';
    this.kind = 'image';
    this.label = 'OpenAI Images';
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY;
    this.model = model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async available() {
    return this.apiKey ? { ok: true, model: this.model } : { ok: false, reason: 'OPENAI_API_KEY non impostata in .env dello Studio' };
  }

  // → { ok, png: Buffer, revisedPrompt }
  async generate({ prompt, size = '1024x1024', background }) {
    if (!this.apiKey) return { ok: false, error: 'OPENAI_API_KEY non impostata', code: 'PROVIDER_UNAVAILABLE' };
    try {
      const r = await this.fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, prompt, size, n: 1, ...(background ? { background } : {}) }),
      });
      const j = await r.json();
      if (!r.ok) return { ok: false, error: `API ${r.status}: ${j?.error?.message || ''}` };
      const d = j.data?.[0];
      if (d?.b64_json) return { ok: true, png: Buffer.from(d.b64_json, 'base64'), revisedPrompt: d.revised_prompt };
      if (d?.url) { const img = await this.fetch(d.url); return { ok: true, png: Buffer.from(await img.arrayBuffer()), revisedPrompt: d.revised_prompt }; }
      return { ok: false, error: 'risposta senza immagine' };
    } catch (e) { return { ok: false, error: `rete: ${e.message}` }; }
  }
}
