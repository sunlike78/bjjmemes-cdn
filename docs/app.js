// BJJ Memes Review Gallery - vanilla JS.
// Effective status per meme id is merged from FOUR sources, in priority order
// (terminal buckets win over pending approvals.json edits):
//   1. docs/published.json  -> "published" (read-only, green)
//   2. docs/accepted.json   -> "accepted"  (read-only, amber — queued)
//   3. docs/rejected.json   -> "rejected"  (read-only, red)
//   4. docs/approvals.json  -> editable (pending | approved | rejected)
// Fixes the bug where review_apply.py strips processed ids from approvals.json
// after moving folders: on reload the status used to collapse back to pending
// because only approvals.json was consulted.
import {
  getPat, setPat, clearPat,
  ghGetJson, ghPutJson,
  rawJsonFetch, isNetworkError,
  relativeTime, formatTimestamp,
} from "./auth.js";

const APPROVALS_PATH = "docs/approvals.json";
const ACCEPTED_PATH  = "docs/accepted.json";
const REJECTED_PATH  = "docs/rejected.json";
const PUBLISHED_PATH = "docs/published.json";
const PENDING_WRITES_KEY = "pending_writes";
const BUCKETS_CACHE_KEY  = "mirror_buckets_cache_v1";

const state = {
  memes: [],            // raw meme objects from data.json (+ bucket-only ids merged in)
  records: {},          // id -> approvals record {status, comment, reviewed_at}
  sha: null,            // current sha of approvals.json on GitHub
  filter: "all",
  dirtyIds: new Set(),
  saving: false,
  offline: false,
  lastError: null,
  published: {}, accepted: {}, rejected: {},  // id -> mirrored meme record
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- PAT modal ---
function showPatModal() { $("#pat-modal").hidden = false; $("#pat-input").focus(); }
function hidePatModal() { $("#pat-modal").hidden = true; $("#pat-input").value = ""; }

function setSaveStatus(s, msg) {
  const el = $("#save-status");
  el.dataset.state = s;
  const labels = {
    saved: "saved \u2713", saving: "saving\u2026", offline: "offline",
    error: msg ? `error: ${msg}` : "error", idle: "idle", dirty: "unsaved",
  };
  el.textContent = labels[s] ?? s;
}

function updateSaveFab() {
  const fab = $("#save-fab"), label = $("#save-fab-label");
  const n = state.dirtyIds.size;
  if (state.saving) { fab.disabled = true; fab.dataset.state = "saving"; label.textContent = "Saving\u2026"; return; }
  if (n === 0) { fab.disabled = true; fab.dataset.state = "clean"; label.textContent = "No changes to save"; }
  else { fab.disabled = false; fab.dataset.state = state.offline ? "offline" : "dirty"; label.textContent = `Save changes (${n})`; }
}

function markDirty(id) {
  state.dirtyIds.add(id);
  setSaveStatus("dirty");
  updateSaveFab();
  queuePendingWrite();
}

// --- Validation: block save until each decision is complete ---
function validateBeforeSave() {
  const errors = [];
  for (const [id, r] of Object.entries(state.records)) {
    if (!r) continue;
    if (r.status === "approved") {
      const rating = typeof r.rating === "number" ? r.rating : 0;
      if (rating < 1) errors.push({ id, reason: "approved — rating required (click a star)" });
    }
    if (r.status === "rejected") {
      const comment = (r.comment || "").trim();
      if (comment.length === 0) errors.push({ id, reason: "rejected — comment required (explain why)" });
    }
  }
  return errors;
}

function highlightInvalidRows(errors) {
  // Clear old markers
  document.querySelectorAll(".row[data-invalid='true']").forEach(r => {
    r.removeAttribute("data-invalid");
    const old = r.querySelector(".row-invalid-msg");
    if (old) old.remove();
  });
  if (!errors.length) return;
  const byId = new Map(errors.map(e => [e.id, e.reason]));
  document.querySelectorAll(".row").forEach(row => {
    const id = row.dataset.id;
    if (!byId.has(id)) return;
    row.dataset.invalid = "true";
    const msg = document.createElement("div");
    msg.className = "row-invalid-msg";
    msg.textContent = "⚠ " + byId.get(id);
    const body = row.querySelector(".row-body");
    if (body) body.appendChild(msg);
  });
  // Scroll to first offender
  const first = document.querySelector(".row[data-invalid='true']");
  if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
}

// --- Save flow (explicit, no debounce) ---
async function doSave() {
  if (state.saving) return;
  if (state.dirtyIds.size === 0) return;
  if (!getPat()) { showPatModal(); return; }

  const errors = validateBeforeSave();
  highlightInvalidRows(errors);
  if (errors.length) {
    setSaveStatus("error", `${errors.length} row(s) incomplete`);
    return;
  }

  state.saving = true;
  setSaveStatus("saving");
  updateSaveFab();

  const inFlight = new Set(state.dirtyIds);
  // Send only records that actually have a user decision: non-pending
  // status OR a non-empty comment. Empty "pending" scaffolding records
  // (created automatically when the row first rendered) must not pollute
  // approvals.json — otherwise review_apply gets a file full of no-ops.
  const snapshot = {};
  for (const [id, r] of Object.entries(state.records)) {
    const hasDecision = r && (r.status === "approved" || r.status === "rejected");
    const hasComment = r && r.comment && r.comment.trim().length > 0;
    const hasRating = r && typeof r.rating === "number" && r.rating > 0;
    if (hasDecision || hasComment || hasRating) snapshot[id] = r;
  }

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
      } else { throw e; }
    }
    state.sha = newSha;
    for (const id of inFlight) state.dirtyIds.delete(id);
    state.offline = false;
    state.lastError = null;
    if (state.dirtyIds.size === 0) clearPendingWrites();
    setSaveStatus("saved");
  } catch (e) {
    if (e.message === "401") { setSaveStatus("error", "401"); showPatModal(); }
    else if (isNetworkError(e)) { state.offline = true; queuePendingWrite(); setSaveStatus("offline"); }
    else { state.lastError = e.message; setSaveStatus("error", e.message.slice(0, 40)); }
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
function clearPendingWrites() { try { localStorage.removeItem(PENDING_WRITES_KEY); } catch {} }

// --- Bucket cache (accepted/published/rejected mirror) ---
// Persist the last fetched buckets so we paint a plausible state on next
// load before the network catches up.
function cacheBuckets() {
  try {
    localStorage.setItem(BUCKETS_CACHE_KEY, JSON.stringify({
      published: state.published, accepted: state.accepted, rejected: state.rejected,
      at: new Date().toISOString(),
    }));
  } catch {}
}
function restoreBucketsCache() {
  try {
    const raw = localStorage.getItem(BUCKETS_CACHE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p && typeof p === "object") {
      if (p.published && typeof p.published === "object") state.published = p.published;
      if (p.accepted  && typeof p.accepted  === "object") state.accepted  = p.accepted;
      if (p.rejected  && typeof p.rejected  === "object") state.rejected  = p.rejected;
    }
  } catch {}
}

// Convert a mirror payload ({generated_at, memes:[...]}) to id -> record.
function mirrorMemesToMap(payload) {
  const out = {};
  if (!payload || !Array.isArray(payload.memes)) return out;
  for (const m of payload.memes) if (m && typeof m === "object" && m.id) out[m.id] = m;
  return out;
}

async function loadMirror(path) {
  try { return mirrorMemesToMap(await rawJsonFetch(path)); }
  catch (e) { console.warn(`Failed to load ${path}:`, e.message); return null; }
}

// --- Data loading ---
async function loadData() {
  // data.json: local list of folders still under output/posts/.
  let data = null;
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) data = null;
    else if (!res.ok) throw new Error(`data.json ${res.status}`);
    else data = await res.json();
  } catch (e) {
    console.warn("Failed to load data.json:", e.message);
    data = null;
  }
  state.memes = (data && Array.isArray(data.memes)) ? data.memes : [];

  // Fetch the three terminal buckets in parallel. 404 -> empty map; network
  // failure -> null (keep cached copy so offline UI is still useful).
  const [pub, acc, rej] = await Promise.all([
    loadMirror(PUBLISHED_PATH),
    loadMirror(ACCEPTED_PATH),
    loadMirror(REJECTED_PATH),
  ]);
  if (pub !== null) state.published = pub;
  if (acc !== null) state.accepted  = acc;
  if (rej !== null) state.rejected  = rej;
  cacheBuckets();

  try {
    const { records, sha } = await ghGetJson(APPROVALS_PATH);
    const merged = { ...records };
    for (const id of state.dirtyIds) if (state.records[id]) merged[id] = state.records[id];
    state.records = merged;
    state.sha = sha;
  } catch (e) {
    if (e.message === "401") { showPatModal(); return; }
    state.lastError = e.message;
    setSaveStatus("error", e.message.slice(0, 40));
    return;
  }

  // Ensure every local meme has an approvals record so freshly generated
  // items default to "pending". Terminal buckets will win later.
  for (const m of state.memes) {
    if (!m || typeof m !== "object" || !m.id) continue;
    if (!state.records[m.id]) state.records[m.id] = { status: "pending", comment: "", reviewed_at: "" };
  }

  mergeBucketMemesIntoLocalList();

  const pubBtn = $(".filter-btn[data-filter=\"published\"]");
  if (pubBtn) pubBtn.hidden = Object.keys(state.published).length === 0;

  setSaveStatus(state.dirtyIds.size ? "dirty" : "saved");
  renderAll();
  updateSaveFab();
}

// Terminal-bucket memes are already moved out of output/posts/, so data.json
// doesn't list them. Merge them in so the review page still shows every id
// the user acted on (read-only).
function mergeBucketMemesIntoLocalList() {
  const seen = new Set(state.memes.filter(m => m && m.id).map(m => m.id));
  const pushFromBucket = (bucket) => {
    for (const [id, rec] of Object.entries(bucket || {})) {
      if (!rec || seen.has(id)) continue;
      state.memes.push({
        id,
        image_url: rec.image_url || "",
        caption: rec.caption || "",
        explanation: rec.explanation || "",
        category: rec.category || "",
      });
      seen.add(id);
    }
  };
  pushFromBucket(state.published);
  pushFromBucket(state.accepted);
  pushFromBucket(state.rejected);
}

// --- Source-priority merge ---
// published > accepted > rejected(bucket) > approvals.json.
function effectiveStatusFor(id) {
  if (state.published[id]) return { status: "published", editable: false, bucketRecord: state.published[id], approvalRecord: state.records[id] || null };
  if (state.accepted[id])  return { status: "accepted",  editable: false, bucketRecord: state.accepted[id],  approvalRecord: state.records[id] || null };
  if (state.rejected[id])  return { status: "rejected",  editable: false, bucketRecord: state.rejected[id],  approvalRecord: state.records[id] || null };
  const rec = state.records[id] || { status: "pending", comment: "", reviewed_at: "" };
  return { status: rec.status || "pending", editable: true, bucketRecord: null, approvalRecord: rec };
}

// --- Render helpers ---
function statusGlyph(s) {
  if (s === "approved")  return "\u2713";
  if (s === "accepted")  return "\u25B2";   // queued, awaiting publish
  if (s === "published") return "\u2605";   // shipped
  if (s === "rejected")  return "\u2717";
  return "\u2026";
}

function renderCounters() {
  let pending = 0, approved = 0, accepted = 0, rejected = 0, published = 0;
  const total = state.memes.filter(m => m && m.id).length;
  for (const m of state.memes) {
    if (!m || !m.id) continue;
    const s = effectiveStatusFor(m.id).status;
    if (s === "published")     published++;
    else if (s === "accepted") accepted++;
    else if (s === "approved") approved++;
    else if (s === "rejected") rejected++;
    else pending++;
  }
  $("#count-pending").textContent   = pending;
  $("#count-approved").textContent  = approved;
  $("#count-accepted").textContent  = accepted;
  $("#count-rejected").textContent  = rejected;
  $("#count-published").textContent = published;
  $("#count-total").textContent     = total;
}

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

function autosizeTextarea(ta) { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; }

// Best-effort timestamp for an accepted (queued) record.
function queuedAtFor(rec) {
  const log = Array.isArray(rec && rec.action_log) ? rec.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) if (log[i] && log[i].event === "queued") return log[i].ts;
  for (let i = log.length - 1; i >= 0; i--) if (log[i] && log[i].event === "approved_by_user") return log[i].ts;
  return (rec && rec.queued_at) || "";
}

function rejectionCommentFor(rec) {
  if (!rec) return "";
  if (rec.rejection && rec.rejection.comment) return rec.rejection.comment;
  if (rec.rejection_comment) return rec.rejection_comment;
  const log = Array.isArray(rec.action_log) ? rec.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e && (e.event === "rejected_by_user" || e.event === "rejected_as_dupe" || e.event === "post_failed")
        && (e.comment || e.reason || e.error)) {
      return e.comment || e.reason || e.error;
    }
  }
  return "";
}

function permalinkFor(rec) {
  if (!rec) return "";
  if (rec.permalink) return rec.permalink;
  if (rec.posted && rec.posted.permalink) return rec.posted.permalink;
  const log = Array.isArray(rec.action_log) ? rec.action_log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] && log[i].event === "posted" && log[i].permalink) return log[i].permalink;
  }
  return "";
}

// Populate readonly-info for a terminal row. Returns true if non-empty.
function renderReadonlyInfo(infoEl, status, bucketRec) {
  infoEl.textContent = "";
  infoEl.dataset.status = status;
  if (status === "published") {
    const permalink = permalinkFor(bucketRec);
    if (permalink) {
      const a = document.createElement("a");
      a.className = "readonly-link";
      a.href = permalink; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "view on Instagram \u2192";
      infoEl.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.className = "readonly-muted";
      span.textContent = "published (no permalink recorded)";
      infoEl.appendChild(span);
    }
    return true;
  }
  if (status === "accepted") {
    const ts = queuedAtFor(bucketRec);
    const span = document.createElement("span");
    span.className = "readonly-muted";
    if (ts) { span.textContent = `queued ${relativeTime(ts)}`; span.title = formatTimestamp(ts); }
    else span.textContent = "queued, awaiting publish";
    infoEl.appendChild(span);
    return true;
  }
  if (status === "rejected") {
    const comment = rejectionCommentFor(bucketRec);
    const box = document.createElement("div");
    box.className = "readonly-reject-box";
    const label = document.createElement("div");
    label.className = "readonly-reject-label";
    label.textContent = "Rejected";
    box.appendChild(label);
    if (comment) {
      const p = document.createElement("div");
      p.className = "readonly-reject-text";
      p.textContent = comment;
      box.appendChild(p);
    }
    infoEl.appendChild(box);
    return true;
  }
  return false;
}

function renderRow(meme) {
  if (!meme || typeof meme !== "object" || !meme.id) {
    const broken = $("#broken-row-template").content.firstElementChild.cloneNode(true);
    broken.querySelector(".row-id").textContent = (meme && meme.id) ? String(meme.id) : "(unknown id)";
    return broken;
  }
  const tpl = $("#row-template").content.firstElementChild.cloneNode(true);
  tpl.dataset.id = meme.id;

  const eff = effectiveStatusFor(meme.id);
  tpl.dataset.status = eff.status;
  tpl.dataset.editable = eff.editable ? "true" : "false";

  const imgUrl = (eff.bucketRecord && eff.bucketRecord.image_url) || meme.image_url || "";
  const img = tpl.querySelector(".thumb"), link = tpl.querySelector(".thumb-link");
  if (imgUrl) { img.src = String(imgUrl); img.alt = String(meme.id); link.href = String(imgUrl); }
  else { img.alt = "no image"; link.removeAttribute("href"); }

  const catEl = tpl.querySelector(".category-badge");
  const category = (eff.bucketRecord && eff.bucketRecord.category) || meme.category;
  if (category) catEl.textContent = String(category);

  tpl.querySelector(".row-id").textContent = String(meme.id);
  updatePill(tpl, eff.status);

  const captionText = (eff.bucketRecord && eff.bucketRecord.caption) || meme.caption || "";
  renderCaption(tpl.querySelector(".caption"), captionText);

  const expBody = tpl.querySelector(".explanation-body");
  const explanation = (eff.bucketRecord && eff.bucketRecord.explanation) || meme.explanation;
  if (explanation) expBody.textContent = String(explanation);
  else tpl.querySelector(".explanation").hidden = true;

  const ta = tpl.querySelector(".comment");
  const actions = tpl.querySelector(".actions");
  const infoEl = tpl.querySelector(".readonly-info");

  const ratingEl = tpl.querySelector(".rating");

  if (!eff.editable) {
    tpl.querySelector(".comment-label").hidden = true;
    actions.hidden = true;
    if (ratingEl) ratingEl.hidden = true;
    infoEl.hidden = !renderReadonlyInfo(infoEl, eff.status, eff.bucketRecord);
  } else {
    const rec = eff.approvalRecord;
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
    const rejectBtn  = tpl.querySelector(".btn-reject");
    updateButtonStates(tpl, rec.status || "pending");
    approveBtn.addEventListener("click", () => toggleStatus(meme.id, "approved", tpl));
    rejectBtn.addEventListener("click",  () => toggleStatus(meme.id, "rejected", tpl));

    // Rating stars (0 = no rating, 1-5 = stars). Click to set, click same
    // value again to clear. Used later for self-learning on which memes
    // the reviewer actually liked — independent of approve/reject.
    updateRatingStars(ratingEl, rec.rating || 0);
    ratingEl.querySelectorAll(".star").forEach(btn => {
      btn.addEventListener("click", () => {
        const v = parseInt(btn.dataset.value, 10);
        setRating(meme.id, v, tpl);
      });
    });
  }

  applyFilterToRow(tpl, eff.status);
  return tpl;
}

function ensureRecord(id) {
  if (!state.records[id]) state.records[id] = { status: "pending", comment: "", reviewed_at: "", rating: 0 };
  return state.records[id];
}

function setRating(id, value, rowEl) {
  const r = ensureRecord(id);
  const next = (r.rating === value) ? 0 : value;  // click-again clears
  if (r.rating === next) return;
  r.rating = next;
  r.reviewed_at = new Date().toISOString();
  updateRatingStars(rowEl.querySelector(".rating"), next);
  markDirty(id);
}

function updateRatingStars(ratingEl, value) {
  if (!ratingEl) return;
  ratingEl.dataset.value = String(value);
  ratingEl.querySelectorAll(".star").forEach(btn => {
    const v = parseInt(btn.dataset.value, 10);
    btn.classList.toggle("is-filled", v <= value);
  });
}

function toggleStatus(id, target, rowEl) {
  const r = ensureRecord(id);
  r.status = (r.status === target) ? "pending" : target;
  r.reviewed_at = new Date().toISOString();
  const eff = effectiveStatusFor(id);
  rowEl.dataset.status = eff.status;
  updatePill(rowEl, eff.status);
  updateButtonStates(rowEl, r.status);
  applyFilterToRow(rowEl, eff.status);
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
  // Terminal statuses (accepted/rejected/published) live on their dedicated
  // pages. Under the default "All" filter on Page 1 we show only items that
  // still need attention (pending + locally-edited approved/rejected that
  // have not been Saved yet — those are marked data-editable="true").
  // The explicit filter tabs (Accepted / Rejected / Published) still reveal
  // them for audit.
  const editable = rowEl.dataset.editable === "true";
  const isTerminal = status === "accepted" || status === "published"
    || (status === "rejected" && !editable);

  if (state.filter === "all") {
    rowEl.dataset.hidden = isTerminal ? "true" : "false";
    return;
  }
  rowEl.dataset.hidden = state.filter !== status ? "true" : "false";
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
    p.appendChild(code); p.appendChild(document.createTextNode("."));
    empty.appendChild(p);
  } else {
    empty.hidden = true;
  }
  for (const m of state.memes) gallery.appendChild(renderRow(m));
  renderCounters();
}

function reapplyFilter() {
  $$(".row", $("#gallery")).forEach(row => applyFilterToRow(row, row.dataset.status || "pending"));
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
    clearPat(); showPatModal();
  });
  $("#pat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#pat-input").value.trim();
    if (!v) return;
    setPat(v); hidePatModal(); setSaveStatus("saving");
    await loadData();
  });
  $("#save-fab").addEventListener("click", () => { doSave(); });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      if (state.dirtyIds.size > 0) { e.preventDefault(); doSave(); }
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirtyIds.size > 0) {
      // Persist once more so next load restores the session; include latest
      // bucket snapshot too, so terminal statuses render instantly.
      queuePendingWrite(); cacheBuckets();
      e.preventDefault();
      e.returnValue = "You have unsaved changes. Leave anyway?";
      return e.returnValue;
    }
    cacheBuckets();
  });
  window.addEventListener("focus", () => {
    if (state.offline && state.dirtyIds.size > 0) doSave();
  });
}

// --- Bootstrap ---
(async function init() {
  wireEvents();
  updateSaveFab();
  restoreBucketsCache();
  try {
    const pending = localStorage.getItem(PENDING_WRITES_KEY);
    if (pending) {
      const parsed = JSON.parse(pending);
      if (parsed && parsed.records) {
        state.records = parsed.records;
        if (Array.isArray(parsed.dirty_ids)) for (const id of parsed.dirty_ids) state.dirtyIds.add(id);
        else for (const id of Object.keys(parsed.records)) state.dirtyIds.add(id);
      }
    }
  } catch {}
  if (!getPat()) { showPatModal(); updateSaveFab(); return; }
  await loadData();
})();
