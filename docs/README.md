# BJJ Memes Review Gallery

Static review dashboard for approving Instagram meme candidates.
Hosted on GitHub Pages at https://sunlike78.github.io/bjjmemes-cdn/

## Files

- `index.html` / `app.js` / `style.css` — the app
- `data.json` — list of memes to review (written by Python generator, not in repo yet)
- `data.json.example` — sample shape
- `approvals.json` — review state (status + comment per meme id), updated by the page
- `.nojekyll` — disables Jekyll so files starting with `_` are served

## Personal Access Token (PAT)

On first load the page prompts for a **fine-grained** GitHub PAT. Create one at
`https://github.com/settings/personal-access-tokens/new` with:

- **Repository access**: only `sunlike78/bjjmemes-cdn`
- **Repository permissions**: `Contents: Read and write`
- **Expiration**: whatever you want (short is fine, you can rotate)

The token is stored in `localStorage["github_pat"]` on this browser only. It is
never logged, displayed, or sent anywhere except the GitHub REST API. The
header has a **Reset PAT** button to clear it.

On a 401 response the page clears the stored token and re-prompts.

## Data flow

1. Python generator writes `docs/data.json` listing new meme candidates (id,
   image_url pointing to `memes/.../meme.png` on the raw CDN, caption,
   explanation, category) and commits/pushes it.
2. You open the Pages site. It fetches `data.json` (public) and
   `approvals.json` via the GitHub Contents API (authenticated, so it always
   gets the latest version + `sha`).
3. You click Approve / Reject / type comments. Each change is marked dirty
   locally, `reviewed_at` is updated.
4. After 1500ms of inactivity the full `approvals.json` is committed via
   `PUT /repos/sunlike78/bjjmemes-cdn/contents/docs/approvals.json` using the
   stored `sha`. The response returns the new `sha`, which is cached for the
   next write.
5. On 409/422 conflict the page re-GETs the file, re-applies the dirty records
   over the fresh remote state, and retries once.
6. On network failure the unsaved state is queued in
   `localStorage["pending_writes"]`; the save is retried on the next edit or
   when the window regains focus.
7. Python reads `approvals.json` to decide which memes get posted to Instagram.

## Local testing

Any static server works:

```
python -m http.server --directory docs 8000
```

Then open http://localhost:8000/. CORS-wise the GitHub API accepts
`Authorization: Bearer` from any origin, so localhost works fine with a real
PAT.
