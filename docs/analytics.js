// Analytics dashboard. Pulls the four mirror JSONs in parallel and renders
// inline-SVG charts client-side. Vanilla JS, no external libraries.
import { rawJsonFetch, relativeTime, formatTimestamp } from "./auth.js";

const SOURCES = {
  data: "docs/data.json",
  accepted: "docs/accepted.json",
  published: "docs/published.json",
  rejected: "docs/rejected.json",
};

const SERIOUS_CATEGORIES = new Set([
  "hard_truth", "factual_post", "quote_post",
  "carousel_micro_essay", "mindset_post", "training_insight",
]);

// Muted single-accent palette.
const COLORS = { memes: "#0f766e", serious: "#b45309", bar: "#1e3a8a" };

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}
function el(tag, opts = {}) {
  const n = document.createElement(tag);
  if (opts.cls) n.className = opts.cls;
  if (opts.text !== undefined) n.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, String(v));
  if (opts.children) for (const c of opts.children) n.appendChild(c);
  return n;
}
function noteP(msg) { return el("p", { cls: "note-muted", text: msg }); }

async function fetchAll() {
  const entries = await Promise.all(Object.entries(SOURCES).map(async ([key, path]) => {
    try { return [key, await rawJsonFetch(path), null]; }
    catch (e) { return [key, null, e.message || String(e)]; }
  }));
  const out = { errors: {} };
  for (const [key, json, err] of entries) { out[key] = json; if (err) out.errors[key] = err; }
  return out;
}

function asList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.memes)) return payload.memes;
  if (Array.isArray(payload)) return payload;
  return [];
}
function ymd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function classifyMix(category) {
  const c = (category || "").toString().toLowerCase();
  if (!c) return "memes";
  return SERIOUS_CATEGORIES.has(c) ? "serious" : "memes";
}
function sumStat(memes, key) {
  let total = 0, any = false;
  for (const m of memes) {
    const s = m && m.stats;
    if (!s || typeof s !== "object" || s.error) continue;
    const v = s[key];
    if (typeof v === "number" && Number.isFinite(v)) { total += v; any = true; }
  }
  return any ? total : null;
}
function getReachLike(s) {
  if (!s || s.error) return null;
  if (typeof s.reach === "number") return s.reach;
  if (typeof s.views === "number") return s.views;
  if (typeof s.impressions === "number") return s.impressions;
  return null;
}

// --- Summary cards ---
function renderSummary(data) {
  const grid = $("#summary-grid");
  grid.textContent = "";
  const published = asList(data.published);
  const accepted = asList(data.accepted);
  const rejected = asList(data.rejected);
  const totalPosts = published.length;
  const approvalBase = totalPosts + rejected.length;
  const approvalRate = approvalBase > 0 ? Math.round((totalPosts / approvalBase) * 100) : null;
  const cards = [
    { label: "Published", value: totalPosts, hint: "total posts" },
    { label: "Total likes", value: sumStat(published, "likes"), hint: "across published" },
    { label: "Total comments", value: sumStat(published, "comments"), hint: "across published" },
    { label: "Total reach", value: sumStat(published, "reach"), hint: "sum of reach" },
    { label: "Approval rate", value: approvalRate === null ? null : `${approvalRate}%`, hint: "pub / (pub + rej)" },
    { label: "In queue", value: accepted.length, hint: "accepted.json" },
  ];
  for (const c of cards) {
    const value = el("div", { cls: "stat-card-value" });
    if (c.value === null || c.value === undefined) {
      value.textContent = "\u2014"; value.classList.add("stat-card-na");
    } else if (typeof c.value === "number") {
      value.textContent = c.value.toLocaleString();
    } else { value.textContent = String(c.value); }
    grid.appendChild(el("div", { cls: "stat-card", children: [
      el("div", { cls: "stat-card-label", text: c.label }),
      value,
      el("div", { cls: "stat-card-hint", text: c.hint }),
    ] }));
  }
}

// --- Donut chart (two stroke-dasharray arcs on concentric circles). ---
function renderContentMix(data) {
  const c = $("#content-mix");
  c.textContent = "";
  if (data.errors.published) { c.appendChild(noteP("(published data unavailable)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("No published posts yet.")); return; }

  let memes = 0, serious = 0;
  for (const m of published) (classifyMix(m.category) === "serious") ? serious++ : memes++;
  const total = memes + serious;

  const size = 180, r = 72, cx = size / 2, cy = size / 2, stroke = 22;
  const C = 2 * Math.PI * r;
  const fracM = total ? memes / total : 0;
  const fracS = total ? serious / total : 0;

  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size,
    class: "donut-svg", role: "img", "aria-label": `${memes} memes, ${serious} serious` });
  svg.appendChild(svgEl("circle", { cx, cy, r, fill: "none", stroke: "var(--border)", "stroke-width": stroke }));
  if (fracM > 0) svg.appendChild(svgEl("circle", { cx, cy, r, fill: "none",
    stroke: COLORS.memes, "stroke-width": stroke,
    "stroke-dasharray": `${C * fracM} ${C}`, "stroke-dashoffset": 0,
    transform: `rotate(-90 ${cx} ${cy})` }));
  if (fracS > 0) svg.appendChild(svgEl("circle", { cx, cy, r, fill: "none",
    stroke: COLORS.serious, "stroke-width": stroke,
    "stroke-dasharray": `${C * fracS} ${C}`, "stroke-dashoffset": -(C * fracM),
    transform: `rotate(-90 ${cx} ${cy})` }));
  const top = svgEl("text", { x: cx, y: cy - 2, "text-anchor": "middle", class: "donut-center-top" });
  top.textContent = String(total);
  const bot = svgEl("text", { x: cx, y: cy + 16, "text-anchor": "middle", class: "donut-center-bot" });
  bot.textContent = "posts";
  svg.appendChild(top); svg.appendChild(bot);

  const legend = el("ul", { cls: "chart-legend", children: [
    legendRow(COLORS.memes, "Memes", memes, total),
    legendRow(COLORS.serious, "Serious", serious, total),
  ] });
  c.appendChild(el("div", { cls: "donut-wrap", children: [svg, legend] }));
}

function legendRow(color, label, value, total) {
  const swatch = el("span", { cls: "legend-swatch" }); swatch.style.background = color;
  const pct = total > 0 ? ` (${Math.round((value / total) * 100)}%)` : "";
  return el("li", { children: [
    swatch,
    el("span", { cls: "legend-label", text: label }),
    el("span", { cls: "legend-count", text: `${value}${pct}` }),
  ] });
}

// --- Posts-per-day timeline (30-day bar chart). ---
function renderTimeline(data) {
  const c = $("#timeline");
  c.textContent = "";
  if (data.errors.published) { c.appendChild(noteP("(published data unavailable)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("No published posts yet.")); return; }

  const days = [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push({ key: d.toISOString().slice(0, 10), count: 0 });
  }
  const map = new Map(days.map(d => [d.key, d]));
  let distinctDays = 0;
  for (const m of published) {
    const k = ymd(m.posted_at);
    const bucket = k && map.get(k);
    if (bucket) { if (bucket.count === 0) distinctDays++; bucket.count += 1; }
  }
  const maxCount = Math.max(1, ...days.map(d => d.count));
  const compact = distinctDays < 7;
  const W = 600, H = compact ? 160 : 140, padL = 28, padR = 8, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB, barW = plotW / days.length;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "timeline-svg",
    preserveAspectRatio: "xMinYMid meet", role: "img",
    "aria-label": "Posts per day over last 30 days" });

  for (const gv of [Math.ceil(maxCount / 2), maxCount]) {
    const y = padT + plotH - (gv / maxCount) * plotH;
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: "var(--border)", "stroke-width": 1, "stroke-dasharray": "2 3" }));
    const lbl = svgEl("text", { x: padL - 6, y: y + 3, "text-anchor": "end", class: "axis-label" });
    lbl.textContent = String(gv);
    svg.appendChild(lbl);
  }
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const h = (d.count / maxCount) * plotH;
    const rect = svgEl("rect", { x: padL + i * barW + 1, y: padT + plotH - h,
      width: Math.max(1, barW - 2), height: Math.max(0, h),
      fill: d.count > 0 ? COLORS.bar : "var(--surface-2)", rx: 2 });
    const title = svgEl("title", {});
    title.textContent = `${d.key}: ${d.count} post${d.count === 1 ? "" : "s"}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  }
  for (const i of [0, Math.floor(days.length / 2), days.length - 1]) {
    const txt = svgEl("text", { x: padL + i * barW + barW / 2, y: H - 8,
      "text-anchor": "middle", class: "axis-label" });
    txt.textContent = days[i].key.slice(5);
    svg.appendChild(txt);
  }
  c.appendChild(svg);
  if (compact) {
    c.appendChild(el("p", { cls: "chart-note",
      text: `Only ${distinctDays} day${distinctDays === 1 ? "" : "s"} with posts so far. Timeline will fill in as more posts go out.` }));
  }
}

// --- Top 5 posts by likes ---
function renderTopPosts(data) {
  const c = $("#top-posts");
  c.textContent = "";
  if (data.errors.published) { c.appendChild(noteP("(published data unavailable)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("No published posts yet.")); return; }

  const scored = published.map(m => {
    const s = (m && m.stats && !m.stats.error) ? m.stats : null;
    return { m, s, likes: s && typeof s.likes === "number" ? s.likes : -1, hasStats: !!s };
  });
  scored.sort((a, b) => (a.hasStats !== b.hasStats) ? (a.hasStats ? -1 : 1) : (b.likes - a.likes));

  for (const { m, s, hasStats } of scored.slice(0, 5)) {
    const img = el("img", { attrs: { loading: "lazy", alt: String(m.id || "meme") } });
    if (m.image_url) img.src = String(m.image_url);
    const thumb = el("a", { cls: "top-post-thumb", attrs: { target: "_blank", rel: "noopener" }, children: [img] });
    if (m.image_url) thumb.href = String(m.image_url);

    const capText = String(m.caption || "").split(/\n/)[0].slice(0, 120);
    const caption = el("div", { cls: "top-post-caption", text: capText || "(no caption)" });

    let metaNode;
    if (hasStats) {
      const parts = [`${(s.likes || 0).toLocaleString()} likes`,
        `${(s.comments || 0).toLocaleString()} comments`];
      const reach = getReachLike(s);
      if (reach !== null) parts.push(`${reach.toLocaleString()} reach`);
      metaNode = el("div", { cls: "top-post-meta", text: parts.join(" \u00b7 ") });
    } else {
      metaNode = el("div", { cls: "top-post-meta note-muted", text: "(stats unavailable)" });
    }

    const bodyChildren = [caption, metaNode];
    if (m.permalink) {
      const link = el("a", { cls: "top-post-permalink", text: "Open on Instagram \u2192" });
      link.href = String(m.permalink); link.target = "_blank"; link.rel = "noopener";
      bodyChildren.push(link);
    }
    c.appendChild(el("article", { cls: "top-post", children: [
      thumb, el("div", { cls: "top-post-body", children: bodyChildren }),
    ] }));
  }
}

// --- Category engagement table with sortable columns ---
const categoryState = { rows: [], sortKey: "count", sortDir: -1 };

function renderCategoryTable(data) {
  const tbody = $("#category-table tbody");
  tbody.textContent = "";
  if (data.errors.published) {
    const td = el("td", { cls: "note-muted", text: "(published data unavailable)" });
    td.colSpan = 5;
    tbody.appendChild(el("tr", { children: [td] }));
    return;
  }
  const published = asList(data.published);
  const agg = new Map();
  for (const m of published) {
    const cat = (m.category || "uncategorized").toString();
    if (!agg.has(cat)) agg.set(cat, { category: cat, count: 0,
      likes_sum: 0, comments_sum: 0, reach_sum: 0,
      likes_n: 0, comments_n: 0, reach_n: 0 });
    const r = agg.get(cat);
    r.count += 1;
    const s = m && m.stats;
    if (s && !s.error) {
      if (typeof s.likes === "number") { r.likes_sum += s.likes; r.likes_n++; }
      if (typeof s.comments === "number") { r.comments_sum += s.comments; r.comments_n++; }
      const reach = getReachLike(s);
      if (reach !== null) { r.reach_sum += reach; r.reach_n++; }
    }
  }
  categoryState.rows = Array.from(agg.values()).map(r => ({
    category: r.category, count: r.count,
    avg_likes: r.likes_n > 0 ? r.likes_sum / r.likes_n : null,
    avg_comments: r.comments_n > 0 ? r.comments_sum / r.comments_n : null,
    avg_reach: r.reach_n > 0 ? r.reach_sum / r.reach_n : null,
  }));
  drawCategoryRows();
}

function drawCategoryRows() {
  const tbody = $("#category-table tbody");
  tbody.textContent = "";
  const { rows, sortKey, sortDir } = categoryState;
  if (!rows.length) {
    const td = el("td", { cls: "note-muted", text: "No published categories yet." });
    td.colSpan = 5;
    tbody.appendChild(el("tr", { children: [td] }));
    return;
  }
  const sorted = rows.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });
  const fmt = v => (v === null || v === undefined) ? "\u2014"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  for (const r of sorted) {
    tbody.appendChild(el("tr", { children: [
      el("td", { text: r.category }),
      el("td", { text: r.count.toLocaleString() }),
      el("td", { text: fmt(r.avg_likes) }),
      el("td", { text: fmt(r.avg_comments) }),
      el("td", { text: fmt(r.avg_reach) }),
    ] }));
  }
  for (const th of document.querySelectorAll("#category-table thead th")) {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortKey) th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
  }
}

function wireCategorySort() {
  for (const th of document.querySelectorAll("#category-table thead th.sortable")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (categoryState.sortKey === key) categoryState.sortDir *= -1;
      else { categoryState.sortKey = key; categoryState.sortDir = key === "category" ? 1 : -1; }
      drawCategoryRows();
    });
  }
}

// --- Rejection reasons: tally first meaningful word from each rejection comment. ---
const STOPWORDS = new Set([
  "the", "a", "an", "is", "it", "i", "to", "of", "in", "on", "and",
  "but", "or", "for", "with", "что", "это", "как", "не", "и", "в",
  "на", "по", "с", "у", "о", "же", "вы", "мы", "они", "он", "она",
]);

function tokenizeComment(c) {
  return c.split(/\s+/)
    .map(t => t.toLowerCase().replace(/[\.,!?:;"'\u00ab\u00bb\u201c\u201d]/g, ""))
    .filter(t => t);
}

function renderRejectionReasons(data) {
  const c = $("#rejection-reasons");
  c.textContent = "";
  if (data.errors.rejected) {
    const li = el("li", { cls: "note-muted", text: "(rejected data unavailable)" });
    li.style.listStyle = "none";
    c.appendChild(li);
    return;
  }
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const m of asList(data.rejected)) {
    const evts = (Array.isArray(m.action_log) ? m.action_log : [])
      .filter(e => e && e.event === "rejected_by_user");
    if (!evts.length) { bump("(no reason)"); continue; }
    for (const e of evts) {
      const c2 = (e.comment || "").trim();
      if (!c2) { bump("(no reason)"); continue; }
      const toks = tokenizeComment(c2);
      const first = toks[0];
      if (!first) { bump("(no reason)"); continue; }
      if (STOPWORDS.has(first)) {
        const alt = toks.find(t => !STOPWORDS.has(t));
        bump(alt || first);
      } else bump(first);
    }
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    const li = el("li", { cls: "note-muted", text: "No rejections yet." });
    li.style.listStyle = "none";
    c.appendChild(li);
    return;
  }
  for (const [term, n] of entries) {
    c.appendChild(el("li", { children: [
      el("span", { cls: "reason-word", text: term }),
      el("span", { cls: "reason-count", text: `\u00d7${n}` }),
    ] }));
  }
}

// --- Rating distribution (future: populated when mirrors expose `rating`). ---
function renderRatingDistribution(data) {
  const c = $("#rating-distribution");
  c.textContent = "";
  const all = [...asList(data.published), ...asList(data.accepted), ...asList(data.rejected)];
  const buckets = [0, 0, 0, 0, 0];
  let seen = 0;
  for (const m of all) {
    const r = m && m.rating;
    if (typeof r === "number" && r >= 1 && r <= 5) { buckets[Math.floor(r) - 1]++; seen++; }
  }
  if (seen === 0) {
    c.appendChild(noteP("Ratings will appear here as you rate memes on the Review page."));
    return;
  }
  const max = Math.max(1, ...buckets);
  const W = 320, H = 140, padL = 24, padR = 8, padT = 8, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB, slot = plotW / 5;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "rating-svg",
    role: "img", "aria-label": "Rating distribution" });
  for (let i = 0; i < 5; i++) {
    const h = (buckets[i] / max) * plotH;
    const x = padL + i * slot + 6, y = padT + plotH - h;
    svg.appendChild(svgEl("rect", { x, y, width: slot - 12,
      height: Math.max(0, h), fill: COLORS.bar, rx: 2 }));
    const lbl = svgEl("text", { x: padL + i * slot + slot / 2, y: H - 8,
      "text-anchor": "middle", class: "axis-label" });
    lbl.textContent = `${i + 1}\u2605`;
    svg.appendChild(lbl);
    if (buckets[i] > 0) {
      const cnt = svgEl("text", { x: padL + i * slot + slot / 2, y: y - 4,
        "text-anchor": "middle", class: "axis-label" });
      cnt.textContent = String(buckets[i]);
      svg.appendChild(cnt);
    }
  }
  c.appendChild(svg);
}

// --- Header wiring ---
function wireRefresh(reload) {
  const btn = $("#refresh-btn");
  const note = $("#refresh-note");
  btn.addEventListener("click", () => {
    note.hidden = false;
    btn.disabled = true;
    btn.textContent = "Refreshing\u2026";
    reload().finally(() => { btn.disabled = false; btn.textContent = "Refresh stats"; });
  });
}
function renderGeneratedAt(data) {
  const el2 = $("#generated-at");
  const ts = data.published && data.published.generated_at;
  if (ts) { el2.textContent = `Mirror updated ${relativeTime(ts)}`; el2.title = formatTimestamp(ts); }
  else el2.textContent = "";
}
function renderLoadErrors(data) {
  const box = $("#load-error");
  const errs = Object.entries(data.errors);
  if (!errs.length) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = "";
  box.appendChild(el("p", {
    text: "Some mirrors failed to load; charts will show \"(data unavailable)\" where relevant.",
  }));
  const ul = el("ul");
  for (const [k, v] of errs) ul.appendChild(el("li", { text: `${k}: ${v}` }));
  box.appendChild(ul);
}

async function renderAll() {
  const data = await fetchAll();
  renderLoadErrors(data);
  renderGeneratedAt(data);
  renderSummary(data);
  renderContentMix(data);
  renderTimeline(data);
  renderTopPosts(data);
  renderCategoryTable(data);
  renderRejectionReasons(data);
  renderRatingDistribution(data);
}

wireCategorySort();
wireRefresh(renderAll);
renderAll();
