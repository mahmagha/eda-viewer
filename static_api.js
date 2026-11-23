// Static mode for the EDA viewer (GitHub Pages or any static host).
// The page calls /api/... as it does with the Python server; this script answers those calls in the
// browser from the files eda_static.py exported to data/. Searches, filters, equivalents, company
// directories and comparisons are computed here from data/index.json; everything else is a
// pre-computed file. Anything that needs the server (editing, live look-ups, chemistry search)
// answers with a short explanation instead.
(function(){
"use strict";
const DATA = "data/";
const DRUG_SHARD = 200, ING_SHARDS = 512, COMPANY_SHARDS = 256, GROUP_SHARDS = 64;
const realFetch = window.fetch.bind(window);
const files = new Map();
function load(path){
  if(!files.has(path)) files.set(path, realFetch(DATA + path).then(r => {
    if(!r.ok) throw new Error(r.status === 404 ? "not found" : "HTTP " + r.status);
    return r.json();
  }).catch(e => { files.delete(path); throw e; }));
  return files.get(path);
}
function shard(s, n){  // FNV-1a over UTF-16 code units; same as shard() in eda_static.py
  let h = 0x811c9dc5;
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % n;
}
const companyKey = name => String(name || "").toLowerCase().replace(/&/g, " and ")
  .replace(/\bcompany\b/g, "co").replace(/[^0-9a-z؀-ۿ]+/g, "");
const like = (hay, q) => hay != null && String(hay).toLowerCase().includes(q.toLowerCase());
const nocase = s => String(s ?? "").toLowerCase();
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ATC_LEVELS = [1, 3, 4, 5, 7];
const ATC_L1 = {A: "Alimentary tract and metabolism", B: "Blood and blood forming organs", C: "Cardiovascular system",
  D: "Dermatologicals", G: "Genito-urinary system and sex hormones", H: "Systemic hormonal preparations (excl. sex hormones and insulins)",
  J: "Anti-infectives for systemic use", L: "Antineoplastic and immunomodulating agents", M: "Musculo-skeletal system",
  N: "Nervous system", P: "Antiparasitic products, insecticides and repellents", R: "Respiratory system", S: "Sensory organs", V: "Various"};
const TREAT_SECTIONS = ["Drug Indication", "Therapeutic Uses", "MeSH Pharmacological Classification"];

// ------------------------------------------------------------------ the product table (data/index.json)
let DB = null;
function db(){
  return DB || (DB = load("index.json").then(x => {
    const c = x.cols, d = x.dicts, n = c.t.length, at = (dict, i) => i < 0 ? null : d[dict][i];
    const ings = x.ings.map(([key, title, kind, eml, matched, atc, names, ctitle]) =>
      ({key, title, kind, eml: !!eml, matched: !!matched, atc, names, ctitle, drugs: []}));
    const byKey = new Map(ings.map(i => [i.key, i]));
    const rows = new Array(n);
    let id = 0;
    for(let i = 0; i < n; i++){
      id += c.id[i];
      const type = at("type", c.t[i]), lv = c.lv[i];
      let list;
      if(Array.isArray(lv)){
        const lay = x.layout[type];
        list = {[lay[0]]: lv[0], [lay[1]]: lv[1], [lay[2]]: at("lapp", lv[2]) ?? "", [lay[3]]: at("lform", lv[3]) ?? ""};
      } else list = lv;
      const co = c.co[i] < 0 ? null : x.companies[c.co[i]], mf = c.mf[i] < 0 ? null : x.mfrs[c.mf[i]];
      const r = {
        drug_id: id, drug_type: type, err: !!c.err[i], has_detail: !!c.hd[i], list,
        trade_name: c.tn[i] ?? (Array.isArray(lv) ? lv[0] : null),
        company: co ? co[1] : null, company_key: co ? co[0] : null, company_group: co ? co[2] : null,
        company_raw: c.cr[i] >= 0 ? d.raw[c.cr[i]] : (co ? co[1] : null), spellings: co ? co[3] : "",
        form: at("form", c.fm[i]), license: at("license", c.li[i]), marketing: at("marketing", c.mk[i]),
        min_price: c.pr[i], manufacturer: mf ? mf[1] : null, mfr_key: mf ? mf[0] : null, mfr_group: mf ? mf[2] : null,
        mfr_country: at("country", c.mc[i]), origin: at("origin", c.or[i]), storage_cat: at("storage", c.sc[i]),
        shelf_months: c.sh[i], route: at("route", c.ro[i]), reg_no: c.rg[i], pop: c.pop[i] || null,
        species: c.sp[i].map(s => d.species[s]), aware: at("aware", c.aw[i]),
        withdrawn: !!(c.fl[i] & 1), controlled: !!(c.fl[i] & 2),
        ings: c.ig[i].map(([k, s]) => [ings[k], s]),
      };
      for(const [g] of r.ings) if(g.drugs[g.drugs.length - 1] !== r) g.drugs.push(r);  // once, even if listed twice
      rows[i] = r;
    }
    const byId = new Map(rows.map(r => [r.drug_id, r]));
    const mfrCountry = new Map(x.mfrs.map(m => [m[0], m[3]]));
    return {x, rows, byId, ings, byKey, mfrCountry};
  }));
}
const ingsOf = r => r.ings.map(([g, s]) => ({key: g.key, title: g.title, strength: s}));
// the facts row the server sends for product tables, with its ingredients
const productRow = r => ({drug_id: r.drug_id, drug_type: r.drug_type, trade_name: r.trade_name, company: r.company,
  company_key: r.company_key, company_group: r.company_group, form: r.form, route: r.route, reg_no: r.reg_no,
  license: r.license, marketing: r.marketing, min_price: r.min_price, manufacturer: r.manufacturer,
  mfr_country: r.mfr_country, origin: r.origin, storage_cat: r.storage_cat, shelf_months: r.shelf_months,
  pop: r.pop, species: r.species.join("; ") || null, ingredients: ingsOf(r)});
const rank = (a, b) =>  // valid licences first, then cheapest, then name
  cmp(a.license !== "Valid", b.license !== "Valid") || cmp(a.min_price == null, b.min_price == null)
  || (a.min_price || 0) - (b.min_price || 0) || cmp(nocase(a.trade_name), nocase(b.trade_name));
const byName = (a, b) => cmp(nocase(a.trade_name), nocase(b.trade_name));
const hasAtc = (r, code) => r.ings.some(([g]) => g.atc.some(a => a.startsWith(code)));
const isEml = r => r.ings.some(([g]) => g.eml);

// ------------------------------------------------------------------ drug list (same filters as build_where)
let HAY = null;
function haystack(D){
  if(!HAY) HAY = D.rows.map(r => [r.trade_name, ...Object.values(r.list), r.company, r.company_raw, r.company_group,
    r.manufacturer, r.reg_no, ...r.ings.map(([g]) => g.title), ...r.ings.flatMap(([g]) => g.names.map(n => n[0]))]
    .filter(Boolean).join("\n").toLowerCase());
  return HAY;
}
async function treatKeys(q){ return new Set((await apiTreats(q)).rows.map(r => r.key)); }
async function filterRows(p){
  const D = await db();
  const tests = [];
  const q = (p.get("q") || "").trim();
  if(q && q.length < 3){
    const ql = q.toLowerCase(), qu = q.toUpperCase();
    tests.push(r => nocase(r.trade_name).startsWith(ql) || nocase(r.company).startsWith(ql)
      || r.ings.some(([g]) => g.names.some(n => n[0].toUpperCase().startsWith(qu))));
  } else if(q){
    const H = haystack(D), ql = q.toLowerCase(), pos = new Map(D.rows.map((r, i) => [r, i]));
    tests.push(r => H[pos.get(r)].includes(ql));
  }
  const type = p.get("type");
  if(type) tests.push(type === "medicines" ? r => r.drug_type !== "cosmetics" : r => r.drug_type === type);
  if(p.get("status") === "errors") tests.push(r => r.err);
  else if(p.get("status") === "details") tests.push(r => r.has_detail);
  for(const col of ["form", "license", "marketing"]){ const v = p.get(col); if(v) tests.push(r => r[col] === v); }
  const company = (p.get("company") || "").trim();
  if(company) tests.push(r => like(r.company, company) || like(r.company_raw, company) || like(r.spellings, company) || like(r.company_group, company));
  for(const [col, key] of [["company_group", "group"], ["mfr_country", "country"], ["origin", "origin"], ["storage_cat", "storage"]]){
    const v = p.get(key); if(v) tests.push(r => r[col] === v);
  }
  if(p.get("mfr")){ const k = companyKey(p.get("mfr")); tests.push(r => r.mfr_key === k); }
  if(p.get("ckey")){ const k = p.get("ckey"); tests.push(r => r.company_key === k); }
  if(p.get("species")){ const s = p.get("species"); tests.push(r => r.species.includes(s)); }
  if(p.get("aware")){ const a = p.get("aware"); tests.push(r => r.aware && (a === "any" || a === r.aware)); }
  if(p.get("flag") === "withdrawn") tests.push(r => r.withdrawn);
  if(p.get("flag") === "controlled") tests.push(r => r.controlled);
  if(p.get("pop")){ const g = p.get("pop"); tests.push(r => (";" + (r.pop || "") + ";").includes(";" + g + ";")); }
  if(p.get("eml") === "1") tests.push(isEml);
  if(p.get("treats")){ const ks = await treatKeys(p.get("treats")); tests.push(r => r.ings.some(([g]) => ks.has(g.key))); }
  if(p.get("price") === "1") tests.push(r => r.min_price != null);
  if(p.get("ings")){
    const want = p.get("ings").split(",").filter(Boolean);
    tests.push(r => want.every(k => r.ings.some(([g]) => g.key === k)));
    if(p.get("only") === "1") tests.push(r => { const ks = new Set(r.ings.map(([g]) => g.key)); return ks.size === new Set(want).size && want.every(k => ks.has(k)); });
  }
  if(p.get("atc")){ const code = p.get("atc").toUpperCase(); tests.push(r => hasAtc(r, code)); }
  let rows = D.rows.filter(r => tests.every(t => t(r)));
  const sort = p.get("sort") || "";
  const price = (a, b, dir) => cmp(a.min_price == null, b.min_price == null) || dir * ((a.min_price || 0) - (b.min_price || 0)) || a.drug_id - b.drug_id;
  if(sort === "name") rows.sort((a, b) => byName(a, b) || a.drug_id - b.drug_id);
  else if(sort === "price") rows.sort((a, b) => price(a, b, 1));
  else if(sort === "price_desc") rows.sort((a, b) => price(a, b, -1));
  else if(sort === "company") rows.sort((a, b) => cmp(nocase(a.company), nocase(b.company)) || byName(a, b));
  return {D, rows};
}
async function apiList(p){
  const {D, rows} = await filterRows(p);
  const size = D.x.page_size, page = Math.max(0, +(p.get("page") || 0));
  return {total: rows.length, page, page_size: size, also: [],
          rows: rows.slice(page * size, (page + 1) * size).map(r => ({id: r.drug_id, type: r.drug_type, err: r.err, price: r.min_price, list: r.list}))};
}
async function exportCsv(p){
  const {rows} = await filterRows(p);
  const cols = ["ID", "Type", "Trade name", "Company", "Corporate group", "Dosage form", "Route", "Registration no",
    "License status", "Marketing status", "Manufacturer", "Manufacturer country", "Storage", "Shelf life (months)", "Active ingredients"];
  const q = v => v == null ? "" : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [cols.join(",")].concat(rows.map(r => [r.drug_id, r.drug_type, r.trade_name, r.company, r.company_group, r.form,
    r.route, r.reg_no, r.license, r.marketing, r.manufacturer, r.mfr_country, r.storage_cat, r.shelf_months,
    r.ings.map(([g, s]) => g.title + (s ? " " + s : "")).join(" + ")].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], {type: "text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "eda_drugs_export.csv";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ------------------------------------------------------------------ equivalents, ingredients, companies
async function apiEquivalents(id){
  const D = await db(), me = D.byId.get(id);
  if(!me || !me.ings.length) return {groups: [], note: "This product has no active-ingredient list, so equivalents can't be matched."};
  const sig = r => [...new Set(r.ings.map(([g, s]) => g.key + "\u0001" + s))].sort().join("\u0002");
  const keys = new Set(me.ings.map(([g]) => g.key)), mySig = sig(me), form = nocase(me.form).trim();
  const smallest = me.ings.map(([g]) => g).reduce((a, b) => a.drugs.length <= b.drugs.length ? a : b);
  const same = [], other = [];
  for(const r of smallest.drugs){
    if(r === me) continue;
    const ks = new Set(r.ings.map(([g]) => g.key));
    if(ks.size !== keys.size || [...keys].some(k => !ks.has(k))) continue;
    (sig(r) === mySig ? same : other).push(r);
  }
  const g1 = same.filter(r => nocase(r.form).trim() === form).map(productRow).sort(rank);
  const g2 = same.filter(r => nocase(r.form).trim() !== form).map(productRow).sort(rank);
  const g3 = other.map(productRow).sort(rank);
  return {ingredients: ingsOf(me), price: me.min_price,
    groups: [{title: "Same active ingredients, strength and dosage form", rows: g1.slice(0, 300), total: g1.length},
             {title: "Same active ingredients and strength, other dosage forms", rows: g2.slice(0, 300), total: g2.length},
             {title: "Same active ingredients, other strengths", rows: g3.slice(0, 300), total: g3.length}]};
}
async function ingredientPage(key){
  const [D, sh] = await Promise.all([db(), load(`ing/${shard(key, ING_SHARDS)}.json`)]);
  const d = sh[key], g = D.byKey.get(key);
  if(!d || !g) return null;
  return {...d, products: g.drugs.map(productRow).sort(rank)};
}
async function apiIngredients(q){
  const D = await db(), qu = q.trim().toUpperCase();
  const out = D.ings.filter(g => !qu || g.title.toUpperCase().includes(qu) || g.names.some(n => n[0].toUpperCase().includes(qu)))
    .map(g => ({key: g.key, title: g.title, count: g.drugs.length, kind: g.kind, matched: g.matched}));
  out.sort((a, b) => cmp(!!qu && !a.title.toUpperCase().startsWith(qu), !!qu && !b.title.toUpperCase().startsWith(qu)) || b.count - a.count);
  return {total: out.length, rows: out.slice(0, 150)};
}
async function apiCompanies(q, by, type, origin){
  const D = await db();
  q = q.trim();
  const base = D.rows.filter(r => (!type || (type === "medicines" ? r.drug_type !== "cosmetics" : r.drug_type === type))
    && (!(origin === "Imported" || origin === "Made in Egypt") || r.origin === origin));
  const groups = new Map(), add = (k, r, init) => { let e = groups.get(k); if(!e){ e = init(); groups.set(k, e); } e.n++; e.imported += r.origin === "Imported"; return e; };
  const max = (a, b) => b == null ? a : a == null || b > a ? b : a;
  if(by === "group"){
    for(const r of base) if(r.company_group && like(r.company_group, q)){
      const e = add(r.company_group, r, () => ({name: r.company_group, n: 0, members: new Set(), imported: 0}));
      e.members.add(r.company_key);
    }
    const rows = [...groups.values()].map(e => ({...e, members: e.members.size})).sort((a, b) => b.n - a.n);
    return {total: rows.length, rows};
  }
  if(by === "manufacturer"){
    for(const r of base) if(r.mfr_key && like(r.manufacturer, q)){
      const e = add(r.mfr_key, r, () => ({key: r.mfr_key, name: null, grp: null, n: 0, imported: 0, country: D.mfrCountry.get(r.mfr_key) ?? null}));
      e.name = max(e.name, r.manufacturer); e.grp = max(e.grp, r.mfr_group);
    }
  } else {
    for(const r of base) if(r.company_key && (like(r.company, q) || like(r.company_raw, q) || like(r.company_group, q))){
      const e = add(r.company_key, r, () => ({key: r.company_key, name: null, grp: null, n: 0, imported: 0}));
      e.name = max(e.name, r.company); e.grp = max(e.grp, r.company_group);
    }
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n);
  return {total: rows.length, rows: rows.slice(0, 200), products: base.length, imported: base.filter(r => r.origin === "Imported").length};
}
async function companyPage(name, role){
  const k = companyKey(name);
  const [D, sh] = await Promise.all([db(), load(`company-${role}/${shard(k, COMPANY_SHARDS)}.json`)]);
  const d = sh[k];
  if(!d) return null;
  const col = role === "manufacturer" ? "mfr_key" : "company_key";
  return {...d, products: D.rows.filter(r => r[col] === k).map(productRow).sort(byName)};
}
async function groupPage(name){
  const [D, sh] = await Promise.all([db(), load(`company-group/${shard(name, GROUP_SHARDS)}.json`)]);
  const d = sh[name];
  if(!d) return null;
  return {...d, products: D.rows.filter(r => r.company_group === name).map(productRow).sort(byName)};
}

// ------------------------------------------------------------------ what it treats
async function apiTreats(q){
  q = q.trim();
  if(q.length < 3) return {rows: [], products: 0, note: "Type at least 3 letters."};
  const [D, texts] = await Promise.all([db(), load("treats.json")]);
  const ql = q.toLowerCase(), hits = new Map();
  for(const [cid, section, text, source] of texts){
    const i = text.toLowerCase().indexOf(ql);
    if(i < 0) continue;
    const k = "cid:" + cid, g = D.byKey.get(k);
    if(!g) continue;
    let h = hits.get(k);
    if(!h) hits.set(k, h = {key: k, title: g.title, count: g.drugs.length, eml: g.eml, snippet: null, source: null, source_section: null, sections: new Set()});
    h.sections.add(section);
    if(!h.snippet || (section === "Drug Indication" && h.source_section !== "Drug Indication")){
      const a = Math.max(0, i - 120);
      h.snippet = (a ? "…" : "") + text.slice(a, i + q.length + 160) + (i + q.length + 160 < text.length ? "…" : "");
      h.source = source; h.source_section = section;
    }
  }
  const out = [...hits.values()].sort((a, b) => cmp(!a.sections.has("Drug Indication"), !b.sections.has("Drug Indication")) || b.count - a.count);
  const prods = new Set();
  for(const h of out){ h.sections = [...h.sections].sort(); for(const r of D.byKey.get(h.key).drugs) prods.add(r.drug_id); }
  return {rows: out, products: prods.size};
}

// ------------------------------------------------------------------ products and comparison
const drugRecord = async id => (await load(`drug/${Math.floor(id / DRUG_SHARD)}.json`))[String(id)] || null;
function namePatterns(g, ctitle){
  const names = new Set([g.title, ctitle || g.ctitle || ""]);
  for(const [raw] of g.names) names.add(raw.replace(/\s*\(.*?\)|\b(hydrochloride|hcl|sodium|potassium|sulfate|sulphate|trihydrate|monohydrate|dihydrate|anhydrous|calcium|maleate|tartrate|citrate)\b/gi, ""));
  return [...names].map(n => n.trim().toLowerCase()).filter(n => n.length >= 4);
}
async function interactions(D, keys){
  keys = [...new Set(keys)].filter(k => k.startsWith("cid:"));
  const pages = await Promise.all(keys.map(k => ingredientPage(k).catch(() => null)));
  const out = [], esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  keys.forEach((a, ia) => {
    const texts = ((pages[ia] && pages[ia].safety) || []).filter(s => s.section === "Interactions").flatMap(s => s.items);
    keys.forEach(b => {
      if(a === b) return;
      const gb = D.byKey.get(b); if(!gb) return;
      const ib = keys.indexOf(b), pats = namePatterns(gb, pages[ib] && pages[ib].compound && pages[ib].compound.title);
      for(const t of texts){
        const low = t.text.toLowerCase();
        if(pats.some(n => new RegExp("\\b" + esc(n) + "\\b").test(low)))
          out.push({a: D.byKey.get(a).title, a_key: a, b: gb.title, b_key: b, text: t.text, source: t.source});
      }
    });
  });
  return out;
}
async function apiCompare(ids){
  const D = await db(), products = [];
  for(const id of ids.slice(0, 6)){
    const r = D.byId.get(id), rec = await drugRecord(id).catch(() => null);
    if(!r || !rec) continue;
    const tables = (rec.detail && rec.detail.tables) || {};
    products.push({...(rec.facts || productRow(r)), ingredients: ingsOf(r),
      packages: Object.keys(tables).filter(t => t.startsWith("ui_gvPackages")).flatMap(t => tables[t]),
      companies: (rec.companies || []).map(c => ({role: c.role, name: c.name, country: c.country})), eml: isEml(r)});
  }
  return {products, interactions: await interactions(D, products.flatMap(p => p.ingredients.map(i => i.key)))};
}
async function apiClinicalCompare(keysStr){
  const D = await db();
  const keys = keysStr.split(",").map(k => k.trim()).filter(Boolean).slice(0, 4);
  const mols = [];
  const SEC_MAP = {
    "mechanism": ["Mechanism of Action"],
    "pharmacodynamics": ["Pharmacodynamics"],
    "half_life": ["Biological Half-Life"],
    "protein_binding": ["Protein Binding"],
    "adme": ["Absorption, Distribution and Excretion", "Metabolism/Metabolites"],
    "interactions": ["Interactions"],
    "hepatotoxicity": ["Hepatotoxicity", "LiverTox Summary"],
    "pregnancy_lactation": ["Effects During Pregnancy and Lactation"],
    "special_populations": ["Populations at Special Risk"]
  };
  for(const k of keys){
    const g = D.byKey.get(k);
    const page = await ingredientPage(k).catch(() => null);
    if(!g && !page) continue;
    const comp = (page && page.compound) || {};
    const title = (page && page.title) || (g && g.title) || k;
    const allSecs = [...(page && Array.isArray(page.pharm) ? page.pharm : []), ...(page && Array.isArray(page.safety) ? page.safety : [])];
    const secObj = {};
    for(const [targetSec, secNames] of Object.entries(SEC_MAP)){
      const hit = allSecs.find(s => secNames.includes(s.section));
      let txt = null;
      if(hit){
        if(typeof hit.text === "string") txt = hit.text;
        else if(Array.isArray(hit.items) && hit.items.length){
          const it = hit.items.find(x => x && x.text) || hit.items[0];
          txt = (it && it.text) || null;
        }
      }
      secObj[targetSec] = txt;
    }
    if(!secObj.special_populations && page && page.populations && typeof page.populations === "object" && !Array.isArray(page.populations)){
      const popVals = Object.values(page.populations).map(v => v && v.label ? `${v.label} (${v.count} forms)` : null).filter(Boolean);
      if(popVals.length) secObj.special_populations = popVals.join(" • ");
    }
    const drugs = g ? g.drugs : [];
    const forms = [...new Set(drugs.map(r => r.form).filter(Boolean))].slice(0, 5);
    const sample_brands = [...new Set(drugs.map(r => r.trade_name).filter(Boolean))].slice(0, 4);
    mols.push({
      cid: comp.cid || (k.startsWith("cid:") ? +k.slice(4) : null),
      key: k,
      title: comp.title || title,
      atc: comp.atc || ((g && g.atc && g.atc[0]) || null),
      cas: comp.cas || null,
      first_approval: comp.first_approval || null,
      eml: comp.eml != null ? !!comp.eml : (g ? g.eml : false),
      bbw: !!comp.bbw,
      fda_approved: !!comp.fda,
      ema_approved: !!comp.ema,
      sections: secObj,
      egyptian_market: {
        registered_drugs: drugs.length,
        sample_brands: sample_brands,
        dosage_forms: forms
      }
    });
  }
  return {molecules: mols};
}

async function apiClinicalConditions(p){
  const sum = await load("clinical/conditions_summary.json").catch(() => ({total: 0, specialties: [], rows: []}));
  const q = (p.get("q") || "").trim().toLowerCase();
  const spec = (p.get("specialty") || "").trim().toLowerCase(), kind = (p.get("kind") || "").trim();
  let rows = sum.rows || [];
  if(spec){
    rows = rows.filter(r => (r.specialty || "").toLowerCase() === spec);
  }
  if(kind){
    rows = rows.filter(r => r.kind === kind);
  }
  if(q){
    rows = rows.filter(r => 
      (r.title || "").toLowerCase().includes(q) ||
      (r.icd10_code || "").toLowerCase().includes(q) ||
      (r.icd10_name || "").toLowerCase().includes(q) ||
      (r.summary || "").toLowerCase().includes(q)
    );
  }
  const lim = parseInt(p.get("limit") || "50", 10);
  const off = parseInt(p.get("offset") || "0", 10);
  return {
    total: rows.length,
    limit: lim,
    offset: off,
    specialties: sum.specialties || [],
    kinds: sum.kinds || [],
    rows: rows.slice(off, off + lim)
  };
}

async function apiOntologyLookup(codeStr){
  const cwList = await load("clinical/ontology_crosswalks.json").catch(() => []);
  const clean = (codeStr || "").trim().toUpperCase();
  const results = [];
  for(const item of cwList){
    let matchedAxis = null, matchedSystem = null, matchedNode = null;
    for(const [axName, axDict] of Object.entries(item.axes || {})){
      for(const [sysId, codeInfo] of Object.entries(axDict)){
        const target = String(codeInfo.code || "").trim().toUpperCase();
        if(target === clean || (clean.length > 2 && target.includes(clean))){
          matchedAxis = axName;
          matchedSystem = sysId;
          matchedNode = codeInfo;
          break;
        }
      }
      if(matchedAxis) break;
    }
    if(matchedAxis){
      const rels = {};
      for(const [ax, axDict] of Object.entries(item.axes)){
        if(ax !== matchedAxis) rels[ax] = axDict;
      }
      results.push({
        query_code: codeStr,
        identified_system: matchedSystem,
        identified_axis: matchedAxis,
        matched_entry: matchedNode,
        condition_id: item.condition_id,
        condition_name: item.canonical_name,
        specialty: item.specialty,
        cross_axial_relations: rels
      });
    }
  }
  return {found: results.length > 0, results};
}

async function apiOntologySearch(qStr){
  const cwList = await load("clinical/ontology_crosswalks.json").catch(() => []);
  const q = (qStr || "").trim().toLowerCase();
  const matches = [];
  for(const item of cwList){
    let found = false;
    if(!q || (item.canonical_name || "").toLowerCase().includes(q) || (item.specialty || "").toLowerCase().includes(q)){
      found = true;
    }
    const matched_codes = [];
    for(const [axName, axDict] of Object.entries(item.axes || {})){
      for(const [sysId, codeInfo] of Object.entries(axDict)){
        const cVal = String(codeInfo.code || "").toLowerCase();
        const nVal = String(codeInfo.name || "").toLowerCase();
        if(q && (cVal.includes(q) || nVal.includes(q))){
          found = true;
          matched_codes.push({axis: axName, system: sysId, code: codeInfo.code, name: codeInfo.name});
        }
      }
    }
    if(found){
      matches.push({...item, matched_codes});
    }
  }
  return {total: matches.length, query: qStr, results: matches};
}

// ------------------------------------------------------------------ router
const NO_SERVER = "This online copy is read-only and has no server behind it";
const answers = {
  "/api/stats": () => load("stats.json"), "/api/facets": () => load("facets.json"), "/api/countries": () => load("countries.json"),
  "/api/vet": () => load("vet.json"), "/api/antibiotics": () => load("antibiotics.json"), "/api/regulatory": () => load("regulatory.json"),
  "/api/controlled": () => load("controlled.json"), "/api/dashboard": () => load("dashboard.json"), "/api/quality": () => load("quality.json"),
  "/api/drugs": p => apiList(p),
  "/api/market": p => load(`market/${p.get("type") || "all"}.json`).catch(() => load("market/all.json")),
  "/api/atc": async p => { const all = await load("atc.json"), d = all[(p.get("code") || "").trim().toUpperCase()]; return d || [404, {error: "No such class"}]; },
  "/api/clinical/pathways": () => load("clinical/pathways.json"),
  "/api/clinical/pathway": p => load(`clinical/pathway/${p.get("id") || ""}.json`).catch(() => [404, {error: "Pathway not found"}]),
  "/api/clinical/conditions": p => apiClinicalConditions(p),
  "/api/clinical/condition": p => load(`clinical/condition/${p.get("id") || ""}.json`).catch(() => [404, {error: "Condition not found"}]),
  "/api/clinical/compare": p => apiClinicalCompare(p.get("keys") || ""),
  "/api/clinical/ontology/systems": () => load("clinical/ontology_systems.json"),
  "/api/clinical/ontology/crosswalk": p => load(`clinical/crosswalk/${p.get("id") || ""}.json`).catch(() => [404, {error: "Crosswalk not found"}]),
  "/api/clinical/ontology/lookup": p => apiOntologyLookup(p.get("code") || ""),
  "/api/clinical/ontology/search": p => apiOntologySearch(p.get("q") || ""),
  "/api/ingredient": async p => (await ingredientPage(p.get("key") || "")) || [404, {error: "No products with this ingredient"}],
  "/api/ingredients": p => apiIngredients(p.get("q") || ""),
  "/api/companies": p => apiCompanies(p.get("q") || "", p.get("by") || "applicant", p.get("type") || "", p.get("origin") || ""),
  "/api/company": async p => (await companyPage(p.get("name") || "", p.get("role") === "manufacturer" ? "manufacturer" : "applicant")) || [404, {error: "No such company"}],
  "/api/group": async p => (await groupPage(p.get("name") || "")) || [404, {error: "No such group"}],
  "/api/treats": p => apiTreats(p.get("q") || ""),
  "/api/compare": p => apiCompare((p.get("ids") || "").split(",").filter(x => /^\d+$/.test(x.trim())).map(Number)),
  "/api/changes": p => load(`changes/${p.get("since") || "latest"}.json`),
  "/api/suggest": () => ({rows: []}),
  "/api/faers": () => [503, {error: "Reported side effects are looked up live from the US FDA, which needs the full viewer. " + NO_SERVER + "."}],
  "/api/sop": () => [404, {error: "SOP drafts are not published in this online copy."}],
};
async function answer(path, p, method){
  if(method !== "GET") return [403, {error: NO_SERVER + ": changes can only be made in the full viewer."}];
  let m;
  if((m = path.match(/^\/api\/drug\/(\d+)$/))) return (await drugRecord(+m[1])) || [404, {error: "not found"}];
  if((m = path.match(/^\/api\/equivalents\/(\d+)$/))) return apiEquivalents(+m[1]);
  if(path.startsWith("/api/chem/")) return [503, {error: "The chemistry search needs RDKit on the server. " + NO_SERVER + ".", missing: "rdkit"}];
  const fn = answers[path];
  return fn ? fn(p) : [404, {error: "Not available in this online copy."}];
}
window.fetch = async function(input, init){
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const i = url.pathname.indexOf("/api/");
  if(url.origin !== location.origin || i < 0) return realFetch(input, init);
  let status = 200, body;
  try{
    body = await answer(url.pathname.slice(i), url.searchParams, ((init && init.method) || "GET").toUpperCase());
    if(Array.isArray(body) && typeof body[0] === "number") [status, body] = body;
  }catch(e){ status = 500; body = {error: "Could not load the data: " + e.message}; }
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
};

// structure drawings are pre-drawn files; the page asks for them through this
window.STATIC_STRUCT = key => DATA + "struct/" + key.replace(/[^A-Za-z0-9_-]/g, "_") + ".svg";

// the drug-list CSV link is made in the browser
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest('a[href*="/api/export.csv"]');
  if(!a) return;
  e.preventDefault();
  const old = a.textContent; a.textContent = "Preparing…";
  exportCsv(new URL(a.href, location.href).searchParams).catch(err => alert(err.message)).finally(() => { a.textContent = old; });
}, true);

window.EDA_STATIC = true;
if(document.body) document.body.classList.add("static", "no-rdkit", "no-openpyxl");  // before the page first draws
db();  // start loading the product table straight away
})();
