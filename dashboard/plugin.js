/**
 * Obsidian Memory — dashboard tab.
 *
 * Authored against the Hermes dashboard Plugin SDK (window.__HERMES_PLUGIN_SDK__,
 * contract v1.1). Nothing is bundled: React, the API client and the UI primitives
 * all come off the SDK.
 *
 * Colours are read from the active dashboard theme's `--color-*` custom
 * properties rather than hardcoded, so the tab reskins with the theme picker.
 * DOM styling can use `var(--color-…)` inline; the graph canvas cannot, so it
 * resolves the same tokens through `themeColor()` at draw time.
 */
(function () {
  "use strict";

  const registry = window.__HERMES_PLUGINS__;
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!registry || !registry.register) return;
  if (!sdk) return;

  const { React, fetchJSON, utils } = sdk;
  // `hooks` is the documented surface; fall back to React for older hosts.
  const hooks = sdk.hooks || React;
  const { useState, useEffect, useRef, useMemo, useCallback } = hooks;

  const BASE = "/api/plugins/obsidian-memory";

  // ─── Theme tokens ─────────────────────────────────────────────────
  // Every value keeps a fallback so the tab stays readable on a host whose
  // palette has not defined one of these yet.
  const SURFACE = "var(--color-card, rgba(255,255,255,0.04))";
  const SURFACE_2 = "var(--color-muted, rgba(255,255,255,0.06))";
  const BORDER = "var(--color-border, rgba(255,255,255,0.1))";
  const TEXT = "var(--color-foreground, #e5e5e5)";
  const TEXT_DIM = "var(--color-muted-foreground, rgba(255,255,255,0.55))";
  const ACCENT = "var(--color-primary, #a8e619)";
  const ACCENT_SOFT = "color-mix(in srgb, var(--color-primary, #a8e619) 14%, transparent)";
  const ACCENT_FAINT = "color-mix(in srgb, var(--color-primary, #a8e619) 7%, transparent)";
  const LINK = "var(--color-accent, #60a5fa)";

  /** Resolve a `--color-*` token to a concrete value. Canvas needs real colors. */
  function themeColor(token, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /** Add an alpha channel to a resolved hex/rgb color for canvas fills. */
  function withAlpha(color, alpha) {
    const c = (color || "").trim();
    if (c.startsWith("#")) {
      const hex = c.length === 4
        ? c.slice(1).split("").map(ch => ch + ch).join("")
        : c.slice(1, 7);
      const n = parseInt(hex, 16);
      if (!Number.isNaN(n)) return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
    }
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(",").map(s => s.trim());
      return `rgba(${parts[0]},${parts[1] || "0"},${parts[2] || "0"},${alpha})`;
    }
    return c;
  }

  // Node colours are assigned per folder by hashing the folder name, so any
  // vault layout gets a stable, distinct colour without a hardcoded map.
  const FOLDER_PALETTE = ["#a8e619","#60a5fa","#ff2d75","#f59e0b","#9333ea","#22d3ee","#fb7185","#84cc16"];
  function folderColor(folder) {
    const key = String(folder || "root");
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return FOLDER_PALETTE[h % FOLDER_PALETTE.length];
  }
  /** The folders actually present in the graph, for the legend. */
  const legendFolders = nodes => {
    const seen = [];
    for (const n of nodes) if (!seen.includes(n.folder)) seen.push(n.folder);
    return seen.slice(0, 8);
  };

  // ─── GRAPH (fixed height, no grow) ──────────────────────────────
  function GraphView({ nodes, edges, onSelect, selectedNode }) {
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const [hovered, setHovered] = useState(null);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [scale, setScale] = useState(1);
    const draggingCanvas = useRef(false);
    const draggingNode = useRef(null);
    const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
    const positions = useRef({});
    const velocities = useRef({});
    const frameRef = useRef(null);
    const settled = useRef(false);
    const tickCount = useRef(0);
    const sizeRef = useRef({ w: 800, h: 500 });
    const drawRef = useRef(null);

    // Set canvas from container, use ref for size
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const update = () => {
        const rect = el.getBoundingClientRect();
        const w = Math.floor(rect.width) || 800;
        const h = Math.floor(rect.height) || 500;
        sizeRef.current = { w, h };
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = w; canvas.height = h; }
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Init positions
    useEffect(() => {
      if (!nodes.length) return;
      const { w, h } = sizeRef.current;
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(cx, cy) * 0.5;
      nodes.forEach((n, i) => {
        if (!positions.current[n.id]) {
          const angle = (2 * Math.PI * i) / nodes.length;
          positions.current[n.id] = {
            x: cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 30,
            y: cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 30,
          };
          velocities.current[n.id] = { x: 0, y: 0 };
        }
      });
      const ids = new Set(nodes.map(n => n.id));
      for (const k of Object.keys(positions.current)) {
        if (!ids.has(k)) { delete positions.current[k]; delete velocities.current[k]; }
      }
      settled.current = false;
      tickCount.current = 0;
    }, [nodes]);

    const degreeMap = useMemo(() => {
      const m = {};
      for (const n of nodes) m[n.id] = 0;
      for (const e of edges) {
        if (m[e.source] !== undefined) m[e.source]++;
        if (m[e.target] !== undefined) m[e.target]++;
      }
      return m;
    }, [nodes, edges]);

    // Force sim — reads sizeRef, no state deps
    useEffect(() => {
      if (!nodes.length) return;
      let running = true;
      const damping = 0.82, repulsion = 2500, attraction = 0.005, idealLen = 100;

      const tick = () => {
        if (!running) return;
        const { w, h } = sizeRef.current;
        const cx = w / 2, cy = h / 2;
        const pos = positions.current, vel = velocities.current;

        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = pos[nodes[i].id], b = pos[nodes[j].id];
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist2 = dx * dx + dy * dy || 1;
            const dist = Math.sqrt(dist2);
            const f = Math.min(repulsion / dist2, 40);
            const fx = (dx / dist) * f, fy = (dy / dist) * f;
            vel[nodes[i].id].x -= fx; vel[nodes[i].id].y -= fy;
            vel[nodes[j].id].x += fx; vel[nodes[j].id].y += fy;
          }
        }
        for (const e of edges) {
          const a = pos[e.source], b = pos[e.target];
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (dist - idealLen) * attraction;
          vel[e.source].x += (dx / dist) * f; vel[e.source].y += (dy / dist) * f;
          vel[e.target].x -= (dx / dist) * f; vel[e.target].y -= (dy / dist) * f;
        }
        for (const n of nodes) {
          const p = pos[n.id], v = vel[n.id];
          if (!p || !v) continue;
          const dx = cx - p.x, dy = cy - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 200) { v.x += dx * 0.0002; v.y += dy * 0.0002; }
          v.x *= damping; v.y *= damping;
          p.x += v.x; p.y += v.y;
          p.x = Math.max(20, Math.min(w - 20, p.x));
          p.y = Math.max(20, Math.min(h - 20, p.y));
        }
        tickCount.current++;
        if (tickCount.current > 200 && !settled.current) {
          let maxV = 0;
          for (const n of nodes) { const v = vel[n.id]; if (v) maxV = Math.max(maxV, Math.abs(v.x), Math.abs(v.y)); }
          if (maxV < 0.15) settled.current = true;
        }
        if (!settled.current) frameRef.current = requestAnimationFrame(tick);
      };
      settled.current = false; tickCount.current = 0;
      frameRef.current = requestAnimationFrame(tick);
      return () => { running = false; if (frameRef.current) cancelAnimationFrame(frameRef.current); };
    }, [nodes, edges]);

    // Draw loop — uses raf for smooth rendering
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const draw = () => {
        const ctx = canvas.getContext("2d");
        const W = sizeRef.current.w, H = sizeRef.current.h;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;
        const pos = positions.current;

        // Canvas 2D cannot use `var()`, so resolve the theme tokens here.
        // Re-read every frame: switching themes does not reload the bundle.
        const accentColor = themeColor("--color-primary", "#a8e619");
        const borderColor = themeColor("--color-border", "rgba(255,255,255,0.1)");
        const fgColor = themeColor("--color-foreground", "#e5e5e5");
        const bgColor = themeColor("--color-background", "#05090a");
        const dimColor = themeColor("--color-muted-foreground", "#bbbbbb");

        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.translate(offset.x, offset.y);
        ctx.scale(scale, scale);

        // Edges
        for (const e of edges) {
          const a = pos[e.source], b = pos[e.target];
          if (!a || !b) continue;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const curve = Math.min(dist * 0.1, 20);
          const nx = -dy / dist, ny = dx / dist;
          const cpx = mx + nx * curve, cpy = my + ny * curve;
          const hl = selectedNode === e.source || selectedNode === e.target;
          ctx.strokeStyle = hl ? withAlpha(accentColor, 0.5) : withAlpha(borderColor, 0.6);
          ctx.lineWidth = hl ? 1.5 : 0.7;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cpx, cpy, b.x, b.y); ctx.stroke();
          if (hl) {
            const t = 0.88;
            const ax = (1-t)*(1-t)*a.x+2*(1-t)*t*cpx+t*t*b.x;
            const ay = (1-t)*(1-t)*a.y+2*(1-t)*t*cpy+t*t*b.y;
            const tx = 2*(1-t)*(cpx-a.x)+2*t*(b.x-cpx);
            const ty = 2*(1-t)*(cpy-a.y)+2*t*(b.y-cpy);
            const angle = Math.atan2(ty, tx);
            ctx.fillStyle = withAlpha(accentColor, 0.5);
            ctx.beginPath(); ctx.moveTo(ax, ay);
            ctx.lineTo(ax-7*Math.cos(angle-0.4), ay-7*Math.sin(angle-0.4));
            ctx.lineTo(ax-7*Math.cos(angle+0.4), ay-7*Math.sin(angle+0.4));
            ctx.fill();
          }
        }

        // Nodes
        for (const n of nodes) {
          const p = pos[n.id];
          if (!p) continue;
          const sel = selectedNode === n.id, hov = hovered === n.id;
          const deg = degreeMap[n.id] || 0;
          const r = Math.max(5, Math.min(16, 4 + deg * 2));
          const color = folderColor(n.folder);
          if (sel || hov) {
            const grad = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, r*2.5);
            grad.addColorStop(0, withAlpha(color, 0.19)); grad.addColorStop(1, withAlpha(color, 0));
            ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.x, p.y, r*2.5, 0, Math.PI*2); ctx.fill();
          }
          ctx.beginPath(); ctx.arc(p.x, p.y, r+(sel?2:0), 0, Math.PI*2);
          ctx.fillStyle = sel ? fgColor : color; ctx.globalAlpha = hov ? 1 : 0.85;
          ctx.fill(); ctx.globalAlpha = 1;
          ctx.strokeStyle = sel ? color : withAlpha(bgColor, 0.4); ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
          if (hov || sel || r > 7) {
            ctx.fillStyle = sel ? color : dimColor;
            ctx.font = (sel?"bold ":"") + Math.max(9, Math.min(12, r)) + "px -apple-system, sans-serif";
            ctx.textAlign = "center"; ctx.fillText(n.label, p.x, p.y - r - 4);
          }
        }
        ctx.restore();

        drawRef.current = requestAnimationFrame(draw);
      };
      drawRef.current = requestAnimationFrame(draw);
      return () => { if (drawRef.current) cancelAnimationFrame(drawRef.current); };
    }, [nodes, edges, offset, scale, hovered, selectedNode, degreeMap]);

    // Mouse
    const toGraph = useCallback(e => {
      const rect = canvasRef.current.getBoundingClientRect();
      return { mx: (e.clientX-rect.left-offset.x)/scale, my: (e.clientY-rect.top-offset.y)/scale };
    }, [offset, scale]);

    const findNode = useCallback((mx, my) => {
      const pos = positions.current;
      let best = null, bestD = Infinity;
      for (const n of nodes) {
        const p = pos[n.id]; if (!p) continue;
        const deg = degreeMap[n.id] || 0;
        const r = Math.max(5, Math.min(16, 4+deg*2));
        const d = Math.sqrt((mx-p.x)**2+(my-p.y)**2);
        if (d < r+5 && d < bestD) { best = n.id; bestD = d; }
      }
      return best;
    }, [nodes, degreeMap]);

    const handleMouseDown = useCallback(e => {
      const { mx, my } = toGraph(e);
      const hit = findNode(mx, my);
      if (hit) {
        draggingNode.current = hit;
        dragStart.current = { x: e.clientX, y: e.clientY, ox: positions.current[hit].x, oy: positions.current[hit].y };
        settled.current = false; tickCount.current = 0;
      } else {
        draggingCanvas.current = true;
        dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      }
    }, [toGraph, findNode, offset]);

    const handleMouseMove = useCallback(e => {
      if (draggingNode.current) {
        const dx = (e.clientX-dragStart.current.x)/scale, dy = (e.clientY-dragStart.current.y)/scale;
        const p = positions.current[draggingNode.current];
        if (p) { p.x = dragStart.current.ox+dx; p.y = dragStart.current.oy+dy; }
        const v = velocities.current[draggingNode.current];
        if (v) { v.x = 0; v.y = 0; }
      } else if (draggingCanvas.current) {
        setOffset({ x: dragStart.current.ox+(e.clientX-dragStart.current.x), y: dragStart.current.oy+(e.clientY-dragStart.current.y) });
      } else {
        const { mx, my } = toGraph(e);
        const hit = findNode(mx, my);
        setHovered(hit);
        canvasRef.current.style.cursor = hit ? "pointer" : "grab";
      }
    }, [toGraph, findNode, scale]);

    const handleMouseUp = useCallback(e => {
      if (draggingNode.current) {
        const moved = Math.abs(e.clientX-dragStart.current.x)+Math.abs(e.clientY-dragStart.current.y);
        if (moved < 5) onSelect(draggingNode.current);
      }
      draggingNode.current = null; draggingCanvas.current = false;
    }, [onSelect]);

    const handleWheel = useCallback(e => {
      e.preventDefault();
      setScale(s => Math.min(4, Math.max(0.15, s*(e.deltaY>0?0.92:1.08))));
    }, []);

    return React.createElement("div", { ref: wrapRef, style: { position: "relative", width: "100%", height: "100%", overflow: "hidden" } },
      React.createElement("canvas", {
        ref: canvasRef, style: { width: "100%", height: "100%", display: "block", borderRadius: 8 },
        onMouseDown: handleMouseDown, onMouseMove: handleMouseMove, onMouseUp: handleMouseUp,
        onMouseLeave: () => { draggingCanvas.current = false; draggingNode.current = null; setHovered(null); },
        onWheel: handleWheel,
      }),
      React.createElement("div", { style: { position: "absolute", bottom: 12, right: 12, display: "flex", gap: 4 } },
        React.createElement("button", { onClick: () => setScale(s=>Math.min(4,s*1.3)), style: { width:28,height:28,borderRadius:6,border:"1px solid "+BORDER,background:SURFACE,color:TEXT,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" } }, "+"),
        React.createElement("button", { onClick: () => setScale(s=>Math.max(0.15,s*0.7)), style: { width:28,height:28,borderRadius:6,border:"1px solid "+BORDER,background:SURFACE,color:TEXT,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" } }, "\u2212"),
        React.createElement("button", { onClick: () => { setOffset({x:0,y:0}); setScale(1); }, style: { width:28,height:28,borderRadius:6,border:"1px solid "+BORDER,background:SURFACE,color:TEXT,cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center" } }, "\u21ba")
      ),
      React.createElement("div", { style: { position: "absolute", top: 12, left: 12, display: "flex", gap: 10, flexWrap: "wrap" } },        ...legendFolders(nodes).map(folder=>
          React.createElement("span", { key: folder, style: { fontSize:11,display:"flex",alignItems:"center",gap:4,color:TEXT_DIM } },
            React.createElement("span", { style: { width:8,height:8,borderRadius:"50%",background:folderColor(folder),display:"inline-block" } }), folder))
      )
    );
  }

  // ─── MARKDOWN ────────────────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return "";
    let h = text.replace(/^---[\s\S]*?---\n/m, "");
    h = h.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_,l,c) => `<pre class="om-code-block" data-lang="${l}"><code>${c.trim()}</code></pre>`);
    h = h.replace(/(?:^|\n)(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/g, (_,hdr,sep,body) => {
      const ths = hdr.split("|").filter(c=>c.trim()).map(c=>`<th>${c.trim()}</th>`).join("");
      const rows = body.trim().split("\n").map(r=>{const tds=r.split("|").filter(c=>c.trim()).map(c=>`<td>${c.trim()}</td>`).join("");return `<tr>${tds}</tr>`;}).join("");
      return `<table class="om-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    });
    h = h.replace(/^###### (.+)$/gm, '<h6 class="om-h6">$1</h6>');
    h = h.replace(/^##### (.+)$/gm, '<h5 class="om-h5">$1</h5>');
    h = h.replace(/^#### (.+)$/gm, '<h4 class="om-h4">$1</h4>');
    h = h.replace(/^### (.+)$/gm, '<h3 class="om-h3">$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2 class="om-h2">$1</h2>');
    h = h.replace(/^# (.+)$/gm, '<h1 class="om-h1">$1</h1>');
    h = h.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr class="om-hr" />');
    h = h.replace(/^&gt; (.+)$/gm, '<blockquote class="om-quote">$1</blockquote>');
    h = h.replace(/(<blockquote class="om-quote">.*<\/blockquote>\n?)+/g, m=>`<div class="om-callout">${m}</div>`);
    h = h.replace(/^- \[x\] (.+)$/gm, '<div class="om-check"><span class="om-check-box om-checked">\u2713</span>$1</div>');
    h = h.replace(/^- \[ \] (.+)$/gm, '<div class="om-check"><span class="om-check-box"></span>$1</div>');
    h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="om-img" />');
    h = h.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_,n,a) => `<a class="om-wikilink" data-note="${n}" href="#">${a||n}</a>`);
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="om-link">$1</a>');
    h = h.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/__(.+?)__/g, "<strong>$1</strong>");
    h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
    h = h.replace(/_(.+?)_/g, "<em>$1</em>");
    h = h.replace(/~~(.+?)~~/g, "<del>$1</del>");
    h = h.replace(/`([^`]+)`/g, '<code class="om-inline-code">$1</code>');
    h = h.replace(/^[-*+] (.+)$/gm, '<li class="om-li">$1</li>');
    h = h.replace(/((?:<li class="om-li">.*<\/li>\n?)+)/g, m=>`<ul class="om-ul">${m}</ul>`);
    h = h.replace(/^\d+\. (.+)$/gm, '<li class="om-oli">$1</li>');
    h = h.replace(/((?:<li class="om-oli">.*<\/li>\n?)+)/g, m=>`<ol class="om-ol">${m}</ol>`);
    h = h.replace(/\n\n+/g, '</p><p class="om-p">');
    h = h.replace(/\n/g, "<br/>");
    h = '<p class="om-p">' + h + "</p>";
    h = h.replace(/<p class="om-p">\s*<\/p>/g, "");
    h = h.replace(/<p class="om-p">\s*(<(?:h[1-6]|ul|ol|table|pre|blockquote|div|hr))/g, "$1");
    h = h.replace(/(\/(?:h[1-6]|ul|ol|table|pre|blockquote|div)>)\s*<\/p>/g, "$1");
    return h;
  }

  // ─── CSS ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("obsidian-plugin-styles")) return;
    const s = document.createElement("style");
    s.id = "obsidian-plugin-styles";
    s.textContent = `
      .om-code-block{background:color-mix(in srgb, var(--color-background, #05090a) 60%, transparent);border:1px solid var(--color-border, rgba(255,255,255,.08));border-radius:var(--radius, .5rem);padding:12px 14px;margin:10px 0;overflow-x:auto;font-size:12px;line-height:1.5;font-family:var(--font-mono, ui-monospace, monospace)}
      .om-code-block code{color:var(--color-foreground, #e5e5e5)}
      .om-code-block::before{content:attr(data-lang);display:block;font-size:10px;color:var(--color-muted-foreground, rgba(255,255,255,.4));text-transform:uppercase;margin-bottom:6px}
      .om-table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
      .om-table th{text-align:left;padding:6px 10px;border-bottom:2px solid var(--color-border, rgba(255,255,255,.15));color:var(--color-muted-foreground, rgba(255,255,255,.7));font-weight:600}
      .om-table td{padding:5px 10px;border-bottom:1px solid var(--color-border, rgba(255,255,255,.06))}
      .om-table tr:hover td{background:color-mix(in srgb, var(--color-primary, #a8e619) 6%, transparent)}
      .om-h1{font-size:22px;font-weight:700;margin:16px 0 8px}
      .om-h2{font-size:18px;font-weight:700;margin:14px 0 6px}
      .om-h3{font-size:15px;font-weight:700;margin:12px 0 4px}
      .om-h4,.om-h5,.om-h6{font-size:13px;font-weight:600;margin:10px 0 4px;opacity:.85}
      .om-hr{border:none;border-top:1px solid var(--color-border, rgba(255,255,255,.1));margin:16px 0}
      .om-callout{background:color-mix(in srgb, var(--color-primary, #a8e619) 8%, transparent);border-left:3px solid var(--color-primary, #a8e619);border-radius:0 6px 6px 0;padding:8px 12px;margin:10px 0}
      .om-quote{border-left:2px solid var(--color-border, rgba(255,255,255,.2));padding-left:10px;margin:4px 0;color:var(--color-muted-foreground, rgba(255,255,255,.65));font-style:italic}
      .om-check{display:flex;align-items:center;gap:8px;margin:3px 0;font-size:13px}
      .om-check-box{width:16px;height:16px;border:1.5px solid var(--color-border, rgba(255,255,255,.25));border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
      .om-check-box.om-checked{background:var(--color-primary, #a8e619);border-color:var(--color-primary, #a8e619);color:var(--color-primary-foreground, #000)}
      .om-img{max-width:100%;border-radius:6px;margin:8px 0}
      .om-wikilink{color:var(--color-accent, #60a5fa);cursor:pointer;text-decoration:none;border-bottom:1px dashed color-mix(in srgb, var(--color-accent, #60a5fa) 40%, transparent);border-bottom-width:1px}
      .om-wikilink:hover{text-decoration:none;border-bottom-style:solid}
      .om-link{color:var(--color-primary, #a8e619);text-decoration:none}
      .om-link:hover{text-decoration:underline}
      .om-inline-code{background:color-mix(in srgb, var(--color-foreground, #fff) 10%, transparent);padding:1px 5px;border-radius:3px;font-size:12px;font-family:var(--font-mono, ui-monospace, monospace)}
      .om-ul,.om-ol{margin:4px 0 4px 20px}
      .om-li,.om-oli{margin:2px 0;font-size:13px}
      .om-p{margin:4px 0}
      .om-note-edit{width:100%;min-height:300px;background:var(--color-background, #05090a);border:1px solid var(--color-border, rgba(255,255,255,.15));border-radius:var(--radius, .5rem);padding:12px;color:var(--color-foreground, #e5e5e5);font-family:var(--font-mono, ui-monospace, monospace);font-size:13px;line-height:1.6;resize:vertical;outline:none}
      .om-note-edit:focus{border-color:var(--color-primary, #a8e619);box-shadow:0 0 0 2px color-mix(in srgb, var(--color-ring, #60a5fa) 30%, transparent)}
      .om-edit-bar{display:flex;gap:6px;margin-bottom:8px;align-items:center}
      .om-btn{padding:4px 12px;border-radius:var(--radius, .5rem);border:1px solid var(--color-border, rgba(255,255,255,.15));background:var(--color-muted, rgba(255,255,255,.06));color:var(--color-foreground, #e5e5e5);cursor:pointer;font-size:12px;font-weight:600}
      .om-btn:hover{background:color-mix(in srgb, var(--color-foreground, #fff) 10%, transparent)}
      .om-btn-save{background:color-mix(in srgb, var(--color-primary, #a8e619) 15%, transparent);border-color:color-mix(in srgb, var(--color-primary, #a8e619) 30%, transparent);color:var(--color-primary, #a8e619)}
      .om-btn-cancel{color:var(--color-muted-foreground, rgba(255,255,255,.5))}
      .om-save-status{font-size:11px;color:var(--color-primary, #a8e619);margin-left:8px}
      .om-save-status.om-error{color:var(--color-destructive, #ff6b6b)}
      .om-vault-select{padding:4px 10px;border-radius:var(--radius, .5rem);border:1px solid var(--color-border, rgba(255,255,255,.15));background:var(--color-muted, rgba(255,255,255,.06));color:var(--color-foreground, #e5e5e5);font-size:12px;font-weight:600;cursor:pointer;outline:none}
      .om-vault-select option{background:var(--color-popover, #1a1a2e);color:var(--color-popover-foreground, #e5e5e5)}
    `;
    document.head.appendChild(s);
  }

  // ─── MAIN ─────────────────────────────────────────────────────────
  function ObsidianPlugin() {
    const [vaults, setVaults] = useState([]);
    const [currentVault, setCurrentVault] = useState(null);
    const [notes, setNotes] = useState([]);
    const [folders, setFolders] = useState([]);
    const [tags, setTags] = useState([]);
    const [graph, setGraph] = useState({ nodes: [], edges: [] });
    const [selected, setSelected] = useState(null);
    const [content, setContent] = useState(null);
    const [search, setSearch] = useState("");
    const [aFolder, setAFolder] = useState(null);
    const [aTag, setATag] = useState(null);
    const [view, setView] = useState("notes");
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState("");
    const [saveStatus, setSaveStatus] = useState("");
    const [error, setError] = useState("");

    useEffect(() => { injectStyles(); }, []);

    // Load vaults
    useEffect(() => {
      fetchJSON(BASE + "/vaults").then(v => {
        setVaults(v);
        if (v && v.length > 0) {
          setCurrentVault(cur => cur || v[0].name);
        } else {
          // No vault: nothing will ever set loading false, because loadAll
          // is gated on having a currentVault. Clear it so the empty state
          // renders instead of an eternal "Loading vault...".
          setLoading(false);
        }
      }).catch(e => {
        setError("Could not reach the Obsidian plugin API: " + (e && e.message ? e.message : e));
        setLoading(false);
      });
    }, []);

    const loadAll = useCallback(() => {
      if (!currentVault) return;
      const q = "?vault=" + encodeURIComponent(currentVault);
      setLoading(true);
      Promise.all([
        fetchJSON(BASE + "/notes" + q),
        fetchJSON(BASE + "/folders" + q),
        fetchJSON(BASE + "/tags" + q),
        fetchJSON(BASE + "/graph" + q),
      ])
        .then(([n,f,t,g]) => { setNotes(n); setFolders(f); setTags(t); setGraph(g); setLoading(false); setSelected(null); setContent(null); setEditing(false); })
        .catch(e => {
          console.error("[obsidian]", e);
          setNotes([]); setFolders([]); setTags([]); setGraph({ nodes: [], edges: [] });
          setSelected(null); setContent(null); setEditing(false); setLoading(false);
        });
    }, [currentVault]);

    useEffect(() => { loadAll(); }, [loadAll]);

    useEffect(() => {
      if (!selected || !currentVault) { setContent(null); setEditing(false); return; }
      setEditing(false); setSaveStatus(""); setError("");
      const q = "?vault=" + encodeURIComponent(currentVault);
      fetchJSON(BASE + "/notes/" + encodeURIComponent(selected) + q)
        .then(setContent)
        .catch(e => {
          // A bare wikilink title that several folders share comes back as a
          // 409 with the candidate paths — show them instead of a blank pane.
          const detail = e && e.detail;
          if (detail && detail.candidates) {
            setError(detail.error + " Try: " + detail.candidates.join(", "));
          } else {
            setError("Could not open note: " + (e && e.message ? e.message : e));
          }
          setContent(null);
        });
    }, [selected, currentVault]);

    const filtered = useMemo(() => notes.filter(n => {
      if (search && !n.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (aFolder && n.folder !== aFolder) return false;
      if (aTag && !n.tags.includes(aTag)) return false;
      return true;
    }), [notes, search, aFolder, aTag]);

    const totalWords = notes.reduce((s,n) => s + n.word_count, 0);
    const handleWikilink = useCallback(noteName => { setSelected(noteName); setView("notes"); }, []);

    const startEdit = useCallback(() => { if (!content) return; setEditText(content.content); setEditing(true); setSaveStatus(""); }, [content]);
    const cancelEdit = useCallback(() => { setEditing(false); setEditText(""); setSaveStatus(""); }, []);
    const saveEdit = useCallback(async () => {
      if (!selected || !currentVault) return;
      setSaveStatus("saving...");
      try {
        const q = "?vault=" + encodeURIComponent(currentVault);
        // MUST go through fetchJSON, never a bare fetch: the plugin API routes
        // sit behind the dashboard auth gate, and only fetchJSON attaches the
        // session token. A raw fetch PUT silently 401s and loses the edit.
        const updated = await fetchJSON(
          BASE + "/notes/" + encodeURIComponent(selected) + q + "&content=" + encodeURIComponent(editText),
          { method: "PUT" }
        );
        setContent(updated); setEditing(false); setSaveStatus("saved"); loadAll();
        setTimeout(() => setSaveStatus(""), 2000);
      } catch(e) { setSaveStatus("error: " + e.message); setEditing(false); }
    }, [selected, currentVault, editText, loadAll]);

    const renderedContent = useMemo(() => content ? renderMarkdown(content.content) : "", [content]);
    const viewerRef = useRef(null);
    useEffect(() => {
      const el = viewerRef.current; if (!el) return;
      const handler = e => { const wl = e.target.closest(".om-wikilink"); if (wl) { e.preventDefault(); handleWikilink(wl.dataset.note); } };
      el.addEventListener("click", handler);
      return () => el.removeEventListener("click", handler);
    }, [renderedContent, handleWikilink]);

    const fmtDate = ts => {
      const d = new Date((Number(ts) || 0) * 1000);
      return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
    };
    const contentStyle = view === "graph"
      ? { display: "flex", gap: 14, height: "calc(100vh - 200px)", minHeight: 0 }
      : { display: "flex", gap: 14, minHeight: 400 };

    return React.createElement("div", { style: { padding: 16, height: "100%", overflow: "hidden", color: TEXT, display: "flex", flexDirection: "column" } },
      // Header
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexShrink: 0 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
          React.createElement("h1", { style: { fontSize: 20, fontWeight: 700, margin: 0 } }, "Obsidian Memory"),
          vaults.length > 1 && React.createElement("select", {
            className: "om-vault-select",
            value: currentVault || "",
            onChange: e => {
              setCurrentVault(e.target.value); setSelected(null); setContent(null); setEditing(false);
              setSearch(""); setAFolder(null); setATag(null);
            },
          }, vaults.map(v => React.createElement("option", { key: v.name, value: v.name }, v.name + " (" + (v.note_count ?? "?") + " notes)")))
        ),
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          React.createElement("span", { style: { fontSize: 12, color: TEXT_DIM } },
            notes.length + " notes \u00b7 " + totalWords.toLocaleString() + " words \u00b7 " + folders.length + " folders"),
          ["notes","graph"].map(v => React.createElement("button", {
            key: v, onClick: () => setView(v),
            style: { padding: "5px 14px", borderRadius: 6, border: "1px solid "+BORDER, background: view===v?ACCENT_SOFT:SURFACE, color: view===v?ACCENT:TEXT, cursor: "pointer", fontSize: 12, fontWeight: 600 },
          }, v==="notes"?"Notes":"Graph"))
        )
      ),
      // Search + filters
      React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center", flexShrink: 0 } },
        React.createElement("input", { placeholder:"Search notes...", value:search, onChange:e=>setSearch(e.target.value), style:{padding:"5px 10px",borderRadius:6,border:"1px solid "+BORDER,background:SURFACE,color:TEXT,fontSize:12,width:180,outline:"none"} }),
        folders.map(f => React.createElement("button", { key:f.name, onClick:()=>setAFolder(aFolder===f.name?null:f.name), style:{padding:"3px 8px",borderRadius:4,border:"1px solid "+BORDER,background:aFolder===f.name?ACCENT_FAINT:SURFACE,color:aFolder===f.name?ACCENT:TEXT,cursor:"pointer",fontSize:11} }, f.name+" ("+f.count+")")),
        tags.slice(0,8).map(t => React.createElement("button", { key:t.tag, onClick:()=>setATag(aTag===t.tag?null:t.tag), style:{padding:"3px 8px",borderRadius:4,border:"1px solid "+BORDER,background:aTag===t.tag?ACCENT_FAINT:SURFACE,color:aTag===t.tag?ACCENT:TEXT,cursor:"pointer",fontSize:11} }, "#"+t.tag+" ("+t.count+")"))
      ),
      // Content
      React.createElement("div", { style: contentStyle },
        view === "notes"
          ? React.createElement(React.Fragment, null,
              React.createElement("div", { style: { width: 240, flexShrink: 0, overflow: "auto", border: "1px solid "+BORDER, borderRadius: 8, background: SURFACE } },
                filtered.length === 0
                  ? React.createElement("p", { style: { padding: 16, fontSize: 12, color: TEXT_DIM, textAlign: "center" } }, "No notes found")
                  : filtered.map(n => {
                    const noteId = n.id || n.path || n.name;
                    return React.createElement("div", { key:noteId, onClick:()=>setSelected(noteId), style:{padding:"8px 10px",borderBottom:"1px solid "+BORDER,cursor:"pointer",background:selected===noteId?ACCENT_FAINT:"transparent",transition:"background .15s"} },
                      React.createElement("div", { style:{fontWeight:600,fontSize:12,color:selected===noteId?ACCENT:TEXT} }, n.name),
                      React.createElement("div", { style:{fontSize:10,color:TEXT_DIM,marginTop:2} }, n.folder+" \u00b7 "+n.word_count+" words \u00b7 "+n.link_count+" links"),
                      n.tags.length>0 && React.createElement("div", { style:{display:"flex",gap:3,marginTop:3,flexWrap:"wrap"} }, n.tags.slice(0,3).map(t => React.createElement("span", { key:t, style:{fontSize:9,padding:"1px 5px",border:"1px solid "+BORDER,borderRadius:3,color:TEXT_DIM} }, "#"+t)))
                    );
                  })
              ),
              React.createElement("div", { ref:viewerRef, style:{flex:1,overflow:"auto",border:"1px solid "+BORDER,borderRadius:8,padding:16,background:SURFACE} },
                error ? React.createElement("div", { style:{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--color-destructive, #ff6b6b)",fontSize:13,textAlign:"center",padding:20} }, error)
                : content ? React.createElement("div", null,
                  React.createElement("div", { style:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6} },
                    React.createElement("h2", { style:{fontSize:18,fontWeight:700,margin:0} }, content.name),
                    !editing && React.createElement("button", { onClick:startEdit, className:"om-btn" }, "\u270E Edit")
                  ),
                  React.createElement("div", { style:{display:"flex",gap:5,marginBottom:10,flexWrap:"wrap",alignItems:"center"} },
                    React.createElement("span", { style:{fontSize:10,padding:"2px 7px",border:"1px solid "+BORDER,borderRadius:4,color:TEXT_DIM} }, content.folder),
                    React.createElement("span", { style:{fontSize:10,padding:"2px 7px",border:"1px solid "+BORDER,borderRadius:4,color:TEXT_DIM} }, content.word_count+" words"),
                    React.createElement("span", { style:{fontSize:10,color:TEXT_DIM} }, fmtDate(content.modified)),
                    content.tags.map(t => React.createElement("span", { key:t, style:{fontSize:10,padding:"2px 7px",background:"color-mix(in srgb, "+LINK+" 12%, transparent)",borderRadius:4,color:LINK} }, "#"+t))
                  ),
                  content.backlinks.length>0 && React.createElement("div", { style:{fontSize:11,color:TEXT_DIM,marginBottom:10,padding:"6px 10px",background:SURFACE,borderRadius:6,border:"1px solid "+BORDER} },
                    "Linked from: ", content.backlinks.map((l,i) => React.createElement("span", { key:l, title:l, style:{color:LINK,cursor:"pointer"}, onClick:()=>handleWikilink(l) }, l.split("/").pop().replace(/\.md$/, ""), i<content.backlinks.length-1?", ":""))
                  ),
                  editing
                    ? React.createElement("div", null,
                        React.createElement("div", { className:"om-edit-bar" },
                          React.createElement("button", { onClick:saveEdit, className:"om-btn om-btn-save" }, "\u2713 Save"),
                          React.createElement("button", { onClick:cancelEdit, className:"om-btn om-btn-cancel" }, "Cancel"),
                          saveStatus && React.createElement("span", { className:"om-save-status" + (saveStatus.startsWith("error") ? " om-error" : "") }, saveStatus)
                        ),
                        React.createElement("textarea", { className:"om-note-edit", value:editText, onChange:e=>setEditText(e.target.value), spellCheck:false })
                      )
                    : React.createElement("div", { style:{fontSize:13,lineHeight:1.7}, dangerouslySetInnerHTML:{__html:renderedContent} })
                ) : React.createElement("div", { style:{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:TEXT_DIM,fontSize:13,flexDirection:"column",gap:8} },
                    React.createElement("div", { style:{fontSize:28,opacity:.3} }, "\ud83d\udcd6"), "Select a note to view"
                  )
              )
            )
          : React.createElement(GraphView, { nodes:graph.nodes, edges:graph.edges, onSelect:id=>{setSelected(id);setView("notes")}, selectedNode:selected })
      ),
      loading && React.createElement("div", { style:{padding:32,textAlign:"center",color:TEXT_DIM,fontSize:13} }, "Loading vault..."),
      !loading && vaults.length === 0 && React.createElement("div", { style: { padding: 32, textAlign: "center", fontSize: 13, display: "flex", flexDirection: "column", gap: 8, alignItems: "center" } },
        React.createElement("div", { style: { fontSize: 28, opacity: 0.4 } }, "📂"),
        React.createElement("div", { style: { fontWeight: 600 } }, "No Obsidian vault found"),
        React.createElement("div", { style: { color: TEXT_DIM, fontSize: 12, maxWidth: 460 } },
          "Set OBSIDIAN_VAULT_PATH to your vault directory (a folder containing a .obsidian folder) in ~/.hermes/.env, then reload the dashboard.")
      )
    );
  }

  registry.register("obsidian-memory", ObsidianPlugin);
})();
