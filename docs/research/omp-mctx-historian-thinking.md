# omp-mctx Historian thinking 設定與 `none` 能力調查

日期：2026-09-07。狀態：source audit，未修改產品程式碼、未執行驗證套件。

研究範圍：`packages/hepi/omp-mctx/` 的 Pi extension、Historian runner，以及其實際使用的 coding-agent / pi-ai / catalog thinking plumbing。既有研究筆記放在 `docs/research/`，採「結論 → 已核對事實 → source audit」並以 `[S#]` 引用；本筆記沿用此慣例。

> **2026-09-08 實作更新。** `historianThinkingLevel` 現為 ext-core setting，會映射到 `historian.thinking_level`，讓 model 與 reasoning 分開設定。實作見 `packages/hepi/omp-mctx/src/config/index.ts` 與 `packages/hepi/omp-mctx/package.json`。

## 結論

1. **目前 omp-mctx Historian 沒有被程式無條件強制成 `none` 或關閉 thinking。** Pi-facing 的可用值是 `off | minimal | low | medium | high | xhigh | max`；`none` 不是 Historian config 的合法值。[S1][S2]
2. **正常的當前 ext-core 設定路徑甚至不會帶 `historian.thinking_level`。** schema 雖接受可選欄位，但 `resolvePiMctxSettings()` 只把 enabled/model/two_pass 等欄位組回 Historian，settings UI/package manifest 也沒有 thinking-level 欄位。因此一般 `/ext-settings` 設定 Historian model 時，`thinkingLevel` 是 `undefined`，不是顯式 `off`，更不是顯式 `none`。[S3][S4][S5]
3. 如果另一個已驗證的 config caller 明確提供 `historian.thinking_level: "off"`，它會被傳給 Pi child 作 `--thinking off`；`off` 是 Pi agent-level 的「disable reasoning」，不是 provider wire 上一定叫 `none` 的值。[S6][S7][S8]
4. 若所選 model 沒有 provider 的 `none` 關閉 lane，**mctx 不會自行改寫成 `none` 或自動換 thinking level**。Pi 的 `off` 先轉成 `reasoning: undefined + disableReasoning: true`；provider 再依自身 dialect：OpenAI-compatible 的 generic `lowest-effort` policy 會送該 model 的最低支援 effort，`none-effort` policy 才送 wire `reasoning_effort: "none"`；mandatory-reasoning model 也會由共用 normalize path 壓到最低支援 effort。[S9][S10][S11]
5. 若把字串 `none` 繞過 mctx schema 直接塞入 child CLI，它不是可接受的 Pi selector：parser 回傳 `undefined`，CLI 只記 warning、不設定 thinking，後續回到 Pi 的普通 default resolution。這是「忽略非法 selector」而非「強制關閉」；目前沒有證據顯示 mctx 會主動把它轉成 `off`。[S12][S13]

## 已核對的 code path

### 1. Historian 的設定來源與預設

- `PiThinkingLevelSchema` 明列七個 Pi selector 且 `.optional()`，沒有 `none`；`HistorianConfigSchema.thinking_level` 同樣是 optional，描述也明列合法值與「顯式傳作 `--thinking <level>`」。[S1]
- 空 config 的 schema test 預期 `result.historian` 是 `undefined`，沒有任何預設 thinking level。[S14]
- 實際 ext-core snapshot 由 `resolvePiMctxSettings()` 建立：它讀取 historian enabled/model/two-pass，但產出的 `historian` object 沒有 `thinking_level`。[S3] UI fields 只列 `historianEnabled`、`historianModel`、`historianTwoPass`、timeout 等，也沒有 thinking level。[S4] package manifest 的 settings 同樣只有 `historianEnabled` 與 `historianModel`（示例 model selector 是 `:high`，不是 `none` thinking config）。[S5]
- `resolveHistorianFromConfig()` 在 model 存在且未 disabled 時，將 `historian?.thinking_level` 原值放入 `PiHistorianOptions.thinkingLevel`，沒有 fallback 常數或 `off`/`none` 強制值。[S6]

### 2. Historian invocation 到 child argv

- context handler 的 `PiHistorianOptions.thinkingLevel` 註明：未設定時由 Pi 自己 resolution；觸發 Historian 時把它原值傳進 `runPiHistorian()`。[S7]
- Pi Historian runner 將相同的 `thinkingLevel` 放入 first pass 與 repair pass 的 `SubagentRunOptions`。[S8]
- `buildArgs()` 僅在 `options.thinkingLevel` truthy 時追加 `--thinking <level>`；未設定就完全沒有 flag。[S9] 既有測試明確確認未設定時 argv 不含 `--thinking`，並註明這會交給 Pi own resolution。[S10]
- 因而「未設定」是 default/effective resolution，不等於顯式關閉；「顯式 `off`」才是 forced no-reasoning request。另有 shared runner contract 直接把 `off` 說成 speed/local-model 的 disable-thinking 選項。[S11]

### 3. `off`、wire `none`、model capability 的界線

Pi agent core 的 selector type 只有 `inherit`、`off` 與 effort levels，沒有 `none`。[S12] coding-agent parser 的 selector map 也只有 `inherit/off/minimal/low/medium/high/xhigh/max`；未知值（含 `none`）回傳 `undefined`。[S13] CLI flag handler 對 invalid value 僅發 warning，不設定 result.thinking。[S13]

有效的顯式 `off` 在 coding-agent 的 model resolution 中被特別保留，不經 effort clamp；送 provider 前 `toReasoningEffort(off)` 回傳 `undefined`，`shouldDisableReasoning(off)` 回傳 `true`。[S15] 所以 mctx 的 `off` 是 harness semantic flag，provider 是否用 wire `none`、`enabled:false`、budget 0、或最低 effort，取決於 provider model metadata/compat policy。

具體 provider evidence：

- `resolveOpenAICompatPolicy()` 以 `disableReasoning` 計算 disabled；若該 compat 是 `none-effort`，wire effort 設為 `"none"`；若是 `lowest-effort` 且 caller 沒有 requested effort，則取 `getSupportedEfforts(model)[0]`，沒有任何支援 effort 時明確丟 `AIError.ConfigurationError`。[S16]
- 對 generic OpenAI-completions effort model 的測試，`disableReasoning: true` 實際送最低支援 `minimal`；Fireworks model 則因其 mapping 把最低 effort 映射成 provider 支援的 `none` literal。[S17] 這證明 wire `none` 不是 mctx 的固定設定，而是 provider policy/mapping 的結果。
- 共用 `normalizeMandatoryReasoningOptions()` 說明 `thinking.requiresEffort` 的 endpoint 拒絕 disabled/omitted thinking 時，改壓到最低支援 effort；若 model 支援 provider-side off suppression，則保留 provider 的顯式 suppression。[S18]

## unsupported `none` 時的 failure/fallback

這裡的「unsupported `none`」要分兩種，不應混稱：

1. **Provider 沒有 wire `none` lane，但接受 disable semantic：** mctx 不報錯，也不自行補 lane；上述 provider policy 可能送最低 effort或另一種 disable 欄位。generic lowest-effort 與 mandatory-reasoning 的程式/測試證據如 [S16]–[S18]。因此不能把「Pi `off`」直接推論成「一定發 `none`」。
2. **非法 Pi selector `none`：** mctx schema 正常解析時不接受；若繞過 schema 送到 `--thinking none`，Pi parser 警告並忽略該 flag，回到未設定 thinking 的 default resolution，而不是 fallback 到 `off`。[S1][S13] 目前沒有 repo 證據顯示此情況會由 mctx 轉碼。

Historian 有兩層 fallback，但都**不會因 model 缺 `none` 而自動改 `thinkingLevel`**：

- `PiSubagentRunner.runModelChain()` 對 child 結果僅在 `model_failed`、`truncated`、`non_zero_exit`、`no_assistant` 等 eligible reason 才嘗試下一個 model；每個 attempt 複製相同 options。[S19]
- Historian runner 在 first/repair 產出無法 validation 時，會按 configured fallback 與最後的 session model 執行；fallback options 仍傳入同一個 `thinkingLevel`。若所有候選都失敗，會記錄 historian failure 並通知，而非隱式降級為 no-thinking。[S20]

因此，若 provider 真正因不接受某個 wire thinking 形狀而回 error，是否進入下一個 model 取決於 child result 被分類成的 failure reason；即使進入 fallback，當前 code 仍沿用同一個 explicit `thinkingLevel`。未找到 mctx 專門捕捉「none 不支援」並改用 `off`、最低 effort或移除 flag 的分支；provider-specific handling 屬 pi-ai layer。

## Source audit

- **[S1]** `packages/hepi/omp-mctx/src/core/config/schema/magic-context.ts:26-33,207-223` — Pi thinking enum 與 Historian optional field/合法值。
- **[S2]** `packages/hepi/omp-mctx/src/core/shared/subagent-runner.ts:38-57` — shared runner 對 `thinkingLevel`/`off` 的 contract。
- **[S3]** `packages/hepi/omp-mctx/src/config/index.ts:145-200` — ext-core settings snapshot 組裝 historian 欄位。
- **[S4]** `packages/hepi/omp-mctx/src/config/index.ts:258-326` — UI settings field 清單，沒有 thinking-level field。
- **[S5]** `packages/hepi/omp-mctx/package.json:45-54` — manifest settings 只有 historian enabled/model，model 示例為 `:high`。
- **[S6]** `packages/hepi/omp-mctx/src/index.ts:445-491` — resolver gate、model 與 `thinkingLevel` plumbing。
- **[S7]** `packages/hepi/omp-mctx/src/context-handler.ts:735-761,3101-3124` — Historian option contract 與 invocation threading。
- **[S8]** `packages/hepi/omp-mctx/src/pi-historian-runner.ts:304-346,805-823,843-873` — runner deps、first/repair pass 傳值。
- **[S9]** `packages/hepi/omp-mctx/src/subagent-runner.ts:1501-1521` — model 與 conditional `--thinking` argv。
- **[S10]** `packages/hepi/omp-mctx/test/subagent-runner.test.ts:201-230` — unset thinking 時無 `--thinking` 的 regression test。
- **[S11]** `packages/hepi/omp-mctx/src/core/shared/subagent-runner.ts:47-57` — `off` 的 contract 說明。
- **[S12]** `packages/agent/src/thinking.ts:1-20` — Pi agent selector type，只有 `off`、efforts、`inherit`。
- **[S13]** `packages/coding-agent/src/thinking.ts:48-90,99-129`；`packages/coding-agent/src/cli/flag-tables.ts:195-204` — parser、invalid warning、off 到 provider options 的轉換。
- **[S14]** `packages/hepi/omp-mctx/test/core/config/schema/magic-context.test.ts:10-41` — empty config 無 historian 預設。
- **[S15]** `packages/coding-agent/src/thinking.ts:102-129` — `off` 保留、`reasoning` undefined、`disableReasoning` true。
- **[S16]** `packages/ai/src/providers/openai-shared.ts:893-955` — `none-effort` / `lowest-effort` 與無 supported efforts 的 error。
- **[S17]** `packages/ai/test/openai-completions-disable-reasoning.test.ts:88-124` — generic 最低 effort、Fireworks wire `none`、OpenRouter disabled dialect。
- **[S18]** `packages/ai/src/stream.ts:1935-1959` — mandatory reasoning 時 disabled → lowest supported effort 的 normalize policy。
- **[S19]** `packages/hepi/omp-mctx/src/subagent-runner.ts:525-570,1304-1310` — child model chain 與 eligible failure reasons。
- **[S20]** `packages/hepi/omp-mctx/src/pi-historian-runner.ts:889-957` — Historian fallback 候選仍使用同一 `thinkingLevel`，全失敗時記錄/通知。
