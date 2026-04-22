// Analytics dashboard. Pulls the four mirror JSONs in parallel and renders
// inline-SVG charts client-side. Vanilla JS, no external libraries.
import { rawJsonFetch, relativeTime, formatTimestamp } from "./auth.js";
import { overallScore } from "./claude_score.js";

const SOURCES = {
  data: "docs/data.json",
  accepted: "docs/accepted.json",
  published: "docs/published.json",
  rejected: "docs/rejected.json",
  profile: "docs/profile.json",
  approvals: "docs/approvals.json",
};

// Sample-size thresholds. Below these, benchmarks / best-worst comparisons
// and per-post anomaly rules would produce noise — we gate them out instead.
const SAMPLE_GATE_POSTS = 10;        // published.length minimum for engagement extremes + anomalies
const SAMPLE_GATE_REACH_28 = 500;    // rollups.reach.days_28 minimum to trust the niche benchmark

// Intent-score thresholds (prototype, pre-calibration).
// TODO: recalibrate once we have real data from: DM volume, poll votes,
// tagged-friend comments. Current values are placeholders and WILL move.
const INTENT_THRESHOLD_EARLY = 5;    // <5 — "рано"
const INTENT_THRESHOLD_WATCH = 15;   // 5-15 — "наблюдайте"; 15+ — "можно тестировать"

const SERIOUS_CATEGORIES = new Set([
  "hard_truth", "factual_post", "quote_post",
  "carousel_micro_essay", "mindset_post", "training_insight",
]);

// Категории в данных остаются на английском; в UI — таблица соответствия.
const CATEGORY_LABELS_RU = {
  relatable: "жиза",
  shitpost: "шитпост",
  observational: "наблюдение",
  absurd: "абсурд",
  meme: "мем",
  hard_truth: "жёсткая правда",
  factual_post: "факт",
  quote_post: "цитата",
  mindset_post: "мышление",
  training_insight: "с тренировки",
  carousel_micro_essay: "эссе-карусель",
  legacy_import: "импорт IG",
  uncategorized: "без категории",
};
function categoryLabel(cat) {
  if (!cat) return "";
  const key = String(cat).toLowerCase();
  return CATEGORY_LABELS_RU[key] || String(cat);
}

// Muted single-accent palette.
const COLORS = {
  memes: "#0f766e", serious: "#b45309", bar: "#1e3a8a",
  navy: "#4a6fa5", teal: "#2d8a7f", amber: "#c89840", rose: "#b45a7a",
};

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

// Русское множественное число: forms = [one, few, many].
function pluralRuSimple(n, forms) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

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

  // Shareability: saves/reach averaged across published. Same math as save-rate
  // for now (we can't measure shares or profile_visits-per-post directly) —
  // framed as "shareability" so we can swap in richer inputs later.
  const shareArr = published.map(saveRate).filter(v => v !== null);
  const avgShare = shareArr.length ? shareArr.reduce((s, v) => s + v, 0) / shareArr.length : null;

  const cards = [
    { label: "Опубликовано", value: totalPosts, hint: "всего постов" },
    { label: "Всего лайков", value: sumStat(published, "likes"), hint: "по опубликованным" },
    { label: "Всего комментариев", value: sumStat(published, "comments"), hint: "по опубликованным" },
    { label: "Охват (28 дней)", value: ((data.profile && data.profile.rollups && data.profile.rollups.reach && data.profile.rollups.reach.days_28) || null), hint: "данные IG за 28 дней" },
    { label: "Охват (7 дней)",  value: ((data.profile && data.profile.rollups && data.profile.rollups.reach && data.profile.rollups.reach.week) || null), hint: "данные IG за 7 дней" },
    { label: "Просмотры (по постам)", value: sumStat(published, "views"), hint: "сумма просмотров по постам API" },
    { label: "Сохранения", value: sumStat(published, "saved"), hint: "сумма сохранений" },
    { label: "Shareability",
      value: avgShare === null ? null : `${avgShare.toFixed(2)}%`,
      hint: "сохранения / охват · чем выше — тем охотнее делятся",
      tooltip: "Пока замеряем только сохранения относительно охвата. Позже сюда добавим shares и переходы в профиль, когда Instagram откроет эти метрики." },
    { label: "Процент одобрения", value: approvalRate === null ? null : `${approvalRate}%`, hint: "опубл. / (опубл. + откл.)" },
    { label: "В очереди", value: accepted.length, hint: "accepted.json" },
  ];
  for (const c of cards) {
    const value = el("div", { cls: "stat-card-value" });
    if (c.value === null || c.value === undefined) {
      value.textContent = "\u2014"; value.classList.add("stat-card-na");
    } else if (typeof c.value === "number") {
      value.textContent = c.value.toLocaleString();
    } else { value.textContent = String(c.value); }
    const labelNode = el("div", { cls: "stat-card-label", text: c.label });
    if (c.tooltip) {
      const tip = el("span", { cls: "stat-card-tooltip", text: "?" });
      tip.title = c.tooltip;
      labelNode.appendChild(tip);
    }
    grid.appendChild(el("div", { cls: "stat-card", children: [
      labelNode,
      value,
      el("div", { cls: "stat-card-hint", text: c.hint }),
    ] }));
  }
}

// --- Donut chart (two stroke-dasharray arcs on concentric circles). ---
function renderContentMix(data) {
  const c = $("#content-mix");
  c.textContent = "";
  if (data.errors.published) { c.appendChild(noteP("(данные published недоступны)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("Пока нет опубликованных постов.")); return; }

  let memes = 0, serious = 0;
  for (const m of published) (classifyMix(m.category) === "serious") ? serious++ : memes++;
  const total = memes + serious;

  const size = 180, r = 72, cx = size / 2, cy = size / 2, stroke = 22;
  const C = 2 * Math.PI * r;
  const fracM = total ? memes / total : 0;
  const fracS = total ? serious / total : 0;

  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size,
    class: "donut-svg", role: "img", "aria-label": `${memes} мемов, ${serious} серьёзных` });
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
  bot.textContent = "постов";
  svg.appendChild(top); svg.appendChild(bot);

  const legend = el("ul", { cls: "chart-legend", children: [
    legendRow(COLORS.memes, "Мемы", memes, total),
    legendRow(COLORS.serious, "Серьёзные", serious, total),
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
  if (data.errors.published) { c.appendChild(noteP("(данные published недоступны)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("Пока нет опубликованных постов.")); return; }

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
    "aria-label": "Постов в день за последние 30 дней" });

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
    title.textContent = `${d.key}: ${d.count} ${pluralRuSimple(d.count, ["пост", "поста", "постов"])}`;
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
      text: `Пока только ${distinctDays} ${pluralRuSimple(distinctDays, ["день", "дня", "дней"])} с постами. График заполнится по мере публикаций.` }));
  }
}

// --- Top 5 posts by likes ---
function renderTopPosts(data) {
  const c = $("#top-posts");
  c.textContent = "";
  if (data.errors.published) { c.appendChild(noteP("(данные published недоступны)")); return; }
  const published = asList(data.published);
  if (!published.length) { c.appendChild(noteP("Пока нет опубликованных постов.")); return; }

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
    const caption = el("div", { cls: "top-post-caption", text: capText || "(без подписи)" });

    let metaNode;
    if (hasStats) {
      const likes = s.likes || 0;
      const comments = s.comments || 0;
      const parts = [`${likes.toLocaleString()} ${pluralRuSimple(likes, ["лайк", "лайка", "лайков"])}`,
        `${comments.toLocaleString()} ${pluralRuSimple(comments, ["комментарий", "комментария", "комментариев"])}`];
      const reach = getReachLike(s);
      if (reach !== null) parts.push(`охват ${reach.toLocaleString()}`);
      metaNode = el("div", { cls: "top-post-meta", text: parts.join(" \u00b7 ") });
    } else {
      metaNode = el("div", { cls: "top-post-meta note-muted", text: "(статистика недоступна)" });
    }

    const bodyChildren = [caption, metaNode];
    if (m.permalink) {
      const link = el("a", { cls: "top-post-permalink", text: "Открыть в Instagram \u2192" });
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
    const td = el("td", { cls: "note-muted", text: "(данные published недоступны)" });
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
    const td = el("td", { cls: "note-muted", text: "Пока нет опубликованных категорий." });
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
    const catCell = el("td", { text: categoryLabel(r.category) });
    catCell.title = String(r.category);
    tbody.appendChild(el("tr", { children: [
      catCell,
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
    const li = el("li", { cls: "note-muted", text: "(данные rejected недоступны)" });
    li.style.listStyle = "none";
    c.appendChild(li);
    return;
  }
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const m of asList(data.rejected)) {
    const evts = (Array.isArray(m.action_log) ? m.action_log : [])
      .filter(e => e && e.event === "rejected_by_user");
    if (!evts.length) { bump("(без причины)"); continue; }
    for (const e of evts) {
      const c2 = (e.comment || "").trim();
      if (!c2) { bump("(без причины)"); continue; }
      const toks = tokenizeComment(c2);
      const first = toks[0];
      if (!first) { bump("(без причины)"); continue; }
      if (STOPWORDS.has(first)) {
        const alt = toks.find(t => !STOPWORDS.has(t));
        bump(alt || first);
      } else bump(first);
    }
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    const li = el("li", { cls: "note-muted", text: "Отклонений пока нет." });
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
    c.appendChild(noteP("Оценки появятся здесь по мере проставления звёзд на странице Обзор."));
    return;
  }
  const max = Math.max(1, ...buckets);
  const W = 320, H = 140, padL = 24, padR = 8, padT = 8, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB, slot = plotW / 5;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "rating-svg",
    role: "img", "aria-label": "Распределение оценок" });
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

// --- Profile header ---
function renderProfileHeader(data) {
  const host = $("#profile-header");
  host.textContent = "";
  const payload = data.profile;
  if (data.errors.profile || !payload || payload.error || !payload.profile) {
    host.appendChild(el("div", { cls: "warn-pill", text: "Профиль недоступен" }));
    return;
  }
  const p = payload.profile;
  const username = String(p.username || "").trim();
  const name = String(p.name || username || "").trim();
  const bioRaw = String(p.biography || "").trim();
  const bio = bioRaw.length > 100 ? bioRaw.slice(0, 99).trimEnd() + "\u2026" : bioRaw;
  const nn = v => (typeof v === "number" ? v : null);

  const avatarWrap = el("div", { cls: "profile-avatar-wrap" });
  const placeholder = el("div", { cls: "profile-avatar-placeholder",
    text: (name || username || "?").slice(0, 1).toUpperCase() });
  avatarWrap.appendChild(placeholder);
  if (p.profile_picture_url) {
    const img = el("img", { cls: "profile-avatar",
      attrs: { alt: name || username || "аватар профиля", loading: "lazy" } });
    img.addEventListener("load", () => { placeholder.style.display = "none"; });
    img.addEventListener("error", () => img.remove());
    img.src = String(p.profile_picture_url);
    avatarWrap.appendChild(img);
  }

  const nameRow = el("div", { cls: "profile-name" });
  if (name) nameRow.appendChild(el("span", { cls: "profile-name-full", text: name }));
  if (username) nameRow.appendChild(el("span", { cls: "profile-handle", text: `@${username}` }));

  const stat = (v, label) => el("div", { cls: "profile-stat", children: [
    el("div", { cls: "profile-stat-value", text: v === null ? "\u2014" : Number(v).toLocaleString() }),
    el("div", { cls: "profile-stat-label", text: label }),
  ] });
  const stats = el("div", { cls: "profile-stats", children: [
    stat(nn(p.followers_count), "подписчики"),
    stat(nn(p.follows_count), "подписок"),
    stat(nn(p.media_count), "постов"),
  ] });

  const extras = el("div", { cls: "profile-extras" });
  if (bio) extras.appendChild(el("p", { cls: "profile-bio", text: bio }));
  if (username) {
    const link = el("a", { cls: "profile-link", text: "Профиль в Instagram \u2192" });
    link.href = `https://www.instagram.com/${username}/`;
    link.target = "_blank"; link.rel = "noopener";
    extras.appendChild(link);
  }
  host.appendChild(el("div", { cls: "profile-card", children: [avatarWrap,
    el("div", { cls: "profile-info", children: [nameRow, stats, extras] })] }));
}

// --- Follower growth chart (30-day line+area) ---
function pickTrendSeries(trend) {
  const src = [["follower_count", null], ["accounts_engaged", "accounts engaged"],
    ["reach", "reach"]];
  for (const [k, proxy] of src) {
    const arr = trend && Array.isArray(trend[k]) ? trend[k] : [];
    if (arr.length > 0) return { series: arr, proxy };
  }
  return { series: [], proxy: null };
}

function renderFollowerGrowth(data) {
  const host = $("#follower-growth");
  host.textContent = "";
  const payload = data.profile;
  if (data.errors.profile || !payload || payload.error) {
    host.appendChild(noteP("(данные профиля недоступны)")); return;
  }
  const { series, proxy } = pickTrendSeries(payload.trend);
  const points = series
    .map(e => ({ date: e && e.date, value: Number(e && e.value) }))
    .filter(e => e.date && Number.isFinite(e.value))
    .slice(-30);

  // Локализация прокси-метрики: в API приходят ключи accounts_engaged / reach.
  const PROXY_LABELS_RU = {
    "accounts engaged": "вовлечённые аккаунты",
    "reach": "охват",
  };
  if (proxy) host.appendChild(el("p", { cls: "chart-subtitle",
    text: `Показана метрика ${PROXY_LABELS_RU[proxy] || proxy} (прокси)` }));
  if (points.length < 3) {
    host.appendChild(noteP("Сбор данных \u2014 график заполнится в течение 30 дней."));
    return;
  }

  const W = 600, H = 180, padL = 34, padR = 10, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const values = points.map(p => p.value);
  const maxV = Math.max(1, ...values), minV = Math.min(0, ...values);
  const yScale = v => padT + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;
  const xScale = i => padL + (i / (points.length - 1)) * plotW;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "growth-svg",
    preserveAspectRatio: "xMinYMid meet", role: "img",
    "aria-label": "Рост подписчиков за последние 30 дней" });

  for (const gv of [Math.ceil(maxV / 2), maxV]) {
    const y = yScale(gv);
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: "var(--border)", "stroke-width": 1, "stroke-dasharray": "2 3" }));
    const lbl = svgEl("text", { x: padL - 6, y: y + 3, "text-anchor": "end", class: "axis-label" });
    lbl.textContent = String(gv);
    svg.appendChild(lbl);
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i).toFixed(2)},${yScale(p.value).toFixed(2)}`).join(" ");
  const baseY = (padT + plotH).toFixed(2);
  const areaPath = `${linePath} L${xScale(points.length - 1).toFixed(2)},${baseY} L${xScale(0).toFixed(2)},${baseY} Z`;
  svg.appendChild(svgEl("path", { d: areaPath, fill: COLORS.navy, "fill-opacity": "0.16", stroke: "none" }));
  svg.appendChild(svgEl("path", { d: linePath, fill: "none", stroke: COLORS.navy,
    "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  for (let i = 0; i < points.length; i++) {
    const c = svgEl("circle", { cx: xScale(i), cy: yScale(points[i].value), r: 3, fill: COLORS.navy });
    const t = svgEl("title", {});
    t.textContent = `${points[i].date}: ${points[i].value.toLocaleString()}`;
    c.appendChild(t); svg.appendChild(c);
  }
  for (const i of [0, Math.floor(points.length / 2), points.length - 1]) {
    const txt = svgEl("text", { x: xScale(i), y: H - 8, "text-anchor": "middle", class: "axis-label" });
    txt.textContent = String(points[i].date).slice(5);
    svg.appendChild(txt);
  }
  host.appendChild(svg);
}

// --- Approval funnel ---
function renderApprovalFunnel(data) {
  const host = $("#approval-funnel");
  host.textContent = "";
  const nD = asList(data.data).length, nA = asList(data.accepted).length;
  const nP = asList(data.published).length, nR = asList(data.rejected).length;
  const drafted = nD + nA + nP + nR;
  const approvals = data.approvals && typeof data.approvals === "object" ? data.approvals : {};
  let approvedFromDecisions = 0;
  for (const v of Object.values(approvals)) {
    if (v && typeof v === "object" && v.status === "approved") approvedFromDecisions++;
  }
  const approved = approvedFromDecisions + nA + nP;
  const steps = [
    { label: "Сгенерировано", value: drafted },
    { label: "Одобрено", value: approved },
    { label: "В очереди", value: nA },
    { label: "Опубликовано", value: nP },
    { label: "Отклонено", value: nR, reject: true },
  ];
  const maxV = Math.max(1, ...steps.map(s => s.value));
  const wrap = el("div", { cls: "funnel-wrap" });

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const bar = el("div", { cls: "funnel-bar" });
    bar.style.width = `${Math.max(2, (s.value / maxV) * 100)}%`;
    if (s.reject) bar.classList.add("is-reject");
    const barWrap = el("div", { cls: "funnel-bar-wrap", children: [bar,
      el("span", { cls: "funnel-value", text: s.value.toLocaleString() })] });
    wrap.appendChild(el("div", { cls: "funnel-row", children: [
      el("div", { cls: "funnel-label", text: s.label }), barWrap] }));
    if (i < steps.length - 1 && !steps[i + 1].reject && s.value > 0) {
      const p = Math.round((steps[i + 1].value / s.value) * 100);
      wrap.appendChild(el("div", { cls: "funnel-pill-wrap",
        children: [el("span", { cls: "funnel-pill", text: `${p}%` })] }));
    }
  }
  host.appendChild(wrap);
}

// --- AI recommendations (five rules) ---
function medianOf(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function likesReachArr(memes) {
  const out = [];
  for (const m of memes) {
    const s = m && m.stats;
    if (!s || s.error) continue;
    const reach = getReachLike(s);
    if (reach && reach > 0) out.push((typeof s.likes === "number" ? s.likes : 0) / reach);
  }
  return out;
}
function lastRejectionTs(m) {
  const evts = Array.isArray(m && m.action_log) ? m.action_log : [];
  let latest = null;
  for (const e of evts) {
    if (!e || e.event !== "rejected_by_user") continue;
    const t = e.ts ? new Date(e.ts).getTime() : NaN;
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

function evaluateRecommendations(data) {
  const recs = [];
  const published = asList(data.published), accepted = asList(data.accepted),
    rejected = asList(data.rejected);
  const weekAgo = Date.now() - 7 * 86400000;
  const pubLast7 = published.filter(m => {
    const t = m && m.posted_at ? new Date(m.posted_at).getTime() : NaN;
    return Number.isFinite(t) && t >= weekAgo;
  }).length;

  if (pubLast7 < 3) recs.push({ rule: "Правило 1",
    text: "\ud83d\udcc8 Увеличьте выпуск: опубликуйте 3\u20135 постов на этой неделе." });
  if (accepted.length > 5 && pubLast7 < 3) recs.push({ rule: "Правило 2",
    text: "\u23f3 Затор на ревью: очередь разрастается." });

  const memePosts = [], seriousPosts = [];
  for (const m of published) (classifyMix(m.category) === "serious" ? seriousPosts : memePosts).push(m);
  if (memePosts.length >= 5 && seriousPosts.length >= 5) {
    const mm = medianOf(likesReachArr(memePosts)), sm = medianOf(likesReachArr(seriousPosts));
    if (mm !== null && sm !== null && sm > 0 && mm > sm
        && ((mm - sm) / sm) * 100 >= 20) {
      recs.push({ rule: "Правило 3", text: "\ud83c\udfaf Сместите расписание в сторону мемов на неделю." });
    }
  }

  const recent = rejected
    .map(m => ({ m, ts: lastRejectionTs(m) })).filter(x => x.ts !== null)
    .sort((a, b) => b.ts - a.ts).slice(0, 20).map(x => x.m);
  if (recent.length >= 1) {
    const words = new Map();
    for (const m of recent) {
      const evts = (Array.isArray(m.action_log) ? m.action_log : [])
        .filter(e => e && e.event === "rejected_by_user");
      const e = evts[evts.length - 1];
      const txt = e && e.comment ? String(e.comment).trim() : "";
      if (!txt) continue;
      const first = tokenizeComment(txt).find(t => t && !STOPWORDS.has(t));
      if (first) words.set(first, (words.get(first) || 0) + 1);
    }
    let topW = null, topN = 0;
    for (const [w, n] of words) if (n > topN) { topW = w; topN = n; }
    if (topW && topN / recent.length >= 0.30) recs.push({ rule: "Правило 4",
      text: `\ud83d\udeab Частая причина отклонения: «${topW}» \u2014 добавьте предпроверку.` });
  }

  const slots = new Map();
  for (const m of published) {
    if (!m.posted_at) continue;
    const d = new Date(m.posted_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${String(d.getUTCHours()).padStart(2, "0")}:${d.getUTCMinutes() < 30 ? "00" : "30"}`;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(m);
  }
  const qual = Array.from(slots.entries()).filter(([, a]) => a.length >= 5);
  if (qual.length > 0) {
    const overall = medianOf(likesReachArr(published));
    if (overall !== null && overall > 0) {
      let bestSlot = null, bestMed = 0;
      for (const [slot, arr] of qual) {
        const med = medianOf(likesReachArr(arr));
        if (med !== null && med > bestMed) { bestMed = med; bestSlot = slot; }
      }
      if (bestSlot && bestMed > overall && ((bestMed - overall) / overall) * 100 >= 20) {
        recs.push({ rule: "Правило 5",
          text: `\ud83d\udd53 Слот ${bestSlot} выстреливает \u2014 сделайте основным.` });
      }
    }
  }
  return recs;
}

function renderRecommendations(data) {
  const host = $("#recommendations");
  host.textContent = "";
  $("#recs-subline").textContent = "(правила, обновляются при загрузке страницы)";
  const recs = evaluateRecommendations(data);
  if (!recs.length) {
    host.appendChild(noteP("Публикуйте больше \u2014 данных пока мало для осмысленных рекомендаций."));
    return;
  }
  for (const r of recs) host.appendChild(el("div", { cls: "rec-row", children: [
    el("span", { cls: "rec-pill", text: r.rule }),
    el("span", { cls: "rec-text", text: r.text }),
  ] }));
}

// --- Header wiring ---
function wireRefresh(reload) {
  const btn = $("#refresh-btn");
  const note = $("#refresh-note");
  btn.addEventListener("click", () => {
    note.hidden = false;
    btn.disabled = true;
    btn.textContent = "Обновление\u2026";
    reload().finally(() => { btn.disabled = false; btn.textContent = "Обновить статистику"; });
  });
}
function renderGeneratedAt(data) {
  const el2 = $("#generated-at");
  const ts = data.published && data.published.generated_at;
  if (ts) { el2.textContent = `Зеркало обновлено ${relativeTime(ts)}`; el2.title = formatTimestamp(ts); }
  else el2.textContent = "";
}
function renderLoadErrors(data) {
  const box = $("#load-error");
  // Profile + approvals errors are surfaced inline (pill / funnel fallback).
  const errs = Object.entries(data.errors).filter(([k]) => k !== "profile" && k !== "approvals");
  if (!errs.length) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = "";
  box.appendChild(el("p", {
    text: "Не удалось загрузить некоторые зеркала; в соответствующих графиках будет «(данные недоступны)».",
  }));
  const ul = el("ul");
  for (const [k, v] of errs) ul.appendChild(el("li", { text: `${k}: ${v}` }));
  box.appendChild(ul);
}

async function renderAll() {
  const data = await fetchAll();
  renderLoadErrors(data);
  renderGeneratedAt(data);
  renderProfileHeader(data);
  renderSummary(data);
  // Growth-focused sections (below the summary cards, in the requested order).
  renderDailyFollowerGrowth(data);
  renderEngagementRate(data);
  renderSaveRate(data);
  renderVisitFunnel(data);
  renderAnomalies(data);
  renderSlotHeatmap(data);
  renderTopHashtags(data);
  renderMerchReadiness(data);
  renderBucketPerformance(data);
  renderComingSoon();
  // Existing sections further down.
  renderContentMix(data);
  renderTimeline(data);
  renderFollowerGrowth(data);
  renderApprovalFunnel(data);
  renderTopPosts(data);
  renderCategoryTable(data);
  renderRejectionReasons(data);
  renderRatingDistribution(data);
  renderRecommendations(data);
}

// =====================================================================
// GROWTH ANALYTICS
// Shared helpers — engagement rate, reach extraction, thumbnail factory.
// =====================================================================

function engagementRate(m) {
  const s = m && m.stats;
  if (!s || s.error) return null;
  const reach = getReachLike(s);
  if (!reach || reach <= 0) return null;
  const likes = typeof s.likes === "number" ? s.likes : 0;
  const comments = typeof s.comments === "number" ? s.comments : 0;
  const saved = typeof s.saved === "number" ? s.saved : 0;
  return ((likes + comments + saved) / reach) * 100;
}
function saveRate(m) {
  const s = m && m.stats;
  if (!s || s.error) return null;
  const reach = getReachLike(s);
  if (!reach || reach <= 0) return null;
  const saved = typeof s.saved === "number" ? s.saved : 0;
  return (saved / reach) * 100;
}
function thumbLink(m, cls) {
  const img = el("img", { attrs: { loading: "lazy", alt: String(m.id || "meme") } });
  if (m.image_url) img.src = String(m.image_url);
  const a = el("a", { cls: cls || "", attrs: { target: "_blank", rel: "noopener" }, children: [img] });
  if (m.permalink) a.href = String(m.permalink);
  else if (m.image_url) a.href = String(m.image_url);
  return a;
}
function firstLineOfCaption(m) {
  return String((m && m.caption) || "").split(/\n/)[0].slice(0, 120);
}
function pct(v, digits) {
  if (v === null || v === undefined || Number.isNaN(v)) return "\u2014";
  return `${Number(v).toFixed(digits === undefined ? 2 : digits)}%`;
}

// --- 2.1 Daily follower growth ---
function renderDailyFollowerGrowth(data) {
  const host = $("#daily-follower-growth");
  host.textContent = "";
  const payload = data.profile;
  const series = payload && payload.trend && Array.isArray(payload.trend.follower_count)
    ? payload.trend.follower_count : [];
  const points = series
    .map(e => ({ date: e && e.date, value: Number(e && e.value) }))
    .filter(e => e.date && Number.isFinite(e.value))
    .slice(-30);

  const current = (payload && payload.profile && typeof payload.profile.followers_count === "number")
    ? payload.profile.followers_count : null;

  const head = el("div", { cls: "growth-head" });
  head.appendChild(el("div", { cls: "growth-num", text: current === null ? "\u2014" : current.toLocaleString() }));
  const deltas = el("div", { cls: "growth-deltas" });

  function deltaCard(label, delta) {
    const sign = delta === null ? "is-zero" : delta > 0 ? "is-pos" : delta < 0 ? "is-neg" : "is-zero";
    const val = delta === null ? "\u2014" : (delta >= 0 ? "+" : "") + delta.toLocaleString();
    return el("div", { cls: `growth-delta ${sign}`, children: [
      el("span", { cls: "growth-delta-label", text: label }),
      el("span", { cls: "growth-delta-val", text: val }),
    ] });
  }

  if (points.length >= 2) {
    const last = points[points.length - 1].value;
    const prev = points[points.length - 2].value;
    const weekAgo = points.length >= 8 ? points[points.length - 8].value : points[0].value;
    const monthAgo = points[0].value;
    deltas.appendChild(deltaCard("сутки", last - prev));
    deltas.appendChild(deltaCard("неделя", last - weekAgo));
    deltas.appendChild(deltaCard("месяц", last - monthAgo));
  } else {
    deltas.appendChild(deltaCard("сутки", null));
    deltas.appendChild(deltaCard("неделя", null));
    deltas.appendChild(deltaCard("месяц", null));
  }
  head.appendChild(deltas);
  host.appendChild(head);

  if (points.length < 3) {
    host.appendChild(noteP("Данные Instagram не заполнены за этот период (метрика follower_count даёт пустой ряд для маленьких аккаунтов)."));
    return;
  }

  // Compact inline-SVG line chart (reuse the style of renderFollowerGrowth).
  const W = 600, H = 140, padL = 30, padR = 10, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const values = points.map(p => p.value);
  const maxV = Math.max(1, ...values), minV = Math.min(0, ...values);
  const yScale = v => padT + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;
  const xScale = i => padL + (i / (points.length - 1)) * plotW;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "growth-svg",
    preserveAspectRatio: "xMinYMid meet", role: "img",
    "aria-label": "Ежедневный прирост подписчиков" });
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i).toFixed(2)},${yScale(p.value).toFixed(2)}`).join(" ");
  const baseY = (padT + plotH).toFixed(2);
  const areaPath = `${linePath} L${xScale(points.length - 1).toFixed(2)},${baseY} L${xScale(0).toFixed(2)},${baseY} Z`;
  svg.appendChild(svgEl("path", { d: areaPath, fill: COLORS.teal, "fill-opacity": "0.14", stroke: "none" }));
  svg.appendChild(svgEl("path", { d: linePath, fill: "none", stroke: COLORS.teal,
    "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  for (const i of [0, Math.floor(points.length / 2), points.length - 1]) {
    const txt = svgEl("text", { x: xScale(i), y: H - 6, "text-anchor": "middle", class: "axis-label" });
    txt.textContent = String(points[i].date).slice(5);
    svg.appendChild(txt);
  }
  host.appendChild(svg);
}

// --- 2.2 Engagement rate ---
function renderEngagementRate(data) {
  const host = $("#engagement-rate");
  host.textContent = "";
  const published = asList(data.published);
  const withRate = published
    .map(m => ({ m, rate: engagementRate(m) }))
    .filter(x => x.rate !== null);
  if (!withRate.length) {
    host.appendChild(noteP("Нет опубликованных постов со статистикой охвата."));
    return;
  }
  const avg = withRate.reduce((s, x) => s + x.rate, 0) / withRate.length;

  // Sample-size guard: at tiny N or tiny reach, the benchmark line + best/worst
  // extremes are misleading. Keep the avg number but caveat it; hide extremes
  // and replace the benchmark line with a "not enough data" note.
  const reach28 = (data.profile && data.profile.rollups && data.profile.rollups.reach
    && typeof data.profile.rollups.reach.days_28 === "number")
    ? data.profile.rollups.reach.days_28 : 0;
  const belowThreshold = reach28 < SAMPLE_GATE_REACH_28 || published.length < SAMPLE_GATE_POSTS;

  const headline = el("div", { cls: "engagement-headline", text: pct(avg) });
  if (belowThreshold) {
    const caveat = el("span", { cls: "sample-caveat",
      text: `sample: ${reach28.toLocaleString()} охват · ${published.length} ${pluralRuSimple(published.length, ["пост", "поста", "постов"])}` });
    headline.appendChild(caveat);
  }
  host.appendChild(headline);

  if (belowThreshold) {
    host.appendChild(el("p", { cls: "gate-note",
      text: "Недостаточно данных \u2014 benchmark включается при 500+ охвата за 28 дней или 10+ постов. Смотрите тренд направления, не абсолют." }));
    return;
  }

  host.appendChild(el("p", { cls: "bench-note",
    text: "Бенчмарк: средняя вовлечённость в BJJ-нише 1\u20133%." }));

  const sorted = withRate.slice().sort((a, b) => b.rate - a.rate);
  const best = sorted[0], worst = sorted[sorted.length - 1];

  function bwCard(label, x, cls) {
    return el("div", { cls: `bw-card ${cls}`, children: [
      thumbLink(x.m),
      el("div", { children: [
        el("div", { cls: "bw-card-label", text: label }),
        el("div", { cls: "bw-card-rate", text: pct(x.rate) }),
        el("div", { cls: "bw-card-cap", text: firstLineOfCaption(x.m) || "(без подписи)" }),
      ] }),
    ] });
  }
  const pair = el("div", { cls: "best-worst-pair" });
  pair.appendChild(bwCard("Лучший пост", best, "is-best"));
  if (worst && worst !== best) pair.appendChild(bwCard("Худший (проверить)", worst, "is-worst"));
  host.appendChild(pair);
}

// --- 2.3 Save rate ---
function renderSaveRate(data) {
  const host = $("#save-rate");
  host.textContent = "";
  const published = asList(data.published);
  const withRate = published
    .map(m => ({ m, rate: saveRate(m) }))
    .filter(x => x.rate !== null)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
  if (!withRate.length) {
    host.appendChild(noteP("Нет данных о сохранениях. Появятся после первых опубликованных постов с охватом."));
    return;
  }
  host.appendChild(el("p", { cls: "chart-subtitle",
    text: "Высокий показатель сохранений = контент, который хочется вернуться пересмотреть." }));
  const ul = el("ul", { cls: "save-top-list" });
  for (const { m, rate } of withRate) {
    const thumb = thumbLink(m);
    const cap = el("div", { cls: "save-top-cap", text: firstLineOfCaption(m) || "(без подписи)" });
    const r = el("span", { cls: "save-top-rate", text: pct(rate) });
    ul.appendChild(el("li", { children: [thumb, cap, r] }));
  }
  host.appendChild(ul);
}

// --- 2.4 Profile visits vs follower adds ---
function renderVisitFunnel(data) {
  const host = $("#visit-funnel");
  host.textContent = "";
  const p = data.profile;
  const rollup = p && p.rollups || {};
  const visits = rollup.profile_views && typeof rollup.profile_views.days_28 === "number"
    ? rollup.profile_views.days_28 : null;
  // Followers delta over ~28 days, if the trend has it.
  const series = p && p.trend && Array.isArray(p.trend.follower_count) ? p.trend.follower_count : [];
  let newFollowers = null;
  if (series.length >= 2) {
    const last = Number(series[series.length - 1].value);
    const first = Number(series[Math.max(0, series.length - 28)].value);
    if (Number.isFinite(last) && Number.isFinite(first)) newFollowers = last - first;
  }
  const retention = p && p.profile && typeof p.profile.followers_count === "number"
    ? p.profile.followers_count : null;
  const conv = (visits && visits > 0 && typeof newFollowers === "number")
    ? (newFollowers / visits) * 100 : null;

  const row = el("div", { cls: "funnel-mini" });
  function step(label, value, extra) {
    const children = [
      el("div", { cls: "funnel-mini-label", text: label }),
      el("div", { cls: "funnel-mini-val",
        text: value === null || value === undefined ? "\u2014" : Number(value).toLocaleString() }),
    ];
    if (extra) children.push(el("div", { cls: "funnel-mini-conv", text: extra }));
    return el("div", { cls: "funnel-mini-step", children });
  }
  row.appendChild(step("Посещения профиля (28 дн.)", visits));
  row.appendChild(step("Новые подписчики", newFollowers,
    conv === null ? "конверсия: нет данных" : `конверсия: ${pct(conv, 1)}`));
  row.appendChild(step("Всего подписчиков", retention));
  host.appendChild(row);

  if (visits === null && newFollowers === null) {
    host.appendChild(noteP("Instagram не отдаёт эти метрики для аккаунтов <100 подписчиков. Секция заполнится на росте."));
  }
}

// --- 2.5 Anomaly detection ---
// Below the sample gate (N < 10 published) we don't run any per-post triggers:
// at 23 followers the old rules fired at every post and produced noise. Instead,
// we show a single gate message and wait for the data to accumulate. Above the
// gate we keep only the pattern rule: a like-spike >5x the median of the last
// 5 posts that ISN'T backed by a corresponding save-rate bump.
function renderAnomalies(data) {
  const host = $("#anomaly-flags");
  host.textContent = "";
  const published = asList(data.published);
  const N = published.length;

  if (N < SAMPLE_GATE_POSTS) {
    host.appendChild(el("p", { cls: "gate-note",
      text: `Правила антифрода включаются с ${SAMPLE_GATE_POSTS} постов — сейчас ${N}.` }));
    return;
  }

  // Chronological order — we need trailing 5-post windows per post.
  const chrono = published.slice().sort((a, b) =>
    String(a.posted_at || "").localeCompare(String(b.posted_at || "")));

  const flags = [];
  for (let idx = 0; idx < chrono.length; idx++) {
    const m = chrono[idx];
    const s = m && m.stats;
    if (!s || s.error) continue;
    const likes = typeof s.likes === "number" ? s.likes : 0;

    // Need at least 5 prior posts to compute a trailing median.
    if (idx < 5) continue;
    const window = chrono.slice(idx - 5, idx);
    const prevLikes = window.map(p => {
      const ps = p && p.stats;
      return ps && !ps.error && typeof ps.likes === "number" ? ps.likes : null;
    }).filter(v => v !== null);
    if (prevLikes.length < 3) continue;
    const med = medianOf(prevLikes);
    if (med === null || med <= 0) continue;

    if (likes > med * 5) {
      const currSave = saveRate(m);
      const prevSaveArr = window.map(saveRate).filter(v => v !== null);
      const prevSaveMed = medianOf(prevSaveArr);
      // No save-rate bump: current save-rate is missing OR <= 1.2x the median.
      const saveBump = currSave !== null && prevSaveMed !== null
        && prevSaveMed > 0 && currSave > prevSaveMed * 1.2;
      if (!saveBump) {
        flags.push({ m, trigger: `лайки ${likes} > медианы последних 5 ×5 (медиана ${med}), сохранения не подтянулись` });
      }
    }
  }

  if (!flags.length) {
    host.appendChild(noteP("Аномалий не найдено."));
    return;
  }
  const ul = el("ul", { cls: "anomaly-list" });
  for (const f of flags) {
    const cap = firstLineOfCaption(f.m) || (f.m && f.m.id) || "(пост)";
    ul.appendChild(el("li", { children: [
      el("div", { children: [
        el("div", { text: cap }),
        el("div", { cls: "anomaly-trigger", text: f.trigger }),
      ] }),
      el("span", { cls: "anomaly-tag", text: "проверить" }),
    ] }));
  }
  host.appendChild(ul);
}

// --- 2.6 Best-hour/day heatmap ---
function renderSlotHeatmap(data) {
  const host = $("#slot-heatmap");
  host.textContent = "";
  const published = asList(data.published);
  if (published.length < 8) {
    host.appendChild(noteP("Недостаточно данных \u2014 нужен минимум 8 постов."));
    return;
  }
  const DAYS_RU = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  // Monday-first: JS getDay() returns Sun=0..Sat=6, so remap.
  function dayIdx(d) { const j = d.getDay(); return j === 0 ? 6 : j - 1; }
  // 7 days × 2 slots: morning (5:00-13:59), evening (14:00-4:59).
  const grid = Array.from({ length: 7 }, () => [[], []]);
  for (const m of published) {
    const t = m && m.posted_at ? new Date(m.posted_at) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    const rate = engagementRate(m);
    if (rate === null) continue;
    const h = t.getHours();
    const slot = (h >= 5 && h < 14) ? 0 : 1;
    grid[dayIdx(t)][slot].push(rate);
  }
  const avg = grid.map(row => row.map(a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null));
  const vals = avg.flat().filter(v => v !== null);
  if (!vals.length) {
    host.appendChild(noteP("Нет постов с корректным охватом для оценки слотов."));
    return;
  }
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  function bg(v) {
    if (v === null) return "transparent";
    const t = maxV === minV ? 0.5 : (v - minV) / (maxV - minV);
    const a = 0.1 + t * 0.6;
    return `color-mix(in srgb, #2d8a7f ${Math.round(a * 100)}%, var(--surface))`;
  }
  const table = el("table", { cls: "heatmap-table" });
  const thead = el("thead");
  const hr = el("tr", { children: [el("th", { text: "" })] });
  for (let d = 0; d < 7; d++) hr.appendChild(el("th", { text: DAYS_RU[d] }));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  const slotLabels = ["Утро", "Вечер"];
  for (let s = 0; s < 2; s++) {
    const tr = el("tr", { children: [el("th", { text: slotLabels[s] })] });
    for (let d = 0; d < 7; d++) {
      const v = avg[d][s];
      const td = el("td", { cls: "heatmap-cell", text: v === null ? "\u2014" : pct(v, 1) });
      td.style.background = bg(v);
      td.title = `${DAYS_RU[d]} ${slotLabels[s].toLowerCase()}: ${v === null ? "нет данных" : pct(v)}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// --- 2.7 Top 3 hashtags by engagement ---
function renderTopHashtags(data) {
  const host = $("#top-hashtags");
  host.textContent = "";
  const published = asList(data.published);
  const perTag = new Map();
  for (const m of published) {
    const rate = engagementRate(m);
    if (rate === null) continue;
    const caption = String((m && m.caption) || "");
    const tags = new Set((caption.match(/#[\w\u0400-\u04ff]+/g) || []).map(t => t.toLowerCase()));
    for (const tag of tags) {
      if (!perTag.has(tag)) perTag.set(tag, []);
      perTag.get(tag).push(rate);
    }
  }
  const rows = [];
  for (const [tag, arr] of perTag.entries()) {
    if (arr.length < 2) continue;
    rows.push({ tag, n: arr.length, avg: arr.reduce((s, v) => s + v, 0) / arr.length });
  }
  if (!rows.length) {
    host.appendChild(noteP("Недостаточно публикаций с повторяющимися хэштегами (нужно \u22652 постов на тег)."));
    return;
  }
  rows.sort((a, b) => b.avg - a.avg);
  const container = el("div", { cls: "hashtag-top" });
  for (const r of rows.slice(0, 3)) {
    container.appendChild(el("div", { cls: "hashtag-top-row", children: [
      el("span", { cls: "hashtag-top-tag", text: r.tag }),
      el("span", { cls: "hashtag-top-n", text: `${r.n} ${pluralRuSimple(r.n, ["пост", "поста", "постов"])}` }),
      el("span", { cls: "hashtag-top-rate", text: pct(r.avg) }),
    ] }));
  }
  host.appendChild(container);
}

// --- 2.8 Qualified Intent Score (prototype) ---
// Rewrites the old arbitrary-threshold merch-readiness gate. The thesis: the
// density of qualified intent matters more than raw follower count. "23
// followers who save every post" beats "2000 who scroll past."
//
// Current backbone: `avg_saves_per_post / followers_count * 1000`. We only
// have `saves` in the Graph API response right now. Future slots (not yet
// populated — feed them in as they come):
//   - DM volume                      (Graph /insights DM inbox, when available)
//   - Poll votes                     (from story insights, per-story)
//   - Tagged-friend comments         (comment parser: count @mentions)
//
// Thresholds are PLACEHOLDERS — see INTENT_THRESHOLD_* at the top of the file.
// They need recalibration once the richer slots land with real data.
function renderMerchReadiness(data) {
  const host = $("#merch-readiness");
  host.textContent = "";
  const published = asList(data.published);
  const followers = data.profile && data.profile.profile && typeof data.profile.profile.followers_count === "number"
    ? data.profile.profile.followers_count : 0;

  const saveArr = published.map(m => {
    const s = m && m.stats;
    return s && !s.error && typeof s.saved === "number" ? s.saved : null;
  }).filter(v => v !== null);
  const avgSavesPerPost = saveArr.length ? saveArr.reduce((a, b) => a + b, 0) / saveArr.length : 0;

  // Backbone intent score. Protect against div-by-zero at empty accounts.
  const score = followers > 0 ? (avgSavesPerPost / followers) * 1000 : 0;

  let label, cls;
  if (score < INTENT_THRESHOLD_EARLY) { label = "Intent: рано"; cls = "is-early"; }
  else if (score < INTENT_THRESHOLD_WATCH) { label = "Intent: наблюдайте"; cls = "is-watch"; }
  else { label = "Intent: можно тестировать"; cls = "is-ready"; }

  const wrap = el("div", { cls: `merch-signal ${cls}`, children: [
    el("span", { cls: "intent-score-val", text: score.toFixed(2) }),
    el("span", { text: label }),
  ] });
  host.appendChild(wrap);

  host.appendChild(el("div", { cls: "merch-breakdown",
    text: `backbone: avg_saves_per_post / followers × 1000 \u2014 ${avgSavesPerPost.toFixed(2)} / ${followers} × 1000 = ${score.toFixed(2)}` }));
  host.appendChild(el("p", { cls: "intent-score-desc",
    text: "Метрика интента важнее числа подписчиков. Идентичность плотнее размера." }));
  host.appendChild(el("p", { cls: "intent-score-future",
    text: "Будущие слоты: объём DM, голоса в опросах, комментарии с @упоминанием друга. Пороги 5 / 15 \u2014 прототип, пересчитаем на реальных данных." }));
}

// --- Content-bucket performance (published-focused) ---
// Separate from the existing category-table above: that one groups across ALL
// records in data.json regardless of state, this one is strictly about posts
// that shipped. Sortable on header click like the other analytics table.
const bucketState = { rows: [], sortKey: "count", sortDir: -1 };

function renderBucketPerformance(data) {
  const host = $("#bucket-performance");
  host.textContent = "";
  if (data.errors.published) {
    host.appendChild(noteP("(данные published недоступны)"));
    return;
  }
  const published = asList(data.published);
  if (!published.length) {
    host.appendChild(noteP("Пока нет опубликованных постов."));
    return;
  }

  // Aggregate per category. Uses the record's own `category` field (same field
  // the existing table reads) but keeps only buckets with >=1 post.
  const agg = new Map();
  for (const m of published) {
    const cat = (m.category || "uncategorized").toString();
    if (!agg.has(cat)) agg.set(cat, { category: cat, count: 0,
      likes_sum: 0, likes_n: 0, comments_sum: 0, comments_n: 0,
      reach_sum: 0, reach_n: 0, eng_sum: 0, eng_n: 0,
      score_sum: 0, score_n: 0 });
    const r = agg.get(cat);
    r.count += 1;
    const s = m && m.stats;
    if (s && !s.error) {
      if (typeof s.likes === "number") { r.likes_sum += s.likes; r.likes_n++; }
      if (typeof s.comments === "number") { r.comments_sum += s.comments; r.comments_n++; }
      const reach = getReachLike(s);
      if (reach !== null) { r.reach_sum += reach; r.reach_n++; }
      const eng = engagementRate(m);
      if (eng !== null) { r.eng_sum += eng; r.eng_n++; }
    }
    const ov = overallScore(m && m.claude_score);
    if (ov !== null) { r.score_sum += ov; r.score_n++; }
  }

  bucketState.rows = Array.from(agg.values()).map(r => ({
    category: r.category,
    count: r.count,
    avg_likes: r.likes_n > 0 ? r.likes_sum / r.likes_n : null,
    avg_comments: r.comments_n > 0 ? r.comments_sum / r.comments_n : null,
    avg_reach: r.reach_n > 0 ? r.reach_sum / r.reach_n : null,
    avg_eng: r.eng_n > 0 ? r.eng_sum / r.eng_n : null,
    avg_score: r.score_n > 0 ? r.score_sum / r.score_n : null,
  }));

  // Only-one-category case: can't compare, leave a note and bail out.
  if (bucketState.rows.length < 2) {
    host.appendChild(noteP("Нужно \u22652 категории чтобы сравнивать."));
    // Still render a single-row table so the one bucket's numbers are visible.
  }

  drawBucketTable(host);
}

function drawBucketTable(hostOverride) {
  const host = hostOverride || $("#bucket-performance");
  // Preserve any existing note paragraph; replace only the table.
  const oldTable = host.querySelector("table.bucket-table");
  if (oldTable) oldTable.remove();

  const { rows, sortKey, sortDir } = bucketState;
  if (!rows.length) return;

  const COLS = [
    { key: "category", label: "Категория" },
    { key: "count", label: "Постов" },
    { key: "avg_likes", label: "Ср. лайки" },
    { key: "avg_comments", label: "Ср. комм." },
    { key: "avg_reach", label: "Ср. охват" },
    { key: "avg_eng", label: "Ср. вовл." },
    { key: "avg_score", label: "Ср. \u03a3" },
  ];

  const table = el("table", { cls: "bucket-table" });
  const thead = el("thead");
  const tr = el("tr");
  for (const c of COLS) {
    const th = el("th", { text: c.label });
    th.dataset.sort = c.key;
    if (sortKey === c.key) {
      th.classList.add("is-active");
      th.textContent = `${c.label} ${sortDir === 1 ? "\u2191" : "\u2193"}`;
    }
    th.addEventListener("click", () => {
      if (bucketState.sortKey === c.key) bucketState.sortDir *= -1;
      else { bucketState.sortKey = c.key; bucketState.sortDir = c.key === "category" ? 1 : -1; }
      drawBucketTable(host);
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);

  const sorted = rows.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });

  const tbody = el("tbody");
  const fmtNum = v => (v === null || v === undefined) ? "\u2014"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const fmtPct = v => (v === null || v === undefined) ? "\u2014"
    : `${Number(v).toFixed(2)}%`;
  const fmtScore = v => (v === null || v === undefined) ? "\u2014"
    : Number(v).toFixed(1);

  for (const r of sorted) {
    const catCell = el("td", { text: categoryLabel(r.category) });
    catCell.title = String(r.category);
    tbody.appendChild(el("tr", { children: [
      catCell,
      el("td", { text: r.count.toLocaleString() }),
      el("td", { text: fmtNum(r.avg_likes) }),
      el("td", { text: fmtNum(r.avg_comments) }),
      el("td", { text: fmtNum(r.avg_reach) }),
      el("td", { text: fmtPct(r.avg_eng) }),
      el("td", { text: fmtScore(r.avg_score) }),
    ] }));
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// --- Coming-soon placeholder cards ---
// Three metrics the user's account can't produce yet. Scaffold them as muted
// cards so when the data starts flowing, a single `if (records carry X)`
// guard flips each from coming-soon into live rendering.
function renderComingSoon() {
  const host = $("#coming-soon-grid");
  if (!host) return;
  host.textContent = "";
  const cards = [
    {
      title: "Конверсия в подписку по посту",
      note: "Нужна метрика profile_views per media \u2014 IG API не отдаёт её для MEDIA_CREATOR. Включится, когда записи начнут нести поле `profile_visits_delta`.",
    },
    {
      title: "Доля возвращающихся комментаторов",
      note: "Нужна история уникальных commenters. Активируется, когда накопим 30+ комментариев.",
    },
    {
      title: "Ритм публикаций vs результат",
      note: "Корреляция частоты постов с вовлечённостью. Активируется с 15+ постами.",
    },
  ];
  for (const c of cards) {
    const card = el("div", { cls: "coming-soon-card", children: [
      el("div", { cls: "coming-soon-title", children: [
        el("span", { text: c.title }),
        el("span", { cls: "coming-soon-badge", text: "coming soon" }),
      ] }),
      el("p", { cls: "coming-soon-text", text: c.note }),
    ] });
    host.appendChild(card);
  }
}

wireCategorySort();
wireRefresh(renderAll);
renderAll();
