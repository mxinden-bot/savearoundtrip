/* Tiny SVG sequence-diagram renderer, ported from the performance.now() 2026
 * slides (mxinden-bot/slides, theme/seq.js) so the site's diagrams match the
 * talk. Themed by the site's CSS variables; re-renders on resize.
 *
 *   Seq.register("id", {
 *     actors: [{ id: "C", label: "Client" }, { id: "S", label: "Server" }],
 *     messages: [
 *       { from: "C", to: "S", text: "TCP SYN" },
 *       { from: "S", to: "C", text: "SYN-ACK", dashed: true },
 *       { note: "the browser learns about HTTP/3 only now", over: ["C", "S"] },
 *       { from: "C", to: "S", text: "GET /", hl: true },
 *     ],
 *   });
 */
(function () {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let uid = 0;

  function render(el, spec) {
    const css = getComputedStyle(document.documentElement);
    const v = (n, f) => css.getPropertyValue(n).trim() || f;
    const INK = v("--fg", "#1c2126"), MUTED = v("--fg-dim", "#5a6570"), HAIR = v("--line", "#d6dad0"),
      SURF = v("--bg-soft", "#eef0ea"), ACC = v("--accent", "#1a9a4b"), FONT = v("--sans", "system-ui, sans-serif");
    const mk = `seqah${++uid}`, mkA = `${mk}A`;
    const actors = spec.actors, msgs = spec.messages;
    const W = Math.max(260, el.clientWidth || 420);
    const k = W < 360 ? 0.9 : 1;
    const padX = 8, topH = 40 * k, rowH = 34 * k, noteH = 28 * k, botPad = 12;
    const n = actors.length, laneW = (W - 2 * padX) / n;
    const cx = (i) => padX + laneW * (i + 0.5);
    const idx = {};
    actors.forEach((a, i) => (idx[a.id] = i));
    const H = topH + msgs.reduce((h, m) => h + (m.note ? noteH + 6 : rowH), 0) + botPad;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" font-family="${esc(FONT)}" role="img"` +
      (spec.label ? ` aria-label="${esc(spec.label)}"` : "") + `>`;
    s += `<defs><marker id="${mk}" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">` +
      `<path d="M0,0 L7,3 L0,6 Z" fill="${MUTED}"/></marker>` +
      `<marker id="${mkA}" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">` +
      `<path d="M0,0 L7,3 L0,6 Z" fill="${ACC}"/></marker></defs>`;

    actors.forEach((a, i) => {
      const x = cx(i);
      s += `<line x1="${x}" y1="${topH}" x2="${x}" y2="${H - botPad}" stroke="${HAIR}" stroke-width="1.5"/>`;
      s += `<rect x="${x - laneW * 0.42}" y="6" width="${laneW * 0.84}" height="${26 * k}" rx="6" fill="${SURF}" stroke="${HAIR}"/>`;
      s += `<text x="${x}" y="${6 + 17 * k}" text-anchor="middle" font-size="${13 * k}" font-weight="700" fill="${INK}">${esc(a.label)}</text>`;
    });

    let y = topH + 6;
    msgs.forEach((m) => {
      if (m.note) {
        const ids = (m.over || actors.map((a) => a.id)).map((id) => idx[id]);
        const x1 = cx(Math.min(...ids)) - laneW * 0.4, x2 = cx(Math.max(...ids)) + laneW * 0.4;
        s += `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="${noteH}" rx="5" fill="${ACC}" fill-opacity="0.10" stroke="${ACC}" stroke-opacity="0.35"/>`;
        s += `<text x="${(x1 + x2) / 2}" y="${y + noteH / 2 + 4 * k}" text-anchor="middle" font-size="${12 * k}" fill="${ACC}">${esc(m.note)}</text>`;
        y += noteH + 6;
        return;
      }
      const xa = cx(idx[m.from]), xb = cx(idx[m.to]);
      const yy = y + rowH - 12 * k, dir = xb >= xa ? 1 : -1;
      const col = m.hl ? ACC : MUTED, mark = m.hl ? mkA : mk;
      s += `<text x="${(xa + xb) / 2}" y="${yy - 6 * k}" text-anchor="middle" font-size="${12 * k}" ` +
        `fill="${m.hl ? ACC : INK}" font-weight="${m.hl ? 700 : 400}">${esc(m.text)}</text>`;
      s += `<line x1="${xa + dir * 2}" y1="${yy}" x2="${xb - dir * 6}" y2="${yy}" stroke="${col}" ` +
        `stroke-width="1.6" ${m.dashed ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#${mark})"/>`;
      y += rowH;
    });
    el.innerHTML = s + "</svg>";
  }

  const reg = {};
  const renderAll = () => {
    for (const [id, spec] of Object.entries(reg)) {
      const el = document.getElementById(id);
      if (el && el.clientWidth > 0) render(el, spec);
    }
  };
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(renderAll, 120);
  });
  window.Seq = {
    register(id, spec) {
      reg[id] = spec;
    },
    renderAll,
  };
})();
