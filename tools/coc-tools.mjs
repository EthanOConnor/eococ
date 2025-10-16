#!/usr/bin/env node
/** COC Repo Tools — index & migrate newsletters (Node 18+)
 *  Extended to support an intermediate "fullsize" scan between initial and archival.
 */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fg from 'fast-glob';
import matter from 'gray-matter';
import yaml from 'js-yaml';

const DEFAULT_CONFIG = {
  src: {
    // initial scans like import/initial_scans/<decade>/<YYYY-NN>.pdf
    initial_pdfs: [
      "import/initial_scans/*/[0-9][0-9][0-9][0-9]-[0-9][0-9].{pdf,PDF,tif,tiff}",
      "initial_scans/**/[0-9][0-9][0-9][0-9]/[0-9][0-9][0-9][0-9]-[0-9]*.{pdf,PDF,tif,tiff}",
      "initial/**"
    ],
    // NEW: fullsize scans (between initial and archival)
    fullsize_pdfs: [
      "import/fullsize_scans/**/*.{pdf,PDF}",
      "fullsize_scans/**/*.{pdf,PDF}"
    ],
    // archival/final scans
    final_pdfs: [
      "import/archival_scans/**/*.{pdf,PDF}",
      "final_scans/**/*.{pdf,PDF}"
    ],
    // final/corrected transcripts
    final_mds: [
      "import/transcripts/corrected/**/*.md",
      "final_transcripts/**/*.md",
      "transcripts_flat/**/*.md"
    ],
  },
  dest: {
    newsletters_root: "newsletters",
    // we allow transcripts in newsletters/transcripts per project preference
    transcripts_root: "newsletters/transcripts",
    data_json: "data/newsletters.json",
  }
};

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || !["index","migrate"].includes(cmd)) {
  console.error("Usage: node tools/coc-tools.mjs <index|migrate> [--config coc.config.json] [--dry-run|--execute]");
  process.exit(1);
}
const getArg = (k, fallback=null)=>{const i=args.indexOf(k); return i>=0? args[i+1] : fallback};
const has = (k)=> args.includes(k);
const configPath = getArg('--config', null);
const execute = has('--execute');
const dryRun = has('--dry-run') || (!execute && cmd==='migrate');

const CONFIG = await loadConfig(configPath);

// Helpers
function monthNameToNum(m){
  if (!m) return null;
  const s = (""+m).toLowerCase();
  const map = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
  const k = Object.keys(map).find(k=> s.startsWith(k));
  return k? map[k]: null;
}
function pad2(n){ return String(n).padStart(2,'0'); }
function slugify(s){
  return (s||"")
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g,'')
    .trim()
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-');
}
function ensureDirSync(p){ if (!fssync.existsSync(p)) fssync.mkdirSync(p, {recursive:true}); }
function isPDF(p){ return /\.(pdf|PDF)$/.test(p); }
function isMD(p){ return /\.md$/i.test(p); }
const toPosix = (p)=> p.split(path.sep).join('/');

function parseInitial(p){
  const bn = path.basename(p);
  const m = bn.match(/^(?<year>\d{4})-(?<n>\d{1,2})/);
  const year = m ? Number(m.groups.year) : null;
  const n = m ? Number(m.groups.n) : null;
  return (year && n!=null) ? { type:'initial', path:p, year, n } : null;
}

function parseFinalName(filePath){
  const baseName = path.basename(filePath);
  const withoutExt = baseName.replace(/\.[^.]+$/, '');

  const fromName = parseMetaFromName(withoutExt);
  if (fromName) return fromName;

  const issueDir = path.basename(path.dirname(filePath));
  const yearDir = path.basename(path.dirname(path.dirname(filePath)));
  if (/^\d{4}$/.test(yearDir) && issueDir){
    return parseMetaFromDirectory(issueDir, Number(yearDir), withoutExt);
  }
  return null;
}

function parseMetaFromName(base){
  const m = base.match(/^(?<year>\d{4})-(?<m1>\d{2})(?:_(?<m2>\d{2}))?(?:_(?<m3>\d{2}))?(?:_(?<code>[A-Za-z0-9]+))?(?:\s+|_)(?<rest>.*)$/);
  if (!m) return null;
  const year = Number(m.groups.year);
  const months = [m.groups.m1, m.groups.m2, m.groups.m3].filter(Boolean).map(x=> Number(x));
  let rest = m.groups.rest || '';
  if (rest && !/\s/.test(rest)){
    rest = rest.replace(/_/g,' ').replace(/-/g,' ');
  }
  const code = m.groups.code || null;
  const volRe = /(\bVol(?:ume)?\.?\s*(?<vol>\d+)\b)/i;
  const noRe = /(\bNo(?:\.|umber)?\.?\s*(?<no>\d+)\b)/i;
  const vol = rest.match(volRe)?.groups?.vol ? Number(rest.match(volRe).groups.vol) : null;
  const no = rest.match(noRe)?.groups?.no ? Number(rest.match(noRe).groups.no) : null;
  const monthWordRe = /(january|february|march|april|may|june|july|august|september|october|november|december)/i;
  const mw = rest.search(monthWordRe);
  let title = rest.trim();
  let textual = '';
  if (mw >= 0){
    title = rest.slice(0, mw).trim();
    textual = rest.slice(mw).trim();
  }
  const { cleanTitle, cleanTextual, scanDesc } = extractScanDescriptor(title, textual);
  title = cleanTitle;
  textual = cleanTextual;
  if (!months?.length && textual){
    const mws = [...textual.matchAll(monthWordRe)].map(x=> monthNameToNum(x[1]));
    if (mws.length){ months.push(...mws); }
  }
  const minMonth = months.length? Math.min(...months): null;
  const maxMonth = months.length? Math.max(...months): null;
  const id = [String(year), '-', (minMonth? pad2(minMonth): '??'), (maxMonth && maxMonth!==minMonth)? '_'+pad2(maxMonth): ''].join('');
  return { year, months, minMonth, maxMonth, title, textual, vol, no, id, code, scan_description: scanDesc };
}

function parseMetaFromDirectory(issueId, year, baseName){
  const months = [];
  const idParts = issueId.split('_');
  for (const part of idParts){
    if (/^\d{2}$/.test(part)) months.push(Number(part));
  }
  const minMonth = months.length? Math.min(...months): null;
  const maxMonth = months.length? Math.max(...months): null;
  let scanDesc = null;
  if (/^scan_/i.test(baseName)){
    scanDesc = baseName.replace(/^scan_/i,'').replace(/_/g,' ').trim();
  }
  return {
    year,
    months,
    minMonth,
    maxMonth,
    title: '',
    textual: '',
    vol: null,
    no: null,
    id: issueId,
    code: null,
    scan_description: scanDesc || null,
  };
}

function extractScanDescriptor(title, textual){
  function splitScanDescriptor(s){
    const t = (s||'').trim();
    if (!t) return { clean: t, desc: null };
    const mDpi = t.match(/(\b\d{2,4}\s*)?dpi.*$/i);
    const mScan = t.match(/scan.*$/i);
    const start = mDpi ? mDpi.index : (mScan ? mScan.index : -1);
    if (start >= 0){
      return {
        clean: t.slice(0, start).replace(/[-–—_()\s]+$/,'').trim(),
        desc: t.slice(start).trim()
      };
    }
    return { clean: t, desc: null };
  }
  let titleOut = title;
  let textualOut = textual;
  let scanDesc = null;
  let sp = splitScanDescriptor(textualOut);
  if (sp.desc){
    textualOut = sp.clean;
    scanDesc = sp.desc;
  } else {
    sp = splitScanDescriptor(titleOut);
    if (sp.desc){
      titleOut = sp.clean;
      scanDesc = sp.desc;
    }
  }
  return { cleanTitle: titleOut, cleanTextual: textualOut, scanDesc };
}

function mergeMeta(current = {}, incoming = {}){
  if (!incoming || Object.keys(incoming).length === 0) return current;
  if (!current || Object.keys(current).length === 0) return { ...incoming };
  const out = { ...current };
  for (const [key, value] of Object.entries(incoming)){
    if (value === undefined || value === null) continue;
    if (key === 'months'){
      if ((!out.months || !out.months.length) && Array.isArray(value) && value.length){
        out.months = [...value];
        out.minMonth = value.length ? Math.min(...value) : out.minMonth;
        out.maxMonth = value.length ? Math.max(...value) : out.maxMonth;
      }
      continue;
    }
    if (typeof value === 'string'){
      if (!value.trim()) continue;
      const existing = out[key];
      if (!existing || (typeof existing === 'string' && !existing.trim())){
        out[key] = value;
      }
      continue;
    }
    if (Array.isArray(value)){
      if (value.length && (!out[key] || !out[key].length)) out[key] = [...value];
      continue;
    }
    if (!(key in out) || out[key] === null || out[key] === undefined){
      out[key] = value;
    }
  }
  return out;
}

async function metaFromMarkdown(filePath){
  try{
    const raw = await fs.readFile(filePath, 'utf8');
    const fm = matter(raw);
    const data = fm.data || {};
    if (!data.id) return null;
    const year = data.year || Number(String(data.id).slice(0, 4));
    const baseMeta = parseMetaFromDirectory(data.id, year, '');
    const name = typeof data.name === 'string' ? data.name : '';
    let textual = '';
    if (name.includes('—')){
      textual = name.split('—').slice(1).join('—').trim();
    }
    if (!textual && typeof data.textual === 'string') textual = data.textual;
    const meta = {
      id: data.id,
      year,
      months: baseMeta.months,
      minMonth: baseMeta.minMonth,
      maxMonth: baseMeta.maxMonth,
      month: data.month ? Number(data.month) : (baseMeta.minMonth || undefined),
      title: data.series_name || data.title || baseMeta.title,
      textual,
      vol: data.volume || data.vol || baseMeta.vol,
      no: data.issue_number || data.issue || baseMeta.no,
      code: data.series_code || baseMeta.code,
      scan_description: data.scan_description || baseMeta.scan_description,
      declared_date_start: data.declared_date_start || null,
      declared_date_end: data.declared_date_end || null,
    };
    return meta;
  }catch(err){
    console.warn(`Failed to read markdown meta for ${filePath}: ${err.message}`);
    return null;
  }
}

function expectedOrdinalFromMonths(months){
  if (!months || !months.length) return null;
  const uniq = [...new Set(months)].sort((a,b)=>a-b);
  const min = uniq[0], max = uniq[uniq.length-1];
  const monthly = min;
  const bimonthly = Math.ceil(max/2);
  return { monthly, bimonthly };
}

function makeIssueObject(meta, files){
  const name = `${meta.title || 'Newsletter'}${meta.textual? ' — '+meta.textual: ''}${meta.vol? ` (Vol ${meta.vol}${meta.no? ` No ${meta.no}`:''})`:''}`;
  const declaredStart = meta.declared_date_start || ((meta.year && meta.minMonth)? `${meta.year}-${pad2(meta.minMonth)}-01` : undefined);
  const declaredEnd = meta.declared_date_end || ((meta.year && meta.maxMonth)? new Date(meta.year, meta.maxMonth, 0).toISOString().slice(0,10) : undefined);
  return {
    id: meta.id,
    name,
    year: meta.year,
    month: meta.month ?? (meta.minMonth || undefined),
    declared_date_start: declaredStart,
    declared_date_end: declaredEnd,
    volume: meta.vol || undefined,
    issue_number: meta.no || undefined,
    series_code: meta.code || undefined,
    series_name: meta.title || undefined,
    scan_description: meta.scan_description || undefined,
    files,
    status: {
      scan_initial: !!files.pdf_initial,
      scan_fullsize: !!files.pdf_fullsize,
      scan_archival: !!files.pdf_archival,
      transcript_auto: !!files.md,
      transcript_review1: { state: 'todo' },
      transcript_review2: { state: 'todo' },
      annotation_people: { state: 'todo' }
    }
  };
}

async function indexCommand(){
  const { initial_pdfs, fullsize_pdfs, final_pdfs, final_mds } = CONFIG.src;
  const data = { issues: [], conflicts: [] };

  const initFiles = await fg(initial_pdfs, { dot:false });
  const fullsizePDFs = await fg(fullsize_pdfs || [], { dot:false });
  const finalPDFs = await fg(final_pdfs || [], { dot:false });
  const finalMDs = await fg(final_mds || [], { dot:false });

  const initials = initFiles.map(parseInitial).filter(Boolean);
  const matchedInitialPaths = new Set();
  const finals = {};

  // Helper to upsert finals map
  const upsert = (id, meta)=>{
    if (!id) return;
    if (!finals[id]){
      finals[id] = { meta: meta || {}, pdf_archival:null, pdf_fullsize:null, md:null, others:[] };
    } else if (meta){
      finals[id].meta = mergeMeta(finals[id].meta, meta);
    }
  };

  function applyCanonicalFiles(issue){
    if (!issue || !issue.id) return;
    const year = issue.year || Number(String(issue.id).slice(0,4));
    if (!year) return;
    const folder = path.join(CONFIG.dest.newsletters_root, String(year), issue.id);
    const pairs = [
      ['pdf_initial','scan_initial.pdf'],
      ['pdf_fullsize','scan_fullsize.pdf'],
      ['pdf_archival','scan_archival.pdf']
    ];
    for (const [key, fname] of pairs){
      const full = path.join(folder, fname);
      if (fssync.existsSync(full)){
        issue.files = issue.files || {};
        issue.files[key] = toPosix(full);
      }
    }
  }

  // Process MDs first to capture rich metadata
  for (const p of finalMDs){
    const metaFromMd = await metaFromMarkdown(p);
    const meta = metaFromMd || parseFinalName(p);
    if (!meta){ data.conflicts.push({ type:'unparsed_final_md', file:p, reason:'filename does not start with YYYY-MM' }); continue; }
    upsert(meta.id, meta);
    finals[meta.id].md = p;
  }

  // Process fullsize PDFs
  for (const p of fullsizePDFs){
    const meta = parseFinalName(p);
    if (!meta){ data.conflicts.push({ type:'unparsed_fullsize', file:p, reason:'filename does not start with YYYY-MM' }); continue; }
    upsert(meta.id, meta);
    finals[meta.id].pdf_fullsize = p;
  }

  // Process archival/final PDFs
  for (const p of finalPDFs){
    const meta = parseFinalName(p);
    if (!meta){ data.conflicts.push({ type:'unparsed_final_pdf', file:p, reason:'filename does not start with YYYY-MM' }); continue; }
    upsert(meta.id, meta);
    finals[meta.id].pdf_archival = p;
  }

  const issues = [];
  for (const id of Object.keys(finals).sort()){
    const f = finals[id];
    const files = {
      pdf_fullsize: f.pdf_fullsize || undefined,
      pdf_archival: f.pdf_archival || undefined,
      md: f.md || undefined,
    };

    const year = f.meta.year;
    const sameYear = initials.filter(x=> x.year === year);
    let matchedInitial = null; let mismatchNote = null;
    if (sameYear.length){
      const ord = expectedOrdinalFromMonths(f.meta.months);
      if (ord){
        matchedInitial = sameYear.find(x=> x.n === ord.monthly) || sameYear.find(x=> x.n === ord.bimonthly) || null;
        if (!matchedInitial){ mismatchNote = {reason:'initial_not_found_by_ordinal', expected: ord, triedInYear: sameYear.map(x=>x.n)}; }
      } else {
        mismatchNote = {reason:'no_months_in_final_filename'};
      }
    }
    if (matchedInitial){
      files.pdf_initial = matchedInitial.path;
      matchedInitialPaths.add(matchedInitial.path);
    }

    const issue = makeIssueObject(f.meta, files);
    applyCanonicalFiles(issue);

    if (matchedInitial){
      const ord = expectedOrdinalFromMonths(f.meta.months);
      const ok = (matchedInitial.n === ord.monthly) || (matchedInitial.n === ord.bimonthly);
      if (!ok){ data.conflicts.push({ type:'issue_number_mismatch', id, initial_n: matchedInitial.n, expected: ord, files }); }
    } else if (mismatchNote){
      data.conflicts.push({ type:mismatchNote.reason, id, details:mismatchNote, files });
    }

    issues.push(issue);
  }

  for (const init of initials){
    if (matchedInitialPaths.has(init.path)) continue;
    // Create placeholder issue for initial-only scans with unknown months
    const id = `${init.year}-??_i${pad2(init.n)}`;
    const meta = {
      year: init.year,
      months: [],
      minMonth: null,
      maxMonth: null,
      title: 'Unknown',
      textual: `Initial Scan (Issue ${init.n})`,
      vol: null,
      no: init.n,
      id,
      code: null,
      scan_description: null,
    };
    const files = { pdf_initial: init.path };
    const placeholder = makeIssueObject(meta, files);
    issues.push(placeholder);
  }

  const outPath = CONFIG.dest.data_json;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(issues, null, 2), 'utf8');
  console.log(`Wrote ${issues.length} issues to ${outPath}`);

  const conflictsPath = path.join(path.dirname(outPath), 'conflicts.ndjson');
  if (data.conflicts.length){
    const report = data.conflicts.map(x=> JSON.stringify(x)).join(os.EOL);
    await fs.writeFile(conflictsPath, report, 'utf8');
    console.warn(`Conflicts: ${data.conflicts.length} (see ${conflictsPath})`);
  } else {
    if (fssync.existsSync(conflictsPath)) await fs.rm(conflictsPath, { force: true });
    console.log('No conflicts detected.');
  }
}

async function migrateCommand(){
  const dataPath = CONFIG.dest.data_json;
  let issues = [];
  try{ const raw = await fs.readFile(dataPath, 'utf8'); issues = JSON.parse(raw); }
  catch{ console.error(`Cannot read ${dataPath}. Run 'index' first to generate newsletters.json.`); process.exit(2); }

  const moves = [];
  for (const issue of issues){
    const year = issue.year || (issue.id? Number(issue.id.slice(0,4)) : null);
    if (!year) continue;
    const id = issue.id;
    const titleSlug = slugify((issue.name||'Newsletter').split('—')[0]).replace(/-+$/,'');

    const folder = path.join(CONFIG.dest.newsletters_root, String(year), id);
    const destInitial = path.join(folder, 'scan_initial.pdf');
    const destFullsize = path.join(folder, 'scan_fullsize.pdf');
    const destArchival = path.join(folder, 'scan_archival.pdf');

    const tdir = path.join(CONFIG.dest.transcripts_root, String(year));
    const tfile = path.join(tdir, `${id}_${titleSlug}.md`);

    if (issue.files?.pdf_initial){ moves.push({ src: issue.files.pdf_initial, dest: destInitial }); }
    if (issue.files?.pdf_fullsize){ moves.push({ src: issue.files.pdf_fullsize, dest: destFullsize }); }
    if (issue.files?.pdf_archival){ moves.push({ src: issue.files.pdf_archival, dest: destArchival }); }
    if (issue.files?.md){ moves.push({ src: issue.files.md, dest: tfile, type:'md', issue }); }
  }

  for (const m of moves){
    const { src, dest } = m;
    if (!src || !dest) continue;
    if (!fssync.existsSync(src)) { console.warn(`[skip] missing src ${src}`); continue; }
    if (fssync.existsSync(dest)) { console.warn(`[skip] exists ${dest}`); continue; }
    console.log(`${dryRun? '[plan]':'[move]'} ${src} -> ${dest}`);
    if (!dryRun){
      ensureDirSync(path.dirname(dest));
      await fs.copyFile(src, dest);
    }

    if (!dryRun && m.type==='md'){
      let raw = await fs.readFile(dest, 'utf8');
      const fm = matter(raw);
      const newFiles = {};
      const year = m.issue.year;
      const id = m.issue.id;
      newFiles.md = dest.split(path.sep).join('/');
      const folder = path.join(CONFIG.dest.newsletters_root, String(year), id);
      const pInit = path.join(folder, 'scan_initial.pdf');
      const pFull = path.join(folder, 'scan_fullsize.pdf');
      const pArch = path.join(folder, 'scan_archival.pdf');
      if (fssync.existsSync(pInit)) newFiles.pdf = pInit.split(path.sep).join('/');
      if (fssync.existsSync(pFull)) newFiles.pdf_fullsize = pFull.split(path.sep).join('/');
      if (fssync.existsSync(pArch)) newFiles.pdf_archival = pArch.split(path.sep).join('/');

      const front = Object.assign({
        id,
        name: m.issue.name,
        year: m.issue.year,
        month: m.issue.month,
        declared_date_start: m.issue.declared_date_start,
        declared_date_end: m.issue.declared_date_end,
        volume: m.issue.volume,
        issue_number: m.issue.issue_number,
        series_code: m.issue.series_code,
        series_name: m.issue.series_name,
        scan_description: m.issue.scan_description,
        files: newFiles,
        status: m.issue.status || {}
      }, fm.data || {});

      const updated = matter.stringify(fm.content.trimStart(), removeUndefined(front), { language: 'yaml' });
      await fs.writeFile(dest, updated, 'utf8');
    }
  }

  if (dryRun){
    console.log(`\nDry-run complete. Use --execute to perform ${moves.length} planned moves.`);
  } else {
    console.log(`\nMigration complete. Review moved files, then remove old sources once satisfied.`);
  }
}

  if (cmd === 'index') await indexCommand();
  else if (cmd === 'migrate') await migrateCommand();

function removeUndefined(v){
  if (Array.isArray(v)) return v.map(removeUndefined);
  if (v && typeof v === 'object'){
    const out = {};
    for (const [k,val] of Object.entries(v)){
      if (val === undefined) continue;
      out[k] = removeUndefined(val);
    }
    return out;
  }
  return v;
}

async function loadConfig(p){
  if (!p){ return DEFAULT_CONFIG; }
  try{
    const raw = await fs.readFile(p, 'utf8');
    const cfg = p.endsWith('.yaml')||p.endsWith('.yml') ? yaml.load(raw) : JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, cfg);
  }catch(e){
    console.warn('Failed to load config, using defaults:', e.message);
    return DEFAULT_CONFIG;
  }
}
function deepMerge(a,b){
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a==='object' && typeof b==='object'){
    const out = {...a};
    for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    return out;
  }
  return b ?? a;
}
