// Shared auth + fetch helpers used by all pages in the review gallery.
// Page 1 (index.html) needs the PAT to write approvals.json.
// Pages 2 and 3 (published.html, rejected.html) fetch public JSON via raw.githubusercontent.com,
// so they never call into the authenticated helpers.

export const REPO = "sunlike78/bjjmemes-cdn";
export const BRANCH = "main";
export const PAT_KEY = "github_pat";

// ---- PAT storage ----
export function getPat() { return localStorage.getItem(PAT_KEY); }
export function setPat(v) { localStorage.setItem(PAT_KEY, v); }
export function clearPat() { localStorage.removeItem(PAT_KEY); }

// ---- Base64 helpers (UTF-8 safe) ----
export function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
export function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ""))));
}

// ---- Public (unauthenticated) raw fetch for JSON blobs ----
// Uses raw.githubusercontent.com with a cache-buster so published.json /
// rejected.json pick up new writes from Python without needing a PAT.
export async function rawJsonFetch(relPath) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${relPath}?t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${relPath}: ${res.status}`);
  return res.json();
}

// ---- Authenticated GitHub Contents API helpers (Page 1 only) ----
function contentsApiUrl(path) {
  return `https://api.github.com/repos/${REPO}/contents/${path}`;
}

/**
 * GET a JSON file via the authenticated GitHub Contents API.
 * Returns { records, sha }. 404 -> empty. 401 -> throws Error("401") after
 * clearing the stored PAT, so the caller can show the PAT modal.
 */
export async function ghGetJson(path) {
  const pat = getPat();
  const res = await fetch(`${contentsApiUrl(path)}?ref=${BRANCH}`, {
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github+json",
    },
    cache: "no-store",
  });
  if (res.status === 401) {
    clearPat();
    throw new Error("401");
  }
  if (res.status === 404) return { records: {}, sha: null };
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const data = await res.json();
  const decoded = b64decode(data.content);
  let records = {};
  try { records = JSON.parse(decoded) || {}; } catch { records = {}; }
  return { records, sha: data.sha };
}

/**
 * PUT a JSON file via the authenticated GitHub Contents API.
 * Throws { code: "conflict" } on 409/422 so the caller can re-GET + retry.
 */
export async function ghPutJson(path, records, sha, message) {
  const pat = getPat();
  const body = {
    message: message || `update ${path} (${new Date().toISOString()})`,
    content: b64encode(JSON.stringify(records, null, 2) + "\n"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(contentsApiUrl(path), {
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

// ---- Misc ----
export function isNetworkError(e) {
  return e instanceof TypeError || /NetworkError|Failed to fetch/i.test(e.message || "");
}

// Human-friendly relative time in Russian: "3 часа назад", "2 дня назад",
// "только что". Russian has a three-branch plural, so we select the right
// word form for each unit.
function pluralRu(n, forms) {
  // forms: [one (1), few (2-4), many (0, 5-20)]
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

export function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 0) return "в будущем";
  if (sec < 45) return "только что";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${pluralRu(min, ["минуту", "минуты", "минут"])} назад`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${pluralRu(hr, ["час", "часа", "часов"])} назад`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} ${pluralRu(day, ["день", "дня", "дней"])} назад`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} ${pluralRu(mo, ["месяц", "месяца", "месяцев"])} назад`;
  const yr = Math.round(mo / 12);
  return `${yr} ${pluralRu(yr, ["год", "года", "лет"])} назад`;
}

export function formatTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
