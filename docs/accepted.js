// Read-only view of memes currently in the posting queue (output/queue/).
// Data source: docs/accepted.json, fetched unauthenticated via raw.githubusercontent.com.
import { rawJsonFetch, relativeTime, formatTimestamp } from "./auth.js";
import { createClaudeScoreBadges, computeScoreAverages, renderScoreAveragesInto } from "./claude_score.js";

const ACCEPTED_PATH = "docs/accepted.json";
const CAPTION_COLLAPSED_LINES = 2;

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
};
function categoryLabel(cat) {
  if (!cat) return "";
  const key = String(cat).toLowerCase();
  return CATEGORY_LABELS_RU[key] || String(cat);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function renderCaption(preEl, text) {
  preEl.textContent = "";
  if (!text) return;
  for (const tok of String(text).split(/(\s+)/)) {
    if (tok.startsWith("#") && tok.length > 1) {
      const span = document.createElement("span");
      span.className = "hashtag";
      span.textContent = tok;
      preEl.appendChild(span);
    } else {
      preEl.appendChild(document.createTextNode(tok));
    }
  }
}

function wireCaptionToggle(preEl, toggleBtn, fullText) {
  const lineCount = (fullText || "").split(/\r?\n/).length;
  if (lineCount <= CAPTION_COLLAPSED_LINES) {
    toggleBtn.hidden = true;
    preEl.dataset.collapsed = "false";
    return;
  }
  toggleBtn.hidden = false;
  preEl.dataset.collapsed = "true";
  toggleBtn.textContent = "Развернуть подпись";
  toggleBtn.addEventListener("click", () => {
    const collapsed = preEl.dataset.collapsed === "true";
    preEl.dataset.collapsed = collapsed ? "false" : "true";
    toggleBtn.textContent = collapsed ? "Свернуть подпись" : "Развернуть подпись";
  });
  preEl.addEventListener("click", () => {
    if (preEl.dataset.collapsed === "true") {
      preEl.dataset.collapsed = "false";
      toggleBtn.textContent = "Свернуть подпись";
    }
  });
}

function eventLabel(event) {
  switch (event) {
    case "generated": return "Сгенерировано";
    case "approved_by_user": return "Одобрено";
    case "rejected_by_user": return "Отклонено";
    case "posted": return "Опубликовано в Instagram";
    case "queued": return "В очереди";
    case "failed": return "Ошибка";
    case "post_failed": return "Ошибка публикации";
    default: return event || "событие";
  }
}

function renderTimeline(olEl, actionLog) {
  olEl.textContent = "";
  const tpl = $("#timeline-item-template");
  const items = Array.isArray(actionLog) ? actionLog.slice() : [];
  items.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  for (const entry of items) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.event = entry.event || "";
    li.querySelector(".timeline-event").textContent = eventLabel(entry.event);
    li.querySelector(".timeline-rel").textContent = relativeTime(entry.ts);
    li.querySelector(".timeline-ts").textContent = formatTimestamp(entry.ts);
    const extra = li.querySelector(".timeline-extra");
    const bits = [];
    if (entry.comment) bits.push(`комментарий: ${entry.comment}`);
    if (entry.reason) bits.push(`причина: ${entry.reason}`);
    if (entry.media_id) bits.push(`media_id: ${entry.media_id}`);
    extra.textContent = bits.join(" \u00b7 ");
    if (!bits.length) extra.remove();
    olEl.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "timeline-empty";
    li.textContent = "История пуста.";
    olEl.appendChild(li);
  }
}

// Best-effort "queued at" timestamp. Prefer the explicit queued_at field
// (written by mirror_publish); fall back to the queued event in action_log;
// then approved_by_user.
function queuedAtFor(meme) {
  if (meme.queued_at) return meme.queued_at;
  const log = Array.isArray(meme.action_log) ? meme.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] && log[i].event === "queued") return log[i].ts;
  }
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] && log[i].event === "approved_by_user") return log[i].ts;
  }
  return "";
}

function renderCard(meme) {
  const tpl = $("#card-template").content.firstElementChild.cloneNode(true);
  tpl.dataset.id = meme.id || "";

  const img = tpl.querySelector(".card-thumb");
  const thumbLink = tpl.querySelector(".card-thumb-link");
  if (meme.image_url) {
    img.src = String(meme.image_url);
    img.alt = String(meme.id || "meme");
    thumbLink.href = String(meme.image_url);
  } else {
    img.alt = "no image";
    thumbLink.removeAttribute("href");
  }

  // Claude-score badges right under the thumbnail.
  const scoreWrap = createClaudeScoreBadges(meme.claude_score);
  thumbLink.insertAdjacentElement("afterend", scoreWrap);

  const catEl = tpl.querySelector(".category-badge");
  if (meme.category) {
    catEl.textContent = categoryLabel(meme.category);
    catEl.title = String(meme.category);
  } else catEl.remove();

  const qAt = queuedAtFor(meme);
  const qEl = tpl.querySelector(".card-queued-at");
  if (qAt) {
    qEl.textContent = `В очереди с ${relativeTime(qAt)}`;
    qEl.title = formatTimestamp(qAt);
  } else {
    qEl.textContent = "в очереди";
  }

  tpl.querySelector(".card-id").textContent = meme.id ? String(meme.id) : "";

  const pre = tpl.querySelector(".caption");
  const toggleBtn = tpl.querySelector(".caption-toggle");
  renderCaption(pre, meme.caption || "");
  wireCaptionToggle(pre, toggleBtn, meme.caption || "");

  renderTimeline(tpl.querySelector(".timeline"), meme.action_log || []);

  return tpl;
}

function renderEmpty(msg) {
  const gallery = $("#gallery");
  $$(".card", gallery).forEach(n => n.remove());
  const empty = $("#empty-state");
  empty.hidden = false;
  empty.textContent = "";
  const p = document.createElement("p");
  p.textContent = msg;
  empty.appendChild(p);
}

async function load() {
  let payload;
  try {
    payload = await rawJsonFetch(ACCEPTED_PATH);
  } catch (e) {
    renderEmpty(`Ошибка загрузки accepted.json: ${e.message}`);
    return;
  }
  // 404 -> treat as empty queue.
  if (!payload || !Array.isArray(payload.memes) || payload.memes.length === 0) {
    renderEmpty("Очередь пуста. Одобряйте мемы на странице Обзор — они попадут сюда, как только `python -m src.review_apply` переместит их в output/queue/.");
    $("#count-total").textContent = "0";
    return;
  }

  const memes = payload.memes.slice();
  // Newest-queued first.
  memes.sort((a, b) => String(queuedAtFor(b) || "").localeCompare(String(queuedAtFor(a) || "")));

  const gallery = $("#gallery");
  $$(".card", gallery).forEach(n => n.remove());
  $("#empty-state").hidden = true;

  for (const m of memes) gallery.appendChild(renderCard(m));

  $("#count-total").textContent = String(memes.length);
  renderScoreAveragesInto($("#avg-score-line"), computeScoreAverages(memes));
  const gen = $("#generated-at");
  if (payload.generated_at) {
    gen.textContent = `Обновлено ${relativeTime(payload.generated_at)}`;
    gen.title = formatTimestamp(payload.generated_at);
  } else {
    gen.textContent = "";
  }
}

load();
