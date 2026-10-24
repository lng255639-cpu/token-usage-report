#!/usr/bin/env node
// 掃 ~/.claude/projects 底下的對話紀錄（*.jsonl），統計最近一段時間 token 花在哪裡。
// 用法：node token_report.mjs [--days 7] [--hours N] [--project 關鍵字] [--top 10] [--json]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const opt = { days: 7, hours: null, project: null, top: 10, json: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--days") opt.days = Number(args[++i]);
  else if (a === "--hours") opt.hours = Number(args[++i]);
  else if (a === "--project") opt.project = String(args[++i]).toLowerCase();
  else if (a === "--top") opt.top = Number(args[++i]);
  else if (a === "--json") opt.json = true;
}
const windowMs = opt.hours ? opt.hours * 3600e3 : opt.days * 86400e3;
const since = Date.now() - windowMs;
const root = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects")
  : path.join(os.homedir(), ".claude", "projects");

// 加權：以「一般 input token」為 1 單位，照 Anthropic 計價比例換算，方便比較誰真的貴。
const W = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 };

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// 粗估文字的 token 數：英數約 4 字元 1 token，中日韓等非 ASCII 約 1 字 1 token。
function estTokens(v) {
  if (v == null) return 0;
  if (typeof v === "string") {
    let ascii = 0, other = 0;
    for (const ch of v) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
    return Math.round(ascii / 4 + other);
  }
  if (Array.isArray(v)) return v.reduce((s, x) => s + estTokens(x), 0);
  if (typeof v === "object") {
    if (v.type === "image") return 1600;
    if (v.type === "text") return estTokens(v.text);
    if (v.type === "tool_reference") return 50;
    return estTokens(JSON.stringify(v));
  }
  return estTokens(String(v));
}

function toolLabel(name, input) {
  if (name === "Skill" && input?.skill) return `Skill:${input.skill}`;
  if ((name === "Agent" || name === "Task") && input?.subagent_type) return `${name}:${input.subagent_type}`;
  if (name?.startsWith("mcp__")) {
    const parts = name.split("__");
    return `mcp:${parts[1]}/${parts.slice(2).join("__")}`;
  }
  return name || "?";
}

const blank = () => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, weighted: 0 });
const bump = (map, key, u) => {
  const r = map.get(key) || blank();
  r.calls++;
  r.input += u.input; r.cacheWrite += u.cacheWrite; r.cacheRead += u.cacheRead; r.output += u.output; r.weighted += u.weighted;
  map.set(key, r);
};

const byProject = new Map(), bySession = new Map(), byModel = new Map(), byDay = new Map(), byKind = new Map();
const tools = new Map(); // label -> { calls, resultTok, inputTok }
const hooks = new Map(); // hook name -> { count, tok }
const sessions = new Map(); // sessionId -> { title, firstPrompt, project, start, end }
const turns = [];
const totals = blank();
let filesScanned = 0;

const files = walk(root).filter(f => { try { return fs.statSync(f).mtimeMs >= since; } catch { return false; } });

for (const file of files) {
  filesScanned++;
  const isSubFile = /[\\/]subagents[\\/]/.test(file);
  const msgs = new Map(); // message.id -> 最後一筆（串流時同一則訊息會寫成多行）
  const toolUse = new Map(); // tool_use id -> label
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const sid = o.sessionId || path.basename(file, ".jsonl");
    const s = sessions.get(sid) || { title: null, firstPrompt: null, project: null };
    sessions.set(sid, s);
    if (o.type === "custom-title" && (o.customTitle || o.title)) s.title = o.customTitle || o.title;
    if (o.type === "summary" && o.summary && !s.title) s.title = o.summary;
    if (o.cwd && !s.project) s.project = o.cwd;

    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!(ts >= since)) continue;

    if (o.type === "assistant" && o.message?.usage) {
      const id = o.message.id || o.requestId || o.uuid;
      const prev = msgs.get(id);
      const content = [...(prev?.content || []), ...(Array.isArray(o.message.content) ? o.message.content : [])];
      msgs.set(id, { o, ts, sid, content, sidechain: isSubFile || o.isSidechain === true || !!o.agentId });
      for (const c of Array.isArray(o.message.content) ? o.message.content : []) {
        if (c.type === "tool_use") {
          const label = toolLabel(c.name, c.input);
          toolUse.set(c.id, label);
          const t = tools.get(label) || { calls: 0, resultTok: 0, inputTok: 0 };
          t.calls++; t.inputTok += estTokens(JSON.stringify(c.input ?? ""));
          tools.set(label, t);
        }
      }
    } else if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === "tool_result") {
          const label = toolUse.get(c.tool_use_id) || "(未知工具)";
          const t = tools.get(label) || { calls: 0, resultTok: 0, inputTok: 0 };
          t.resultTok += estTokens(c.content);
          tools.set(label, t);
        } else if (c.type === "text" && !s.firstPrompt && !o.isMeta) {
          s.firstPrompt = c.text;
        }
      }
    } else if (o.type === "user" && typeof o.message?.content === "string" && !s.firstPrompt && !o.isMeta) {
      s.firstPrompt = o.message.content;
    } else if (o.type === "attachment" && o.attachment) {
      const a = o.attachment;
      const name = a.hookName || a.type || "attachment";
      const tok = estTokens(a.content) + estTokens(a.stdout);
      if (tok > 0) {
        const h = hooks.get(name) || { count: 0, tok: 0 };
        h.count++; h.tok += tok; hooks.set(name, h);
      }
    }
  }

  for (const { o, ts, sid, content, sidechain } of msgs.values()) {
    const u0 = o.message.usage;
    const cw1h = u0.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cwAll = u0.cache_creation_input_tokens ?? 0;
    const u = {
      input: u0.input_tokens ?? 0,
      cacheWrite: cwAll,
      cacheRead: u0.cache_read_input_tokens ?? 0,
      output: u0.output_tokens ?? 0,
    };
    u.weighted = u.input * W.input + (cwAll - cw1h) * W.cacheWrite5m + cw1h * W.cacheWrite1h
      + u.cacheRead * W.cacheRead + u.output * W.output;
    const s = sessions.get(sid);
    const proj = o.cwd || s?.project || "(未知)";
    if (opt.project && !proj.toLowerCase().includes(opt.project)) continue;
    const model = o.message.model || "?";
    if (model === "<synthetic>") continue;
    s.start = Math.min(s.start ?? ts, ts); s.end = Math.max(s.end ?? ts, ts);
    totals.calls++; for (const k of ["input", "cacheWrite", "cacheRead", "output", "weighted"]) totals[k] += u[k];
    bump(byProject, proj, u);
    bump(bySession, sid, u);
    bump(byModel, model, u);
    bump(byDay, new Date(ts).toLocaleDateString("sv-SE"), u);
    bump(byKind, sidechain ? "子代理 (subagent)" : "主對話", u);
    const toolsHere = content.filter(c => c.type === "tool_use").map(c => toolLabel(c.name, c.input));
    // 快取重建：一次寫入大量快取、卻幾乎沒讀到舊快取（閒置超過快取時效、compact、換模型、新對話第一輪）
    const rebuild = u.cacheWrite >= 30000 && u.cacheRead < u.cacheWrite * 0.2;
    turns.push({ ts, sid, model, ...u, tools: toolsHere, rebuild });
  }
}

const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
const pct = n => totals.weighted ? (100 * n / totals.weighted).toFixed(1) + "%" : "-";
const short = (t, n = 40) => { t = (t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const projName = p => short(path.basename(p) || p, 36);
const sessName = sid => {
  const s = sessions.get(sid) || {};
  return short(s.title || s.firstPrompt || sid.slice(0, 8), 40);
};
const sortW = m => [...m.entries()].sort((a, b) => b[1].weighted - a[1].weighted);

if (opt.json) {
  const obj = m => Object.fromEntries(sortW(m));
  console.log(JSON.stringify({
    since: new Date(since).toISOString(), filesScanned, weights: W, totals,
    byKind: obj(byKind), byModel: obj(byModel), byDay: obj(byDay), byProject: obj(byProject),
    bySession: sortW(bySession).map(([sid, r]) => ({ sid, name: sessName(sid), project: sessions.get(sid)?.project, ...r })),
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1].resultTok - a[1].resultTok)),
    hooks: Object.fromEntries([...hooks.entries()].sort((a, b) => b[1].tok - a[1].tok)),
    topTurns: turns.sort((a, b) => b.weighted - a.weighted).slice(0, opt.top),
  }, null, 2));
  process.exit(0);
}

const out = [];
const head = "| 項目 | 呼叫 | input | 快取寫入 | 快取讀取 | output | 加權量 | 佔比 |\n|---|---:|---:|---:|---:|---:|---:|---:|";
const row = (name, r) => `| ${name} | ${r.calls} | ${fmt(r.input)} | ${fmt(r.cacheWrite)} | ${fmt(r.cacheRead)} | ${fmt(r.output)} | ${fmt(r.weighted)} | ${pct(r.weighted)} |`;
const table = (title, entries, nameFn, limit = opt.top) => {
  out.push(`\n## ${title}\n`, head);
  for (const [k, r] of entries.slice(0, limit)) out.push(row(nameFn(k), r));
  if (entries.length > limit) out.push(`| …另外 ${entries.length - limit} 項 | | | | | | | |`);
};

const label = opt.hours ? `最近 ${opt.hours} 小時` : `最近 ${opt.days} 天`;
out.push(`# Token 去向報告（${label}，${new Date(since).toLocaleString("sv-SE")} 起）`);
out.push(`\n掃描 ${filesScanned} 個對話檔、${totals.calls} 次 API 呼叫${opt.project ? `，只看專案含「${opt.project}」` : ""}。`);
out.push(`\n**總計**：input ${fmt(totals.input)}、快取寫入 ${fmt(totals.cacheWrite)}、快取讀取 ${fmt(totals.cacheRead)}、output ${fmt(totals.output)}；加權量 ${fmt(totals.weighted)}`);
out.push(`\n> 加權量 = input×1 + 快取寫入×1.25（1 小時快取×2）+ 快取讀取×0.1 + output×5，代表相對花費，不是金額。`);

table("主對話 vs 子代理", sortW(byKind), k => k);
table("依模型", sortW(byModel), k => k);
table("依日期", [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])), k => k, 60);
table("依專案資料夾", sortW(byProject), projName);
table("依對話（最貴的幾個）", sortW(bySession), sid => `${sessName(sid)}<br><sub>${projName(sessions.get(sid)?.project || "")}</sub>`);

out.push(`\n## 工具帶進上下文的量（估算）\n`);
out.push("工具結果會被塞回上下文，之後每一輪都會被重讀（變成快取讀取）。結果越大、越早出現，累積成本越高。\n");
out.push("| 工具 | 次數 | 結果總量(估) | 平均每次 | 參數量(估) |\n|---|---:|---:|---:|---:|");
const toolRows = [...tools.entries()].sort((a, b) => b[1].resultTok - a[1].resultTok);
for (const [k, t] of toolRows.slice(0, opt.top + 5)) out.push(`| ${k} | ${t.calls} | ${fmt(t.resultTok)} | ${fmt(t.calls ? t.resultTok / t.calls : 0)} | ${fmt(t.inputTok)} |`);

const hookRows = [...hooks.entries()].sort((a, b) => b[1].tok - a[1].tok);
if (hookRows.length) {
  out.push(`\n## Hook／附件注入（估算）\n`);
  out.push("| 來源 | 次數 | 總量(估) |\n|---|---:|---:|");
  for (const [k, h] of hookRows.slice(0, opt.top)) out.push(`| ${short(k, 50)} | ${h.count} | ${fmt(h.tok)} |`);
}

const rebuilds = turns.filter(t => t.rebuild);
const rbW = rebuilds.reduce((s, t) => s + t.weighted, 0);
out.push(`\n## 快取重建\n`);
out.push(`${rebuilds.length} 次呼叫幾乎整段上下文重新寫入快取，加權量 ${fmt(rbW)}（${pct(rbW)}）。常見原因：對話閒置超過快取時效後再回來、/compact、中途換模型、新對話第一輪。上下文越長，每次重建越貴。\n`);
const rbBySess = new Map();
for (const t of rebuilds) { const r = rbBySess.get(t.sid) || { n: 0, w: 0, max: 0 }; r.n++; r.w += t.weighted; r.max = Math.max(r.max, t.cacheWrite); rbBySess.set(t.sid, r); }
if (rbBySess.size) {
  out.push("| 對話 | 重建次數 | 加權量 | 最大一次寫入 |\n|---|---:|---:|---:|");
  for (const [sid, r] of [...rbBySess.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, opt.top)) out.push(`| ${sessName(sid)} | ${r.n} | ${fmt(r.w)} | ${fmt(r.max)} |`);
}

out.push(`\n## 單次最貴的 API 呼叫\n`);
out.push("| 時間 | 對話 | 模型 | 快取寫入 | 快取讀取 | output | 加權量 | 重建? | 這輪呼叫的工具 |\n|---|---|---|---:|---:|---:|---:|---|---|");
for (const t of turns.sort((a, b) => b.weighted - a.weighted).slice(0, opt.top)) {
  out.push(`| ${new Date(t.ts).toLocaleString("sv-SE").slice(5, 16)} | ${sessName(t.sid)} | ${t.model} | ${fmt(t.cacheWrite)} | ${fmt(t.cacheRead)} | ${fmt(t.output)} | ${fmt(t.weighted)} | ${t.rebuild ? "是" : ""} | ${short(t.tools.join(", "), 50)} |`);
}

console.log(out.join("\n"));
