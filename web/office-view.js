// La "telecamera" dell'ufficio: zoom (rotellina, pizzico, pulsanti), trascinamento e superzoom su un personaggio.
// La tela e le etichette stanno in uno "stage" in pixel logici; qui si decide solo come inquadrarlo.
// Le etichette (nomi, lavagna) restano leggibili: si ingrandiscono meno della stanza.

const MIN_Z = 1, MAX_Z = 8, SUPER_Z = 5;

export class OfficeView {
  constructor(wrap, stage, office) {
    Object.assign(this, { wrap, stage, office });
    this.z = 1; this.tx = 0; this.ty = 0;          // zoom relativo al "tutta la stanza" e traslazione (px schermo)
    this.anim = null; this.focused = null;
    this.pointers = new Map();
    office.onResize = () => this.fit(false);
    new ResizeObserver(() => this.fit(false, true)).observe(wrap);
    wrap.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    wrap.addEventListener('pointerdown', (e) => this.onDown(e));
    wrap.addEventListener('pointermove', (e) => this.onMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) wrap.addEventListener(ev, (e) => this.onUp(e));
    wrap.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this.zoomAt(e.clientX, e.clientY, this.z < 2.5 ? 2.5 : 1 / this.z); });
    wrap.tabIndex = 0;
    wrap.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomBy(1.4); else if (e.key === '-') this.zoomBy(1 / 1.4);
      else if (e.key === '0' || e.key === 'Escape') this.fit(true);
      else if (e.key.startsWith('Arrow')) { const d = 60; this.panBy(e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0, e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0); }
      else return;
      e.preventDefault();
    });
  }

  // scala che fa stare tutta la stanza nel riquadro
  get base() {
    const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    return Math.min(W / this.office.LW, H / this.office.LH) || 1;
  }
  get scale() { return this.base * this.z; }

  // altezza del riquadro: proporzionata alla stanza, senza superare lo schermo
  sizeWrap() {
    const W = this.wrap.clientWidth;
    const h = Math.min(window.innerHeight * 0.72, W * this.office.LH / this.office.LW);
    this.wrap.style.height = `${Math.max(260, Math.round(h))}px`;
  }

  fit(animate = true, keep = false) {
    if (!this.office.LW) return;
    this.stage.style.width = `${this.office.LW}px`; this.stage.style.height = `${this.office.LH}px`;
    if (!keep) this.sizeWrap();
    if (keep && this.z > 1) return this.apply();
    this.focused = null; this.office.onFocusChange?.(null);
    const s = this.base, W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    this.go(1, (W - this.office.LW * s) / 2, (H - this.office.LH * s) / 2, animate);
  }

  clamp(z, tx, ty) {
    const s = this.base * z, W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    const w = this.office.LW * s, h = this.office.LH * s;
    const cx = (lo, hi, v) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    // si può trascinare finché resta dentro almeno un pezzo di stanza
    return [cx(W - w - W * 0.25, W * 0.25, tx), cx(H - h - H * 0.25, H * 0.25, ty)];
  }

  go(z, tx, ty, animate = true) {
    z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    [tx, ty] = this.clamp(z, tx, ty);
    cancelAnimationFrame(this.anim);
    if (!animate) { Object.assign(this, { z, tx, ty }); return this.apply(); }
    const from = { z: this.z, tx: this.tx, ty: this.ty }, t0 = performance.now(), D = 380;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
      this.z = from.z + (z - from.z) * e; this.tx = from.tx + (tx - from.tx) * e; this.ty = from.ty + (ty - from.ty) * e;
      this.apply();
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  apply() {
    const s = this.scale;
    this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${s})`;
    // etichette: crescono poco con lo zoom (restano leggibili ma non coprono tutto)
    this.stage.style.setProperty('--lab', String(Math.min(1.7, Math.pow(this.z, 0.3)) / s));
    this.wrap.classList.toggle('zoomed', this.z > 1.02);
  }

  // zoom tenendo fermo il punto sotto il cursore
  zoomAt(clientX, clientY, factor, animate = true) {
    const r = this.wrap.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, this.z * factor));
    const k = z / this.z;
    this.go(z, px - (px - this.tx) * k, py - (py - this.ty) * k, animate);
  }
  zoomBy(f) { const r = this.wrap.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
  panBy(dx, dy) { this.go(this.z, this.tx + dx, this.ty + dy, true); }

  // superzoom: centra un punto della stanza (coordinate logiche) a zoom alto
  focusOn(lx, ly, z = SUPER_Z, id = null) {
    const s = this.base * z, W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    this.focused = id;
    this.go(z, W * 0.62 - lx * s, H * 0.55 - ly * s, true);
  }

  onWheel(e) {
    e.preventDefault();
    const f = Math.exp(-(e.deltaY || 0) * (e.ctrlKey ? 0.01 : 0.0022));
    this.zoomAt(e.clientX, e.clientY, f, false);
  }
  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragged = 0;
    if (this.pointers.size === 2) this.pinch = this.dist();
  }
  onMove(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pointers.size === 2) {
      const d = this.dist(), c = this.center();
      if (this.pinch) this.zoomAt(c.x, c.y, d / this.pinch, false);
      this.pinch = d; this.dragged += 10; return;
    }
    this.dragged += Math.abs(dx) + Math.abs(dy);
    if (this.dragged > 4) {
      if (!this.wrap.hasPointerCapture?.(e.pointerId)) try { this.wrap.setPointerCapture(e.pointerId); } catch { /* ok */ }
      this.wrap.classList.add('dragging');
      cancelAnimationFrame(this.anim);
      [this.tx, this.ty] = this.clamp(this.z, this.tx + dx, this.ty + dy); this.apply();
    }
  }
  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.wrap.classList.remove('dragging');
  }
  // un trascinamento non deve valere come clic su un personaggio
  get wasDrag() { return this.dragged > 6; }
  dist() { const [a, b] = [...this.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
  center() { const [a, b] = [...this.pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
}
