// Read-only view of memes actually shipped to Instagram.
// Data source: docs/published.json, fetched unauthenticated via raw.githubusercontent.com.
import { rawJsonFetch, relativeTime, formatTimestamp } from "./auth.js";

const PUBLISHED_PATH = "docs/published.json";
const CAPTION_COLLAPSED_LINES = 2;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- Render helpers ---
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
  toggleBtn.textContent = "Expand caption";
  toggleBtn.addEventListener("click", () => {
    const collapsed = preEl.dataset.collapsed === "true";
    preEl.dataset.collapsed = collapsed ? "false" : "true";
    toggleBtn.textContent = collapsed ? "Collapse caption" : "Expand caption";
  });
  preEl.addEventListener("click", () => {
    if (preEl.dataset.collapsed === "true") {
      preEl.dataset.collapsed = "false";
      toggleBtn.textContent = "Collapse caption";
    }
  });
}

function eventLabel(event) {
  switch (event) {
    case "generated": return "Generated";
    case "approved_by_user": return "Approved";
    case "rejected_by_user": return "Rejected";
    case "posted": return "Posted to Instagram";
    case "queued": return "Queued";
    case "failed": return "Failed";
    default: return event || "event";
  }
}

function renderTimeline(olEl, actionLog) {
  olEl.textContent = "";
  const tpl = $("#timeline-item-template");
  const items = Array.isArray(actionLog) ? actionLog.slice() : [];
  // Oldest at top so the timeline reads naturally.
  items.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  for (const entry of items) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.event = entry.event || "";
    li.querySelector(".timeline-event").textContent = eventLabel(entry.event);
    li.querySelector(".timeline-rel").textContent = relativeTime(entry.ts);
    li.querySelector(".timeline-ts").textContent = formatTimestamp(entry.ts);
    const extra = li.querySelector(".timeline-extra");
    const bits = [];
    if (entry.comment) bits.push(`comment: ${entry.comment}`);
    if (entry.media_id) bits.push(`media_id: ${entry.media_id}`);
    if (entry.reason) bits.push(`reason: ${entry.reason}`);
    extra.textContent = bits.join(" \u00b7 ");
    if (!bits.length) extra.remove();
    olEl.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "timeline-empty";
    li.textContent = "No history entries.";
    olEl.appendChild(li);
  }
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

  const catEl = tpl.querySelector(".category-badge");
  if (meme.category) catEl.textContent = String(meme.category);
  else catEl.remove();

  const postedEl = tpl.querySelector(".card-posted");
  if (meme.posted_at) {
    postedEl.textContent = `Posted ${relativeTime(meme.posted_at)}`;
    postedEl.title = formatTimestamp(meme.posted_at);
  } else {
    postedEl.textContent = "posted";
  }

  const permalink = tpl.querySelector(".permalink");
  if (meme.permalink) {
    permalink.href = String(meme.permalink);
  } else {
    permalink.remove();
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
    payload = await rawJsonFetch(PUBLISHED_PATH);
  } catch (e) {
    renderEmpty(`Error loading published.json: ${e.message}`);
    return;
  }
  if (!payload || !Array.isArray(payload.memes) || payload.memes.length === 0) {
    renderEmpty("No published memes yet. They'll appear here once posted via `python -m src.cli post`.");
    $("#count-total").textContent = "0";
    return;
  }

  const memes = payload.memes.slice();
  memes.sort((a, b) => String(b.posted_at || "").localeCompare(String(a.posted_at || "")));

  const gallery = $("#gallery");
  $$(".card", gallery).forEach(n => n.remove());
  $("#empty-state").hidden = true;

  for (const m of memes) {
    gallery.appendChild(renderCard(m));
  }

  $("#count-total").textContent = String(memes.length);
  const gen = $("#generated-at");
  if (payload.generated_at) {
    gen.textContent = `Updated ${relativeTime(payload.generated_at)}`;
    gen.title = formatTimestamp(payload.generated_at);
  } else {
    gen.textContent = "";
  }
}

load();
