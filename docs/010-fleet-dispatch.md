# 010 Fleet 派工集成设计

> **状态：设计提案，尚未实施。** 本文描述的目标行为在代码落地前都不成立。文中"现状"一节记录的是 2026-11-05 对 `local.8` 代码的只读核查结果；"目标"一节描述的是拟议行为。两者不可混读。

本文是 [001 Domain model](001-domain.md) 到 [007 Architecture](007-architecture.md) 的一条支线：把 superagent 的 Executor 从"亲自写码的工人"改造成"指挥外部模型工人并对其产出做异族评审的工头"。既有文档描述今天的行为，本文描述明天要建的那条链路，以及建它的理由、边界和验收方式。

## 1. 背景与目标

### 1.1 为什么做

superagent 今天的执行链路是"一个 DSH Session 写完全部代码"：`executor.model` 固定一个模型，`maxWorkers` 允许最多 16 个 Ticket 同时开工，产出由人（`person/review`）验收。三个问题随之而来：

1. **单点产能与单点盲区。** 一个模型同时负责实现和自检，同族的偏好与盲区没有任何外部对照。Code Review 类任务里，这正是异族评审存在的理由。
2. **模型选型靠配置而非靠任务。** `executor.model` 是一个全局静态值（`src/policy.ts:93-106`）。一个批量文本改写任务和一个跨模块重构任务用同一个模型，既不省成本也不合适。
3. **额度与健康无人管。** 本机已有 `fleet` 派工机制（`~/.agents/skills/fleet/`），它有工人登记表、真实能力自检、额度池冷却、按族隔离的评审规则和换人链。superagent 没有接它。

### 1.2 目标

- **G1 选人由宿主按证据决定。** 谁来干活由 fleet 的健康与额度证据决定，不由模型的自由裁量决定。
- **G2 产出经异族评审才可交付。** 委派产出的代码在拿到一个"家族与额度池都不同于生产者"的评审结论之前，不得标记为 ready。
- **G3 分工有两层。** 卡内用 fleet 的角色链（reader → builder → critic）分派；卡外用 DSH 原生子代理做只读摸底。
- **G4 委派在领域层可见。** 委派是 Ticket 的一等状态，不是散落在日志里的一段对话。

### 1.3 非目标

- **N1 不在 superagent 里重造路由、健康或额度体系。** 那是 `fleet` 与 `~/.agents/bin/dispatch-health.py` 的职责，superagent 只消费。
- **N2 不做多角色层级团队。** 仓库级任务上角色分离的层级团队收益递减（见 [Adversarial Review](https://arxiv.org/abs/2608.18167)）。今天的三段式——工人、异族评审、工头裁定——已经是足够的层级。
- **N3 不让模型自己指名工人、自己挑评审者、自己勾免费档。** 这三件事各自都是一次无监督的裁量。
- **N4 不改变 superagent 的准入与授权模型。** Trigger → Eval → Decision → Ticket 的链路和 Mandate 规则不动。

## 2. 现状（2026-11-05 只读核查）

### 2.1 角色与执行链路

| 角色 | 载体 | 职责 | 模型来源 |
|---|---|---|---|
| Orchestrator（主 Session） | preset `dsh-superagent-router` | 只路由，不做技术判断；产出不超过 30 词的 routing note | `eval.model`（`src/app/sessions.ts:182`） |
| Executor（工人 Session） | preset `dsh-superagent-worker`，每 Ticket 一个 Session | 调查、实现、验证、建 PR、决定人类跟进 | `executor.model`（同上） |

模型在 Session 创建时注入一次，之后不变（`src/app/role-models.ts:15-20`）。没有按任务选型、没有 fallback 链。

### 2.2 领域模型现状

- Ticket 的 stage 是派生值，规则按表自上而下**首条命中**（`src/core/stage.ts:9-21`）：ended → person/delivery → person/answer → person/review → person/blocked|failed → working/queued → idle → working。
- Ticket 没有委派的概念。`Ticket` 接口（`src/core/model.ts:281-311`）有 `assignments`、`inputs`、`execution`，没有 `delegations`。
- 持久化是"整张 Ticket 一个 JSON 值"：`ticket(id PK, value TEXT)`，另有 kv / trigger / disposition / thread / decision / outbox / trigger_thread / effect 九张表（`src/app/store.ts:71-87`），`SCHEMA_VERSION = 11`（`src/app/migration.ts:20`）。
- 域内没有 reviewer / critic / verdict 角色。代码与文档里的 "reviewer" 一律指 GitHub 上的人类或机器人评审者；`person/review` 是人工闸。

### 2.3 已有的 fleet 接线

`src/app/tools/fleet.ts`（92 行）注册了 `orchestrator_fleet` 工具：

- 子命令白名单 `card / run / review / verdict / ls / status / critics`（`:12`）；每个子命令有各自的 flag 白名单（`:14-19`）。
- 参数在调用前全量校验（`:22-65`）：工人名匹配 `/^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/`；项目操作数必须等于工单目录；任务目录必须落在 `<工单目录>/.fleet/tasks/` 下且 realpath 一致（`:50-53`）；`.fleet` 不得是符号链接（`:44-49`）；`--role` 只收 `builder|reader|mass`（`:61`）；verdict 只收 `pass|rework|escalate|close`（`:63`）。
- `run` 与 `review` 走后台 job，立即返回 `job_id`，完成后以 `steer` 消息 `fleet_result` 唤醒工人 Session（`:81-89`）。
- 工具只在 `executor.fleet.enabled` 为真时注册，且每次调用重新检查开关（`:68-69`、`:77`）。
- 配置项 `executor.fleet = { enabled, bin, timeoutMinutes, reportMaxChars }`（`src/policy.ts:98-103`），`enabled` 默认 false。

### 2.4 提示词级"工头"契约

`prompts/work.md:51` 与 `prompts/worker-general.md:27` 写着："For complex work, act as foreman (工头) with youxiyin-fleet via the available host fleet tool: write a card → `fleet run @<type>` → fleet review by a different model family → verify artifacts and acceptance yourself → `orchestrator_report`."

这段话是**团队可编辑的文本层**（见 [004 Prompts](004-prompts.md)）。它既不强制，也不可靠：一次文案改动就能删掉"异族 review"这半句。

### 2.5 实测证据（2026-11-03 冒烟）

`~/.dsh/sessions/--Volumes-Macssd-~5DE5~5355-20261103-fleet-superagent-honglou-superagent-smoke--/worker-*/session.v4.jsonl.zstd` 记录了唯一一次真实 fleet 冒烟：

- 工人 Session 自己用 bash 读了 `~/.agents/skills/fleet/routing.json` 与 `workers.json`，然后写下 `argv: ["run", "codex", <任务目录>, "--timeout", "300"]`。**`@<type>` 链从未被真正使用，fleet 自己的链解析、准入与健康证据全部被绕过。**
- 该 Session 只有 `run`，**没有 `review`**。评审全部由主控在事后用 `fleet review` 完成。
- 产物 receipt.txt 经字节核验通过，但报告标记"部分完成"：fleet 自己的 `stderr.log` 被改动，未满足"其他文件不变"。

结论：现有接线证明了"能调通"，没有证明"按机制运行"。

### 2.6 fleet 侧现状

| 事实 | 出处 |
|---|---|
| CLI 无 JSON 输出模式；`fleet run` / `fleet review` 阻塞到结束 | `~/.agents/skills/fleet/bin/fleet` |
| 链定义 `code / complex / bulk / survey / zh-text / visual / review`，按 `routing.json` 的 `chains` 依次尝试 | `~/.agents/skills/fleet/routing.json`；SKILL.md:77 |
| 角色语义 `builder / reader / mass / critic`；文本任务必须显式选角色 | SKILL.md:23, 56 |
| 卡片「任务类型」必填，取值只能是 `code/complex/bulk/survey/zh-text/visual/structured/research`；**直接点名工人的 `fleet run` 以退出码 2 拒绝**，`fleet run @类型` 放行并把实际链名写入 `meta.task_type` | SKILL.md:36 |
| 换人只发生在不可用（401/403/429/529、限流、额度、超时、未准入、退役）；**质量失败不换人**，退出码 5 交人工 | SKILL.md:77, 88 |
| 评审族冲突（critic 与生产者同族、或 critic 族为 mixed/unknown）退出码 4 | SKILL.md:88 |
| 生产者族推导：取本卡最后一次 builder/mass/reader run 的 family；没有 run 时以退出码 2 拒绝 | `bin/fleet:2904-2914` |
| `fleet review --producer-family <族>` 可声明**外部**生产者（族名须已知，且不得与本卡已有 run 冲突，冲突退出码 4）；meta 记 `producer_provenance=external_declared` | SKILL.md:116；`bin/fleet:2906-2911, 2926-2927` |
| M / L / critical 卡要求至少两个候选，且 family 与 quotaPool **都**不同 | SKILL.md:41 |
| 带结论评审默认最多 3 轮（卡片「评审轮数上限」可改），达到后退出码 2；`--extra-round` 每任务只放行一次 | SKILL.md:86 |
| 评审正文缺 `## 结论：通过 / 需返工` 行，退出码 7（review.md 仍保存） | SKILL.md:62, 88 |
| 评审 diff 基准默认 `refs/fleet/<task_id>`（builder 启动时快照），无 ref 退回 HEAD；评审只附卡片「允许修改」内的 diff | SKILL.md:85, 86 |
| `report.md` 必须是本次新写的，旧回执判 `missing-report`；输出截断判 `truncated` | SKILL.md:62 |
| 自检证据 72 小时内有效，写 `~/.agents/fleet/health.json`；有 `route_id` 的工人先查 `dispatch-health.py select`，探针停摆期间以 72 小时内的 selftest 作临时证据 | SKILL.md:26, 83 |
| `fallback_only` 工人被直接点名时退出码 6，只有加 `--as-fallback` 才放行 | SKILL.md:81 |
| `quota_gate: claude` 的工人在周额度 ≥80% 等情形下退出码 6，且不可被 `--skip-admission` 跳过 | SKILL.md:82 |
| 材料敏感度：`internal/restricted` 不走免费渠道；`data_policy`（no-train/may-train/unknown）与 `promo_until` 由 workers.json 声明 | SKILL.md:38 |
| opencode 系工人共用一个 sqlite，fleet 用 `serial_lock` 与 `~/.agents/fleet/locks/opencode-sqlite.lock` 串行化，等待超时退出码 3 | SKILL.md:92, 106 |
| 目标节超过 3 条或预算节超过 60 分钟时，fleet 提示拆成阶段卡（只提示，不拦截） | SKILL.md:46 |
| `~/.agents/bin/dispatch-health.py select --role R --capability C [--producer-family F]` 输出 JSON，退出码 0 有候选 / 3 无候选 | 该脚本 |
| 两套证据体系并存：`dispatch-health` 读 `~/.agents/routes.json`（TTL 26 小时），fleet 读 `health.json`（TTL 72 小时） | 两个脚本各自实现 |

**这张表带来的第一个结论：fleet 已经强制了本设计里大半的护栏。** 直接指名工人（退出码 2）、免费档与敏感度的分流（`data_policy`）、opencode 串行（`serial_lock`）、额度闸（`quota_gate`）、质量失败不换人（退出码 5）——这些都不需要在 superagent 里重写一遍。superagent 要做的是**把正确的用法接上，并且让错误用法尽早、清楚地失败**，而不是自己造一套判定逻辑。

`fleet status` 实测（2026-11-05）：code → `kimi-k3-1-pro`，review → `bigmodel-glm-5-3`，visual → `codex`；**bulk、survey、zh-text 当前无可用工人**。

### 2.7 DSH 原生能力（可复用的现成件）

- `packages/subagent/` 已有多个 provider：`spawn` / `fork`（进程内）、`codex`、`claude-code`、`acp`、`dsh-sdk`（进程外）。注册在 `ctx.subagents` 上，可共存。
- `AgentOptions.provider` 与 `AgentOptions.model`（`packages/core/agent/src/runtime-types.ts:24-31`）可钉住子代理的 provider 与模型。
- `SubagentStartRequest.maxDepth` 是绝对委派深度上限（`docs/subsystems/subagent.md:79`）；`toolFilter` 与 `persona` 可按子代理裁剪。
- superagent 的工人 preset 已开启 `tool-subagent`，配置为 `provider: spawn`、`modelSelection: true`、`modelDiscovery: true`（`cordis.patch.yml:102-111`）。

## 3. 已确认的决策

| 决策项 | 结论 |
|---|---|
| 代码落点 | 改 superagent 本体，不新建插件，不改 fleet CLI |
| 选人权 | 宿主按 fleet 证据选；模型只能填任务类型 |
| 评审强度 | 硬闸：异族评审通过才可 ready |
| 分工层级 | L1（fleet 卡内角色链）+ L2（DSH 会话内子代理）+ Executor 降格为工头 |

**由这些决策推出的连带约束（关键）：**

> **凡是需要评审的产出，必须有唯一可归属的生产者族。**

fleet 的生产者族推导在 `review_producer`（`~/.agents/skills/fleet/bin/fleet:2904-2914`），有三条路径：

1. 卡上有 builder / mass / reader 的 run 记录时，取**最后一次** run 的 family；
2. 没有 run 记录时，直接评审以退出码 2 拒绝（"没有 builder run，无法确定生产家族"）；
3. `fleet review --producer-family <族>` 可以声明**外部**生产者（SKILL.md:116），但声明的族必须在 workers.json 的已知族集合内，且不得与本卡已有 run 的 family 冲突——冲突以退出码 4 拒绝。

所以"Executor 自己写码再送评审"并不是 fleet 的禁区，但需要宿主替 Executor 声明族。那是一次**自我担保**：Executor 的 provider 未必对应 workers.json 里的某个族，声明错了 fleet 也无从发现（fleet 只校验"族名已知"和"不与已有记录冲突"）。

因此 P0 阶段选择更严的一条：**Executor 只做工头，一行码都不写**；写码全部走 fleet。L2 的 DSH 子代理**只用于只读摸底**，不产出需评审的代码。这样生产者族直接来自 run 目录的 `meta.json`，不需要任何声明，评审归属唯一且可复核。宿主仍然**在 fleet 工具里实现 `--producer-family` 的透传**（§8.2），以备将来 Executor 真要产出可评审产物时有一条受控通路，而不是靠模型绕过工具去调 fleet。

## 4. 目标架构

### 4.1 两个控制面

```
┌─ 工单层控制面（superagent）────────────────────────────┐
│  Source → Eval → Decision → Ticket(Mandate)             │
│  Orchestrator：只路由                                    │
│  Executor = 工头：拆卡 · 选型 · 验收裁定 · 报告           │
│  职责边界：决定"这个工单要做成什么样"，不决定"谁来做"     │
└──────────────────────────────────────────────────────────┘
                    │  委派（受限 argv 工具）
                    ▼
┌─ 执行层控制面（fleet）─────────────────────────────────┐
│  card → run(链解析 + 准入 + 额度 + 自检证据)              │
│       → review(异族) → verdict                           │
│  职责边界：决定"谁来做、用哪个模型、能不能做"             │
└──────────────────────────────────────────────────────────┘
```

两个控制面不重叠：superagent 不读 `routing.json`，fleet 不知道 Ticket 与 Mandate 的存在。

### 4.2 委派生命周期

```
Executor 判定"这活超出我一个人"
  └─ card          写卡：任务类型 / 输入白名单 / 验收 / 禁区 / 预算
      └─ run       fleet run @<type> <任务目录>   → 后台 job_id
          └─ 工人产出 report.md + refs/fleet/<slug>
              └─ review    fleet review <任务目录> --critic <异族>  → 后台 job_id
                  （--critic 与 --producer-family 由宿主填，Executor 不填）
                  └─ review.md（含「结论：通过 / 需返工」）
                      └─ verdict   fleet verdict <任务目录> pass|rework|escalate|close
                          └─ Executor 独立复核产物 → orchestrator_report ready
```

每一步失败都落在明确状态（见 §5.2），失败不是静默重试。

### 4.3 禁止交叉

- Executor 不得直接读 `~/.agents/skills/fleet/routing.json` / `workers.json` / `health.json`，也不得用 bash 调 `fleet`。它只有 `orchestrator_fleet` 一个入口。
- Executor 不得指名具体工人；只能给链类型（`@code` / `@complex` / `@bulk` / `@survey` / `@zh-text` / `@visual`）。
- Executor 不得选择评审者；评审者由宿主按 §6.3 选。

## 5. 领域模型变更

### 5.1 新增 Delegation

`Ticket` 增加一个可选数组（`src/core/model.ts`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 卡 slug，与 `<工单目录>/.fleet/tasks/<slug>` 同名 |
| `chain` | string | 派工用的链类型（`code` / `complex` / …） |
| `taskDir` | string | 绝对路径，恒等于 `<工单目录>/.fleet/tasks/<id>` |
| `role` | `builder` \| `reader` \| `mass` | fleet 角色 |
| `jobId` | string | 后台 job 标识，与 `fleet_result` 唤醒消息配对 |
| `state` | `carded` \| `running` \| `reported` \| `reviewing` \| `reviewed` \| `verdicted` \| `failed` | 委派状态；`running` / `reviewing` 是命令起飞前写下的占位，完成后才推进，启动失败记 `failed` |
| `producer` | `{ worker, family, routeId?, model? }` | **实际**生产者身份，来自 run 目录的 `meta.json`，不是模型声明 |
| `critic` | `{ worker, family }` | 评审者身份 |
| `reviewJobId` | string | 评审的后台 job 标识 |
| `verdict` | `pass` \| `rework` \| `escalate` \| `close` | 裁定 |
| `reviewRounds` | number | 已用评审轮数 |
| `errorClass` | string | fleet 的 `meta.json.error_class`（`unavailable` / `truncated` / `missing-report` / `network-down` / `prompt-too-long` / …） |
| `note` | string | 宿主记下的提示（如 fleet 的大卡建议，见 §10.1）；只供面板显示，不参与任何判定 |
| `startedAt` / `endedAt` | string | 时间戳 |

**存储**：Ticket 整体是一个 JSON 值列（`src/app/store.ts:71-87`），新增可选字段不需要表结构迁移；但读取路径上任何对 Ticket 形状的校验需要同步放行该字段。`SCHEMA_VERSION` 是否需要提升取决于该校验是否存在——实施时以 `src/app/store.ts` 与 `src/app/migration.ts` 的实际校验逻辑为准。

### 5.2 阶段表变更

`TicketStage` 的 `working` 分支扩展 action（`src/core/stage.ts:5-6`）：

```ts
| { stage: 'working'; action?: 'queued' | 'delegating' | 'reviewing' }
```

`ticketStage()` 在"人工态"四条规则之后、"working/queued" 之前插入委派规则：

- 任一 delegation 的 `state` 为 `running` 或 `reported`（尚未评审）→ `{ stage: 'working', action: 'delegating' }`
- 任一 delegation 的 `state` 为 `reviewing` → `{ stage: 'working', action: 'reviewing' }`

插入位置在人工态之后，是因为人的问题永远优先于在飞的后台工作。委派规则不改变既有七条规则的行为：没有委派的 Ticket 走原路径，结果完全一致。

### 5.3 与既有概念的关系

- Delegation 不是新的 Source、不是新的 Ticket。它是 Ticket 的一种工作方式，落在 `Ticket` 内部。
- Delegation 不改变 Mandate。委派出去的活仍然是原 Mandate 授权范围内的活；工头不得借委派扩大授权。
- Delegation 结束后不产生新的 Trigger 与 Report。工头对人类说话仍然只通过 `orchestrator_report`。

## 6. 生产者族与评审者选择

### 6.1 生产者族的来源

| 来源 | 取值方式 | 适用 |
|---|---|---|
| fleet 工人 | run 目录 `meta.json` 里的实际工人身份与 family | 委派产出（P0 唯一来源，见 §3 连带约束） |
| 外部声明 | `fleet review --producer-family <族>`，宿主专用，模型不可见 | 留给将来 Executor 自产可评审产物时的一条受控通路 |
| DSH provider | `executor.model` 对应的 provider 族 | 仅用于诊断与面板显示，P0 阶段不参与评审归属 |

**读取时机**：`run` 的后台 job 结束、宿主收到 `fleet_result` 终态时读 `meta.json`。不读模型的声明，不读提示词，不从 `workers.json` 反查。

**宿主追加 `--producer-family` 的规则**：只有当本卡**没有任何** builder/mass/reader run 记录时才允许追加——一旦卡上已有 run，fleet 会用"声明与已有记录冲突"（退出码 4）拒绝追加，宿主不得为了绕开这个冲突去改写 run 记录。P0 阶段生产者族一定来自 builder run，因此宿主**只剥离模型传入的值，不注入**（§8.1）。

### 6.2 生产者不变量

一个 Ticket 在同一时刻**至多一个未裁定的委派**。这是硬约束，理由有三：

1. fleet 的 `review_producer` 从"最后一次 builder run"推导生产者族——两个并发委派会让族归属变得不确定。
2. fleet 对同一项目**不允许两个 builder 同时在跑**（退出码 3）。并发委派会撞上这条限制。
3. 一个工单同时改一个仓库的两个分支会产生无法评审的合并差异。

违反不变量时，宿主拒绝第二次 `run`，返回明确错误，而不是让 fleet 去失败。

### 6.3 评审者选择

由宿主执行，模型不参与。宿主做两件事：**前置可用性检查**与**身份回读**，选人逻辑本身不复制 fleet 的（§7.2 同理）。

1. 宿主先读生产者族 `F`——来自 builder run 的 `meta.json`（§6.1），不读模型的声明。
2. 宿主用 `fleet critics --producer-family <F>` 做**前置检查**（工作目录为工单目录）：没有新鲜候选（输出里带 `过期` 标记的不算可派）时，直接拒绝发起评审并说明"当前没有可派的不同家族评审者"，不静默降级、不让模型指定人选。生产者族为空时同样拒绝（生产族未知，无法安排异族评审）。
3. 宿主发起评审时注入 **`--critic @review`**——**指名评审链，不指名评审者**。链内的具体选人由 fleet 执行：`ordered_chain_workers` 按证据顺序排候选，逐候选跳过不合格者（额度池冷却、族为 mixed/unknown、`never_roles`、免费档、卡片约束、准入不通过），并在 M/L/critical 卡上强制"两个 family 与 quotaPool 都不同的候选"（`require_critics`，不满足则退出码 6）。
4. 评审跑完后，宿主读评审 run 的 `meta.json`，把**实际**评审者（名字与 family）写进 `delegation.critic`；模型在报告里只能引用它，不能改它。

### 6.4 盲化评审输入

评审者收到的 diff 与验收标准里**不出现**生产者模型名、族名或"这是某某模型写的"这类措辞。

理由：LLM 评审者对同族产出存在自我偏好偏差（[Self-Preference Bias](https://arxiv.org/abs/2604.06996)），且仅标注产出来源本身就足以诱发双向偏差（[Self- and Other-Labels Induce Bidirectional Bias](https://arxiv.org/abs/2608.18091)）。盲化同时对冲这两个方向。

实现上，评审走 fleet 的既有链路（`fleet review`），输入是卡片与 diff 基准；superagent 这一侧的责任是**在写卡时不写入生产者身份**，并在评审完成后独立核对 `review.md` 的结论行。

### 6.5 评审轮数与退出码

宿主按 fleet 的既有语义处理终态，不另造一套：

| fleet 退出码 | 含义 | 宿主动作 |
|---|---|---|
| 0 | 评审完成 | 读 `review.md`，必须有「结论：通过 / 需返工」 |
| 2 | 参数或状态错误（含评审轮数超限、指名工人） | 委派失败，记录 `errorClass` |
| 3 | 同项目已有 builder 在跑，或 opencode 串行锁等待超时 | 委派未开始；稍后重试一次，仍冲突则如实报告 |
| 4 | 评审家族冲突 | 委派失败；换用 §6.3 的下一个候选重试一次 |
| 5 | 工人失败、超时或输出被截断 | 委派失败（**质量失败不换人**，fleet 已如此规定） |
| 6 | 未准入 | 委派失败；不得靠改健康记录或跳过准入放行 |
| 7 | 评审缺结论行 | `review.md` 已保存；视为未评审，委派失败 |
| 8 | 验收 sh 明卷前置失败 | 委派失败；明卷未过不得继续 |

## 7. 选人机制

### 7.1 run 只接受链类型

fleet 已经拦了一半：卡片带「任务类型」字段时，**直接点名工人的 `fleet run` 以退出码 2 拒绝**（SKILL.md:36）。也就是说，只要 superagent 写的卡带上了任务类型，模型就算想指名 `codex` 也会被 fleet 挡下。

superagent 这一侧的收紧仍有价值，区别在**失败得更早、说得更清楚**：

- 现状：模型可以指名 `codex`，fleet 直到执行那一刻才以退出码 2 拒绝，模型只看到一次没有上下文的失败。
- 目标：模型在工具调用参数校验阶段就被拒，错误信息直接告诉它"用 `@code` 这样的类型，不要指名工人"。

`fleetArgv` 对 `run` 的工人位（`src/app/tools/fleet.ts:55`）从"token 正则通过即可"收紧为"**必须是 `@` 开头的链类型**"：

- 接受：`@code`、`@complex`、`@bulk`、`@survey`、`@zh-text`、`@visual`——取 `routing.json` 的 `chains` 与卡片「任务类型」枚举的交集。`structured` 与 `research` 是卡片任务类型但不是链名，`@review` 由宿主在评审阶段使用，模型不填。
- 拒绝：`codex`、`kimi-k3-1-pro` 等具体工人名，以及未登记的 `@xxx`。

模型因此只能表达"这是哪一类活"，不能表达"派谁"。

### 7.2 链解析与准入

模型给出 `@code` 之后，选人完全交给 fleet：

- `ordered_chain_workers`（SKILL.md:77）按"新鲜 → 陈旧 → 降级链尾"稳定排序。
- 逐候选过滤：退役 / 促销过期 / 角色不符 / `never_roles` / 额度池冷却 / 免费档授权 / 卡片约束 / 材料敏感度（`data_policy`）/ 准入。
- 准入（SKILL.md:39、41、83）：有 `route_id` 的工人走 `dispatch-health.py select` 并核对 model、family、quotaPool、roles；其余读 `health.json` 的 `[worker][role]`，要求 `ok` 且 72 小时内且身份一致；探针停摆期间以 72 小时内的 selftest 作临时证据。
- `quota_gate: claude` 的工人在额度闸命中时退出码 6，且不可被 `--skip-admission` 绕过（SKILL.md:82）。
- `fallback_only` 工人被直接点名时退出码 6（SKILL.md:81）；它们只在链尾以 `--as-fallback` 放行。

**superagent 不复刻这套逻辑，也不再自己读 health/routing 文件。** 它只需要知道"链解析发生在 fleet 内部"，并在失败时如实报告 fleet 给的 `error_class`。

### 7.3 实际工人身份回读

`run` 的后台 job 结束（`fleet_result` 唤醒）后，宿主读 run 目录的 `meta.json`，取得实际工人身份、family、状态与 `error_class`，写入 `delegation.producer`。这一步是 §6.1 的唯一数据来源。

**只认本次派工自己产生的 run 目录**：宿主要在派工时快照 `<taskDir>/runs/` 的**直接子目录名**，完成时从 stdout 取候选目录，再按真实路径确认它是 `<taskDir>/runs/` 的**直接子目录**（`dirname(realRun) === realpath(<taskDir>/runs)`）且不在快照里；嵌套的历史目录（如 `runs/old/cached`）一律不算。判定成功后返回**已核验的真实路径**，不返回调用方传入的原始字符串。拿不到这样的目录时不得回落到最新历史 run，记 `missing-run-dir`（stdout 无目录）或 `unattributed-run`（目录不属于本次派工），且不写任何历史身份。评审失败时委派回到 `reported`，`critic` 保持空，`reviewRounds` 只对归属成立的尝试加一。

**判定完成的依据是 meta 的终态 + `report.md` 是本次新写的**，不是 `job_id` 处于 running。fleet 已实现"旧回执判 `missing-report`"的防静默失败（SKILL.md:62、88）。命令非零退出会丢 stdout，此时只能按 fleet 退出码记 `fleet-exit-N`（取不到记 `unknown`），不得把历史 run 当成本次结果。

### 7.4 拒绝路径

宿主在派工前拒绝以下情形并给出明确原因，不静默降级：

- 该工单已有未裁定的委派（§6.2 生产者不变量）。
- 该工单已用过同一张卡的 slug（任何状态都算；一次委派 = 一张卡，要返工就新开一张卡，不覆盖旧记录）。
- 链类型不在 `executor.fleet.allowedChains` 内。
- 该工单的委派预算已用尽（§10.1）。
- 卡片要求免费档，但 `executor.fleet.allowFree` 为假，或工单的材料敏感度高于允许级别（§10.2）。
- **在飞委派不可裁定**：`verdict` 发现该 slug 的委派处于 `running` / `reviewing` 时直接拒绝，不调用 fleet 裁定命令、不写任何记录；`rework` / `escalate` / `close` 只能在 `reported` / `reviewed` / `failed` 状态下记录。
- **`pass` 必须以已完成的异族评审为前提**：只有 `state === 'reviewed'`、`critic.family` 非空且与 `producer.family` 不同才允许；不满足时同样拒绝且不调用命令、不写记录，消息与 ready 闸门各条可区分。
- **同一委派不得重复发起评审**：只有 `state === 'reported'` 允许 `review`；`running` / `reviewing` / `reviewed` / `verdicted` / `failed` 各自给出互不相同、可关键词检索的拒绝消息。拒绝时不调用 `fleet critics`、不启动 fleet 命令、不写 `reviewing` 占位、不启动后台 job。状态在写占位的同一事务内重查一次（防 TOCTOU）。
- **评审轮数上限在宿主侧生效**：`review` 先取该 slug 委派记录的最新 `reviewRounds`，`>= executor.fleet.reviewRounds` 即拒绝，消息含已用轮数与上限（形如 `3/3`）、「评审轮数已用尽」以及改报 `escalate` 交人工的提示。该检查先于 `fleet critics`，轮数用尽时不花子进程。

## 8. 组件级改动规格

### 8.1 `src/app/tools/fleet.ts`

| 位置 | 改动 |
|---|---|
| `:14-19` flag 表 | `review` 增加 `--producer-family`（宿主专用）；`--critic` 与 `--producer-family` 同时标为**宿主专用** |
| `:22-65` `fleetArgv` | ① `run` 的工人位只接受 `@<链类型>`；② 新增 `card` 标题必填校验；③ **剥离**模型传入的 `--critic` / `--producer-family`，不与宿主填入的值共存；④ 保持现有 realpath / 符号链接 / 操作数校验不变 |
| `:72` 工具描述 | 改为"填任务类型（@code/@complex/…），不填工人名；评审者由宿主按 fleet 证据安排" |
| `:74-89` `execute` | ① `run` / `review` 派工时先在事务内写下 `running` / `reviewing` 占位再启动后台 job，结束后按本次派工自己的 `meta.json` 写终态（生产者身份、评审者、`error_class`）；② 发起 `review` 前用 `fleet critics --producer-family <F>` 做前置检查（工作目录为工单目录），通过后注入 `--critic @review`（§6.3）；③ 派工前执行 §7.4 的拒绝闸，含拒绝重复 slug；④ 对 `ready` 报告的拦截不在此文件，见 §8.4；⑤ `verdict` 在调用 fleet 裁定命令**之前**读该 slug 的委派记录做判定点（在飞拒绝，`pass` 必须已有完成的异族评审，`rework` / `escalate` / `close` 只在 `reported` / `reviewed` / `failed` 状态记录），拒绝时不调用命令也不写记录；⑥ 退出码捕获点在传给 `startBackgroundJob` 的后台执行函数**内部**：在原始错误被 `String(error)` 之前读取 `CliError.exitCode`，放进闭包变量供终态记 `fleet-exit-N`；⑦ `review` 先查该 slug 最新记录的 `reviewRounds`（`>= executor.fleet.reviewRounds` 即拒绝，含已用/上限与 escalate 提示），再要求 `state === 'reported'`；写 `reviewing` 占位的同一事务内重查状态与轮数（防 TOCTOU）；⑧ 写 `reviewing` 占位的同一事务内先清空上一轮遗留的 `reviewJobId`（失败重试时旧 ID 仍在，否则新 job 绑不上、其回调会被身份守卫拦下）；后台 job 拿到 `jobId` 后在**同一同步段内**（中间无 `await`）于事务内把 `reviewJobId` 写成该 jobId，条件是记录仍为 `reviewing` 且 `reviewJobId` 为空；完成回调推进状态前核对记录当前 `reviewJobId === wakeId`，不相等则只唤醒 Session，不改 `state` / `critic` / `reviewRounds` / `errorClass`（该守卫只作用于 review 分支） |
| `:68-69` | 注册条件不变（`executor.fleet.enabled`） |

**P0 阶段宿主只剥离 `--producer-family`，不注入它。** 生产者族永远来自 builder run 的 `meta.json`，注入路径没有输入；等 Executor 真的要自产可评审产物时（P1）再打开注入。

**模型侧 argv 的形状**：`run` 是 `["run", "@code", "<taskdir>"]`，`review` 是 `["review", "<taskdir>"]`。两者都不含工人名、评审者名或生产者族——这三个都是宿主的裁量（§6.1、§6.3），模型只表达"做哪一类活"和"现在要评审"。

新增私有模块 `src/app/tools/fleet-delegation.ts`：封装"读 meta.json → 写 delegation → 判定终态"的逻辑，避免 `fleet.ts` 继续膨胀。它导出 `readRunOutcome(taskDir, runDir?)` 读 run 目录的 `meta.json`（没有显式 run 目录时返回 `errorClass: 'missing-run-dir'`，不回落最新目录；meta 缺失时返回 `status: 'unknown'` 而不抛错）、`attributeRunDir(taskDir, runDir, known)` 用真实路径与派工快照判定一个 run 目录是否属于本次派工、`runDirFromStdout(stdout)` 从 `fleet run` 的输出行里取回本次 run 的目录、`parseCriticCandidates(stdout)` 解析 `fleet critics` 的候选（跳过标记为 `过期` 的行）、`readCriticCandidates(bin, producerFamily, cwd, run)` 在显式工作目录下调 `fleet critics` 并在无可派候选时抛错。委派记录由 `recordDelegation(...)` 写入，写入必须发生在事务内——`ResourceHost.store` 没有 `atomic`，所以 `fleetTools` 要多收一个事务函数参数，由 `executorTools` 传 `host.atomic`。

**评审结论证据闸（P0 收口）**：宿主不替评审下结论，但必须读得出结论。评审 job 结束后，宿主读该卡的 `review.md`，解析出 `reviewConclusion`：`pass` / `rework` / `unknown`。先判「需返工 / 返工」再判「通过」，两者都没有就是 `unknown`——**没有结论行不等于通过**；冲突时「需返工」优先，后出现的「通过」不能把负面评审翻绿。

**结论行的读法是严格的，不是全文搜词**（异族评审在 P0 收口时查出的真缺陷：宽松子串匹配会把「结论：不通过」读成 `pass`、把「结论：无需返工」读成 `rework`，假绿换一个入口复活）。规则：

- 逐行处理：去行首空白、去行首 Markdown 标题标记（`#` 及其后空格）、去整行首尾的强调标记（`**` / `*` / `_`）。
- 剩下的文本必须形如 `结论` + 可选空白 + `：`/`:` + 值；取到的值去掉首尾空白与首尾强调标记后，必须**精确等于** `通过` / `需返工` / `返工` 之一，才算一条有效结论。
- 其余取值一律**不是**结论：`不通过`、`未通过`、`不建议通过`、`无需返工`、`建议返工`、`通过 / 需返工`（模板原文）、`通过（附条件）`、空值、带标点的值。它们不贡献任何结论，因此整篇没有有效结论行时结果是 `unknown`。
- 判定优先级不变：有效结论行里有 `需返工`/`返工` → `rework`；否则有 `通过` → `pass`；一条有效结论行都没有 → `unknown`。
- 严格不等于「把正常评审也判没」：fleet 的标准结论行 `## 结论：通过` / `## 结论：需返工` 及其无标题、无强调的变体必须仍然被认出来。

裁定闸随之收紧（`verdict` 子命令）：

- `pass` 仍须先满足既有条件（该委派已有**已完成的异族评审**），且 `reviewConclusion` 不得为 `unknown`；`unknown` 一律拒绝，消息点明「评审没有结论行」。
- `reviewConclusion === 'rework'` 时，`pass` 必须带 `--override-reason`：非空、单行、不含 NUL。理由原文写进委派记录的 `overrideReason`，并出现在就绪报告摘要里（§8.4）——人能看到这次放行是谁、以什么理由放行的。
- 理由不是自由文本豁免：它不改变评审结论，只把「强行通过」变成一条留痕、可追责的显式动作；`--override-reason` 未经校验（空串、含换行或 NUL）时连同整个裁定一起被拒。

### 8.2 `src/policy.ts`

`ExecutorConfigSchema.fleet`（`:98-103`）从 4 字段扩为：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | false | 保留 |
| `bin` | string | `'fleet'` | 保留 |
| `timeoutMinutes` | number | 180 | 保留 |
| `reportMaxChars` | number | 20000 | 保留 |
| `allowedChains` | string[] | `['code','complex']` | 允许的链类型；默认只开两条，其余按需扩 |
| `delegationsPerTicket` | number | 2 | 单工单委派次数上限 |
| `reviewRounds` | number | 3 | 评审轮数上限，与 fleet 卡默认值一致 |
| `allowFree` | boolean | false | 是否允许免费档工人；P0 默认关 |
| `freeMaterialSensitivity` | string[] | `[]` | 允许走免费档的材料敏感度白名单 |

`RoleModelSchema`（`:71-72`）不变。

### 8.3 `src/core/stage.ts`

按 §5.2 扩展 `TicketStage` 与 `ticketStage()`。既有七条规则的行为不变。

### 8.4 `src/app/tools/executor.ts`

`orchestrator_report`（`:77-80`）在 `state === 'ready'` 时对该 Ticket 的**全部委派**求值，判定顺序固定如下：

1. **任一**委派 `state` 为 `running` / `reviewing`（在飞）→ 拒绝，消息含「委派尚未完成」。
2. **末条**委派 `verdict === 'rework'` → 拒绝，消息含「评审要求返工」。
3. **任一**委派未裁定且未失败（`state` 为 `reported` / `reviewed` 且 `verdict` 为空）：`reviewRounds >= executor.fleet.reviewRounds` → 拒绝，消息含「评审轮数已用尽」；否则拒绝，消息含「委派尚未通过异族评审」。
4. **末条**委派必须 `state === 'verdicted'` 且 `verdict === 'pass'`，否则拒绝：`verdict` 为 `escalate` / `close` 时消息点明裁定值并说明「只有 pass 允许 ready」；`state === 'failed'` 时消息说明「最后一次委派失败，没有通过评审的产出」。这些消息与第 1、2、3、5 条可区分。
5. **末条**委派 `critic.family` 为空，或与 `producer.family` 相同 → 拒绝，消息含「评审者必须来自异族」（即使 `verdict === 'pass'` 也不放行）。

**取代规则**：末条之前的委派，若 `state === 'verdicted'`（pass / rework / escalate / close 任一）或 `state === 'failed'`，视为已被取代，不再阻断 ready；若仍是 `reported` / `reviewed`，仍按第 3 条阻断。没有委派时照旧放行。

这样定的理由：`fleet.ts` 的开闸规则（`:154`）已把「已裁定 / 已失败」的委派视为关闭（只有 `state !== 'verdicted' && state !== 'failed'` 才算未关闭）。若 ready 闸门要求所有历史委派都 `pass`，任何一次返工之后 ready 将永远不可达。返工的正常路径是：评审要求返工 → 裁定 `rework` → 换新卡重派 → 新委派通过异族评审并 `pass` → ready。

其他 report 状态（progress / blocked / failed / dropped）不受影响。

**放行理由可见**：工单里有委派带 `overrideReason`（评审要求返工却被强行 `pass`）时，`ready` 报告的摘要追加一段 `Fleet delegation overrideReason:`，逐条列出委派 id 与理由原文。摘要超长按既有 `reportMaxChars` 规则拒绝整份报告，不静默截断——理由进不了人眼就不算留痕。

### 8.5 `src/core/model.ts`

新增 `Delegation` 接口（§5.1 字段表），`Ticket` 增加 `delegations?: Delegation[]`。

P0 收口另加两个可选字段：`reviewConclusion?: 'pass' | 'rework' | 'unknown'`（宿主解析出的评审结论；旧记录缺该字段时按 `unknown` 处理，不得当成通过）与 `overrideReason?: string`（宿主校验过的放行理由原文，见 §8.1）。

### 8.6 `src/app/sessions.ts`

`ensure(role)`（`:182`）保持按角色取模型不变——**Executor 的 DSH 模型不再决定"谁写代码"，只决定"谁当工头"**。工头模型的选择标准是"能拆卡、能读回执、能裁定"，与写码能力解耦。

### 8.7 `prompts/work.md` 与 `prompts/worker-general.md`

改写第 51 / 27 行：

- "write a card → `fleet run @<type>`" 保留，但补一句"`@<type>` 取自 code / complex / bulk / survey / zh-text / visual；不要指名工人，宿主会按 fleet 的健康证据选"。
- "fleet review by a different model family" 从工头职责改为**宿主职责**：工头写卡时不写生产者身份；工头不选评审者。
- 删除任何让工头自行 bash 调用 fleet 的暗示；明确"fleet 只能通过**宿主提供的 fleet 工具**调用，绝不用 shell"。
- 工头红线**以宿主 fleet 工具是否在工具清单里为前提**，提示词写明两档：
  - 工具可用（工头模式）：所有实现代码改动由 fleet 工人完成；**你不写实现代码**，只做只读调查、核验产物、裁定与报告。
  - 工具不可用（未启用 fleet 的部署）：保留既有能力——小型本地编码工单由你自行完成调查、实现、检查、自检、提交、推送与开 PR；复杂工单报告阻塞。
- **不得**留下「简单活自己做」这类无条件授权句；工头模式下的自行完成范围只限只读调查、核验与报告。

**提示词里不写工具的字面名 `orchestrator_fleet`。** 该工具只在 `executor.fleet.enabled` 为真时才注册（`fleetTools` 在关闭时返回空数组），而提示词是静态文本；写它的字面名会违反"提示词只提到已注册工具"的模型表面不变量——`tests/model-surface.spec.ts` 会以 `orchestrator_fleet is not a tool` 判失败。提示词用"the host fleet tool"指代它（改写前的既有措辞），模型从工具清单里认得出；工具的名字与描述由工具自身承担。**这条约束同时适用于 `src/app/tools/fleet.ts` 的工具描述改动（§8.1）：描述文本只在工具已注册时才进入模型表面。**

这段文本同时是**可被团队编辑的**。因此 §8.1–§8.4 的代码闸是真正的强制点，prompt 只是协作说明。

**这段契约接近 worker 的提示词预算。** P0 为容纳最初的工头契约把 `tests/model-surface.spec.ts` 的 `BUDGET.worker` 从 40_500 提到 **40_800**。返工后的两档措辞必须装在这一上限内，**不得再上调**；净增长靠压缩同段其它句子消化。

**返工协议（P0 收口）**：两份提示词用同一套措辞写明返工动作——评审结论为「需返工」时，先在原卡上记 `rework` 裁定，再**另开新卡**做修复；不在原卡上重试，也不放弃这项工作。强行 `pass` 必须给 `--override-reason` 并附证据，宿主会记录并在最终报告里展示。两份提示词都不出现工具字面名，措辞互为对照。

### 8.8 面板（对应 [005 Panel](005-panel.md)）

- Overview 增加"在飞委派"计数（delegating / reviewing 各一）与"待裁定"计数。
- Ticket 视图增加"委派"段：链类型、实际工人、族、评审者、轮次、裁定、`error_class`。
- Settings → Execution 增加 §8.2 的五个新字段。
- 面板遵守 [000 Philosophy](000-philosophy.md)："只显示需要人处理的东西"。健康的委派不占面板空间。

## 9. 并发与隔离

### 9.1 目录冲突

今天 Executor 的工作目录就是工单目录（`src/app/sessions.ts:184` 设 `danger-full-access`），fleet 的 builder 也以项目根为 cwd 运行（SKILL.md:77 记录的 `cwd = task.parents[2]`）。两者同时写同一目录会互相覆盖。

**目标**：每个委派在独立的工作副本中进行，工头只读。

- fleet 已在 builder 启动时创建 `refs/fleet/<task_id>` 快照（SKILL.md:85），P1 在此基础上扩成 per-delegation worktree：builder 在 worktree 中工作，评审以 worktree diff 为基准，工头核对产物后再决定如何落回工单目录。
- 委派进行期间，Executor 不得写工单目录。宿主在工头提示词层与代码层都表达这一点。

### 9.2 并发预算

- 单工单至多一个未裁定委派（§6.2）。
- 主机全局在飞委派数上限：`executor.maxWorkers` 复用为主控上限，另设 `executor.fleet.maxConcurrent`（默认 2）。
- **opencode 系工人的串行由 fleet 负责。** `opencode-*` 与 `oc-*` 共用一个 sqlite，fleet 已在运行期持 `~/.agents/fleet/locks/opencode-sqlite.lock`（工人可配 `serial_lock`），等待上限 `FLEET_SERIAL_LOCK_WAIT_S`（默认 1800 秒），超时退出码 3（SKILL.md:92、106）。superagent 不再自己实现互斥组；它需要做的是**认识退出码 3**——那是"还没开始"，不是"失败了"。

### 9.3 深度上限

工头自身不得再嵌套派工。DSH 的 `SubagentStartRequest.maxDepth` 提供绝对深度上限（`docs/subsystems/subagent.md:79`），superagent 不再自建一套 hop 计数。

## 10. 成本与治理

### 10.1 每工单预算

- `executor.fleet.delegationsPerTicket`（默认 2）限制一个工单能开几次委派。
- `executor.fleet.reviewRounds`（默认 3）与 fleet 卡上的"评审轮数上限"一致；超出后宿主不再自动发起评审，改为报告 `escalate` 交人工。宿主在 `review` 前读该委派最新 `reviewRounds`，达到上限即拒绝，且该检查先于 `fleet critics`，不为其花子进程。
- fleet 卡片自带预算节（任务类型 / 材料敏感度 / 质量级别 / 评审轮数上限等），宿主写卡时必须填写，否则 `run` 被拒（fleet 退出码 2）。
- **大卡要自己拆。** fleet 在 `run` 启动前会检查目标节条目（超过 3 条）或预算节时间上限（超过 60 分钟），在 stdout 提示"建议拆成阶段卡"，但只提示、不拦截（SKILL.md:46）。工头读到这条提示时的动作是**按阶段拆卡重新写卡**，而不是无视它继续跑一张大卡——工头拿到的阶段划分才是"worker 内部有分工"的实际载体。宿主把该 stdout 提示落到 `Delegation.note`，让面板能看见"这张卡 fleet 认为偏大"。

### 10.2 免费档策略

fleet 要求免费档工人在卡上独占一行 `- 免费档：允许`（SKILL.md:54）。

**fleet 已经排除了最危险的一档。** `internal/restricted` 材料不走免费渠道；`data_policy` 为 `may-train` 的工人只接 public 卡，直接点名或链上遇到不匹配会退出码 6（SKILL.md:38）。superagent 的 `allowFree` 因此只能是**再加一道**闸，不能是绕开 fleet 隐私规则的开关：

- `executor.fleet.allowFree` 为真**且**工单材料敏感度在 `freeMaterialSensitivity` 白名单内**且** fleet 侧准入通过，才允许写这一行。
- `allowFree` 只能收紧、不能放宽 fleet 的判定；宿主写卡前不重复实现 `data_policy` 语义，只把材料敏感度如实填进卡里，交给 fleet 判。
- **模型不得自行决定免费档。** 敏感度由 Source 的 admission 表与规则决定，属授权范畴。
- P0 默认 `allowFree: false`。批量类任务（`@bulk`）当前也无可用工人（§2.6），免费档放开前需先确认链上有健康的免费 builder。

### 10.3 路由档位

任务类型 → 链的映射沿用 fleet 的 `routing.json`，不在 superagent 复制一份。superagent 只维护一张"允许哪些链"的开关表（§8.2）。

## 11. 可观测性与验收

### 11.1 证据链

沿用 [009 Local acceptance](009-local-acceptance.md) 已写好的 fleet 验收协议（`:117-128`），本设计只补两点：

- **委派证据**：`tool/call`（name=orchestrator_fleet、arguments.argv、callId）+ `job_id` + 同 job_id 的 `fleet_result` 唤醒消息 + run 目录 `meta.json` + `report.md` + `review.md` + `verdict.md`，五者互相印证。
- **族隔离证据**：评审记录中的 critic 族必须与 `meta.json` 里的生产者族不同，且 quotaPool 不同。

单看 `job_id` 处于 running、旧回执、或 `status/ls/critics` 有输出，都**不构成**外部工人执行的证据（009:119）。

### 11.2 防假绿

- 完成的判定依据是 `meta.json` 终态 + 本次新写的 `report.md`，不是 job 状态。
- fleet 的 `error_class` 为 `truncated` / `missing-report` / `network-down` / `prompt-too-long` 一律记为失败，不得改健康记录、路由或开关来伪装成功（009:128）。
- 评审缺结论行（退出码 7）记为**未评审**，委派不算完成。

### 11.3 面板与成本

- 面板的委派段（§8.8）显示实际工人与族，让"谁做的、谁审的"一眼可见。
- 成本从 fleet 侧的 `fleet stats` 取；superagent 不自建计费。

## 12. 分期路线

### P0：解锁链路（4 个文件 + 2 处 prompt）

| 步骤 | 内容 | 验收 |
|---|---|---|
| P0-1 | `policy.ts` 扩 §8.2 策略字段；`model.ts` 加 `Delegation` | 类型检查通过；既有测试全绿 |
| P0-2 | `fleet.ts` 收紧 run 只收 `@链类型`；`review` 的 `--critic` / `--producer-family` 剥离模型值并由宿主填入；新增 `fleet-delegation.ts` 读 meta 写 delegation | 新增测试：指名工人被拒；`@类型` 被接受；模型传入的 `--critic` 被剥离 |
| P0-3 | `stage.ts` 加 delegating / reviewing | 新增测试：无委派的 Ticket 阶段不变（回归） |
| P0-4 | `executor.ts` 的 ready 门禁 | 新增测试：未裁定委派时 ready 被拒；裁定 pass 后放行 |
| P0-5 | 改写 `prompts/work.md:51`、`prompts/worker-general.md:27` | 人工走查：无指名工人、无自选评审者 |
| P0-6 | 真实冒烟：一条 `@code` 卡 → run → 异族 review → verdict pass → ready → PR | 满足 §11.1 全部证据项 |

### P1：链与隔离

- fleet 卡内角色链（reader → builder → critic）在一条卡内串起来。
- per-delegation worktree 隔离；委派期间工头只读。
- 并发预算；退出码 3（串行锁等待超时）按"尚未开始"处理并重试。

### P2：治理与面板

- 结构化交接契约（机器可校验的卡字段）。
- 委派视图与成本账。
- 敏感度驱动的免费档策略（先补齐 `@bulk` / `@survey` / `@zh-text` 的健康工人）。

## 13. 风险与不做的事

| 风险 | 表现 | 缓解 |
|---|---|---|
| 链上无健康工人 | `@bulk` / `@survey` / `@zh-text` 今天就没人（§2.6） | P0 只开 `code` / `complex`；其余等 `fleet status` 有健康候选再开 |
| 评审族冲突 | 同族或池相同 → fleet 退出码 4 | 宿主按 §6.3 换候选重试一次，仍失败则如实报告 |
| 并发写冲突 | 工头与 builder 同目录 | §9.1 隔离，P0 期间靠"工头不写码"这条约束兜底 |
| 提示词被改软 | 团队编辑 `prompts/team/*` 时删掉工头红线 | 真正的强制在 §8.1–§8.4 的代码闸；prompt 只是说明 |
| 自我偏好偏差 | 同族评审偏袒同族产出 | §6.4 盲化 + §6.3 强制异族 |
| 成本不可见 | 免费档或评审轮数悄悄上升 | §10.1 预算 + §11.3 面板与 fleet stats |
| 额度闸 | Codex 周额度 ≥80% 时链首不可用 | fleet 的 `fallback_only` 与 `pool-clear` 既有机制；superagent 只如实报 `error_class` |

**明确不做**：不在 superagent 里复刻 fleet 的路由/健康/额度逻辑；不新增自由形式的"工头配置"；不引入多级角色团队；不让 Executor 写实现代码；不引入第二套评审结论格式（沿用 fleet 的「结论：通过 / 需返工」）。

## 14. 社区依据

| 结论 | 出处 |
|---|---|
| 薄编排器的收益在上下文隔离与并行；token 爆炸与级联错误是主要失败模式 | [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)、[When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) |
| 多 agent 失败约 36.9% 源于协调错位；对策是确定性代码状态机、中立 verifier、严格 hop 限制、全量交接日志 | [Scaling smart: multi-agent orchestration bottlenecks](https://www.techradar.com/pro/scaling-smart-how-llm-developers-are-solving-multi-agent-orchestration-bottlenecks) |
| 编排者越薄越好；扩展放在核心 spec 之外 | [Harness engineering](https://openai.com/index/harness-engineering/)、[Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) |
| 双账本（任务账本外环、进度账本内环）与停滞重规划 | [Magentic-One](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/11/MagenticOne.pdf) |
| 评审者偏好同族产出；仅标注来源即诱发双向偏差 | [Self-Preference Bias in Rubric-Based Evaluation](https://arxiv.org/abs/2604.06996)、[Self- and Other-Labels Induce Bidirectional Bias](https://arxiv.org/abs/2608.18091) |
| 角色分离的层级团队在仓库级任务上收益递减；最小协议是 coder + reviewer + critic | [Adversarial Review](https://arxiv.org/abs/2608.18167) |
| 多 agent 评审存在串通规避监督的风险，故评审者身份不应由生产者决定 | [Studying Coordination and Collusion in Multi-Agent LLM Code Reviews](https://www.aristeidispanos.com/publication/panos2025multiagents/) |
| 路由是成本/质量显式阈值，分类器会漂移 | [RouteLLM](https://github.com/lm-sys/RouteLLM)、[claude-code-router](https://github.com/musistudio/claude-code-router/blob/main/docs/src/content/docs/en/configuration/routing.md) |

## 附录 A：现状证据索引

| 事实 | 位置 |
|---|---|
| 已有 fleet 工具与 argv 校验 | `src/app/tools/fleet.ts` |
| fleet 配置 | `src/policy.ts:98-103` |
| 角色模型 | `src/policy.ts:71-72`、`src/app/sessions.ts:182` |
| 阶段派生 | `src/core/stage.ts:9-21` |
| Ticket 结构 | `src/core/model.ts:281-311` |
| 报告工具 | `src/app/tools/executor.ts:77-80` |
| 存储表 | `src/app/store.ts:71-87`、`src/app/migration.ts:20` |
| 工头提示词 | `prompts/work.md:51`、`prompts/worker-general.md:27` |
| 子代理工具配置 | `cordis.patch.yml:102-111` |
| fleet 验收协议 | `docs/009-local-acceptance.md:117-128` |
| fleet 链与换人规则 | `~/.agents/skills/fleet/SKILL.md:23, 26, 36, 38, 39, 41, 46, 54, 62, 77, 81, 82, 85, 86, 88, 92, 106, 116` |
| 生产者族推导与外部声明 | `~/.agents/skills/fleet/bin/fleet:2904-2935` |
| fleet 工人表 | `~/.agents/skills/fleet/workers.json` |
| fleet 链定义 | `~/.agents/skills/fleet/routing.json` |
| fleet 健康证据 | `~/.agents/fleet/health.json` |
| 机器可读选人 | `~/.agents/bin/dispatch-health.py select` |
| 真实 fleet 冒烟会话 | `~/.dsh/sessions/--Volumes-Macssd-~5DE5~5355-20261103-fleet-superagent-honglou-superagent-smoke--/` |
