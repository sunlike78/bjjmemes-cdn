// Shared renderer for Claude-score badges and aggregate averages.
// A record's `claude_score` has shape { text_score, image_score, reasoning, reviewer, ts }
// (integers 1-10). If the field is missing, we show a faint "unscored" pill.
//
// Exported:
//   createClaudeScoreBadges(score)  -> DOM element (.claude-score-wrap)
//   computeScoreAverages(memes)     -> { text:number|null, image:number|null,
//                                        overall:number|null, n:int }
//   renderScoreAveragesInto(el, a)  -> fills a header slot with the summary line
//   overallScore(score)             -> number|null   (0.6*text + 0.4*image, rounded 1 d.p.)

const TRUNCATE_LEN = 240;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Derived overall score: weighted average of text (0.6) and image (0.4),
// rounded to 1 decimal place. Returns null if neither component is available.
// If only one side is present, use it alone (re-normalizing the weights).
export function overallScore(score) {
  if (!score || typeof score !== "object") return null;
  const t = typeof score.text_score === "number" ? score.text_score : null;
  const i = typeof score.image_score === "number" ? score.image_score : null;
  if (t === null && i === null) return null;
  let raw;
  if (t !== null && i !== null) raw = 0.6 * t + 0.4 * i;
  else if (t !== null) raw = t;
  else raw = i;
  return Math.round(raw * 10) / 10;
}

// Same tint rule as text/image pills: high if both components >=8, low if any <=5.
function tintClass(text, image) {
  const both = [text, image].filter(v => typeof v === "number");
  if (!both.length) return "";
  const hi = both.every(v => v >= 8);
  const lo = both.some(v => v <= 5);
  if (hi) return "is-high";
  if (lo) return "is-low";
  return "";
}

// Build a single pill: `<span class="cs-pill cs-pill--text">📝 7/10</span>`
function pill(kind, emoji, score) {
  const p = el("span", `cs-pill cs-pill--${kind}`);
  const ico = el("span", "cs-pill-ico", emoji);
  const val = el("span", "cs-pill-val", `${score}/10`);
  p.appendChild(ico);
  p.appendChild(val);
  return p;
}

// Dedicated overall pill — uses a capital sigma glyph and 1-decimal formatting.
function overallPill(value) {
  const p = el("span", "cs-pill cs-pill--overall");
  const ico = el("span", "cs-pill-ico", "\u03a3");
  const val = el("span", "cs-pill-val", value.toFixed(1));
  p.appendChild(ico);
  p.appendChild(val);
  p.title = "Суммарная оценка: 0.6·текст + 0.4·картинка";
  return p;
}

function truncate(s, n) {
  if (!s) return "";
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "\u2026" : t;
}

// Produce the wrapper with score pills + hover/click tooltip (or unscored pill).
export function createClaudeScoreBadges(score) {
  const wrap = el("div", "claude-score-wrap");

  if (!score || typeof score !== "object"
      || (typeof score.text_score !== "number" && typeof score.image_score !== "number")) {
    const u = el("span", "cs-pill cs-pill--unscored", "без оценки");
    wrap.appendChild(u);
    return wrap;
  }

  const t = typeof score.text_score === "number" ? score.text_score : null;
  const i = typeof score.image_score === "number" ? score.image_score : null;
  const overall = overallScore(score);

  const pairs = el("div", `claude-score-pairs ${tintClass(t, i)}`);
  if (t !== null) pairs.appendChild(pill("text", "\ud83d\udcdd", t));
  if (i !== null) pairs.appendChild(pill("image", "\ud83d\uddbc", i));
  if (overall !== null) pairs.appendChild(overallPill(overall));

  const reasoning = (score.reasoning || "").trim();
  if (reasoning) {
    pairs.tabIndex = 0;
    pairs.setAttribute("role", "button");
    pairs.setAttribute("aria-label", "Показать обоснование оценки");
    const tip = el("div", "cs-tooltip");
    tip.appendChild(el("div", "cs-tooltip-head", "Обоснование Claude"));
    const body = el("div", "cs-tooltip-body");
    // Spec: truncate to 240 chars. The tooltip is scrollable for long strings
    // (max-height / overflow-y:auto in CSS) — but we still cap the text so
    // cards don't grow unbounded when reasoning is verbose.
    body.textContent = truncate(reasoning, TRUNCATE_LEN);
    if (reasoning.length > TRUNCATE_LEN) body.title = reasoning;
    tip.appendChild(body);
    if (score.reviewer || score.ts) {
      const meta = el("div", "cs-tooltip-meta",
        [score.reviewer ? `reviewer: ${score.reviewer}` : "",
         score.ts ? new Date(score.ts).toISOString().slice(0, 16).replace("T", " ") : ""]
          .filter(Boolean).join(" \u00b7 "));
      tip.appendChild(meta);
    }
    pairs.appendChild(tip);
    // Click toggles the "sticky" tooltip on touch devices.
    pairs.addEventListener("click", (e) => {
      e.stopPropagation();
      pairs.classList.toggle("cs-sticky");
    });
    document.addEventListener("click", () => pairs.classList.remove("cs-sticky"), { passive: true });
  } else {
    // Still expose the short numeric title for hover tooltips without reasoning.
    pairs.title = `Текст ${t ?? "?"} / Картинка ${i ?? "?"}${overall !== null ? ` / Σ ${overall.toFixed(1)}` : ""}`;
  }
  wrap.appendChild(pairs);
  return wrap;
}

// Given an array of mirror meme records, return averages over records that
// actually carry numeric scores. `text` / `image` / `overall` are null if no data.
export function computeScoreAverages(memes) {
  let tSum = 0, tN = 0, iSum = 0, iN = 0, oSum = 0, oN = 0, any = 0;
  for (const m of memes || []) {
    const s = m && m.claude_score;
    if (!s || typeof s !== "object") continue;
    if (typeof s.text_score === "number") { tSum += s.text_score; tN += 1; }
    if (typeof s.image_score === "number") { iSum += s.image_score; iN += 1; }
    const ov = overallScore(s);
    if (ov !== null) { oSum += ov; oN += 1; }
    if (typeof s.text_score === "number" || typeof s.image_score === "number") any += 1;
  }
  return {
    text: tN > 0 ? tSum / tN : null,
    image: iN > 0 ? iSum / iN : null,
    overall: oN > 0 ? oSum / oN : null,
    n: any,
  };
}

// Fill a header slot with "Ср. оценка: 📝 X.X 🖼 Y.Y Σ Z.Z" (or dash if no data).
export function renderScoreAveragesInto(hostEl, avg) {
  if (!hostEl) return;
  hostEl.textContent = "";
  const fmt = v => v === null || v === undefined ? "\u2014" : v.toFixed(1);
  const label = el("span", "avg-score-label", "Ср. оценка:");
  const val = el("span", "avg-score-val",
    `\ud83d\udcdd ${fmt(avg.text)}  \ud83d\uddbc ${fmt(avg.image)}  \u03a3 ${fmt(avg.overall)}`);
  hostEl.appendChild(label);
  hostEl.appendChild(val);
  if (avg.n > 0) {
    const n = el("span", "avg-score-n", `(n=${avg.n})`);
    hostEl.appendChild(n);
  }
}
