// Read-only view of rejected memes.
// Data source: docs/rejected.json, fetched unauthenticated via raw.githubusercontent.com.
import { rawJsonFetch, relativeTime, formatTimestamp } from "./auth.js";
import { createClaudeScoreBadges, computeScoreAverages, renderScoreAveragesInto } from "./claude_score.js";

const REJECTED_PATH = "docs/rejected.json";
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
  const tokens = String(text).split(/(\s+)/);
  for (const tok of tokens) {
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

// Pull the best "when was this rejected" timestamp. Prefer the explicit
// rejected_at field, otherwise dig it out of the action log.
function rejectedAtFor(meme) {
  if (meme.rejected_at) return meme.rejected_at;
  const log = Array.isArray(meme.action_log) ? meme.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] && log[i].event === "rejected_by_user") return log[i].ts;
  }
  return "";
}

function rejectionCommentFor(meme) {
  if (meme.rejection_comment) return meme.rejection_comment;
  if (meme.comment) return meme.comment;
  const log = Array.isArray(meme.action_log) ? meme.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e && e.event === "rejected_by_user" && e.comment) return e.comment;
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

  thumbLink.insertAdjacentElement("afterend", createClaudeScoreBadges(meme.claude_score));

  const catEl = tpl.querySelector(".category-badge");
  if (meme.category) {
    catEl.textContent = categoryLabel(meme.category);
    catEl.title = String(meme.category);
  } else catEl.remove();

  const rejectedAt = rejectedAtFor(meme);
  const rejAtEl = tpl.querySelector(".card-rejected-at");
  if (rejectedAt) {
    rejAtEl.textContent = `Отклонено ${relativeTime(rejectedAt)}`;
    rejAtEl.title = formatTimestamp(rejectedAt);
  } else {
    rejAtEl.textContent = "отклонено";
  }

  tpl.querySelector(".card-id").textContent = meme.id ? String(meme.id) : "";

  const rejectionText = rejectionCommentFor(meme);
  const rejBox = tpl.querySelector(".rejection-box");
  if (rejectionText) {
    tpl.querySelector(".rejection-text").textContent = rejectionText;
  } else {
    rejBox.remove();
  }

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
    payload = await rawJsonFetch(REJECTED_PATH);
  } catch (e) {
    renderEmpty(`Ошибка загрузки rejected.json: ${e.message}`);
    return;
  }
  if (!payload || !Array.isArray(payload.memes) || payload.memes.length === 0) {
    renderEmpty("Отклонённых мемов пока нет.");
    $("#count-total").textContent = "0";
    return;
  }

  const memes = payload.memes.slice();
  memes.sort((a, b) => String(rejectedAtFor(b) || "").localeCompare(String(rejectedAtFor(a) || "")));

  const gallery = $("#gallery");
  $$(".card", gallery).forEach(n => n.remove());
  $("#empty-state").hidden = true;

  for (const m of memes) {
    gallery.appendChild(renderCard(m));
  }

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
