#!/usr/bin/env node
// Personal to-do list, meeting follow-ups and the morning brief (local, gitignored). Usage: README.md, or
// `node pm/todo.js help`. The store is pm/todos.json; pm/TODO.md is a checkbox view that is read back on every run.
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const ROOT = path.resolve(DIR, "..");
const STORE = path.join(DIR, "todos.json");
const TODO_MD = path.join(DIR, "TODO.md");
const BRIEFS = path.join(DIR, "briefs");
if (!fs.existsSync(path.join(DIR, "config.json"))) {
  console.error(`No config.json in ${DIR} - copy config.example.json to config.json and fill it in (README.md, "Set-up").`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const TZ = cfg.timeZone || "Europe/Tallinn";

const KINDS = ["test", "complete", "communicate", "implement", "prepare", "follow-up", "decide", "review", "other"];
const PRIORITIES = ["high", "normal", "low"];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const DUE_KINDS = ["agreed", "soft"];

// ---- dates (local calendar days in cfg.timeZone) ----
const ymd = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localHour = (d = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d));
const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = toUtc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (s) => toUtc(s).getUTCDay();
const isWeekend = (s) => weekday(s) === 0 || weekday(s) === 6;
function addWorkingDays(s, n) {
  let d = s;
  while (n > 0) { d = addDays(d, 1); if (!isWeekend(d)) n--; }
  return d;
}
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pretty = (s) => toUtc(s).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
function parseDue(v, today = ymd()) {
  if (v == null || v === "" || v === "none") return null;
  const s = String(v).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  let m = s.match(/^\+(\d+)d$/);
  if (m) return addDays(today, Number(m[1]));
  m = s.match(/^\+(\d+)wd$/);
  if (m) return addWorkingDays(today, Number(m[1]));
  const wd = DAY_NAMES.indexOf(s.slice(0, 3));
  if (wd >= 0) { let d = addDays(today, 1); while (weekday(d) !== wd) d = addDays(d, 1); return d; }
  throw new Error(`due: "${v}" - use YYYY-MM-DD, today, tomorrow, +3d, +2wd (working days) or a weekday (mon..sun).`);
}

// ---- store ----
function load() {
  if (!fs.existsSync(STORE)) return { nextId: 1, items: [], meetings: {}, agenda: null, log: [], lastBrief: null, lastWorkerRun: null };
  const s = JSON.parse(fs.readFileSync(STORE, "utf8"));
  s.items = s.items || []; s.meetings = s.meetings || {}; s.log = s.log || [];
  return s;
}
function save(s) {
  s.log = s.log.slice(-500);
  const tmp = `${STORE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, STORE);
  renderTodoMd(s);
}
const now = () => new Date().toISOString();
const byId = (s, id) => {
  const it = s.items.find((x) => x.id === Number(String(id).replace(/^#/, "")));
  if (!it) throw new Error(`#${id} is not on the list.`);
  return it;
};

// ---- validation ----
const catKey = (v) => {
  if (v == null || v === "") return "other";
  const k = String(v).trim().toLowerCase();
  if (cfg.categories[k]) return k;
  const byLabel = Object.entries(cfg.categories).find(([, c]) => c.label.toLowerCase() === k);
  if (byLabel) return byLabel[0];
  const byProject = Object.entries(cfg.categories).find(([, c]) => (c.project || "").toLowerCase() === k);
  if (byProject) return byProject[0];
  throw new Error(`category: "${v}" - one of ${Object.keys(cfg.categories).join(", ")}.`);
};
const oneOf = (v, list, name, dflt) => {
  if (v == null || v === "") return dflt;
  const k = String(v).trim().toLowerCase();
  if (!list.includes(k)) throw new Error(`${name}: "${v}" - one of ${list.join(", ")}.`);
  return k;
};
const ownerOf = (v) => {
  if (v == null || v === "" || /^me$/i.test(v)) return "me";
  const m = String(v).match(/^waiting:(.+)$/i);
  if (m) return `waiting:${m[1].trim()}`;
  throw new Error(`owner: "${v}" - "me" or "waiting:<name>".`);
};
const clean = (t) => String(t || "").replace(/—/g, " - ").replace(/\s+/g, " ").trim();

function makeItem(s, f, via) {
  const title = clean(f.title);
  if (!title) throw new Error("title: required.");
  const it = {
    id: s.nextId++,
    title,
    category: catKey(f.category),
    kind: oneOf(f.kind, KINDS, "kind", "other"),
    owner: ownerOf(f.owner),
    due: parseDue(f.due),
    dueKind: f.due ? oneOf(f.dueKind, DUE_KINDS, "dueKind", "agreed") : null,
    priority: oneOf(f.priority, PRIORITIES, "priority", "normal"),
    status: "open",
    notes: f.notes ? clean(f.notes) : undefined,
    key: f.key || undefined,
    source: f.source || { type: via },
    created: now(),
  };
  s.items.push(it);
  return it;
}
function applyEdit(it, f) {
  if (f.title != null) it.title = clean(f.title);
  if (f.category != null) it.category = catKey(f.category);
  if (f.kind != null) it.kind = oneOf(f.kind, KINDS, "kind");
  if (f.owner != null) it.owner = ownerOf(f.owner);
  if (f.due !== undefined) { it.due = parseDue(f.due); it.dueKind = it.due ? oneOf(f.dueKind, DUE_KINDS, "dueKind", it.dueKind || "agreed") : null; }
  else if (f.dueKind != null && it.due) it.dueKind = oneOf(f.dueKind, DUE_KINDS, "dueKind");
  if (f.priority != null) it.priority = oneOf(f.priority, PRIORITIES, "priority");
  if (f.notes != null) it.notes = clean(it.notes ? `${it.notes} | ${f.notes}` : f.notes);
  it.updated = now();
}
function close(it, status, via, why) {
  it.status = status;
  it.closedAt = now();
  it.closedVia = via;
  if (why) it.closedWhy = clean(why);
}

// ---- ranking ----
function bucket(it, today) {
  const near = addWorkingDays(today, cfg.nearWorkingDays || 3);
  const upcoming = addDays(today, cfg.upcomingDays || 7);
  if (it.due && it.due < today) return 0;
  if (it.due === today) return 1;
  if (it.due && it.due <= near) return 2;
  if (it.priority === "high") return 3;
  if (it.due && it.due <= upcoming) return 4;
  return 5;
}
const BUCKET_LABEL = ["overdue", "today", "near", "high priority", "upcoming", "later"];
function rankSort(items, today) {
  return items.slice().sort((a, b) => bucket(a, today) - bucket(b, today)
    || (a.due || "9999") .localeCompare(b.due || "9999")
    || PRIO_RANK[a.priority] - PRIO_RANK[b.priority]
    || a.id - b.id);
}
const openMine = (s) => s.items.filter((x) => x.status === "open" && x.owner === "me");
const openWaiting = (s) => s.items.filter((x) => x.status === "open" && x.owner !== "me");
function topItems(s, n, today = ymd()) {
  return rankSort(openMine(s), today).filter((x) => bucket(x, today) <= 4).slice(0, n);
}

// ---- formatting ----
const label = (k) => (cfg.categories[k] || { label: k }).label;
function dueText(it, today = ymd()) {
  if (!it.due) return "";
  const soft = it.dueKind === "soft" ? ", soft" : "";
  if (it.due < today) return ` - OVERDUE (was ${pretty(it.due)}${soft})`;
  if (it.due === today) return ` - due today${soft}`;
  return ` - due ${pretty(it.due)}${soft}`;
}
function line(it, today = ymd(), { cat = true } = {}) {
  const who = it.owner === "me" ? "" : ` (waiting on ${it.owner.slice(8)})`;
  const prio = it.priority === "high" ? " !high" : it.priority === "low" ? " (low)" : "";
  const state = it.status === "open" ? "" : ` [${it.status}]`;
  return `#${it.id}${cat ? ` [${label(it.category)}]` : ""} ${it.title}${who}${dueText(it, today)}${prio} {${it.kind}}${state}`;
}

// ---- TODO.md: checkbox view, read back before every command ----
const MD_HEAD = [
  "# To-do (generated by pm/todo.js - edits below are read back on the next run)",
  "",
  "Tick `[x]` = done, `[-]` = drop. A new line `- [ ] text` under a heading becomes an item in that category;",
  "optional `@2026-11-03` (or @fri, @+2d) sets the due date, `!high` / `!low` the priority, `>waiting:Name` the owner.",
  "Headings are categories: " + Object.entries(cfg.categories).map(([k, c]) => `${k} (${c.label})`).join(", ") + ".",
  "",
];
function syncTodoMd(s) {
  if (!fs.existsSync(TODO_MD)) return [];
  const notes = [];
  let cat = "other";
  for (const raw of fs.readFileSync(TODO_MD, "utf8").split(/\r?\n/)) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) { try { cat = catKey(h[1].replace(/\s*\(\d+\)$/, "")); } catch { cat = "other"; } continue; }
    const m = raw.match(/^\s*[-*]\s+\[([ xX-])\]\s+(.*)$/);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const rest = m[2];
    const idm = rest.match(/^#(\d+)\b/);
    if (idm) {
      const it = s.items.find((x) => x.id === Number(idm[1]));
      if (!it || it.status !== "open") continue;
      if (mark === "x") { close(it, "done", "TODO.md"); notes.push(`#${it.id} done (TODO.md)`); }
      if (mark === "-") { close(it, "dropped", "TODO.md"); notes.push(`#${it.id} dropped (TODO.md)`); }
      continue;
    }
    if (mark !== " ") continue;
    let text = rest;
    const f = { category: cat };
    text = text.replace(/\s@(\S+)/, (_, d) => { f.due = d; return ""; });
    text = text.replace(/\s!(high|low|normal)\b/i, (_, p) => { f.priority = p.toLowerCase(); return ""; });
    text = text.replace(/\s>(waiting:[^@!]+)/i, (_, o) => { f.owner = o.trim(); return ""; });
    f.title = text;
    try {
      const it = makeItem(s, f, "TODO.md");
      notes.push(`#${it.id} added (TODO.md): ${it.title}`);
    } catch (e) { notes.push(`not added from TODO.md ("${clean(rest)}"): ${e.message}`); }
  }
  return notes;
}
function renderTodoMd(s) {
  const today = ymd();
  const out = MD_HEAD.slice();
  out.push(`Updated ${new Date().toLocaleString("en-GB", { timeZone: TZ })}. Top ${cfg.topN || 5}:`, "");
  const top = topItems(s, cfg.topN || 5, today);
  if (top.length) top.forEach((it, i) => out.push(`${i + 1}. ${line(it, today)}`));
  else out.push("(nothing due in the near future)");
  out.push("");
  const open = s.items.filter((x) => x.status === "open");
  for (const k of Object.keys(cfg.categories)) {
    const items = rankSort(open.filter((x) => x.category === k), today);
    if (!items.length) continue;
    out.push(`## ${label(k)} (${items.length})`, "");
    items.forEach((it) => out.push(`- [ ] ${line(it, today, { cat: false })}`));
    out.push("");
  }
  if (!open.some((x) => x.category === "other")) out.push(`## ${label("other")}`, "");
  out.push("<!-- add new lines under any category heading; a heading that is a category key (## navasana) works too -->", "");
  fs.writeFileSync(TODO_MD, out.join("\n"));
}

// ---- args ----
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v == null || v.startsWith("--")) opt[k] = true; else { opt[k] = v; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}
// Input comes from `--file pm/inbox/<name>` (the morning worker: a command line holding JSON always asks for approval,
// so it writes the input to a file first) or from stdin. The file is removed once the command has succeeded.
const INBOX = path.join(DIR, "inbox");
let inputFile = null;
function setInputFile(f) {
  if (!f || f === true) return;
  const abs = path.resolve(ROOT, String(f));
  if (path.relative(INBOX, abs).startsWith("..") || path.isAbsolute(path.relative(INBOX, abs))) throw new Error(`--file: only files in pm/inbox/ (${f}).`);
  if (!fs.existsSync(abs)) throw new Error(`--file: ${f} does not exist.`);
  inputFile = abs;
}
const readStdin = () => {
  if (inputFile) return fs.readFileSync(inputFile, "utf8");
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
};
const readJsonStdin = () => {
  const t = readStdin().trim();
  if (!t) throw new Error("expected JSON: --file pm/inbox/<name>.json (or on stdin).");
  return JSON.parse(t);
};

// ---- commands ----
function cmdTop(s, opt) {
  const today = ymd();
  const n = Number(opt.n || cfg.topN || 5);
  const out = [];
  if (s.lastWorkerRun !== today && localHour() >= 9 && !isWeekend(today)) out.push(`Note: the morning worker has not run today (last run ${s.lastWorkerRun || "never"}).`);
  const top = topItems(s, n, today);
  out.push(`Top ${n} (${pretty(today)}):`);
  if (!top.length) out.push("  nothing due in the near future");
  top.forEach((it, i) => out.push(`${i + 1}. ${line(it, today)}`));
  const w = rankSort(openWaiting(s), today).filter((x) => bucket(x, today) <= 2);
  if (w.length) { out.push("", "Waiting on others, due or overdue:"); w.forEach((it) => out.push(`- ${line(it, today)}`)); }
  out.push("", `Open: ${openMine(s).length} mine, ${openWaiting(s).length} waiting on others. More: node pm/todo.js list --by category`);
  const text = out.join("\n");
  if (!opt.hook) return text;
  // SessionStart hook: systemMessage is shown to the user, additionalContext tells the session
  return JSON.stringify({
    systemMessage: `To-do\n${text}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `The user's to-do list (pm/todo.js, local). Top items today:\n${text}\nShow these top items to the user at the start of your first reply in this session, as a short list, then answer their message. Items are marked done with: node pm/todo.js done <id>.`,
    },
  });
}
function cmdList(s, opt) {
  const today = ymd();
  let items = s.items.filter((x) => (opt.all ? true : x.status === "open"));
  if (opt.category) { const k = catKey(opt.category); items = items.filter((x) => x.category === k); }
  if (opt.kind) { const k = oneOf(opt.kind, KINDS, "kind"); items = items.filter((x) => x.kind === k); }
  const owner = opt.owner || "all";
  if (owner === "me") items = items.filter((x) => x.owner === "me");
  else if (owner === "waiting") items = items.filter((x) => x.owner !== "me");
  if (opt.within) { const end = addDays(today, Number(opt.within)); items = items.filter((x) => x.due && x.due <= end); }
  if (opt.priority && opt.priority !== true) { const p = oneOf(opt.priority, PRIORITIES, "priority"); items = items.filter((x) => x.priority === p); }
  if (opt.json) return JSON.stringify(items, null, 2);
  const by = opt.by || (opt.priority === true ? "priority" : "rank");
  const out = [];
  if (by === "category") {
    for (const k of Object.keys(cfg.categories)) {
      const g = rankSort(items.filter((x) => x.category === k), today);
      if (g.length) { out.push(`${label(k)} (${g.length})`); g.forEach((it) => out.push(`  ${line(it, today, { cat: false })}`)); }
    }
  } else if (by === "priority") {
    for (const p of PRIORITIES) {
      const g = rankSort(items.filter((x) => x.priority === p), today);
      if (g.length) { out.push(`${p} (${g.length})`); g.forEach((it) => out.push(`  ${line(it, today)}`)); }
    }
  } else if (by === "due") {
    items.slice().sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id).forEach((it) => out.push(line(it, today)));
  } else {
    let last = -1;
    for (const it of rankSort(items, today)) {
      const b = bucket(it, today);
      if (b !== last) { out.push(`${BUCKET_LABEL[b]}:`); last = b; }
      out.push(`  ${line(it, today)}`);
    }
  }
  return out.length ? out.join("\n") : "(no items)";
}
function cmdShow(s, pos) {
  const it = byId(s, pos[0]);
  return JSON.stringify(it, null, 2);
}
function cmdAdd(s, pos, opt) {
  const it = makeItem(s, { title: pos.join(" "), category: opt.category, kind: opt.kind, owner: opt.owner, due: opt.due, dueKind: opt["due-kind"], priority: opt.priority, notes: opt.notes }, "manual");
  return `Added ${line(it)}`;
}
function cmdEdit(s, pos, opt) {
  const it = byId(s, pos[0]);
  applyEdit(it, { title: opt.title, category: opt.category, kind: opt.kind, owner: opt.owner, due: opt.due === undefined ? undefined : opt.due, dueKind: opt["due-kind"], priority: opt.priority, notes: opt.notes });
  return `Updated ${line(it)}`;
}
function cmdClose(s, pos, opt, status) {
  if (!pos.length) throw new Error("give one or more item numbers.");
  return pos.map((id) => { const it = byId(s, id); close(it, status, "cli", opt.why); return `${status}: ${line(it)}`; }).join("\n");
}
function cmdReopen(s, pos) {
  const it = byId(s, pos[0]);
  it.status = "open"; delete it.closedAt; delete it.closedVia; delete it.closedWhy; it.updated = now();
  return `Reopened ${line(it)}`;
}
function cmdSnooze(s, pos) {
  const it = byId(s, pos[0]);
  if (!pos[1]) throw new Error("snooze <id> <due>, e.g. snooze 12 +2wd");
  it.due = parseDue(pos[1]); it.dueKind = it.dueKind || "soft"; it.updated = now();
  return `Snoozed ${line(it)}`;
}

// worker: the context it needs to start
function cmdWorkerStart(s) {
  const today = ymd();
  const first = !s.lastWorkerRun;
  const back = first ? cfg.firstRunDays || 14 : cfg.minLookBackDays || 3;
  let from = addDays(today, -back);
  if (s.lastWorkerRun && addDays(s.lastWorkerRun, -1) < from) from = addDays(s.lastWorkerRun, -1);
  const processed = Object.entries(s.meetings).filter(([, m]) => !m.date || m.date >= addDays(from, -1)).map(([id]) => id);
  // the client profiles (studies/<client>/profile.json) are the one place for a client's people and scope
  const profiles = {};
  const studies = path.join(ROOT, "studies");
  for (const d of fs.existsSync(studies) ? fs.readdirSync(studies) : []) {
    const f = path.join(studies, d, "profile.json");
    if (!fs.existsSync(f)) continue;
    try {
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      profiles[p.client] = {
        folder: d,
        file: path.relative(ROOT, f).replace(/\\/g, "/"),
        jiraProjects: p.jiraProjects || [],
        scope: { onboardingTenant: (p.scope || {}).onboardingTenant || null, version: (p.scope || {}).version || null, published: (p.scope || {}).published || null },
        people: (p.people || []).map((x) => `${x.name} (${x.side || "?"}): ${x.role}`),
        notUsed: (p.useCases || []).filter((u) => u.status !== "in-scope").map((u) => u.name),
        decisions: (p.decisions || []).map((x) => `${x.id} [${x.status}] ${x.text}`),
      };
    } catch { /* a broken profile is skipped here; insly_client_profile reports it */ }
  }
  return JSON.stringify({
    today,
    window: { from, to: today, firstRun: first },
    lookAhead: { from: today, to: addWorkingDays(today, 2) },
    me: cfg.me, meAliases: cfg.meAliases, notMe: cfg.notMe,
    categories: Object.fromEntries(Object.entries(cfg.categories).map(([k, c]) => [k, { label: c.label, project: c.project || null, match: c.match }])),
    kinds: KINDS,
    projectsWithTrackers: Object.fromEntries(Object.entries(cfg.projects).map(([k, p]) => [k, { category: p.category, file: p.tracker.file, style: p.tracker.style, heading: p.tracker.heading }])),
    clientProfiles: profiles,
    processedMeetingIds: processed,
    openItems: s.items.filter((x) => x.status === "open").map((x) => ({ id: x.id, title: x.title, category: x.category, owner: x.owner, due: x.due, dueKind: x.dueKind, priority: x.priority, kind: x.kind, key: x.key })),
  }, null, 2);
}

// worker: one meeting's (or the calendar's) items and updates
function cmdIngest(s, opt) {
  const j = readJsonStdin();
  const out = [];
  const mt = j.meeting || null;
  if (mt) {
    if (!mt.id || !mt.name || !/^\d{4}-\d{2}-\d{2}$/.test(mt.date || "")) throw new Error("meeting: id, name and date (YYYY-MM-DD) are required.");
    if (s.meetings[mt.id] && !opt.again) throw new Error(`meeting ${mt.id} was already processed on ${s.meetings[mt.id].processedAt} - add --again to process it again.`);
  }
  const added = [];
  for (const f of j.items || []) {
    if (!f.key) { out.push(`skipped (no key): ${clean(f.title)}`); continue; }
    const dup = s.items.find((x) => x.key === f.key);
    if (dup) { out.push(`skipped (already #${dup.id}, ${dup.status}): ${clean(f.title)}`); continue; }
    try {
      const source = mt ? { type: "meeting", id: mt.id, name: mt.name, date: mt.date, at: f.at || undefined } : { type: j.source || "worker" };
      const it = makeItem(s, { ...f, source }, "worker");
      added.push(it.id);
      out.push(`added ${line(it)}`);
    } catch (e) { out.push(`not added ("${clean(f.title)}"): ${e.message}`); }
  }
  for (const u of j.updates || []) {
    try {
      const it = byId(s, u.id);
      if (u.done) {
        if (it.status !== "open") { out.push(`#${it.id} already ${it.status}`); continue; }
        close(it, "done", mt ? `worker: ${mt.name} ${mt.date}` : "worker", u.why);
        s.log.push({ at: now(), type: "autodone", id: it.id, text: `#${it.id} ${it.title} - ${clean(u.why || "")}` });
        out.push(`done ${line(it)}`);
      } else {
        applyEdit(it, { due: u.due, dueKind: u.dueKind, priority: u.priority, notes: u.notes, owner: u.owner, title: u.title });
        s.log.push({ at: now(), type: "update", id: it.id, text: `#${it.id} ${it.title}${u.due ? ` - due ${u.due}` : ""}${u.notes ? ` - ${clean(u.notes)}` : ""}` });
        out.push(`updated ${line(it)}`);
      }
    } catch (e) { out.push(`update failed (#${u.id}): ${e.message}`); }
  }
  if (mt) {
    s.meetings[mt.id] = { name: mt.name, date: mt.date, minutes: mt.minutes || null, language: mt.language || null, processedAt: now(), items: added };
    s.log.push({ at: now(), type: "meeting", text: `${mt.date} ${mt.name}: ${added.length} new item(s)` });
  }
  return out.length ? out.join("\n") : "nothing to add";
}

// worker: a meeting block into a project's tracker
function cmdTracker(s, opt) {
  const p = cfg.projects[String(opt.project || "").toUpperCase()];
  if (!p) throw new Error(`project: one of ${Object.keys(cfg.projects).join(", ")}.`);
  if (!opt.meeting) throw new Error("--meeting <Circleback meeting id> is required.");
  if (opt.skip) return `skipped: meeting ${opt.meeting} is already in ${p.tracker.file} (input file removed).`;
  const block = readStdin().replace(/—/g, " - ").replace(/\s+$/, "");
  if (!block) throw new Error("expected the tracker block on stdin.");
  if (!block.includes(opt.meeting)) throw new Error("the block must name the meeting id (it keeps the tracker from getting the same meeting twice).");
  const file = path.join(ROOT, p.tracker.file);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(opt.meeting)) return `${p.tracker.file} already has meeting ${opt.meeting} - not added.`;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  // a block written by hand for the same day carries no meeting id: it may be this meeting - the worker compares and
  // passes --also only for a different meeting
  const day = (block.split(/\r?\n/)[0].match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
  const sameDay = day ? lines.filter((l) => /^#{2,3} /.test(l) && l.includes(day) && !/`[A-Za-z0-9_-]{15,}`/.test(l)) : [];
  if (sameDay.length && !opt.also) {
    throw new Error(`NOT ADDED: ${p.tracker.file} already has a block for ${day} without a meeting id:\n${sameDay.map((l) => `  ${l}`).join("\n")}\n` +
      `If that is this meeting, skip it (leave the input file). If it is a different meeting, run the same command with --also.`);
  }
  const anchor = new RegExp(p.tracker.anchor);
  const blockLines = block.split(/\r?\n/);
  let at;
  if (p.tracker.style === "top-of-section") {
    const i = lines.findIndex((l) => anchor.test(l));
    if (i < 0) throw new Error(`${p.tracker.file}: no line matches ${p.tracker.anchor}.`);
    at = i + 1;
    while (at < lines.length && lines[at].trim() === "") at++;
    lines.splice(at, 0, ...blockLines, "");
  } else {
    // after the section of the newest dated block up to this one's date (the file is not always in date order)
    const dateOf = (l) => (l.match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
    const mine = dateOf(blockLines[0]) || ymd();
    let last = -1;
    let lastDate = "";
    lines.forEach((l, i) => {
      if (!anchor.test(l)) return;
      const d = dateOf(l);
      if (d <= mine && d >= lastDate) { last = i; lastDate = d; }
    });
    if (last < 0) at = lines.length;
    else { at = lines.findIndex((l, i) => i > last && /^## /.test(l)); if (at < 0) at = lines.length; }
    while (at > 0 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, "", ...blockLines);
  }
  fs.writeFileSync(file, lines.join(nl).replace(/(\r?\n){3,}/g, nl + nl));
  const title = blockLines[0].replace(/^#+\s*/, "");
  s.log.push({ at: now(), type: "tracker", text: `${p.tracker.file}: ${title}` });
  return `Added to ${p.tracker.file}: ${title}`;
}

// worker: a planned go-live date agreed in a meeting (never liveFrom - that is the user's call)
function cmdGolive(s, opt) {
  const key = String(opt.project || "").toUpperCase();
  const p = cfg.projects[key];
  if (!p) throw new Error(`project: one of ${Object.keys(cfg.projects).join(", ")}.`);
  const planned = parseDue(opt.planned);
  if (!planned) throw new Error("--planned YYYY-MM-DD is required.");
  if (!opt.meeting || !opt.note) throw new Error("--meeting <name and date> and --note <what was agreed> are required.");
  const cr = require(path.join(ROOT, "mcp-server", "src", "change-record.js"));
  const cur = (cr.readProjects() || []).find((x) => x.project === key);
  if (cur && cur.live) return `${key} is already live - planned go-live not changed.`;
  if (cur && cur.plannedGoLive === planned) return `${key} planned go-live is already ${planned}.`;
  const was = cur && cur.plannedGoLive;
  cr.setProjectStatus({ project: key, live: false, plannedGoLive: planned, by: cfg.me, note: `${clean(opt.note)} (${clean(opt.meeting)}; morning worker)` });
  if (p.memoryNote && !process.env.PM_NO_MEMORY && fs.existsSync(p.memoryNote)) {
    fs.appendFileSync(p.memoryNote, `\n**${ymd()} (morning worker, ${clean(opt.meeting)}): planned go-live ${planned}${was ? ` (was ${was})` : ""}.** ${clean(opt.note)}\n`);
  }
  const text = `${key} planned go-live ${was || "(none)"} -> ${planned}: project status${p.memoryNote ? ", memory note" : ""}`;
  s.log.push({ at: now(), type: "golive", text });
  return text;
}

// client profiles (studies/<folder>/profile.json): the worker proposes decisions, the user agrees or drops them
function profileFile(client) {
  const studies = path.join(ROOT, "studies");
  const want = String(client || "").trim().toLowerCase();
  for (const d of fs.existsSync(studies) ? fs.readdirSync(studies) : []) {
    const f = path.join(studies, d, "profile.json");
    if (!fs.existsSync(f)) continue;
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    const names = [d, p.client, ...(p.aliases || []), ...(p.tenants || []), ...(p.jiraProjects || [])].map((x) => String(x).toLowerCase());
    if (names.includes(want)) return { f, p };
  }
  throw new Error(`no client profile for "${client}" in studies/.`);
}
function writeProfile(f, p) {
  p.updated = ymd();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  fs.renameSync(tmp, f);
}
function cmdPropose(s, opt) {
  const { f, p } = profileFile(opt.client);
  const j = readJsonStdin();
  const text = clean(j.text);
  if (!text || !j.source || !/^\d{4}-\d{2}-\d{2}$/.test(j.date || "")) throw new Error("propose: JSON with text, date (YYYY-MM-DD) and source.");
  p.decisions = p.decisions || [];
  if (p.decisions.some((d) => clean(d.text).toLowerCase() === text.toLowerCase())) return `${p.client}: already in the profile - not added.`;
  const n = p.decisions.reduce((m, d) => Math.max(m, Number(String(d.id).replace(/\D/g, "")) || 0), 0) + 1;
  const kinds = ["scope-detail", "change-request", "operational"];
  if (!kinds.includes(j.kind)) throw new Error(`propose: kind is one of ${kinds.join(", ")}.`);
  const d = { id: `D${n}`, date: j.date, text, status: "proposed", kind: j.kind, source: clean(j.source), proposedBy: "morning worker", ...(j.scopeUpdate && j.kind === "scope-detail" ? { scopeUpdate: clean(j.scopeUpdate) } : {}) };
  p.decisions.push(d);
  writeProfile(f, p);
  s.log.push({ at: now(), type: "profile", text: `${p.client} ${d.id} (proposed): ${text} - agree: node pm/todo.js decision --client ${opt.client} ${d.id} agree | drop` });
  return `${p.client}: proposed ${d.id}`;
}
function cmdDecision(s, pos, opt) {
  const { f, p } = profileFile(opt.client);
  const [id, what] = pos;
  const d = (p.decisions || []).find((x) => x.id === id);
  if (!d) throw new Error(`${p.client}: no decision ${id}.`);
  if (what === "agree") {
    d.status = "agreed";
    d.by = opt.by || cfg.me;
    delete d.proposedBy;
  } else if (what === "open") d.status = "open";
  else if (what === "drop") {
    const used = (p.useCases || []).filter((u) => u.decision === id || (u.decisions || []).includes(id)).map((u) => u.id);
    if (used.length) throw new Error(`${id} is referenced by ${used.join(", ")} - change those use cases first.`);
    p.decisions = p.decisions.filter((x) => x !== d);
  } else throw new Error("decision --client <client> <id> agree | open | drop");
  writeProfile(f, p);
  return `${p.client} ${id}: ${what === "drop" ? "dropped" : d.status}`;
}
function cmdNote(s, pos, opt) {
  const text = clean(pos.join(" ") || readStdin());
  if (!text) throw new Error("note: the text.");
  s.log.push({ at: now(), type: "note", kind: opt.type || "note", text });
  return "noted";
}

// worker: today's and the coming days' meetings, with what to prepare
function cmdAgenda(s) {
  const j = readJsonStdin();
  const events = (Array.isArray(j) ? j : j.events || []).map((e) => ({ date: e.date, start: e.start || "", name: clean(e.name), prep: e.prep ? clean(e.prep) : "" }));
  s.agenda = { at: ymd(), events: events.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)) };
  return `${events.length} meeting(s) on the agenda`;
}

function cmdBrief(s, opt) {
  const today = ymd();
  const since = s.lastBrief ? s.lastBrief.at : null;
  const out = [`# Morning brief - ${pretty(today)} ${today.slice(0, 4)}`, ""];
  const top = topItems(s, cfg.topN || 5, today);
  out.push(`## Top ${cfg.topN || 5}`, "");
  if (top.length) top.forEach((it, i) => out.push(`${i + 1}. ${line(it, today)}`)); else out.push("Nothing due in the near future.");
  out.push("");
  if (s.agenda && s.agenda.at === today && s.agenda.events.length) {
    out.push("## Meetings ahead", "");
    s.agenda.events.forEach((e) => out.push(`- ${pretty(e.date)} ${e.start} ${e.name}${e.prep ? ` - prep: ${e.prep}` : ""}`));
    out.push("");
  }
  const fresh = s.items.filter((x) => (!since || x.created > since) && x.status === "open");
  if (fresh.length) {
    out.push(`## New since the last brief (${fresh.length})`, "");
    rankSort(fresh, today).forEach((it) => out.push(`- ${line(it, today)}${it.source && it.source.name ? ` (from: ${it.source.name}, ${it.source.date})` : ""}`));
    out.push("");
  }
  const logSince = s.log.filter((l) => !since || l.at > since);
  const auto = logSince.filter((l) => l.type === "autodone");
  if (auto.length) { out.push("## Closed by the worker (from transcripts - reopen with `node pm/todo.js reopen <id>`)", ""); auto.forEach((l) => out.push(`- ${l.text}`)); out.push(""); }
  const ups = logSince.filter((l) => l.type === "update");
  if (ups.length) { out.push("## Changed by the worker", ""); ups.forEach((l) => out.push(`- ${l.text}`)); out.push(""); }
  const w = rankSort(openWaiting(s), today).filter((x) => bucket(x, today) <= 2);
  if (w.length) { out.push("## Waiting on others - due or overdue", ""); w.forEach((it) => out.push(`- ${line(it, today)}`)); out.push(""); }
  const notes = logSince.filter((l) => l.type === "note");
  if (notes.length) { out.push("## Notes", ""); notes.forEach((l) => out.push(`- ${l.kind && l.kind !== "note" ? `[${l.kind}] ` : ""}${l.text}`)); out.push(""); }
  const prof = logSince.filter((l) => l.type === "profile");
  if (prof.length) { out.push("## For the client profiles - agree or drop", ""); prof.forEach((l) => out.push(`- ${l.text}`)); out.push(""); }
  const tr = logSince.filter((l) => l.type === "tracker" || l.type === "golive");
  if (tr.length) { out.push("## Trackers and go-live", ""); tr.forEach((l) => out.push(`- ${l.text}`)); out.push(""); }
  const mts = logSince.filter((l) => l.type === "meeting");
  if (mts.length) { out.push(`## Meetings read (${mts.length})`, ""); mts.forEach((l) => out.push(`- ${l.text}`)); out.push(""); }
  const mine = openMine(s);
  out.push(`Open: ${mine.length} mine (${mine.filter((x) => bucket(x, today) === 0).length} overdue), ${openWaiting(s).length} waiting on others. List: pm/TODO.md or \`node pm/todo.js list --by category\`.`);
  const text = out.join("\n");
  if (!opt["no-save"]) {
    fs.mkdirSync(BRIEFS, { recursive: true });
    fs.writeFileSync(path.join(BRIEFS, `${today}.md`), text + "\n");
    s.lastBrief = { at: now(), date: today };
    if (opt.worker) s.lastWorkerRun = today;
  }
  return text;
}

// ---- Jira: open tickets assigned to me (read-only) ----
// Adds a ticket that isn't on the list yet (key "jira:<KEY>", or an item whose title names the key is adopted),
// closes an item whose ticket is done, notes a status, assignee or due-date change. Waiting statuses (Ready for Demo,
// In QA, ...) go under waiting on others. Settings: config.json "jira".
const JIRA_DEFAULTS = {
  jql: "assignee = currentUser() AND statusCategory != Done AND issuetype != Epic ORDER BY updated DESC",
  waitingStatuses: ["Ready for Demo", "In QA", "Waiting for Q/A", "Estimated/Needs approval", "On Hold", "Waiting for customer"],
  reviewStatuses: ["Analysis", "Needs estimation"],
  highPriorities: ["Highest", "High", "Critical", "Blocker"],
  ignoreKeys: [],
  projectCategories: {},
};
async function jiraSearch(jc, jql, fields) {
  const jw = require(path.join(ROOT, "jira-scan", "jira-write.js"));
  const conf = jw.loadConfig();
  const auth = Buffer.from(`${conf.email}:${conf.apiToken}`).toString("base64");
  const out = [];
  let token;
  for (let page = 0; page < 10; page++) {
    const p = new URLSearchParams({ jql, fields: fields.join(","), maxResults: "100" });
    if (token) p.set("nextPageToken", token);
    const res = await fetch(`https://${conf.domain}/rest/api/3/search/jql?${p}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const d = await res.json();
    out.push(...(d.issues || []).map((i) => ({
      key: i.key,
      url: `https://${conf.domain}/browse/${i.key}`,
      summary: i.fields.summary,
      status: i.fields.status && i.fields.status.name,
      done: !!(i.fields.status && i.fields.status.statusCategory && i.fields.status.statusCategory.key === "done"),
      priority: i.fields.priority && i.fields.priority.name,
      assignee: i.fields.assignee ? i.fields.assignee.displayName : null,
      due: i.fields.duedate || null,
      project: i.key.split("-")[0],
    })));
    if (d.isLast || !d.nextPageToken) break;
    token = d.nextPageToken;
  }
  return out;
}
async function cmdJira(s, opt) {
  const jc = { ...JIRA_DEFAULTS, ...(cfg.jira || {}) };
  const fields = ["summary", "status", "priority", "assignee", "duedate"];
  const has = (list, v) => list.some((x) => x.toLowerCase() === String(v || "").toLowerCase());
  const keyRe = (k) => new RegExp(`(^|[^A-Za-z0-9-])${k.replace("-", "\\-")}(?![0-9])`);
  const ownerFor = (t) => (has(jc.waitingStatuses, t.status) ? `waiting:Jira ${t.status}` : "me");
  const catFor = (t) => {
    if (jc.projectCategories[t.project]) return jc.projectCategories[t.project];
    const hit = Object.entries(cfg.categories).find(([, c]) => c.project === t.project);
    if (hit) return hit[0];
    const byName = Object.entries(cfg.categories).find(([, c]) => (c.match || []).some((m) => new RegExp(m, "i").test(t.summary || "")));
    return byName ? byName[0] : "other";
  };
  // a Jira due date already past when the ticket is first seen is stale (the ticket ran on): kept in the note only
  const usableDue = (t) => (t.due && t.due >= ymd() ? t.due : null);
  const snap = (t) => ({ status: t.status, assignee: t.assignee, due: t.due, priority: t.priority });
  const mine = (await jiraSearch(jc, jc.jql, fields)).filter((t) => !jc.ignoreKeys.includes(t.key));
  const out = [];
  const dry = !!opt["dry-run"];
  const seen = new Set();
  for (const t of mine) {
    seen.add(t.key);
    let it = s.items.find((x) => x.key === `jira:${t.key}`);
    if (!it) {
      it = s.items.find((x) => !x.key && keyRe(t.key).test(x.title)) || s.items.find((x) => x.key && !x.key.startsWith("jira:") && keyRe(t.key).test(x.title) && x.status === "open");
      if (it) {
        out.push(`linked #${it.id} to ${t.key} (title names it)`);
        if (!dry) { if (!it.key) it.key = `jira:${t.key}`; it.jira = snap(t); }
        continue;
      }
      const f = {
        title: `${t.key}: ${t.summary}`,
        category: catFor(t),
        kind: has(jc.reviewStatuses, t.status) ? "review" : /q\/?a|test/i.test(t.status || "") ? "test" : "complete",
        owner: ownerFor(t),
        due: usableDue(t),
        dueKind: usableDue(t) ? "agreed" : undefined,
        priority: has(jc.highPriorities, t.priority) ? "high" : "normal",
        notes: `Jira: ${t.status}, ${t.priority}${t.due && !usableDue(t) ? `, Jira due date ${t.due} (passed)` : ""} - ${t.url}`,
        key: `jira:${t.key}`,
        source: { type: "jira", name: `${t.key} (${t.status})`, date: ymd() },
      };
      if (dry) { out.push(`would add: ${f.title} [${label(f.category)}, ${f.owner === "me" ? "mine" : f.owner}${f.priority === "high" ? ", high" : ""}${f.due ? `, due ${f.due}` : ""}]`); continue; }
      const added = makeItem(s, f, "jira");
      added.jira = snap(t);
      s.log.push({ at: now(), type: "jira", id: added.id, text: `added #${added.id} ${added.title}` });
      out.push(`added ${line(added)}`);
      continue;
    }
    const prev = it.jira || {};
    const changes = [];
    if (prev.status && prev.status !== t.status) changes.push(`status ${prev.status} -> ${t.status}`);
    if ((prev.due || null) !== (t.due || null)) changes.push(`due ${prev.due || "none"} -> ${t.due || "none"}`);
    if (it.status !== "open") { if (!dry) it.jira = snap(t); continue; }
    if (!changes.length) { if (!dry) it.jira = snap(t); continue; }
    out.push(`${dry ? "would update" : "updated"} #${it.id} ${t.key}: ${changes.join(", ")}`);
    if (dry) continue;
    applyEdit(it, { notes: `Jira ${ymd()}: ${changes.join(", ")}`, due: (prev.due || null) !== (t.due || null) && usableDue(t) ? t.due : undefined, owner: prev.status !== t.status ? ownerFor(t) : undefined });
    it.jira = snap(t);
    s.log.push({ at: now(), type: "update", id: it.id, text: `#${it.id} ${it.title} - Jira: ${changes.join(", ")}` });
  }
  // tracked tickets that dropped out of the search: done, or no longer mine
  const gone = s.items.filter((x) => x.status === "open" && x.key && x.key.startsWith("jira:") && !seen.has(x.key.slice(5)));
  if (gone.length) {
    const keys = gone.map((x) => x.key.slice(5));
    const found = await jiraSearch(jc, `key in (${keys.join(",")})`, fields).catch((e) => { out.push(`could not check ${keys.join(", ")}: ${e.message}`); return []; });
    for (const it of gone) {
      const t = found.find((x) => x.key === it.key.slice(5));
      if (!t) continue;
      if (t.done) {
        out.push(`${dry ? "would close" : "closed"} #${it.id} ${t.key}: Jira ${t.status}`);
        if (!dry) { close(it, "done", "jira", `Jira: ${t.status}`); it.jira = snap(t); s.log.push({ at: now(), type: "autodone", id: it.id, text: `#${it.id} ${it.title} - Jira: ${t.status}` }); }
      } else if ((it.jira || {}).assignee !== t.assignee) {
        out.push(`${dry ? "would note" : "noted"} #${it.id} ${t.key}: now assigned to ${t.assignee || "nobody"} (left open - drop it if it is not yours any more)`);
        if (!dry) { applyEdit(it, { notes: `Jira ${ymd()}: assigned to ${t.assignee || "nobody"}` }); it.jira = snap(t); s.log.push({ at: now(), type: "update", id: it.id, text: `#${it.id} ${it.title} - Jira: assigned to ${t.assignee || "nobody"}` }); }
      }
    }
  }
  if (!dry) s.lastJiraRun = now();
  return `Jira: ${mine.length} open ticket(s) assigned to me.\n${out.length ? out.join("\n") : "nothing new"}`;
}

const HELP = `node pm/todo.js                        top ${cfg.topN || 5} (due today, overdue, near future, high priority)
node pm/todo.js list [--category c] [--kind k] [--owner me|waiting] [--priority [high]] [--within 7]
                     [--by rank|category|priority|due] [--all] [--json]
node pm/todo.js add "text" [--category c] [--due 2026-11-03|today|fri|+2d|+2wd] [--priority high]
                     [--kind k] [--owner waiting:Name] [--notes "..."]
node pm/todo.js done <id...> | drop <id...> [--why "..."] | reopen <id> | snooze <id> <due>
node pm/todo.js edit <id> [--title|--category|--due|--priority|--kind|--owner|--notes ...]
node pm/todo.js show <id> | brief [--no-save]
node pm/todo.js jira [--dry-run]       open Jira tickets assigned to me onto the list (read-only Jira)
Client profiles: decision --client <client> <id> agree|open|drop   (proposed decisions from the worker)
Worker only: worker-start | ingest | tracker --project P --meeting ID | golive --project P --planned D
             --meeting "..." --note "..." | agenda | propose --client C | note [--type scope] "..." | brief --worker
Categories: ${Object.keys(cfg.categories).join(", ")}. Kinds: ${KINDS.join(", ")}.
pm/TODO.md: tick [x] = done, [-] = drop, new "- [ ] text" lines are added; read back on every run.`;

async function main() {
  const [cmd = "top", ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (cmd === "help" || cmd === "--help") { console.log(HELP); return; }
  const s = load();
  const synced = syncTodoMd(s);
  const run = {
    top: () => cmdTop(s, opt), list: () => cmdList(s, opt), show: () => cmdShow(s, pos), add: () => cmdAdd(s, pos, opt),
    edit: () => cmdEdit(s, pos, opt), done: () => cmdClose(s, pos, opt, "done"), drop: () => cmdClose(s, pos, opt, "dropped"),
    reopen: () => cmdReopen(s, pos), snooze: () => cmdSnooze(s, pos), "worker-start": () => cmdWorkerStart(s),
    ingest: () => cmdIngest(s, opt), tracker: () => cmdTracker(s, opt), golive: () => cmdGolive(s, opt),
    agenda: () => cmdAgenda(s), brief: () => cmdBrief(s, opt),
    propose: () => cmdPropose(s, opt), decision: () => cmdDecision(s, pos, opt), note: () => cmdNote(s, pos, opt),
    jira: () => cmdJira(s, opt),
  }[cmd];
  if (!run) throw new Error(`unknown command "${cmd}".\n${HELP}`);
  setInputFile(opt.file);
  const result = await run();
  if (!(cmd === "jira" && opt["dry-run"])) save(s);
  if (inputFile) fs.rmSync(inputFile, { force: true });
  if (synced.length) console.log(`From TODO.md: ${synced.join("; ")}\n`);
  console.log(result);
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
