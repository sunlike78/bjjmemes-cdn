// BJJ Memes Review Gallery - vanilla JS
const REPO = "sunlike78/bjjmemes-cdn";
const APPROVALS_PATH = "docs/approvals.json";
const API_BASE = `https://api.github.com/repos/${REPO}/contents/${APPROVALS_PATH}`;
const DEBOUNCE_MS = 1500;
const PAT_KEY = "github_pat";
const PENDING_WRITES_KEY = "pending_writes";

const state = {
  memes: [],          // array of raw meme objects from data.json
  records: {},        // id -> approval record {status, comment, reviewed_at}
  sha: null,          // current sha of approvals.json
  filter: "all",
  saveTimer: null,
  dirty: false,
  saving: false,
  offline: false,
  lastError: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- PAT management ---
function getPat() { return localStorage.getItem(PAT_KEY); }
function setPat(v) { localStorage.setItem(PAT_KEY, v); }
function clearPat() { localStorage.removeItem(PAT_KEY); }

function showPatModal() {
  const modal = $("#pat-modal");
  modal.hidden = false;
  $("#pat-input").focus();
}
function hidePatModal() {
  $("#pat-modal").hidden = true;
  $("#pat-input").value = "";
}

// --- Base64 helpers (UTF-8 safe) ---
function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(str) {
  // GitHub returns base64 with line breaks
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ""))));
}

// --- Save status UI ---
function setSaveStatus(state_, msg) {
  const el = $("#save-status");
  el.dataset.state = state_;
  const labels = {
    saved: "saved \u2713",
    saving: "saving\u2026",
    offline: "offline",
    error: msg ? `error: ${msg}` : "error",
    idle: "idle",
  };
  el.textContent = labels[state_] ?? state_;
}

// --- GitHub API ---
async function ghGet() {
  const pat = getPat();
  const res = await fetch(`${API_BASE}?ref=main`, {
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github+json",
    },
    cache: "no-store",
  });
  if (res.status === 401) {
    clearPat();
    setSaveStatus("error", "401");
    showPatModal();
    throw new Error("401");
  }
  if (res.status === 404) {
    // File missing on server - treat as empty
    return { records: {}, sha: null };
  }
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const data = await res.json();
  const decoded = b64decode(data.content);
  let records = {};
  try { records = JSON.parse(decoded) || {}; } catch { records = {}; }
  return { records, sha: data.sha };
}

async function ghPut(records, sha) {
  const pat = getPat();
  const body = {
    message: `review: update approvals (${new Date().toISOString()})`,
    content: b64encode(JSON.stringify(records, null, 2) + "\n"),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const res = await fetch(API_BASE, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearPat();
    showPatModal();
    throw new Error("401");
  }
  if (res.status === 409 || res.status === 422) {
    throw Object.assign(new Error("conflict"), { code: "conflict" });
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT ${res.status}${txt ? `: ${txt.slice(0, 80)}` : ""}`);
  }
  const data = await res.json();
  return data.content.sha;
}

// --- Save flow ---
function scheduleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(doSave, DEBOUNCE_MS);
}

async function doSave() {
  if (state.saving) { scheduleSave(); return; }
  if (!state.dirty) return;
  if (!getPat()) { showPatModal(); return; }

  state.saving = true;
  setSaveStatus("saving");
  const snapshotDirty = { ...state.records };
  try {
    let newSha;
    try {
      newSha = await ghPut(snapshotDirty, state.sha);
    } catch (e) {
      if (e.code === "conflict") {
        // re-GET and retry once, re-applying dirty records over remote
        const remote = await ghGet();
        const merged = { ...remote.records, ...snapshotDirty };
        newSha = await ghPut(merged, remote.sha);
        state.records = merged;
        renderAll(); // re-render because remote may have added records
      } else {
        throw e;
      }
    }
    state.sha = newSha;
    state.dirty = false;
    state.offline = false;
    state.lastError = null;
    clearPendingWrites();
    setSaveStatus("saved");
  } catch (e) {
    if (isNetworkError(e)) {
      state.offline = true;
      queuePendingWrite();
      setSaveStatus("offline");
    } else {
      state.lastError = e.message;
      setSaveStatus("error", e.message.slice(0, 40));
    }
  } finally {
    state.saving = false;
  }
}

function isNetworkError(e) {
  return e instanceof TypeError || /NetworkError|Failed to fetch/i.test(e.message || "");
}

function queuePendingWrite() {
  try {
    localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify({
      records: state.records,
      at: new Date().toISOString(),
    }));
  } catch {}
}
function clearPendingWrites() {
  try { localStorage.removeItem(PENDING_WRITES_KEY); } catch {}
}
function hasPendingWrites() {
  return !!localStorage.getItem(PENDING_WRITES_KEY);
}

// --- Data loading ---
async function loadData() {
  // data.json (public, no auth needed for Pages file)
  let data = null;
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) {
      data = null;
    } else if (!res.ok) {
      throw new Error(`data.json ${res.status}`);
    } else {
      data = await res.json();
    }
  } catch (e) {
    console.warn("Failed to load data.json:", e.message);
    data = null;
  }
  state.memes = (data && Array.isArray(data.memes)) ? data.memes : [];

  // approvals.json via GitHub API (authoritative, read latest)
  try {
    const { records, sha } = await ghGet();
    state.records = records;
    state.sha = sha;
  } catch (e) {
    if (e.message !== "401") {
      state.lastError = e.message;
      setSaveStatus("error", e.message.slice(0, 40));
    }
    return;
  }

  // Ensure every meme has a record (default pending)
  for (const m of state.memes) {
    if (!m || typeof m !== "object" || !m.id) continue;
    if (!state.records[m.id]) {
      state.records[m.id] = { status: "pending", comment: "", reviewed_at: "" };
    }
  }

  setSaveStatus("saved");
  renderAll();
}

// --- Render ---
function statusGlyph(status) {
  if (status === "approved") return "\u2713";
  if (status === "rejected") return "\u2717";
  return "\u2026";
}

function renderCounters() {
  let pending = 0, approved = 0, rejected = 0;
  const total = state.memes.filter(m => m && m.id).length;
  for (const m of state.memes) {
    if (!m || !m.id) continue;
    const rec = state.records[m.id];
    const s = rec ? rec.status : "pending";
    if (s === "approved") approved++;
    else if (s === "rejected") rejected++;
    else pending++;
  }
  $("#count-pending").textContent = pending;
  $("#count-approved").textContent = approved;
  $("#count-rejected").textContent = rejected;
  $("#count-total").textContent = total;
}

function renderCaption(preEl, text) {
  preEl.textContent = "";
  if (!text) return;
  // Split preserving whitespace; mark tokens starting with # muted
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

function autosizeTextarea(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function renderRow(meme) {
  if (!meme || typeof meme !== "object" || !meme.id) {
    const broken = $("#broken-row-template").content.firstElementChild.cloneNode(true);
    const idEl = broken.querySelector(".row-id");
    idEl.textContent = (meme && meme.id) ? String(meme.id) : "(unknown id)";
    return broken;
  }

  const tpl = $("#row-template").content.firstElementChild.cloneNode(true);
  tpl.dataset.id = meme.id;

  const rec = state.records[meme.id] || { status: "pending", comment: "", reviewed_at: "" };
  tpl.dataset.status = rec.status || "pending";

  // Image
  const img = tpl.querySelector(".thumb");
  const link = tpl.querySelector(".thumb-link");
  if (meme.image_url) {
    img.src = String(meme.image_url);
    img.alt = String(meme.id);
    link.href = String(meme.image_url);
  } else {
    img.alt = "no image";
    link.removeAttribute("href");
  }

  // Category
  const catEl = tpl.querySelector(".category-badge");
  if (meme.category) catEl.textContent = String(meme.category);

  // ID
  tpl.querySelector(".row-id").textContent = String(meme.id);

  // Status pill
  updatePill(tpl, rec.status || "pending");

  // Caption
  renderCaption(tpl.querySelector(".caption"), meme.caption || "");

  // Explanation
  const expBody = tpl.querySelector(".explanation-body");
  if (meme.explanation) {
    expBody.textContent = String(meme.explanation);
  } else {
    tpl.querySelector(".explanation").hidden = true;
  }

  // Comment
  const ta = tpl.querySelector(".comment");
  ta.value = rec.comment || "";
  requestAnimationFrame(() => autosizeTextarea(ta));
  ta.addEventListener("input", () => {
    autosizeTextarea(ta);
    const r = ensureRecord(meme.id);
    if (r.comment !== ta.value) {
      r.comment = ta.value;
      r.reviewed_at = new Date().toISOString();
      scheduleSave();
    }
  });

  // Buttons
  const approveBtn = tpl.querySelector(".btn-approve");
  const rejectBtn = tpl.querySelector(".btn-reject");
  updateButtonStates(tpl, rec.status || "pending");

  approveBtn.addEventListener("click", () => toggleStatus(meme.id, "approved", tpl));
  rejectBtn.addEventListener("click", () => toggleStatus(meme.id, "rejected", tpl));

  // Filter visibility
  applyFilterToRow(tpl, rec.status || "pending");
  return tpl;
}

function ensureRecord(id) {
  if (!state.records[id]) {
    state.records[id] = { status: "pending", comment: "", reviewed_at: "" };
  }
  return state.records[id];
}

function toggleStatus(id, target, rowEl) {
  const r = ensureRecord(id);
  // Clicking same status toggles back to pending
  r.status = (r.status === target) ? "pending" : target;
  r.reviewed_at = new Date().toISOString();
  rowEl.dataset.status = r.status;
  updatePill(rowEl, r.status);
  updateButtonStates(rowEl, r.status);
  applyFilterToRow(rowEl, r.status);
  renderCounters();
  scheduleSave();
}

function updatePill(rowEl, status) {
  const pill = rowEl.querySelector(".status-pill");
  if (!pill) return;
  pill.dataset.status = status;
  pill.querySelector(".status-glyph").textContent = statusGlyph(status);
  pill.querySelector(".status-label").textContent = status;
}

function updateButtonStates(rowEl, status) {
  const a = rowEl.querySelector(".btn-approve");
  const r = rowEl.querySelector(".btn-reject");
  if (a) a.classList.toggle("is-active", status === "approved");
  if (r) r.classList.toggle("is-active", status === "rejected");
}

function applyFilterToRow(rowEl, status) {
  const hidden = state.filter !== "all" && state.filter !== status;
  rowEl.dataset.hidden = hidden ? "true" : "false";
}

function renderAll() {
  const gallery = $("#gallery");
  // Clear previous rows (keep empty state)
  $$(".row", gallery).forEach(n => n.remove());
  const empty = $("#empty-state");

  if (!state.memes.length) {
    empty.hidden = false;
    empty.textContent = "";
    const p = document.createElement("p");
    p.textContent = "No memes to review. Run ";
    const code = document.createElement("code");
    code.textContent = "python -m src.review_sync";
    p.appendChild(code);
    p.appendChild(document.createTextNode("."));
    empty.appendChild(p);
  } else {
    empty.hidden = true;
  }

  for (const m of state.memes) {
    const row = renderRow(m);
    gallery.appendChild(row);
  }
  renderCounters();
}

function reapplyFilter() {
  $$(".row", $("#gallery")).forEach(row => {
    const st = row.dataset.status || "pending";
    applyFilterToRow(row, st);
  });
}

// --- Event wiring ---
function wireEvents() {
  // Filters
  $$(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.filter;
      $$(".filter-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      reapplyFilter();
    });
  });

  // Reset PAT
  $("#reset-pat").addEventListener("click", () => {
    if (!confirm("Clear stored PAT from this browser?")) return;
    clearPat();
    showPatModal();
  });

  // PAT form
  $("#pat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#pat-input").value.trim();
    if (!v) return;
    setPat(v);
    hidePatModal();
    setSaveStatus("saving");
    await loadData();
    if (hasPendingWrites() && state.dirty) scheduleSave();
  });

  // Retry pending writes on focus
  window.addEventListener("focus", () => {
    if (state.offline && state.dirty) {
      scheduleSave();
    }
  });
}

// --- Bootstrap ---
(async function init() {
  wireEvents();

  // Restore pending writes if any
  try {
    const pending = localStorage.getItem(PENDING_WRITES_KEY);
    if (pending) {
      const parsed = JSON.parse(pending);
      if (parsed && parsed.records) {
        state.records = parsed.records;
        state.dirty = true;
      }
    }
  } catch {}

  if (!getPat()) {
    showPatModal();
    return;
  }

  await loadData();
  if (state.dirty) scheduleSave();
})();
