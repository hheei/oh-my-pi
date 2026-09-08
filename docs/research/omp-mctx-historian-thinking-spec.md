# Historian thinking level — Working spec

状态：待实现。用户确认 A/A/A/A；仅记录设计，未修改产品代码。
流程来源：`skill://ask-matt` → grill-with-docs → to-spec。
研究依据：[Historian thinking source audit](omp-mctx-historian-thinking.md)。

## Problem Statement

Historian 的 thinking override 存在于 schema，但未接通 shipped ext settings。未传 thinking flag 不等于 none/off，也不保证最低 effort：child 可能采用 selector、模型默认或全局默认。需要可配置的 Historian thinking，且未显式覆盖时使用每个实际候选模型的最低可控 effort。

## Solution

提供统一的 Historian thinking 设置，默认采用模型最低 effort，覆盖所有可控 reasoning 模型。显式关闭或指定 effort 仍可用。每个候选独立解析；provider wire normalization 继续由现有 catalog/pi-ai 负责。

## User Stories

1. 用户未设置 thinking 时，使用模型最低可控 effort，而非继承较高的全局默认。
2. 用户可以通过 ext settings 配置 Historian thinking，而不依赖 schema-only 字段。
3. 显式 off 保持关闭请求，不被默认策略覆盖。
4. 显式 effort 优先于模型 selector suffix。
5. 没有独立 override 时，已有 model selector thinking suffix 继续生效。
6. fallback 按自身模型能力运行，不继承 primary 的预计算最低档。
7. first、repair、editor 与历史重整命令遵循同一 thinking 规则。
8. 动态模型在父进程无法解析 metadata 时仍能由 child 尝试运行，并提供诊断。
9. 无可控 reasoning 的模型不被强制发送 off 或虚构 effort。
10. 维护者不必在 mctx 重复维护 provider policy。

## Implementation Decisions

### 已确认产品合同

- 优先级：显式 Historian thinking setting > 当前 candidate selector 的 thinking suffix > 模型最低 effort。
- 默认覆盖所有可控 reasoning 模型；采用 `minimumSupportedEffort` 语义，不以 `defaultSupportedEffort` 替代。
- metadata 无法解析：省略 thinking flag，记录模型与原因的 warning，允许 child 使用既有 resolution。不新增失败、重试或 off/none 转换。
- 已解析模型没有可控 effort：省略 thinking flag。这是正常 capability 状态，不作为 metadata 查询失败告警。
- 接通 settings、UI、manifest 与配置映射，不继续保留 schema-only 的用户配置入口。
- 合法显式档位：off、minimal、low、medium、high、xhigh、max。none 不是 Pi selector。

### 配置与实现边界

- UI 默认项明确显示“模型最低档”；建议持久化 sentinel 为 `minimum`，映射到内部默认策略，不能原样传给 child。
- Pi `auto` 是另一种分类策略，不等于模型最低档。不得生成 `--thinking auto`、`--thinking minimum` 或 `--thinking none`。
- 旧配置未设置字段时采用新 minimum policy；显式 level 与 suffix 按优先级保留。
- Historian policy 集中于 fork-owned 模块。复用 catalog 最低 effort 算法与公开模型解析能力，不复制 ladder、provider policy、ModelRegistry 或冒号解析器。
- 使用运行时 metadata，不仅查 bundled catalog；查询失败走已确认的 unresolved 行为。
- 实施时核对能同时保留 selector effort 和解析模型的公共 API；只有确有缺口才增加窄接口，不预先承诺扩展整个 Extension API。
- 在每个 attempt 的模型确定后解析 effort，不把 primary 的具体 effort复制给 fallback。共享 runner 如需 model-aware hook，必须可选，保持其他 caller 的原有行为。
- 正常 Historian 由自身 runner 管理 validation fallback，transient retry wrapper 会清除 runner-level fallbackModels；recomp 等路径仍可能使用共享 runner model chain。两条路径均需覆盖。
- first、repair、editor、configured fallback、session-model fallback 和 recomp model override 都对当前候选应用相同策略。
- 保留现有 editor 模型选择。此前提出“editor 跟随 draft 生产模型”未经用户确认，且不是 thinking 设置所必需，不纳入本次变更；无论 editor 选择哪个模型，都应按该模型解析 thinking。
- provider mandatory-reasoning、collapsed route 和 wire disable normalization 保持原状。最低 selector 不保证 provider 最终 wire 永远是字面最低档。

## Testing Decisions

- 优先现有配置入口与 child invocation 行为测试；不新增源码文本断言或多层重复测试。
- 配置：默认与显式值通过 shipped settings 路径生效；none 被拒绝；旧配置默认采用 minimum。
- 优先级：显式 off/high 胜过 suffix，suffix 胜过 minimum，无 override 使用候选最低档。
- 模型边界：不同最低档候选、无可控 effort、unresolved metadata。后两者 omit，只有 unresolved 产生查询失败诊断。
- fallback：正常 Historian 手动 fallback 与 recomp 共享 runner chain 各覆盖真实独有路径，证明未复制 primary effort。
- repair、editor 与 model override 对当前候选解析；不改变 editor 模型选择。
- 真实 child argv 不含内部 sentinel、auto 或 none；显式 off 保留。
- catalog sparse-ladder/minimum 的既有测试作为算法依据；不在 mctx 重复整套 provider wire 测试。
- 实施后运行 focused tests、可控 child invocation smoke 与仓库要求的检查。本文未运行产品验证；smoke 必须证明行为，而非仅证明启动成功。

## Out of Scope

- 改变 editor 模型 provenance、fallback 顺序、failure classification 或 retry policy。
- 新增 provider wire none 映射、禁用参数或 mandatory-reasoning 特判。
- 新建 mctx model registry 或复制 effort 算法。
- 修改 dreamer/sidekick 默认 thinking。
- 本轮实现代码、创建 GitHub issue、提交或推送。

## Further Notes

- 原研究核心判断成立：未设置不等于显式 none。默认顺序及 mandatory normalization 应补充下述限制。
- 模型 defaultLevel 可能早于全局 defaultThinkingLevel 生效；未配置不能概括为固定 high。Historian child 使用 --no-session，不依赖既有 session thinking。
- mandatory normalization 可能采用 route-aware defaultSupportedEffort，不能概括为所有 provider 都发送 minimumSupportedEffort。
- 未发现已配置的 Matt issue tracker 文档；本次按用户要求保存本地 spec。后续若要发布 tracker，需完成 `/setup-matt-pocock-skills` 并获得明确发布授权。
