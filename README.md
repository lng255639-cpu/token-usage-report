# token-usage-report 使用說明

額度用得很快，卻不知道 token 花到哪去了？這個 skill 會掃一遍電腦裡的 Claude Code 對話紀錄，把最近的 token 用量依專案、對話、模型、日期、工具拆開，找出最耗的地方，再告訴你可以怎麼省。**只讀紀錄，不會改任何檔案，也不會傳到任何地方。**

English version: [token-usage-report-en](https://github.com/lng255639-cpu/token-usage-report-en)（流程相同，英文觸發詞和報告）。

## 安裝

需要 [Claude Code](https://claude.com/claude-code) 和 Node.js 18 以上（不用裝其他套件）。把這個 repo clone 到 Claude Code 的 skills 資料夾：

```bash
git clone https://github.com/lng255639-cpu/token-usage-report.git ~/.claude/skills/token-usage-report
```

Windows 的 `~` 是 `C:\Users\<你的使用者名稱>`。裝好後開新對話就能用。

## 怎麼用

在 Claude Code 新對話裡輸入：

```
/token-usage-report
```

也可以直接用講的，skill 會自動觸發：

- 「最近 token 花在哪」
- 「token 用到哪去了」
- 「為什麼額度用這麼快」
- 「哪個對話最耗 token」
- 「今天的 token 去向」
- 「只看 my-project 這個專案最近 3 天」

沒指定範圍的話，預設看最近 7 天、全部專案。

## 會列出什麼

| 表格 | 內容 |
|---|---|
| 主對話 vs 子代理 | 你自己的對話和 subagent 各花多少 |
| 依模型 | Opus／Sonnet／Haiku 各佔多少 |
| 依日期 | 哪一天用最多 |
| 依專案資料夾 | 哪個專案最耗 |
| 依對話 | 最貴的幾個對話（用對話標題顯示） |
| 工具帶進上下文的量 | Read、Bash、瀏覽器、MCP 等工具的結果塞回上下文多少（估算） |
| Hook／附件注入 | SessionStart hook、skill 清單等每次自動塞進去的量（估算） |
| 快取重建 | 整段上下文被重新寫入快取的次數和花費 |
| 單次最貴的 API 呼叫 | 哪幾次呼叫最貴、當時在用什麼工具 |

最後 Claude 會用白話整理結論，例如：

```
錢主要花在哪
- 「網站改版」對話佔 31%，「資料清理」佔 20%，兩個長對話就花掉一半
- observer-sessions 佔 25%：這是記憶外掛在背景用 Haiku 做摘要，不是你開的對話

為什麼貴
- 最貴的幾次都是快取重建：長對話閒置一陣子再回來，60 萬 token 的上下文整段重寫
- Read 帶進最多內容，常整個大檔讀進來

建議
1. 做完一件事就開新對話，不要一個對話拖好幾天
2. 長時間離開後要接續，開新對話帶摘要過去
3. 讀大檔用 offset/limit，只讀需要的段落
```

## 「加權量」是什麼

直接加總 token 數會被「快取讀取」灌爆：長對話每一輪都會重讀整段上下文，數字很大，但單價很便宜。所以報告用**加權量**排序，以一般 input token 為 1 單位，照計價比例換算：

| 種類 | 權重 |
|---|---:|
| input | 1 |
| 快取寫入（5 分鐘） | 1.25 |
| 快取寫入（1 小時） | 2 |
| 快取讀取 | 0.1 |
| output | 5 |

加權量代表相對花費，不是金額。

## 自己跑腳本（不經過 Claude）

```bash
node ~/.claude/skills/token-usage-report/scripts/token_report.mjs
```

| 參數 | 作用 | 預設 |
|---|---|---|
| `--days N` | 看最近 N 天 | 7 |
| `--hours N` | 看最近 N 小時（優先於 `--days`） | |
| `--project 關鍵字` | 只看工作資料夾路徑含這個字的專案 | 全部 |
| `--top N` | 每張表列幾筆 | 10 |
| `--json` | 改輸出 JSON，方便再加工 | Markdown |

範例：

```bash
node ~/.claude/skills/token-usage-report/scripts/token_report.mjs --hours 24 --top 5
node ~/.claude/skills/token-usage-report/scripts/token_report.mjs --days 30 --project my-project --json
```

有設 `CLAUDE_CONFIG_DIR` 的話，會改讀 `$CLAUDE_CONFIG_DIR/projects`。

## 限制

- 只算得到還留在電腦上的對話紀錄。claude.ai 網頁版、其他電腦、已經被清掉的舊紀錄都不在裡面。
- input、快取、output 的數字直接取自紀錄裡的 `usage`，是準的。工具結果、hook 注入是用字數**估算**的（英文約 4 字元 1 token、中文約 1 字 1 token），只適合拿來比大小。
- 「快取重建」是用規則判斷的：一次寫入 3 萬以上、讀到的舊快取不到寫入量的兩成。新對話的第一輪也會被算進去。

## 檔案結構

```
token-usage-report/
├── SKILL.md                ← Claude 讀的流程說明
├── README.md               ← 本說明
└── scripts/
    └── token_report.mjs    ← 分析腳本（只需要 Node.js，不用裝套件）
```
