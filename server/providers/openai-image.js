import fs from 'node:fs';
import path from 'node:path';
// Provider immagini "openai-image" (per Cosetta): API Images di OpenAI (GPT Image 2). Serve OPENAI_API_KEY nel file .env
// (platform.openai.com → API keys; si paga a consumo, separato dall'abbonamento ChatGPT).
// Se la chiave manca, lo Studio funziona lo stesso: le richieste di immagini restano come brief in attesa.
export class OpenAIImageProvider {
  constructor({ apiKey, model, fetchImpl } = {}) {
    this.id = 'openai-image';
    this.kind = 'image';
    this.label = 'OpenAI Images';
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY;
    this.model = model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async available() {
    return this.apiKey ? { ok: true, model: this.model } : { ok: false, reason: 'OPENAI_API_KEY non impostata in .env dello Studio' };
  }

  // → { ok, png: Buffer, revisedPrompt }
  async generate({ prompt, size = '1024x1024', background, references = [] }) {
    if (!this.apiKey) return { ok: false, error: 'OPENAI_API_KEY non impostata', code: 'PROVIDER_UNAVAILABLE' };
    try {
      let r;
      const refs = references.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).slice(0, 8);
      if (refs.length) {
        // con reference: endpoint "edits" (le immagini guidano stile e personaggi)
        const fd = new FormData();
        fd.append('model', this.model); fd.append('prompt', prompt); fd.append('size', size);
        for (const f of refs) fd.append('image[]', new Blob([fs.readFileSync(f)], { type: f.endsWith('.jpg') || f.endsWith('.jpeg') ? 'image/jpeg' : f.endsWith('.webp') ? 'image/webp' : 'image/png' }), path.basename(f));
        r = await this.fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: fd });
      } else {
        r = await this.fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, prompt, size, n: 1, ...(background ? { background } : {}) }),
        });
      }
      const j = await r.json();
      if (!r.ok && this.model === 'gpt-image-2' && /model/i.test(j?.error?.message || '')) { this.model = 'gpt-image-1'; return this.generate({ prompt, size, background, references }); }   // account senza gpt-image-2
      if (!r.ok) return { ok: false, error: `API ${r.status}: ${j?.error?.message || ''}` };
      const d = j.data?.[0];
      if (d?.b64_json) return { ok: true, png: Buffer.from(d.b64_json, 'base64'), revisedPrompt: d.revised_prompt };
      if (d?.url) { const img = await this.fetch(d.url); return { ok: true, png: Buffer.from(await img.arrayBuffer()), revisedPrompt: d.revised_prompt }; }
      return { ok: false, error: 'risposta senza immagine' };
    } catch (e) { return { ok: false, error: `rete: ${e.message}` }; }
  }
}
