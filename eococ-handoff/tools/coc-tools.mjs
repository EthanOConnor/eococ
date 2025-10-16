#!/usr/bin/env node
/** COC Repo Tools — index & migrate newsletters (Node 18+) */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fg from 'fast-glob';
import matter from 'gray-matter';
import yaml from 'js-yaml';

const DEFAULT_CONFIG = {
  src: {
    initial_pdfs: ["initial_scans/**/[0-9][0-9][0-9][0-9]/[0-9][0-9][0-9][0-9]-[0-9]*.{pdf,PDF,tif,tiff}", "initial/**"],
    final_pdfs: ["final_scans/**/*.{pdf,PDF}"],
    final_mds: ["final_transcripts/**/*.md", "transcripts_flat/**/*.md"],
  },
  dest: {
    newsletters_root: "newsletters",
    transcripts_root: "transcripts",
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

function parseInitial(p){
  const bn = path.basename(p);
  const dir = path.basename(path.dirname(p));
  const m = bn.match(/^(?<year>\d{4})-(?<n>\d{1,2})/);
  const year = Number(m?.groups?.year || (/^\d{4}$/.test(dir)? dir: null));
  const n = m? Number(m.groups.n): null;
  return year? { type:'initial', path:p, year, n }: null;
}

function parseFinalName(bn){
  const m = bn.match(/^(?<year>\d{4})-(?<m1>\d{2})(?:_(?<m2>\d{2}))?(?:_(?<m3>\d{2}))?\s+(?<rest>.*)$/);
  if (!m) return null;
  const year = Number(m.groups.year);
  const months = [m.groups.m1, m.groups.m2, m.groups.m3].filter(Boolean).map(x=> Number(x));
  const rest = m.groups.rest || '';
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
  if (!months?.length && textual){
    const mws = [...textual.matchAll(monthWordRe)].map(x=> monthNameToNum(x[1]));
    if (mws.length){ months.push(...mws); }
  }
  const minMonth = months.length? Math.min(...months): null;
  const maxMonth = months.length? Math.max(...months): null;
  const id = [year, minMonth? pad2(minMonth): '??', (maxMonth && maxMonth!==minMonth)? '_'+pad2(maxMonth): ''].join('');
  return { year, months, minMonth, maxMonth, title, textual, vol, no, id };
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
  return {
    id: meta.id,
    name,
    year: meta.year,
    month: meta.minMonth || undefined,
    declared_date_start: (meta.year && meta.minMonth)? `${meta.year}-${pad2(meta.minMonth)}-01` : undefined,
    declared_date_end: (meta.year && meta.maxMonth)? new Date(meta.year, meta.maxMonth, 0).toISOString().slice(0,10) : undefined,
    volume: meta.vol || undefined,
    issue_number: meta.no || undefined,
    files,
    status: {
      scan_initial: !!files.pdf_initial,
      scan_archival: !!files.pdf_archival,
      transcript_auto: !!files.md,
      transcript_review1: { state: 'todo' },
      transcript_review2: { state: 'todo' },
      annotation_people: { state: 'todo' }
    }
  };
}

async function indexCommand(){
  const { initial_pdfs, final_pdfs, final_mds } = CONFIG.src;
  const data = { issues: [], conflicts: [] };

  const initFiles = await fg(initial_pdfs, { dot:false });
  const finalPDFs = await fg(final_pdfs, { dot:false });
  const finalMDs = await fg(final_mds, { dot:false });

  const initials = initFiles.map(parseInitial).filter(Boolean);
  const finals = {};

  for (const p of [...finalPDFs, ...finalMDs]){
    const bn = path.basename(p);
    const meta = parseFinalName(bn);
    if (!meta){
      data.conflicts.push({ type:'unparsed_final', file:p, reason:'filename does not start with YYYY-MM' });
      continue;
    }
    const id = meta.id;
    finals[id] = finals[id] || { meta, pdf_archival:null, md:null, others:[] };
    if (isPDF(p)) finals[id].pdf_archival = p; else if (isMD(p)) finals[id].md = p; else finals[id].others.push(p);
  }

  const issues = [];
  for (const id of Object.keys(finals).sort()){
    const f = finals[id];
    const files = { pdf_archival: f.pdf_archival || undefined, md: f.md || undefined };

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
    if (matchedInitial) files.pdf_initial = matchedInitial.path;

    const issue = makeIssueObject(f.meta, files);

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
    const id = `${init.year}-??`;
    const existing = issues.find(x=> x.year===init.year && (x.files?.pdf_initial === init.path || x.files?.pdf_archival === init.path));
    if (existing) continue;
    data.conflicts.push({ type:'initial_without_final', year:init.year, n:init.n, file:init.path });
  }

  const outPath = CONFIG.dest.data_json;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(issues, null, 2), 'utf8');
  console.log(`Wrote ${issues.length} issues to ${outPath}`);

  if (data.conflicts.length){
    const report = data.conflicts.map(x=> JSON.stringify(x)).join(os.EOL);
    await fs.writeFile(path.join(path.dirname(outPath), 'conflicts.ndjson'), report, 'utf8');
    console.warn(`Conflicts: ${data.conflicts.length} (see ${path.join(path.dirname(outPath), 'conflicts.ndjson')})`);
  } else {
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
    const destArchival = path.join(folder, 'scan_archival.pdf');

    const tdir = path.join(CONFIG.dest.transcripts_root, String(year));
    const tfile = path.join(tdir, `${id}_${titleSlug}.md`);

    if (issue.files?.pdf_initial){ moves.push({ src: issue.files.pdf_initial, dest: destInitial }); }
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
      const pArch = path.join(folder, 'scan_archival.pdf');
      if (fssync.existsSync(pInit)) newFiles.pdf = pInit.split(path.sep).join('/');
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
        files: newFiles,
        status: m.issue.status || {}
      }, fm.data || {});

      const updated = matter.stringify(fm.content.trimStart(), front, { language: 'yaml' });
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
