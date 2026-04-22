// BJJ Memes Review Gallery - vanilla JS
// Behavior: all edits stay local until the user clicks the Save FAB.
// That's the difference from the old version, which debounced + auto-saved
// every 1.5s after the last edit.
import {
  getPat, setPat, clearPat,
  ghGetJson, ghPutJson,
  isNetworkError,
} from "./auth.js";

const APPROVALS_PATH = "docs/approvals.json";
const PENDING_WRITES_KEY = "pending_writes";

const state = {
  memes: [],             // raw meme objects from data.json
  records: {},           // id -> approval record {status, comment, reviewed_at}
  sha: null,             // current sha of approvals.json on GitHub
  filter: "all",
  dirtyIds: new Set(),   // which record ids have unsaved edits
  saving: false,
  offline: false,
  lastError: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- PAT modal ---
function showPatModal() {
  const modal = $("#pat-modal");
  modal.hidden = false;
  $("#pat-input").focus();
}
function hidePatModal() {
  $("#pat-modal").hidden = true;
  $("#pat-input").value = "";
}

// --- Save status UI (header pill) ---
function setSaveStatus(state_, msg) {
  const el = $("#save-status");
  el.dataset.state = state_;
  const labels = {
    saved: "saved \u2713",
    saving: "saving\u2026",
    offline: "offline",
    error: msg ? `error: ${msg}` : "error",
    idle: "idle",
    dirty: "unsaved",
  };
  el.textContent = labels[state_] ?? state_;
}

// --- Save FAB UI ---
function updateSaveFab() {
  const fab = $("#save-fab");
  const label = $("#save-fab-label");
  const n = state.dirtyIds.size;
  if (state.saving) {
    fab.disabled = true;
    fab.dataset.state = "saving";
    label.textContent = "Saving\u2026";
    return;
  }
  if (n === 0) {
    fab.disabled = true;
    fab.dataset.state = "clean";
    label.textContent = "No changes to save";
  } else {
    fab.disabled = false;
    fab.dataset.state = state.offline ? "offline" : "dirty";
    label.textContent = `Save changes (${n})`;
  }
}

function markDirty(id) {
  state.dirtyIds.add(id);
  setSaveStatus("dirty");
  updateSaveFab();
  queuePendingWrite();
}

function clearDirty() {
  state.dirtyIds.clear();
  updateSaveFab();
}

// --- Save flow (explicit, no debounce) ---
async function doSave() {
  if (state.saving) return;
  if (state.dirtyIds.size === 0) return;
  if (!getPat()) { showPatModal(); return; }

  state.saving = true;
  setSaveStatus("saving");
  updateSaveFab();

  // Snapshot what we're about to commit. New edits during the PUT create new
  // dirty ids, so we only clear the ones we actually saved.
  const inFlight = new Set(state.dirtyIds);
  const snapshot = { ...state.records };

  try {
    let newSha;
    try {
      newSha = await ghPutJson(APPROVALS_PATH, snapshot, state.sha, `review: update approvals (${new Date().toISOString()})`);
    } catch (e) {
      if (e.code === "conflict") {
        // Re-GET and retry once, applying our dirty records on top of remote.
        const remote = await ghGetJson(APPROVALS_PATH);
        const merged = { ...remote.records };
        for (const id of inFlight) {
          if (state.records[id]) merged[id] = state.records[id];
        }
        newSha = await ghPutJson(APPROVALS_PATH, merged, remote.sha, `review: update approvals (conflict retry) (${new Date().toISOString()})`);
        state.records = merged;
        renderAll();
      } else {
        throw e;
      }
    }
    state.sha = newSha;
    for (const id of inFlight) state.dirtyIds.delete(id);
    state.offline = false;
    state.lastError = null;
    if (state.dirtyIds.size === 0) clearPendingWrites();
    setSaveStatus("saved");
  } catch (e) {
    if (e.message === "401") {
      setSaveStatus("error", "401");
      showPatModal();
    } else if (isNetworkError(e)) {
      state.offline = true;
      queuePendingWrite();
      setSaveStatus("offline");
    } else {
      state.lastError = e.message;
      setSaveStatus("error", e.message.slice(0, 40));
    }
  } finally {
    state.saving = false;
    updateSaveFab();
  }
}

function queuePendingWrite() {
  try {
    localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify({
      records: state.records,
      dirty_ids: Array.from(state.dirtyIds),
      at: new Date().toISOString(),
    }));
  } catch {}
}
function clearPendingWrites() {
  try { localStorage.removeItem(PENDING_WRITES_KEY); } catch {}
}

// --- Data loading ---
async function loadData() {
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

  // approvals.json via GitHub API (authoritative, read latest).
  try {
    const { records, sha } = await ghGetJson(APPROVALS_PATH);
    // If we have local dirty edits, keep them overlaid on top of remote.
    const merged = { ...records };
    for (const id of state.dirtyIds) {
      if (state.records[id]) merged[id] = state.records[id];
    }
    state.records = merged;
    state.sha = sha;
  } catch (e) {
    if (e.message === "401") {
      showPatModal();
      return;
    }
    state.lastError = e.message;
    setSaveStatus("error", e.message.slice(0, 40));
    return;
  }

  // Ensure every meme has a record (default pending)
  for (const m of state.memes) {
    if (!m || typeof m !== "object" || !m.id) continue;
    if (!state.records[m.id]) {
      state.records[m.id] = { status: "pending", comment: "", reviewed_at: "" };
    }
  }

  setSaveStatus(state.dirtyIds.size ? "dirty" : "saved");
  renderAll();
  updateSaveFab();
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

  const catEl = tpl.querySelector(".category-badge");
  if (meme.category) catEl.textContent = String(meme.category);

  tpl.querySelector(".row-id").textContent = String(meme.id);

  updatePill(tpl, rec.status || "pending");

  renderCaption(tpl.querySelector(".caption"), meme.caption || "");

  const expBody = tpl.querySelector(".explanation-body");
  if (meme.explanation) {
    expBody.textContent = String(meme.explanation);
  } else {
    tpl.querySelector(".explanation").hidden = true;
  }

  const ta = tpl.querySelector(".comment");
  ta.value = rec.comment || "";
  requestAnimationFrame(() => autosizeTextarea(ta));
  ta.addEventListener("input", () => {
    autosizeTextarea(ta);
    const r = ensureRecord(meme.id);
    if (r.comment !== ta.value) {
      r.comment = ta.value;
      r.reviewed_at = new Date().toISOString();
      markDirty(meme.id);
    }
  });

  const approveBtn = tpl.querySelector(".btn-approve");
  const rejectBtn = tpl.querySelector(".btn-reject");
  updateButtonStates(tpl, rec.status || "pending");

  approveBtn.addEventListener("click", () => toggleStatus(meme.id, "approved", tpl));
  rejectBtn.addEventListener("click", () => toggleStatus(meme.id, "rejected", tpl));

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
  r.status = (r.status === target) ? "pending" : target;
  r.reviewed_at = new Date().toISOString();
  rowEl.dataset.status = r.status;
  updatePill(rowEl, r.status);
  updateButtonStates(rowEl, r.status);
  applyFilterToRow(rowEl, r.status);
  renderCounters();
  markDirty(id);
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
  $$(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.filter;
      $$(".filter-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      reapplyFilter();
    });
  });

  $("#reset-pat").addEventListener("click", () => {
    if (!confirm("Clear stored PAT from this browser?")) return;
    clearPat();
    showPatModal();
  });

  $("#pat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#pat-input").value.trim();
    if (!v) return;
    setPat(v);
    hidePatModal();
    setSaveStatus("saving");
    await loadData();
  });

  $("#save-fab").addEventListener("click", () => {
    doSave();
  });

  // Keyboard shortcut: Ctrl/Cmd+S triggers save when there are dirty changes.
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      if (state.dirtyIds.size > 0) {
        e.preventDefault();
        doSave();
      }
    }
  });

  // Before-unload guard: warn if the user tries to leave with unsaved edits.
  window.addEventListener("beforeunload", (e) => {
    if (state.dirtyIds.size > 0) {
      e.preventDefault();
      // Modern browsers ignore the message text, but a truthy returnValue
      // still triggers the native "Leave site?" confirmation.
      e.returnValue = "You have unsaved changes. Leave anyway?";
      return e.returnValue;
    }
  });

  // Retry on focus if we went offline mid-save.
  window.addEventListener("focus", () => {
    if (state.offline && state.dirtyIds.size > 0) {
      doSave();
    }
  });
}

// --- Bootstrap ---
(async function init() {
  wireEvents();
  updateSaveFab();

  // Restore any pending writes from a previous session.
  try {
    const pending = localStorage.getItem(PENDING_WRITES_KEY);
    if (pending) {
      const parsed = JSON.parse(pending);
      if (parsed && parsed.records) {
        state.records = parsed.records;
        if (Array.isArray(parsed.dirty_ids)) {
          for (const id of parsed.dirty_ids) state.dirtyIds.add(id);
        } else {
          // Legacy format: no id list - mark all keys dirty as a safe fallback.
          for (const id of Object.keys(parsed.records)) state.dirtyIds.add(id);
        }
      }
    }
  } catch {}

  if (!getPat()) {
    showPatModal();
    updateSaveFab();
    return;
  }

  await loadData();
})();
