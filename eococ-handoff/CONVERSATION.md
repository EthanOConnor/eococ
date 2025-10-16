# Conversation Transcript — COC Newsletter Tools & UI

**Date:** 2025-10-15 (America/Los_Angeles)

---

**User:**  
Is there a good, lightweight, maintained markdown viewer for web page embedding that would host cleanly on a static html site on github pages? Application is transcription proof-reading for scans and transcriptions of the Cascade Orienteering Club's paper newsletter archive; we have .pdfs of scans plus LLM transcriptions that have been proofread by a human once. Would like volunteers to have a good interface for viewing the scan & the markdown, either rendered or not, side by side. Eventually want an interface for labelling named entities/etc in the interface to tie into a database of (among other things) people who've participated in the club, with canonical names, etc... basically marking up the newsletters with ties to the db for both info callout when reading and for feeding the db with information for participant summary pages.

**Assistant:**  
Short answer: yes. For a static GitHub Pages site, the lightest, well-maintained pieces that play nicely together are: (1) zero-md or Marked + DOMPurify; (2) browser PDF or PDF.js; (3) Split.js; (4) Hypothesis; (5) Recogito Text Annotator for future NER. I added a ready-to-host proofing UI (single file) showing scan left and Markdown right with Rendered/Raw toggle and query params.

**User:**  
We also want a canonical list of newsletter issues with details (textual name, declared date range, etc) and status (ohysical copy on hand, initial scan, archival scan, auto transcript, transcript review 1, transcript review 2, annotation/data extraction (subcategories)), and a quick status view grid interface for those. Eventually some progress visualizations of different parts of the project to help motivate sub projects that get volunteers pumped (Completely annotate all November Issues in the 80s, or things like that)

**Assistant:**  
Added a static dashboard (single file) with a filterable grid, KPIs, a bar chart per stage, and a campaign suggester. Data comes from `/data/newsletters.json` (or a demo sample).

**User:**  
Thinking about when to track changes in git vs file structure to keep things very simple/manually amenable & legible for now. Ie. have <projectdir>/transcripts/initial/1978-01_02 Bearing 315 January February 1978 Volume 1 Number 1.md at first, and keep that constant. then <projectdir>/transcripts/checked/1978-01_02 Bearing 315 January February 1978 Volume 1 Number 1_edit.md is created and changes tracked in git, and once the first check is finished <projectdir>/transcripts/checked/1978-01_02 Bearing 315 January February 1978 Volume 1 Number 1_checked.md.... etc.. so for these small files, expose structure status identity history etc. in the file system. Does that make sense so this can progress while we develop our full DB? Or... ?

**Assistant:**  
Yes, but avoid proliferating copies. Recommended: one canonical Markdown per issue + YAML front‑matter for status (Option A). Alternatives: move the single file across stage folders (Option B), or use suffix copies (Option C, not recommended). Provided a front‑matter template and workflow tips.

**User:**  
Sounds good. Then let's design the new issue/edit issue flow incl. connecting to / double checking connections to existing files. Right now our initial scan pdfs are named differently and may not 100% mirror the final scans & transcripts ... like final has special issues (schedules, etc). And initial scans are named <yyyy>/<yyyy>-<n> where n is just what # issue of that year the scan is. While final scans are (right now) in a flat directory named YYYY-MM{_MM}{_MM} <NEWSLETTER NAME> <Textual Issue Description/Date> <Textual Vol/Number>.md ie. 1978-01_02 Bearing 315 January February 1978 Volume 1 Number 1.md    so give me both a path to auto populate the issue db from the files, autoflagging differences in number / year and setting status needs review, and to move the files to the recommended file structure for the project. Sound good? Looking forward to seeing what you think/design/produce here.

**Assistant:**  
Added `tools/coc-tools.mjs` (Node CLI). `index` builds `data/newsletters.json` from current files and writes `conflicts.ndjson`. `migrate` (dry-run by default) moves files into canonical layout and injects/updates front‑matter in transcripts. Included example config, package.json scripts, and a GitHub Action.

**User:**  
Please create a single .zip file with everything you've implemented so far and a transcript of this conversation as an .md file. This is for handoff to a coding agent with access to git/github. Thank you!!

**Assistant:**  
Provided a ZIP with proofing UI, dashboard, Node tool, sample data, config, package.json, CI workflow, README, and this transcript.
