# mctx × AgentMemory：以穩定 context projection 取代 transient recall

日期：2026-09-07。狀態：研究與建議，**未實作、未成為新 ADR**。

研究基準：本地 `7cdedc645eaf4e82234ce5c7f91870f7d73e3e4c`；AgentMemory `v0.9.29` / `2d38dafede67d0d4ed920cde94d2106e98825b8a`。以下將 source facts 與 proposed contracts 分開；沒有實測 provider cache hit、成本或延遲。

## 結論

**不要把修復限縮成「換一個 hook」。應將記憶取用改為穩定、可重播、帶來源的 session context 事件，並讓 mctx 成為唯一的 Window projection owner。**

推薦的 production 基線是：

1. 固定的工具與使用規則；不在 system prompt 放每輪搜尋結果。
2. `memory_search` 作為主要的按需召回路徑；真實工具結果正常 append 到 history，不在下一輪移除或重新搜尋後覆寫。
3. 若產品必須保留自動 Inject，把它改為**一次取用、一次准入、可重播的 recall event**；不偽造模型 tool call，不維持另一套 turn-local ephemeral lane。
4. mctx 控制 context epoch：epoch 內凍結已呈現的 prefix；只有明確的壓縮、切換、撤回等邊界可重新投影，記錄原因並承認其 cache 成本。
5. Historian、Capture、promotion 使用來源與依賴標記防止 feedback，不再靠「從 history 刪除 recalled text」達成。

本方案不是第二套跨 session memory database。AgentMemory 仍擁有知識本身與演化；本地 event 只證明「此 session 在此時實際看過甚麼」。

## 1. 已核對的設計事實

### 1.1 Magic Context 是 Window owner，不是第二個 memory backend

本地 README 定義 mctx 負責 historian compaction、compartments、reduce/expand/note，AgentMemory 是未修改的 canonical Durable Memory backend。整合設計明確保留 m[0]/m[1]、protected tail、tags、Historian 與 current-session search，排除本地重做 embeddings、ranking、consolidation。[S1][S2]

這表示 **讓 mctx 決定哪些已發生的 recall/tool events 留在 active Window，符合它的責任；讓 mctx 持續同步、整理、排序一份可獨立搜尋的遠端知識庫，不符合責任。** 後半句是由 ownership 推導的架構判斷。

### 1.2 現有 mctx 已有 cache-aware 投影，而非絕對不變的 history

`context-handler.ts` 將 history refresh、system prompt refresh、pending materialization 分開；一般 execute 不應每次重建 history block。m[0] 應保留 cached bytes，新增 compartment 優先走 m[1] soft refresh；model/system/TTL/epoch/upgrade/mutation 等 hard signals 才重建 m[0]。[S3]

**不能因此宣稱今天的 mctx 是嚴格 append-only。** m[1] soft refresh 仍可能更改早於 live tail 的 provider input；只是保留較長的 m[0] prefix。推薦的 epoch contract 是進一步收緊的不變量，不是對現況的重新命名。

### 1.3 AgentMemory 的核心是持久記憶與跨 host interoperability

官方 README 把產品定位為 persistent memory，含 confidence/lifecycle/knowledge graph/hybrid search，支援 hooks、MCP、REST。官方 Pi adapter 同時提供 `memory_search`、`memory_save`、Capture 與 prompt-specific recall。[S4][S5]

但該 adapter 在 `before_agent_start` 將每輪 recall 與 TOOL_GUIDANCE 合併進 `systemPrompt`（322–335 行）。這是 host adapter 的實作選擇，**不是 backend API 的必要 contract，也不是可直接沿用的 cache 最佳實踐**。[S5]

所以「只採工具召回」保留 AgentMemory backend 的知識哲學與 API，但會改變官方 adapter 的自動召回 UX；不能假裝完全等價。如果自動召回是已承諾功能，需提供下述 durable recall event 路徑，而不是默默移除。

### 1.4 本地 transient recall、provenance 已是兩個不同機制

`inject-save.ts` 每輪搜尋、補 scope、排除 active remote session、寫入 turn taint，再回傳 `ephemeralMessage`。這些步驟並沒有證明完整 provider conversation prefix 穩定。[S6]

`historian.ts` 已將 retrieval 定義為 background、非獨立 evidence；source identity 含 hostEntry/toolCall/harness/content fingerprint/branch/projection。`capture.ts` 已排除 memory tools 的直接 observations。[S7][S8]

**不持久化不是 provenance。** 隱藏 recall 後，模型產生的文字仍可被 Capture 或 Historian 看見；是否能作為新記憶依據，必須由來源依賴判斷。工具結果原樣留在 session transcript 也不會因此自動成為新的 durable fact。

### 1.5 現有 hook 破壞的是 causal prefix，不只是 system-prompt cache key

目前第一輪 provider 實際看到的序列可簡化為：

```text
P | user-1 | recall-1  -> assistant-1
```

但 `AgentSession` 在回合結束後刪除 `recall-1`。第二輪因而是：

```text
P | user-1 | assistant-1 | user-2 | recall-2
```

兩次 request 在 `user-1` 後即分岔；更嚴重的是，重播的 `assistant-1` 看似沒有當初令它生成的 `recall-1`。這是 **causal history hole**，不是換 cache key 可以修復的計費細節。[S6][S10]

OpenAI 官方要求完整 rendered prefix 在 breakpoint 前一致，並明確建議 multi-turn 應保留 earlier messages、以 append 而不是 rewrite 維持 growing history；compaction/truncation 會重置重用。Anthropic 同樣要求 breakpoint 前 100% identical，且變更早期 message 會令該點後的 message cache 失效。[S11][S12]

本地 OpenAI Responses stateful path 還會比較 strict wire-history prefix；若 history 被改寫，就清掉 `previous_response_id` chain 並 full replay。換言之，這個 hook 同時傷害 provider KV prefix reuse 和 OMP 已有的 stateful append fast path。[S13]

## 2. 必須分開的四個維度

| 維度         | 責任與建議                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Instruction  | 固定工具 schema、固定操作規則；來源資料不能升格為 system authority。                                              |
| Presentation | TUI 顯示、折疊或隱藏；`display: false` 不代表沒有進入 provider，也不等於安全。                                    |
| Retention    | local transcript、mctx replay state、remote observation 與 provider retention 分別制定政策。                      |
| Provenance   | 原始 user/tool evidence、retrieval、retrieval-derived output、explicit save 分類；跨 compaction/branch 持續保留。 |

把這四者混成一個 `ephemeral` flag，無法同時表達安全、UI 與 cache 需求。此表是建議的 domain model，而非現有 OMP API。

## 3. 推薦架構：一個 Window owner，兩條 retrieval 路徑

```text
固定 system / tools
        │
        ▼
OMP session events ──────────► mctx ContextProjection(epoch E)
        ▲                                │
        │ immutable recall/tool results  ├── frozen base
        │                                └── append-only admitted tail
        │
        ├── explicit memory_search ──────┐
        └── optional automatic recall ───┤
                                         ▼
                             unified retrieval + scope gate
                                         │ public REST
                                         ▼
                               AgentMemory backend

Historian ──► current-session compartments
         └─► independent evidence candidates ─► atomic outbox ─► /remember
```

### 3.1 基線：tool-first retrieval

- 固定指示說明何時應搜尋：前次決策、使用者偏好、跨 session 背景或當前證據不足。
- 真實模型呼叫 `memory_search`；沿用同一個 unified search / scope gate，保留 current-session 與 remote 結果分組。[S9]
- tool call/result 按正常 session event append。後續 request 重播當時結果，不重新 hydrate 遠端 ID 來改寫舊結果。
- 新查詢可以拿到 backend 的新版本；以新 event 追加，不覆寫歷史。
- token 上限、scope、來源 metadata 在結果**首次准入前**處理，不能下一輪對舊結果換排序或截斷策略。

優點：使用原生工具語義與 persistence，容易觀測，沒有額外 provider turn 開始 hook。代價：模型可能漏用工具、可能多一輪 model/tool latency；需要任務型 recall evaluation，而非只看 cache hit。

### 3.2 自動召回：持久的 recall admission，而不是可消失訊息

自動 recall 可非同步預取，但必須有 admission boundary：

1. 綁定 session、branch leaf / user event ID、scope 和取消 token。
2. 搜尋、驗 scope、token-budget、去除本 Window 已可見的相同內容。
3. 生成 immutable recall event，保存實際呈現的 bytes 及來源 metadata；一次 append，之後 replay。
4. 若首個 provider request 已送出，結果只能在下一個合法 append 邊界進入；不能插回已送出的 user event 之前，也不能替換歷史 slot。
5. 從新 epoch 的 baseline 開始才可移除過期/壓縮結果。新的 provider context 與 epoch identity 一起發布。

自動事件應明確是 extension/tool-like context，**不要偽造模型曾呼叫某個工具**。是否可用既有 persistent custom message 完整實作，或需要一個通用 typed context event contract，須以 host persistence、resume、branch 和 projection 測試判斷；本研究不先承諾「不需要改 host」。

遠端搜尋失敗可不准入任何新 recall event；Window 繼續。若已准入，重試同一個 turn/branch 應 replay 同一 event，不再搜尋後替換，也不能因去重而讓原有 event 消失。

### 3.3 Context epoch：有限且可解釋的 prefix 重建

建議定義 `ContextProjection` 的 identity 包含 session、branch、epoch、renderer version 與實際 provider-relevant model/tool/system contract。不是把這些字串每次塞進 prompt，而是本地控制資訊。

- epoch 內：固定 baseline 與已送出 event bytes；只追加新 events。
- 候選 compartments 可在背景準備，但 publication 與 active prefix 重建分開。
- token pressure、explicit reduce/recomp、scope 切換、privacy revoke、不相容 renderer/model/tool/system 變更才切換 epoch。
- 每次切換記錄 earliest changed region、原因與預估 token；新 projection 原子發布，失敗維持 LKG。
- 若保留現有 m[1] soft refresh，應在指標中單獨記為「prefix-preserving partial rebuild」，不能稱為 strict append-only。

這比純粹刪除 hook 大：要把 mctx 的變更排程從個別 flags 收斂為可稽核的 projection commit。也不代表永久不壓縮；有限 context window 下，要求永久增長與永不失效不切實際。

## 4. Replay state 不等於第二套 Durable Memory

建議每個 recall event 最少保存：

- stable event ID、parent/branch identity、admission epoch；
- 已呈現的 body 與 digest；
- source kind + remote ID + retrieval scope + content hash；
- origin=`retrieval`、promotionEligible=`false`；
- 與後續衍生內容的依賴關係。

backend 若沒有 revision token，不虛構它；本地 content hash 只識別「當時看到的版本」，不是遠端真實版本 API。

本地只保留 session replay 需要的 selected snapshot，不建立跨 session remote content index，不同步完整 memory 表，不維護 supersession/ranking。當 backend 修改記憶，舊事件仍表示當時的觀察，新結果用新事件追加。語義 owner 與歷史快照不是競爭關係。

目前 `memory-search.ts` 回傳 details 只有 local/remote 數量與 partial errors，雖搜尋層有 ID/scope，tool event 尚未提供上述完整 provenance contract；不能以現況直接宣稱工具路徑已滿足全部需求。[S9]

## 5. Resume、branch、compaction 與 anti-feedback

### Resume

重建相同 epoch 時使用當時的 local snapshot bytes，不依賴可變的遠端搜尋結果。檔案損毀、snapshot 缺失或 schema 不相容時，明確新建 epoch；不得假裝舊 cache prefix 可重播。

### Branch / switch

分支只繼承祖先 events 與其 provenance；不借用 sibling branch 或另一 project 的 recall state。非同步 callback 回來時重新比對 scope/branch identity，過期結果丟棄。避免以 prompt 文本相同作為 turn identity。

### Compaction

可以壓縮「曾參考 memory X」這一 session 事實，但保留 retrieval-origin。不得把 recall 改寫成沒有來源的 user assertion，再拿去 `/remember`。原始證據與 retrieved background 在 Historian 的 input/output contract 中分欄。

### Promotion / Capture

- 直接 recall、memory tool output 不得重新 Capture 成獨立觀測證據。
- 助理文字是可能受 recall 影響的 derived output；刪掉原 recall 不會清除影響。
- coarse turn-taint 是安全 fallback，但會錯殺同輪讀取到的獨立檔案/工具證據；根本優化應使用 event/source dependencies，保留可獨立驗證的 evidence，而不是把整個 turn 永久禁用。
- explicit `memory_save` 是使用者/模型授權寫入路徑，不應自動被當成額外的獨立 evidence 再 promotion 一次。
- 不修改 AgentMemory observation schema 或 API 以塞入未知 taint contract。若 backend 不理解 provenance，bridge 應過濾不合格來源；不能期待 backend 自動識別 OMP taint。[S7][S8]

## 6. 隱私是必須明確承認的 trade-off

保留 exact prefix replay，通常需要在 subsequent requests 重送已准入的 recall；若也要求 restart 後 replay，就需要某種 durable local snapshot。

若「跨 session recall 絕不落本地磁碟」仍是硬要求，不能偷偷把 body 從 transcript 搬到 context.db / LKG，宣稱沒有持久化。選擇應是：

- memory-only projection：process 存活期可 replay；restart 必須新 epoch，承认 cold cache；
- 僅把必要的去敏摘要准入；完整資料不進主要 agent；
- 明確的隱私撤回：優先撤除敏感內容並切 epoch，接受 cache loss。

隔離子 agent 也不是免費解法：其回傳摘要仍可能含敏感/檢索來源資料，需同樣 admission 與 provenance。加密 local snapshot 是另一個資料保護策略，不等於「不落磁碟」。

## 7. 不推薦的替代方案

| 選項                                        | 判斷                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 把 ephemeralMessage 改成 systemPromptAppend | 將每輪變化推到更早的 prefix；不是根本修復。                                                           |
| 每輪只在最後插 recall，結束即刪             | 本轮插入位置较後不等於下一輪 prefix 一致；會移除已在 response 前出現的 context。                      |
| 每輪替換固定 m[1] memory slot               | 凍結 m[0] 有部分價值，但 m[1] 與後續 tail 仍受影響；不符合 strict append-only。                       |
| 只調 cache key / cache_control / TTL        | 不能把不同的 prefix 變成相同輸入；仍須遵守 provider contract。                                        |
| 保留 hook，再由 provider breakpoint 補救    | 最多保住 recall 之前的較短 prefix；不能修復缺失的 causal history，也不能恢復 strict stateful append。 |
| 永久保留所有 recall，不做壓縮               | 越用越肥，重複資訊與過時記憶污染 Window；需要 epoch 與 token admission。                              |
| 複製 AgentMemory DB 到本地統一管理          | 破壞 canonical ownership，並重建已排除的 durable memory 系統。                                        |
| 只停用自動 recall                           | 合理的風險止血，不是完整的 mctx projection、provenance 與 UX 解決方案。                               |

## 8. 上 production 前的 acceptance criteria（建議，未執行）

1. 真實 provider serialization 後比較相鄰 request 的 longest common prefix；工具回合、下一 user turn 不因 recall removal/refresh 修改已有 prefix。
2. 同 epoch 多次 context pass、retry、tool continuation 的相同 event bytes 一致；不以記憶體物件 identity 或內部 getter 相等替代。
3. recall-result snapshot 改不了祖先 branch；restart/backend down/backend memory update 不改寫舊 events。
4. compaction / LKG / fork / discard-last 保留 provenance；recalled text 自循環不得生成新 durable memory。
5. scope 切換後，遲到的 async results 不可准入；未驗證 scope 的結果不顯示。
6. 衡量 tool-first 漏召回率、實際任務品質、token 膨脹、TTFT 與端到端 latency；不能只優化 cache hit。
7. 用已記錄的真實 request/usage 對照 no-memory、現有 transient、tool-first、auto-event 各方案；provider/cache retention/model 必須相同，區分 cold/warm/epoch transition。
8. 本輪未跑任何實作測試、provider benchmark 或 remote jobs；研究結論不等於測試結果。

## 來源

- [S1] `packages/hepi/omp-mctx/README.md`，Owner、Window-only、Agentmemory bridge、Lineage。
- [S2] `docs/research/mctx+agentmem.md`，§1/3/4/5/33；既有設計，不當作 provider cache 證據。
- [S3] `packages/hepi/omp-mctx/src/context-handler.ts:320–341,2365–2389,4625–4661`；`src/core/hooks/compartment-render-epoch.ts:1–20`。
- [S4] [AgentMemory pinned README](https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/README.md)，本輪抓取。
- [S5] [AgentMemory pinned Pi adapter](https://github.com/rohitg00/agentmemory/blob/2d38dafede67d0d4ed920cde94d2106e98825b8a/integrations/pi/index.ts#L239-L336)，本輪抓取並核對搜尋、save、dynamic system prompt。
- [S6] `packages/hepi/omp-mctx/src/agentmemory/inject-save.ts:159–248`。
- [S7] `packages/hepi/omp-mctx/src/agentmemory/historian.ts:5–44,108–130`；其餘 candidate admission functions。
- [S8] `packages/hepi/omp-mctx/src/agentmemory/capture.ts:297–329`。
- [S9] `packages/hepi/omp-mctx/src/agentmemory/memory-search.ts:6–29,87–93,129–214,231–265`。
- [S10] `packages/coding-agent/src/session/agent-session.ts:6305–6353,6436–6455`；`packages/coding-agent/src/extensibility/extensions/types.ts:1138–1143`。
- [S11] [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)，本輪抓取；exact rendered prefix、preserve conversation history、explicit breakpoint 與 cache key contract。
- [S12] [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)，本輪抓取；exact match、hierarchical invalidation 與 breakpoint placement contract。
- [S13] `packages/ai/src/providers/openai-responses.ts:292–325,1029–1104`；strict history prefix、chain reset 與 explicit breakpoint policy。
