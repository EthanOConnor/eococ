# COC Newsletter Tools & UI

This bundle contains a **static proofing viewer**, a **dashboard**, and a **Node.js tool** to index and migrate existing newsletter files into a clean structure, plus CI scaffolding.

## Contents

- `proof/index.html` — Side‑by‑side **scan + Markdown** viewer; no build, works on GitHub Pages.
- `dashboard/index.html` — Project dashboard: filterable grid, stage chips, progress, and simple charts (uses Chart.js CDN).
- `tools/coc-tools.mjs` — Node 18+ CLI to **index** files into `data/newsletters.json` and optionally **migrate** into canonical structure.
- `data/newsletters.sample.json` — Example data for the dashboard.
- `coc.config.json` — Config for source glob patterns and destination layout.
- `package.json` — Scripts and dependencies (`fast-glob`, `gray-matter`, `js-yaml`).
- `.github/workflows/index.yml` — Optional CI to auto‑update `data/newsletters.json` on push.

## Quick start (GitHub Pages)

1. Commit `proof/` and `dashboard/` to your repo (e.g., under `/docs` or on the `gh-pages` branch).
2. (Optional) Put `data/newsletters.json` at `/data/newsletters.json`. For a demo, use `data/newsletters.sample.json` and open `dashboard/index.html?data=/data/newsletters.sample.json`.
3. Use the proofing viewer with query params, for example:

```
/proof/index.html?md=/transcripts/1987/1987-11_Cascade-Orienteer_Vol12_No9.md&pdf=/newsletters/1987/1987-11/scan_archival.pdf&view=rendered&page=1
```

## Node CLI (index & migrate)

Install deps and run:

```bash
npm i
npm run index          # scans sources from coc.config.json → writes data/newsletters.json (+ conflicts.ndjson)
npm run migrate        # dry-run planned moves to canonical structure
npm run migrate:exec   # execute moves (copies); review then prune old sources manually
```

### Source assumptions

- **Initial scans** currently named like `<year>/<year>-<n>.pdf` (e.g., `initial_scans/1978/1978-3.pdf`).  
- **Final files** (PDFs and/or Markdown) start with `YYYY-MM{_MM}{_MM}` followed by newsletter title and optional textual dates & volume/number (e.g., `1978-01_02 Bearing 315 January February 1978 Volume 1 Number 1.md`).

The `index` command parses finals to derive an **ID** (`YYYY-MM` or `YYYY-MM_MM`) and tries to match initials by **year + monthly/bimonthly ordinal**. It writes any uncertainties to `data/conflicts.ndjson`.

### Canonical destination layout

```
newsletters/<YEAR>/<ID>/scan_initial.pdf
newsletters/<YEAR>/<ID>/scan_archival.pdf
transcripts/<YEAR>/<ID>_<slug>.md
```

When a transcript is migrated, the tool **adds/merges YAML front‑matter** (ID, dates, files, status) so future automation can scan transcripts directly to build the dashboard data.

## Front‑matter schema (transcripts)

```yaml
---
id: "1978-01_02"
name: "Bearing 315 — January/February 1978 (Vol 1 No 1)"
year: 1978
month: 1
declared_date_start: 1978-01-01
declared_date_end: 1978-02-28
volume: 1
issue_number: 1
files:
  pdf: /newsletters/1978/1978-01_02/scan_initial.pdf
  pdf_archival: /newsletters/1978/1978-01_02/scan_archival.pdf
  md: /transcripts/1978/1978-01_02_Bearing-315_Vol1_No1.md
status:
  physical_on_hand: true
  scan_initial:      { state: done, date: 2025-10-10, by: Ethan }
  scan_archival:     { state: todo }
  transcript_auto:   { state: done, by: "LLM vX.Y" }
  transcript_review1:{ state: done, date: 2025-10-12, by: Alice }
  transcript_review2:{ state: in_progress, by: Bob }
  annotation_people: { state: todo }
  annotation_places: { state: todo }
  annotation_events: { state: todo }
---
```

## CI (optional)

Enable `.github/workflows/index.yml` to keep `data/newsletters.json` fresh on every push.

---

*Generated 2025-10-15T21:01:44.060493*
