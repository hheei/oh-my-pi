# Magic Context × agentmemory 整合設計

狀態：設計已實作，並完成本地 contract、故障降級與隔離 Docker 驗證。

源碼基準：

- `omp-mctx`：本倉庫目前工作樹。
- agentmemory：`rohitg00/agentmemory` `v0.9.29`，commit `2d38dafede67d0d4ed920cde94d2106e98825b8a`。
- agentmemory 官方 Pi integration 只作 bridge 行為參考；本方案可以針對 OMP / Magic Context 調整 bridge，但不修改 agentmemory backend。

## 1. 目標與硬約束

目標是讓 `omp-mctx` 成為一個可直接連接現有 agentmemory Docker 服務的 OMP plugin：

```text
start agentmemory Docker
        ↓
configure omp-mctx URL/secret/project
        ↓
enable omp-mctx
        ↓
Window + cross-session Durable Memory available
```

硬約束：

1. 不修改 agentmemory repository 的 database、KV schema、index、RAG、consolidation、graph、lifecycle 或其他 backend 邏輯。
2. 不要求新增或修改 agentmemory REST API。
3. 只使用 agentmemory 公開 HTTP contract；不讀取 `KV.*`、`StateKV`、iii internal functions 或 agentmemory SQLite。
4. 所有 OMP-specific 行為都在 `omp-mctx` bridge 內完成。
5. agentmemory 官方 Pi integration 是參考，不是必須逐行複製的產品 contract。
6. 完成切換後，同一 OMP process 只能啟用一個 agentmemory bridge，避免重複 Capture、Inject 和 Session lifecycle。

不做：

- 不在 `omp-mctx` 重做 agentmemory 的 embeddings、semantic ranking、graph、consolidation、supersession 或 memory lifecycle。
- 不把 agentmemory 嵌入 `omp-mctx` process。
- 不把 `context.db` 變成第二個 searchable Durable Memory store。
- 不為舊 mctx Memory 做 feature-by-feature compatibility layer。

## 2. 實際起點

目前 `omp-mctx` 已經預設採用 Window-only path：

- plugin `enabled` 預設 `false`。
- `memoryEnabled` 預設 `false`。
- fresh `context.db` 使用 Window schema。
- `ctx_memory`、legacy Memory injection、memory embeddings 和 Dreamer memory pipeline 只在 legacy opt-in path 生效。

因此這不是一次 live database backend migration。正確起點是：

1. 在 `memoryEnabled=false` 的 Window path 上加入 agentmemory bridge。
2. 驗證 Window、Capture、retrieval、Historian promotion 和 failure boundary。
3. 完成 cutover 後再移除 legacy opt-in runtime。
4. 最後才清理不再被 Window schema 依賴的 legacy code/schema。

現有 `packages/hepi/omp-agentmemory/` 只作為 bridge 的參考和遷移來源；最終
由 `omp-mctx` 單獨承擔 bridge，並在 cutover 中移除該套件，不同時 live-enable
兩者。

## 3. 核心思想

一句話：

> Historian 可以理解和產生 Memory，但不能擁有 Memory。

更精確地說：

- Magic Context 管理「這個 session 發生過甚麼」。
- agentmemory 管理「跨 session 仍然知道甚麼」以及這些知識如何演化。
- `omp-mctx` 的 agentmemory bridge 只負責 host events、HTTP transport、scope validation、prompt formatting 和可靠投遞。

```text
                          OMP agent
                              │
               ┌──────────────┴──────────────┐
               │                             │
               ▼                             ▼
        Magic Context Window           agentmemory bridge
               │                       │       │
               │                  Capture   retrieval
               ▼                       │       │
           Historian ◄─────────────────┘       │
               │                               │
        ┌──────┴─────────┐                     │
        ▼                ▼                     │
  compartments     memory candidates           │
        │                │                     │
        ▼                ▼                     ▼
   context.db        local outbox ───────► agentmemory Docker
                                               │
                                      memory/RAG/graph/lifecycle
```

## 4. 唯一 owner

| 資料或行為 | Canonical owner |
| --- | --- |
| 當前 session raw conversation | OMP host / Magic Context |
| tags、pending drops、protected tail | Magic Context |
| tiered compartments、importance、episode type | Magic Context |
| `<session-history>` | Magic Context |
| `ctx_reduce`、`ctx_expand`、`ctx_note` | Magic Context |
| 當前 session raw/compartment search | Magic Context |
| agent activity observations | agentmemory |
| agentmemory session metadata | agentmemory |
| previous-session summaries | agentmemory |
| durable facts、architecture、workflow、preference、bugs | agentmemory |
| project profile、lessons | agentmemory |
| graph、BM25/vector indexes、ranking | agentmemory |
| supersession、strength、decay、consolidation | agentmemory |
| host event 到 REST 的轉換 | `omp-mctx` bridge |
| scope validation、outbox transport | `omp-mctx` bridge |

兩邊可以互讀，但同一類資料只能有一個 canonical owner。

## 5. Magic Context 保留與移除的能力

### 保留

- tags、pending operations、source contents
- protected-tail selection
- Historian triggering、validation、repair 和 optional editor
- P1–P4 compartments、importance、episode type
- deterministic decay rendering
- m[0]/m[1] cache-stable Window layout
- `ctx_reduce`、`ctx_expand`、`ctx_note`
- recomp、wrapup、session upgrade
- current-session raw history 和 compartment search
- historian leases、stale-source checks、discard-last healing
- failure recovery、LKG 和 OMP-specific session handling

### 最終移除

- mctx `memories`、memory FTS、memory embeddings
- memory mutation log、project memory epoch
- `ctx_memory`、`ctx-embed`、`ctx-aug`、`ctx-dream`
- `<project-memory>`、`<memory-updates>`、`<new-memories>`
- Dreamer memory verification/curation/classification/retrospective tasks
- user memory candidates、user memories、`<user-profile>`
- primers 和 memory auto-search hint
- mctx-side semantic Durable Memory ranking

物理刪除必須晚於 Window schema 脫離 legacy monolithic schema。既有 DB 中未再讀取的 legacy tables 可以先保留，不能為了換 backend 刪掉整個 `context.db`。

## 6. agentmemory 黑盒 contract

Bridge 只使用公開 endpoint：

```text
GET  /agentmemory/health

POST /agentmemory/session/start
POST /agentmemory/observe
POST /agentmemory/search
POST /agentmemory/lessons/search
POST /agentmemory/remember
POST /agentmemory/session/end

GET  /agentmemory/sessions
GET  /agentmemory/memories/:id
GET  /agentmemory/memories?latest=...&limit=...&offset=...
```

`/search format=full` 在 v0.9.29 已接到和 `/smart-search` 相同的 hybrid ranker；vector 不可用時由 backend 自己退回 BM25。它可一次返回 Memory 和 Observation 的完整搜尋內容，因此是 bridge 的主要 remote lane。

本方案不把 `/smart-search expandIds` 當通用 hydration API。v0.9.29 的 expansion branch 只讀 Observation store，不能展開由 shared index 返回的 `mem_*` Memory；compact Lesson 也只有 240-character preview。若未來改回 compact discovery，必須按 kind 分流：Observation 才能用 `expandIds`，Memory 用 `GET /memories/:id`，完整 Lesson 用 `/lessons/search`。

本設計不依賴 agentmemory internal SQLite、`KV.*`、`StateKV`、iii internal function IDs 或 undocumented storage access。

`/context` 不用作主要 OMP Inject。它是 broad、opaque context，內含不同 scope 的 profile、lessons、pinned/global content；無法在 client 端逐項 fail-closed 驗證。`/session/start` 即使返回 context，bridge 也只把它視為 backend response metadata，不直接注入。

## 7. Project、session 與 agent identity

Magic Context project identity 和 agentmemory project 是不同 namespace：

```ts
interface ProjectContext {
  mctxProjectId: string;
  agentmemoryProject: string;
  cwd: string;
  agentId?: string;
}
```

- `mctxProjectId`：用於共享 `context.db` 內的 row-level scope。
- `agentmemoryProject`：傳給所有 agentmemory request。
- `cwd`：實際工作目錄，不能代替 project。
- `agentId`：只有 deployment 使用 agent isolation 時才配置；不要自動發明新的 ID。

`context.db` 是 agent-global shared DB，不是 per-project DB。所有新增 bridge tables 都必須有足夠的 session/project/harness scope。

### agentmemoryProject resolution

模仿 agentmemory 官方 integration：

1. `AGENTMEMORY_PROJECT_NAME`；未設定時使用明確 plugin setting `project`
2. `git rev-parse --show-toplevel` 的 basename
3. `cwd` basename

所有 `/session/start`、`/observe`、retrieval、`/remember` request 必須共用同一個 project resolver。`cwd` 只作 session/observation metadata；project-wide retrieval 不傳 `/search.cwd`，否則同 project 的其他 worktree/subdirectory session 會被錯誤排除。

Basename fallback 延續官方 integration 的便利行為，但可能讓兩個同名 repository 碰撞，不是 security identity。存在同名 repo 或隔離要求時必須明確配置唯一 `project`（或分開 backend）。

### Scope 能力邊界

本設計的 Scope Gate 能對 read/display fail-closed，但不能把一個共享 v0.9.29 backend 變成嚴格的 multi-agent write-isolation boundary：

- `/remember` 會保存新 Memory 的 `agentId`，但 dedup/supersession candidate loop 不按既有 Memory 的 `agentId` 過濾；agent B 的相似 write 可能令 agent A 的 Memory 變成非 latest。
- project guard 只在新舊兩筆都有明確 project 時生效；legacy unscoped Memory 被 backend 視為 wildcard，可能參與 scoped write 的 supersession。

因此 `agentId` 在此是 routing/read-filter tag，不是 security boundary。若不同 agent 或 legacy corpus 之間需要硬隔離，又不能修改 agentmemory，必須使用不同的 agentmemory instance/data volume；bridge preflight 無法修正 backend 內部 mutation semantics。

## 8. AgentMemoryClient

只有一個 HTTP abstraction：

```ts
interface AgentMemoryClient {
  health(): Promise<HealthResult>;
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  observe(input: ObserveInput): Promise<ObserveResult>;
  search(input: SearchInput): Promise<SearchResult>;
  searchLessons(input: LessonSearchInput): Promise<LessonSearchResult>;
  getMemory(id: string): Promise<Memory | null>;
  listSessions(): Promise<Session[]>;
  listMemories(input: MemoryListInput): Promise<MemoryPage>;
  remember(input: RememberInput): Promise<RememberResult>;
  endSession(sessionId: string): Promise<void>;
}
```

它負責 base URL、bearer header、HTTPS guard、timeouts、JSON validation、endpoint-specific success validation、error normalization 和 cancellation。不能只看 HTTP 2xx；例如 `/remember` 必須確認 body `success === true` 且有合法 `memory.id`，`/observe` 的 deduplicated response 沒有 `observationId` 時不能建立 provenance link。

它不做 ranking、dedup、scope guessing、secret persistence 或 generic blind retries。Observation 是 best effort；Durable candidate retry 由 outbox 管理。

## 9. Session lifecycle

OMP logical session 和 agentmemory capture session 必須分開命名。`/session/start` 不是 idempotent：以相同 ID 重複呼叫會覆寫 session row，重設 `startedAt`、status 和 observation count。因此 bridge 為每次 process activation 建立一個 capture segment，並在該 process 內對同一 OMP session 重用：

```ts
interface AgentMemorySessionBinding {
  ompSessionId: string;
  agentmemorySessionId: string;
  project: string;
  agentId?: string;
}
```

建立或切換到一個尚未綁定的 OMP session 時：

```text
resolve stable OMP session ID
create one unique agentmemory capture-segment ID
resolve project/cwd/optional agentId
health probe or circuit state check
POST /agentmemory/session/start
```

只有 `/session/start` 成功後才記錄 binding 並允許該 segment Capture。Start failure 不阻止 OMP session，但在成功重試前停止 remote Capture，因為 `/observe` 不接受有效的 request-body `agentId` override，Observation 的 project/agent scope 依賴已存在的 remote session row。

普通 `session_switch` 不呼叫 `/session/end`；它可能只是稍後會 resume 的 navigation。Bridge 在 process 內保存所有成功啟動的 capture segments。現有 OMP `SessionShutdownEvent` 沒有 `reason`，而且只在 terminal `AgentSession.dispose()` 發出；收到它時，對本 process 尚未結束的所有 segments 各呼叫一次：

```text
POST /agentmemory/session/end
```

不能複製 agentmemory 官方 Pi integration 對 `event.reason === "quit"` 的判斷；它針對的是不同 Pi event contract，在目前 OMP 會永遠讀到 `undefined`。Crash/KILL 無法保證 end，交給 agentmemory 的 stale-session recovery；不為此增加 backend API。

Bridge 不另外呼叫 `/summarize`。`session/end` 已觸發 backend lifecycle。本方案也不額外呼叫 `/consolidate`，讓 agentmemory Docker 自己的 feature flags 和 lifecycle 負責。這是 bridge policy，不是 agentmemory backend 改動。

`/session/end` 的 200 只表示 session row 已完成且後續 lifecycle 已 dispatch；summary、graph、lesson 和 consolidation 的可見性是 eventual，不能在 response 後立即斷言完成。

## 10. Capture

Capture 是 high-recall、best-effort evidence stream；Historian promotion 是 low-recall、high-precision semantic path。

捕捉：

- user prompt
- substantive tool call/result
- tool failure
- meaningful completed assistant turn
- session start/end metadata

不捕捉：

- `ctx_reduce`、`ctx_expand`、`ctx_note`
- `memory_search`、`memory_save`
- Historian/repair/editor hidden sessions
- Magic Context compaction control events
- secret-bearing internal output

這些排除是 OMP bridge 的降噪和 anti-feedback policy，不要求改 agentmemory。

Capture task 帶著當下可取得的 stable entry ID、`toolCallId`、kind 和 fingerprint 非同步呼叫 `/observe`；成功後保存 `observationId` 供 provenance 使用。`tool_result` hook 有 `toolCallId` 但未必已有 SessionEntry ID，必須稍後和 Pi branch entry reconciliation，不能猜 ordinal。

失敗則丟棄；Observation 不進 outbox，也不能阻止 Window。Remote session 尚未成功建立時不送 `/observe`，避免產生無法證明 project/agent scope 的 orphan Observation。

## 11. 唯一 agent-visible search：`memory_search`

只保留一個 search tool：

```ts
memory_search({
  query: string;
  limit?: number;
})
```

不暴露：

- `ctx_history_search`
- `memory_recall`
- `memory_smart_search`
- source selector
- project、sessionId、agentId
- backend endpoint choice

`memory_search` 自動並行搜尋兩個來源：

```text
                         query
                    ┌─────┴─────┐
                    ▼           ▼
             WindowSearch   AgentMemorySearch
                    │           │
                    └─────┬─────┘
                          ▼
                  grouped result response
```

### 11.1 WindowSearch

只搜尋目前 session：

- 現有 `message_history_fts` 的 raw-message hits
- 依 raw hit range 對應的 persisted compartment context；可補 bounded lexical compartment match，但不建立新的 embedding index

它不搜尋 Durable Memory、git history 或 legacy mctx memories。

實作應抽出/narrow 現有 search 中的 message lane，不能直接沿用會默認混入 memory、primer、note、git commit 的 broad `unifiedSearch` 設定。WindowSearch 的 project boundary 由 exact current `sessionId` 決定。

WindowSearch 也要套用 provenance filter：移除 `memory_search`/`memory_save` tool payload，並 drop 只有 tainted assistant restatement 的 hit。否則同一份 agentmemory 內容會先被寫進 raw tool result，再錯標成 `current-session`。若一個 folded raw message 同時含獨立 user/tool 內容，只裁掉 memory-derived parts，不必丟掉整個 message。

```ts
interface SessionSearchHit {
  source: "current-session";
  kind: "raw-message" | "compartment";
  range: { start: number; end: number };
  content: string;
}
```

### 11.2 AgentMemorySearch

AgentMemorySearch 是一個完整 remote retrieval transaction，而不是另一個 agent tool：

1. 以 `/search format=full` 取得 backend-ranked Memory/Observation；request 帶 project 和 optional agentId（不帶 cwd），並適度 over-fetch，最後配額才是 model-visible limit。
2. 若 project-only deployment 啟用 Lesson recall，並行呼叫 `/lessons/search`，明確傳 project。
3. 對 Memory、Observation、Lesson 執行 client-side Scope Gate。
4. exact ID dedup；不同 remote corpus 各自保留 backend ranking。
5. 以 per-kind quota/round-robin 合併 Memory、Observation 和 Lesson，不直接比較 `/search` score 與 Lesson score。
6. 限制 hit count 和 token budget；不自己計算 embedding。

這些 HTTP call 對模型是一個不可分割的 `memory_search` 操作。任何單一 endpoint 失敗都可降級，不增加工具數量。

這裡刻意不把 `/smart-search` 和 `/search` 對同一 query 同時跑一次：v0.9.29 兩者共用 hybrid ranker，重複呼叫主要增加延遲，並不能構成獨立的 completeness proof。

### 11.3 Scope Gate

`project` request field 只是一層 server-side filter，不足以當作 fail-closed proof。

兩條 remote candidate path 都必須通過相同 Scope Gate：

- Memory：hydrate record，要求 `memory.project === currentProject`。
- Observation：先驗證 inline `observation.agentId`，再從 cached `/sessions` snapshot 取得 session metadata，要求 `session.project === currentProject`；`/sessions` 沒有 by-ID endpoint，snapshot 必須限頻並重用。
- Remote Observation 若屬於目前 OMP session 的 active capture segment，drop；同一輪內容應由 WindowSearch 呈現，不能因 Capture 回流而變成假 cross-session hit。
- Lesson：要求明確的 `lesson.project === currentProject`。
- 如果配置了 effective `agentId`，Memory、Observation 和 Session 都要明確符合該 agent scope。
- Lesson schema 沒有 `agentId`。effective `agentId` 存在時不呼叫 Lesson lane，任何意外 Lesson hit 一律 drop。
- unknown、missing、ambiguous scope：drop。

`/search` 不能命名為 strict lane。agentmemory 為 backward compatibility 會讓部分 unknown/unscoped rows 通過；它只是 server-filtered baseline。

`GET /memories/:id` 只用於 hydration，不能因為能取到 record 就視為有權顯示。

### 11.4 Scope cache

Process-local cache：

- 一次 `/sessions` snapshot 建成的 `sessionId → project/cwd/agentId`，TTL 約 60 秒；同一 remote transaction 共用 singleflight。
- `memoryId → hydrated record`，TTL 約 5 分鐘。

Cache 不是 canonical storage。過期、miss 或 backend failure 都必須 fail-closed。

`/sessions` 在 v0.9.29 沒有 by-ID route，且會為整個列表載入 summaries；大 corpus 的 cold validation 可能較慢。成功建立 remote session 後可 background warm snapshot，但 interactive retrieval 仍受總 deadline 約束。Snapshot 未能及時取得時只 drop 無法證明 scope 的 Observation，不拖垮 Window 或已驗證的 Memory/Lesson hits。

### 11.5 Merge 和 ranking

Window FTS score 和 agentmemory hybrid score 不是同一量尺，不能直接數值排序。

1. 兩個來源各自在自己的 ranking 中排序。
2. 先保留每個非空來源至少一個 hit。
3. 使用 bounded quota 或 round-robin 填滿 global limit。
4. 同來源 exact ID dedup；跨來源不丟棄 provenance。內容完全相同時可標記 duplicate/also-present 並只計一次內容 budget，但結果仍保留 `current-session` 和 `agentmemory` source metadata。
5. 不在 mctx 做 semantic embeddings 或 supersession。
6. 最後施加 token budget。

### 11.6 結果格式

結果明確區分來源：

```text
## Current session
- [§120-145 | compartment] ...
- [§151 | raw message] ...

## Durable memory (agentmemory)
- [memory mem_abc | architecture | remote rank 1] ...
- [observation obs_def | prior session | remote rank 2] ...
- [lesson lesson_xyz | lesson rank 1 | confidence 0.91] ...
```

若某一來源失敗，保留另一來源並在 structured `details` 標記 partial failure。不要把 transport error 偽裝成「沒有結果」。

## 12. 自動 cross-session Inject

每次 substantive `before_agent_start` 使用當前 user prompt 執行一次 bounded AgentMemorySearch，參考 agentmemory 官方 Pi integration 的 prompt-specific recall。

它只走 remote lane；目前 session continuity 已由 `<session-history>` 提供，不重複注入 WindowSearch 結果。

在目前 OMP Extension API 中，recall 應作為 `before_agent_start` 返回的 hidden custom message（`display: false`）加入該次 provider request，而不是改寫 system prompt。這條路徑不呼叫 `sessionManager.appendCustomMessageEntry`，因此不持久化到 JSONL，也不因每輪 recall 內容變動而破壞 Magic Context 的 system-prompt cache：

```ts
return {
  message: {
    customType: "omp-mctx-agentmemory-recall",
    content: recallBlock,
    display: false,
    details: { nonCandidateEvidence: true },
  },
};
```

非空 recall block 返回前必須先持久化該 turn 的 taint marker；marker write 失敗時 fail-closed 省略 Inject。否則 model 可能看過 remote Memory，但重啟後的 Historian 無法辨識其 assistant restatement。

```text
<cross-session-memory project="repo-name">
  ...scope-validated remote results...
</cross-session-memory>

<session-history>
  ...Magic Context compartments...
</session-history>
```

Inject 是 turn-local adjunct：

- 不寫入 raw transcript。
- 不進 m[0]/m[1] compartment baseline。
- 不成為 Historian candidate evidence。
- retrieval failure 時整個 block 省略。
- 同一 prompt generation 只能注入一次。

不要求 `AGENTMEMORY_INJECT_CONTEXT=false`；它不是通用 Pi/OMP bridge kill switch。避免重複 Inject 的方法是只啟用一個 OMP agentmemory bridge。

## 13. Historian 的新角色

Historian 是：

```text
Context compressor + high-precision memory candidate compiler
```

```text
Historian
  ├─ compartments → context.db
  └─ memory candidates → local outbox → /remember
```

- compartment：當前 session 的 episodic chronology。
- memory candidate：跨 session 仍值得保留的 semantic/procedural knowledge。

agentmemory 仍是 candidate 接收後的 canonical owner。

## 14. Historian retrieval

Historian 不使用 `/context`，也不 dump 所有 memories。它使用和 `memory_search` 相同的 AgentMemorySearch、Scope Gate、project resolver 和 HTTP client，但不使用 WindowSearch。

不用額外 LLM。從 historian chunk deterministic 產生最多三條 query：

1. 主要語義：substantive user intents + assistant conclusions。
2. artifacts：file paths、symbols、package names、commands、error names、configuration keys。
3. continuity：previous compartment title + current objective。

多條 query 可並行，最後 ID dedup 和 token-budget packing。

```text
<agentmemory_context project="repo-name">
  <durable_memories>...</durable_memories>
  <past_observations>...</past_observations>
  <lessons>...</lessons>
</agentmemory_context>
```

建議總 budget 約 1,500–3,000 tokens。raw current-session chunk 永遠是 primary source。

同一 chunk 的 first pass、repair 和普通 editor 共用 retrieval cache。只有明確啟用 editor second-pass retrieval 時才產生新 query。

## 15. Anti-feedback-loop

核心規則：

> agentmemory recall 是 background，不是新 Memory 的證據。

只把 `<agentmemory_context>` 標成 background 還不夠，因為 `memory_search` tool result 和 assistant 重述會出現在 raw session history。

Historian evidence policy：

- `memory_search` output 標記為 `non_candidate_evidence`。
- `memory_save` call/result 標記為 `non_candidate_evidence`。
- injected `<cross-session-memory>` 不寫入 raw history。
- Bridge 在 `context.db` 為每個看過 remote recall/search 的 turn 保存最小 taint marker（不保存 recall 內容）；若該 turn 有 taint，assistant text 不能單獨作獨立 evidence。Marker 必須能在 process restart 後供 Historian 使用。
- candidate 必須引用 current chunk 中明確列出的獨立、非 memory-derived source ordinals，不能用一整段 range 掩蓋來源。
- 只有 recall 內容、或只重述 recall 內容的 candidate 不得輸出。
- agentmemory context 只用於 semantic dedup、contradiction awareness 和 canonical wording。

Candidate admission 再次逐項驗證 evidence source 的 stable identity 和 origin。這能阻止純 memory-derived source 通過，但不能純 deterministic 地證明自然語言 claim 真由 evidence entail；語義判斷仍由 Historian prompt/validator 負責，失敗時取 conservative rejection。

Allowed independent evidence 限於 user 當前明確提供的事實/決定、非 memory tool 所觀察到的 repository/runtime state，以及由這些來源支持的 assistant conclusion。只包含「請回憶先前決定」之類 query 的 user message不算對被召回事實的支持。

## 16. Historian candidate contract

直接採用 agentmemory `/remember` 支持的 taxonomy：

```text
pattern
preference
architecture
bug
workflow
fact
```

```xml
<memory_candidates>
  <memory
    type="architecture">
    <content>Project identity uses the Git repository root basename.</content>
    <evidence>
      <source ordinal="142" />
      <source ordinal="148" />
    </evidence>
    <concepts>
      <concept>project-identity</concept>
      <concept>worktree</concept>
    </concepts>
    <files>
      <file>src/project.ts</file>
    </files>
  </memory>
</memory_candidates>
```

不加入 backend 不支持的 lifecycle fields，例如 `reinforces`、`contradicts`、`extends`、`supersedes` 或 client-side semantic confidence。

Historian 只輸出 canonical current truth。若 current evidence 修改既有 Memory，盡量保留原有 terminology，只更新已變更的值。

兩層 dedup 都保留：

1. Historian 對 recalled memories 做 LLM semantic dedup。
2. agentmemory `/remember` 做 backend dedup/versioning。

## 17. Candidate admission

Admission 只做 deterministic validation：

- allowed type
- non-empty bounded content
- valid concepts/files shape
- 至少一個 evidence source，且每個 ordinal 都屬於本次 exact chunk
- 每個 evidence source 都解析到 stable message/tool identity，且 origin 不是 Inject、`memory_search`、`memory_save` 或其衍生內容
- evidence 只落在真正準備 persist 的 trusted compartments
- evidence 不落在 discarded provisional tail 或 weak-lookahead-only range
- 同一 historian output exact duplicate collapse
- source message IDs/fingerprints 仍與推理輸入一致

Admission 不做 embeddings、semantic threshold、Memory merge、stale-memory detection 或 supersession decision。

High-signal candidate 進 outbox；weak/uncertain candidate 丟棄。原始 evidence 若已被 Capture，仍留在 Observation layer。

## 18. Provenance bridge

`POST /observe` 返回：

```json
{ "observationId": "obs_xxx" }
```

`POST /remember` 接受：

```json
{ "sourceObservationIds": ["obs_xxx"] }
```

但 OMP raw ordinal 不是穩定的一對一 host event identity：tool results 會摺進 user/synthetic messages，branch projection 也可能改變 ordinal。

因此 link table 以 stable source identity 為主：

```sql
CREATE TABLE agentmemory_observation_links (
  omp_session_id TEXT NOT NULL,
  agentmemory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL,
  source_entry_id TEXT,
  source_tool_call_id TEXT,
  source_kind TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_version TEXT,
  observation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agentmemory_session_id, observation_id)
);

CREATE INDEX idx_agentmemory_obs_source
ON agentmemory_observation_links(
  omp_session_id,
  source_entry_id,
  source_tool_call_id,
  source_fingerprint
);
```

規則：

1. 有 host entry/tool-call ID 時優先使用。
2. Capture event 尚無 stable entry ID 時，只能稍後以 OMP session + agentmemory segment + kind + unique fingerprint reconciliation。
3. fingerprint 有多個候選或 branch identity 不一致時，不建立 link。
4. Historian publish 使用本次 chunk 的 `ordinal → messageId/version/fingerprint` mapping 解 provenance。
5. 錯誤 link 不得猜測；`sourceObservationIds` 是 enrichment，不是 correctness requirement。

agentmemory 不保證 source observation 一定存在或同 project，因此 client 只提交本地已驗證 link；provenance 是 traceability，不是 authorization。

## 19. Atomic publication 和 outbox

Outbox row 必須和 Window publication 在同一 SQLite transaction 中提交：

```text
1. validate historian output
2. prepare persisted compartments and trusted evidence source refs
3. BEGIN IMMEDIATE
4. recheck compartment lease
5. recheck source snapshot/message IDs/fingerprints/taint markers
6. write compartments/events/drop queue/coverage state
7. resolve local provenance links
8. INSERT candidate outbox rows
9. COMMIT
10. signal Window publication
11. asynchronously deliver /remember
```

禁止在 `COMMIT compartments` 和 `INSERT outbox` 之間留下 crash window，也禁止在 SQLite transaction 內做 HTTP。

```sql
CREATE TABLE agentmemory_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK (operation = 'remember'),
  payload_json TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at INTEGER,
  lease_owner TEXT,
  lease_until INTEGER,
  UNIQUE(project, scope_agent_id, candidate_hash)
);
```

`candidate_hash` 由 canonical effective request 計算：project、effective agentId、type、normalized content，以及 normalized/sorted concepts 和 files。`sourceObservationIds` 不改變 semantic identity；同一未投遞 candidate 再次出現時可合併本地已驗證 provenance。

Outbox 不可搜尋、不可注入 prompt、不可由 agent 編輯、不作 canonical knowledge，也不包含 secret。

Outbox 是 correctness 機制，不提供關閉設定。若本地 outbox insert 失敗，該 historian publication 必須 rollback；agentmemory network failure 則不影響已提交 Window。

## 20. Outbox delivery

```text
BEGIN IMMEDIATE
claim one due, unleased/expired row
COMMIT
   ↓
best-effort exact-content preflight with project/scope gate
   │
   ├─ exact same scoped memory exists → mark delivered
   └─ absent → POST /remember
                 │
                 ├─ success → mark delivered
                 ├─ definite failure → release lease + schedule retry
                 └─ ambiguous timeout → delayed reconciliation, then retry if still absent
```

Success 必須是已驗證的 `/remember` body，不是單純 HTTP 201。Delivered row 可先保留短期 tombstone 供 local coalescing/telemetry，再按 retention 清理；不可把它當成 Durable Memory corpus。

`context.db` 可被 sibling OMP processes 共用，因此 delivery worker 必須以短 transaction 原子 claim row；HTTP 不在 transaction 內。Worker crash 後 lease expiry 允許另一 process 接手。Drain 在 plugin startup/session activation 觸發，之後由 managed timer 根據最早 `next_attempt_at` 喚醒；shutdown 只作 bounded best-effort drain，不等待所有 row 清空。

Retry 例如：

```text
5s → 30s → 2m → 10m → 1h → 6h
```

最大 hot retry age 可設 7 days；之後 row 進入 cold retry（例如 health 恢復、plugin startup 或每日一次）並保留 failure telemetry，不能當成功或靜默刪除。這裡的 at-least-once 承諾以 outbox 未被操作者清除且 backend 最終恢復為前提。

Preflight 必須通過同一 Scope Gate，並比較 normalized exact content、type、project 和 effective agentId。正常路徑可先用 `/search format=full`；ambiguous POST 可再用 paginated `GET /memories` 做 bounded reconciliation。

這仍然不是 exactly-once：v0.9.29 `/remember` 沒有 idempotency key，每次成功都建立新 `mem_*`，而 search/index 可能在已持久化後暫時 miss。Outbox 提供的是 **at-least-once delivery + best-effort duplicate suppression**；無法消除的重複交給 agentmemory 原生 versioning/dedup 處理。Preflight 是減少重複的 optimization，不是 correctness proof。

## 21. Recomp、wrapup 和 stale-source rules

- incremental Historian：允許 candidate extraction。
- recomp：禁止 candidate extraction。
- session upgrade：禁止 candidate extraction。
- repair：只在沒有推進 coverage 且使用同一 source snapshot 時保留原 candidate contract。
- wrapup：只有首次處理的 trusted range 允許 candidates。
- discard-last：與 discarded tail 相交的 candidates 全部 withholding，等待下次重新推導。
- forced weak-lookahead final range：沿用現有 conservative no-promotion policy。

現有 protected-tail refresh、lease、no-forward-progress、drain reservation rollback 和 source snapshot checks 都是 Window correctness invariant。

## 22. m[0]/m[1] 和 context.db

```text
m[0]
  stable adjuncts
  decay-rendered compartment baseline

m[1]
  newly published compartments/session deltas

turn-local adjunct
  scope-validated cross-session recall
```

Turn-local recall 不混入 compartment baseline，因此不需要 project memory epoch，也不會被 Historian 誤當 raw evidence。

`context.db` 最終保留 Window/session tables、message history index、LKG/recovery state，以及 `agentmemory_observation_links`、`agentmemory_turn_taint` 和 `agentmemory_outbox`。Taint table 最小 contract：

```sql
CREATE TABLE agentmemory_turn_taint (
  omp_session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  user_entry_id TEXT,
  user_fingerprint TEXT NOT NULL,
  saw_injected_recall INTEGER NOT NULL DEFAULT 0,
  saw_memory_tool INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (omp_session_id, turn_key)
);
```

它只保存 OMP session/source identity 和 boolean taint，不複製 recalled content。若 `before_agent_start` 時還沒有 durable user entry ID，先使用生成的 `turn_key`，entry 寫入後再按 unique fingerprint reconciliation；歧義時把相關 assistant source 視為 tainted，而不是猜 link。Legacy tables 先停止讀寫，物理清理在獨立 migration 階段進行。

## 23. Tool surface

Model tools：

```text
ctx_reduce
ctx_expand
ctx_note            optional

memory_search       current session + agentmemory federated search
memory_save         explicit durable write
```

Slash command：

```text
/memory-health
```

不註冊 model-visible `memory_health`。移除 `ctx_search`、`ctx_history_search`、`ctx_memory`、`ctx-aug`、`ctx-dream`、`ctx-embed`、`memory_recall` 和 `memory_smart_search`。

`ctx_expand` 保持原語義：依 compartment range 恢復目前 session raw 內容。它不是 search。

## 24. `memory_save`

```ts
memory_save({
  content: string;
  type?: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
  concepts?: string[];
  files?: string[];
})
```

Bridge 自動補 project 和 optional effective agentId。

普通 model-initiated `memory_save` 通常沒有完整 `sourceObservationIds`；不可偽造。只有 Historian path 在 verified provenance 存在時加入。

`memory_save` 不建立第二條直寫路徑。它使用同一 canonical hash 和 outbox，enqueue 後觸發一次 bounded immediate drain：已確認 `/remember` 成功則返回 `saved`；暫時不可達或結果 ambiguous 則返回 `queued`，不能謊報成已持久化到 agentmemory。這讓顯式 save 和 Historian candidate 共用相同的 retry、claim lease 和 duplicate-suppression boundary。

## 25. Prompt surface

Primary agent 不再看到 `<project-memory>`、`<memory-updates>`、`<new-memories>` 或 `<user-profile>`。

只看到：

```text
<cross-session-memory>...</cross-session-memory>
<session-history>...</session-history>
```

Tool guidance：

```text
Use memory_search when you need either earlier current-session detail
or cross-session durable knowledge. Results identify their source.

Use ctx_expand when an existing session-history compartment does not
contain enough exact detail and you know its range.

Use memory_save for durable knowledge that should survive future sessions.
```

Historian prompt 必須明確：

```text
CURRENT SESSION MESSAGES = possible evidence
AGENTMEMORY CONTEXT       = background only
MEMORY-DERIVED PARTS      = never independent evidence
```

## 26. Failure semantics

| Failure | 行為 |
| --- | --- |
| health failure | Window 正常，remote search unavailable |
| session start failure | Window 正常；Capture 暫停。若 scoped retrieval endpoints 獨立健康，search/Inject 仍可降級運作 |
| Capture failure | drop observation |
| WindowSearch failure | 返回 remote 結果並標 partial |
| AgentMemorySearch failure | 返回 current-session 結果並標 partial |
| Historian retrieval failure | 無 memory context，仍正常 compact |
| `/remember` failure | outbox retry |
| session end failure | log，不阻止 shutdown |
| Historian failure | Capture 仍正常 |
| agentmemory Docker down | Window、tags、reduce、expand 仍正常 |

建議 timeout：

```text
health                1s
session/start         3s
observe               1–2s
search                3s
lesson search         2s
memory/session scope  2–3s
remember              4s
session/end           2s
```

一次 remote retrieval transaction 約 4s 總 deadline；超時後返回 local 結果或讓 Historian 無 augmentation 繼續。

## 27. Security 和 privacy

- `AGENTMEMORY_SECRET` 只進 HTTP Authorization header。
- secret 不寫 `context.db`、outbox、logs、telemetry 或 prompt。
- 非 loopback plaintext HTTP + bearer 必須 warn；可提供 require-HTTPS fail-closed setting。
- Capture 避免 authorization headers、environment dumps、raw credentials 和 known secret-bearing tool output。
- backend privacy stripper 不是完整 DLP；bridge 不能假設任意 tool output 都安全。
- Tool renderer/UI preview 必須做 tabs、width 和 home-path sanitization；不要為了 UI 安全改寫 model-visible result 的必要 path/content 語義。
- `agentId` 和 project Scope Gate 不是 shared-backend write authorization。硬 trust boundary 使用不同 instance/data volume。

## 28. Config

只配置 bridge integration：

`agentmemory.enabled` 是獨立的總 opt-in，預設為 `false`；啟用後
`capture`、`inject`、`historianRetrieval` 和 `memoryTools` 預設為 `true`，
並可個別作 kill switch。這不改變 legacy `memoryEnabled=false` 的
Window-only baseline，也不會在 agentmemory 未啟用時發出網路請求。

```json
{
  "enabled": true,
  "agentmemory": {
    "enabled": true,
    "url": "http://127.0.0.1:3111",
    "project": "",
    "agentId": "",
    "capture": true,
    "inject": true,
    "historianRetrieval": true,
    "memoryTools": true
  }
}
```

Environment override：

```text
AGENTMEMORY_URL
AGENTMEMORY_SECRET
AGENTMEMORY_PROJECT_NAME
AGENT_ID             only when agent-scoped deployment needs it
```

配置 `agentId` 只啟用既有 API 的 tagging/filtering；它不提升 v0.9.29 `/remember` 的 supersession isolation。若要求不可信 agent 互相不能影響，部署層必須分開 backend/data volume。

不要鏡像 backend 的 graph/vector weights、Jaccard threshold、consolidation、graph extraction、auto-compression 或 lifecycle tuning。

## 29. Suggested module layout

```text
packages/hepi/omp-mctx/src/
  agentmemory/
    client.ts
    config.ts
    project.ts
    session.ts
    capture.ts
    injection.ts
    scope-gate.ts
    remote-search.ts
    unified-search.ts
    formatter.ts
    turn-taint.ts
    provenance.ts
    candidate.ts
    admission.ts
    outbox.ts

  core/
    hooks/
      compartment-runner-incremental.ts
      compartment-prompt.ts
      historian-prompt.source.md
    features/
      history-search/
      compartments/

  tools/
    ctx-reduce.ts
    ctx-expand.ts
    ctx-note.ts
    memory-search.ts
    memory-save.ts
```

所有 fork-owned bridge 邏輯放在獨立 module tree。對既有 Window 核心只增加窄 hook。

## 30. Telemetry

只觀察 integration layer：

```text
health

capture:
  attempted/succeeded/failed/deduplicated/excluded/no_remote_session

unified search:
  window_hits
  remote_search_hits
  remote_lesson_hits
  scope_dropped
  final_window_hits
  final_remote_hits
  partial_failures
  latency

historian candidates:
  emitted/rejected/queued/delivered
  rejected_memory_derived
  rejected_untrusted_source

outbox:
  depth/oldest_age/claims/lease_expirations/retries/ambiguous/failures
  preflight_hits/duplicate_risk
```

不複製 agentmemory backend metrics。

## 31. 測試 contract

### Project resolver

- explicit setting/env override
- git repository、worktree、non-git directory
- whitespace/empty values
- all request types use the same project

### Unified search

- current-session only hit
- agentmemory only hit
- both sources hit 並分組顯示
- same project、different cwd/worktree 的 remote hit 不被錯誤過濾
- prior `memory_search` tool payload 不被重新標成 current-session hit
- mixed folded message 只移除 memory-derived part，保留獨立內容
- active capture segment 的 Observation 不從 remote lane 回流
- one source fails 時返回另一來源並標 partial
- Window 和 remote scores 不直接比較
- `/search` 和 Lesson score 不直接比較
- global token budget 和 per-source floor
- no split search tool exposure
- recall 以 hidden custom message 注入，不進 session JSONL，也不改 system prompt cache key

### Remote Scope Gate

- Memory/Observation/Lesson 的 same、other、unknown project
- configured agentId 的 same、other、unknown
- configured agentId 時不返回無 agent scope 的 Lesson
- `/search` unknown-scope result 仍被 client drop
- Memory hydration 或 Session snapshot failure fail-closed
- shared backend 的 read gate 不被誤測成 write-isolation guarantee

### Anti-feedback

- recalled Memory 不產 candidate
- `memory_search` output 不產 candidate
- assistant 只重述 recall 內容不產 candidate
- taint marker 跨 process restart 仍有效
- current session 獨立更新既有 Memory 時產 new current truth
- new durable knowledge 有 allowed evidence source

### Provenance

- stable entry 連 observation
- multiple tool results folded into one raw ordinal 仍保持各自 identity
- branch/projection 改變後不錯連
- unique fingerprint 可 reconciliation
- ambiguous fingerprint 不建立 link

### Publication/outbox

- compartments 和 outbox 在同 transaction
- outbox insert failure 回滾 publication
- network failure 不回滾 committed Window
- sibling processes 只能由一個有效 lease owner deliver 同一 row
- worker crash 後 expired lease 可被接手
- stale lease/source snapshot 拒絕 publish
- discard-last/weak-lookahead candidate 不入 outbox
- candidate hash 包含 project、agent scope 和 canonical effective request
- ambiguous POST timeout + exact scoped hit 視為成功；miss 後重試只承諾 at-least-once，不宣稱 exactly-once

### Session/Capture lifecycle

- 同一 OMP session 在一個 process activation 只 start 一個 capture segment
- resume/switch 不以相同 agentmemory session ID 重複 `/session/start`
- start failure 時 Window 繼續，但 Capture 暫停至成功建立 scoped remote session
- terminal `session_shutdown` 沒有 `reason` 也能 end 本 process 的所有已啟動 segments
- `/session/end` 200 後以 bounded eventual assertion 等待 summary/lesson，不立即斷言完成

### E2E

1. 啟動 unmodified agentmemory Docker。
2. 啟動 `omp-mctx` session並驗證唯一 capture segment 的 `/session/start`。
3. user/tool/assistant events 經 Capture 產生 observations。
4. `memory_search` 同時返回 current-session 和 agentmemory hits，來源清楚。
5. Historian 取得 scope-validated background。
6. Historian 在同一 transaction 提交 compartments 和 outbox。
7. candidate 帶 verified `sourceObservationIds` 寫入 `/remember`。
8. 下一次 retrieval 找到 Memory，但不再次產生 candidate。
9. 結束 process session並驗證所有已啟動 segments 的 `/session/end` dispatch；eventual lifecycle 另行等待。
10. 下一個 session 透過 prompt-specific Inject 召回相關 Memory。

Failure E2E：agentmemory down 時 Window 仍能 tag/reduce/expand/publish；outbox 保留 candidate。agentmemory 恢復後 outbox drain，Memory 可被召回。

## 32. 實作順序

### A. Bridge foundation

- client/config/security
- project identity + OMP-session/capture-segment binding
- session start/end
- Capture

保持 legacy `memoryEnabled=false`；新增的 agentmemory bridge 另以獨立
opt-in 啟用，預設不連線。

### B. Unified search

- WindowSearch
- AgentMemorySearch `/search format=full` + optional project-scoped Lesson lane
- project/agent Scope Gate
- grouped formatter
- 單一 `memory_search`

### C. Inject

- prompt-specific remote recall
- turn-local `<cross-session-memory>`
- prompt-generation dedup

### D. Historian contract

- `projectMemory → agentMemoryContext`
- `facts → memoryCandidates`
- agentmemory-native taxonomy
- explicit evidence refs + durable anti-feedback taint markers

### E. Provenance 和 atomic outbox

- stable source links
- candidate admission
- same-transaction outbox insert
- multi-process claim lease + delivery/retry/preflight
- document and test at-least-once boundary

### F. Tool 和 prompt cleanup

- add `memory_save` 和 `/memory-health`
- remove old split search surfaces
- update tool guidance

### G. Legacy subsystem retirement

- remove legacy runtime registrations
- remove Dreamer Memory paths
- establish explicit Window schema baseline
- add non-destructive migrations
- only then delete unused implementation; this is a later cleanup ticket

### H. Package cutover

- remove `omp-agentmemory`
- verify only one bridge handles Capture/Inject/lifecycle
- update `CONTEXT.md` and supersede the relevant ADR before merge

### I. Rust/subc parity

如果 Rust/module path 仍啟用，最後同步 schema、tool facade 和 removed Memory RPC。不能留下 TS 寫 agentmemory、Rust 仍寫 mctx memories 的雙 owner 狀態。

## 33. 最終 invariants

| 問題 | 答案 |
| --- | --- |
| agentmemory backend/database/API 被修改？ | No |
| 開啟標準 agentmemory Docker 後可直接連接？ | Yes |
| mctx 有自己的 cross-session searchable store？ | No |
| mctx 有自己的 Durable Memory embeddings/RAG？ | No |
| Dreamer 仍維護 Durable Memory？ | No |
| Durable Memory canonical owner 是 agentmemory？ | Yes |
| agent-visible search 工具只有一個？ | Yes, `memory_search` |
| search 結果區分 current-session 和 agentmemory？ | Yes |
| Historian 和 tool 共用 remote retriever/Scope Gate？ | Yes |
| `/search` 被錯誤視為完全 strict？ | No |
| unknown project/agent scope 會被放行？ | No |
| shared v0.9.29 backend 提供嚴格 multi-agent write isolation？ | No；硬隔離需不同 instance/data volume |
| agent-scoped mode 會返回無 `agentId` 的 Lesson？ | No |
| recalled Memory 可自行生成新 Memory？ | No |
| provenance 只靠 ordinal？ | No |
| outbox 和 Window publication 原子提交？ | Yes |
| `/remember` delivery 是 exactly-once？ | No；at-least-once + best-effort dedup |
| HTTP request 在 SQLite transaction 內？ | No |
| agentmemory down 會破壞 Window？ | No |
| recomp/session upgrade 重複 promotion？ | No |
| 同時啟用兩個 OMP agentmemory bridge？ | No |

## 34. 最終定義

> Magic Context 管理目前 session 的 Window；單一 `memory_search` 聯合搜尋目前 session 和 agentmemory 並明確標示來源；Historian 使用 scope-validated agentmemory background 理解當前 history，並把只由當前獨立 evidence 支持的 durable candidates 經 atomic outbox、以 at-least-once 語義寫回 unmodified agentmemory backend。agentmemory 仍獨自負責跨 session 記憶的存儲、召回、融合和演化；需要硬 multi-agent 隔離時由部署分開 backend/data volume。

## 35. Source audit

- agentmemory Pi integration：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/integrations/pi/index.ts>
- agentmemory `/search`：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/functions/search.ts>
- agentmemory `/smart-search`：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/functions/smart-search.ts>
- agentmemory `/remember` dedup/write semantics：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/functions/remember.ts>
- agentmemory Lesson contract：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/functions/lessons.ts>
- agentmemory backend session lifecycle：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/triggers/events.ts>
- agentmemory public REST triggers：<https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/src/triggers/api.ts>
- local Window-only baseline：`packages/hepi/omp-mctx/README.md`
- local publication invariants：`packages/hepi/omp-mctx/src/core/hooks/compartment-runner-incremental.ts`
- local Pi raw-message projection：`packages/hepi/omp-mctx/src/read-session-pi.ts`
- local OMP session event contract：`packages/coding-agent/src/extensibility/shared-events.ts`
- local OMP turn-local custom-message injection：`packages/coding-agent/src/session/agent-session.ts`
