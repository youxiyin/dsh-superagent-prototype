# 009 主 Session 通用工单真实验收

本文件准备主控执行的真实验收，不表示生产已经验收通过。本任务没有向生产提交工单、重放消息、启用 fleet、修改设置、构建或安装。四卡的宿主测试与 local.7 闲聊成功，不证明工单 outbox → local → 主 Session 已通过。

## 固定范围与验收口径

- 仓库：`/Volumes/Macssd/deepseek/superagent-20261031/dsh-superagent`。
- 首轮 run ID：`relay-20261103-01`；业务 request ID：`local-ticket-smoke:relay-20261103-01`。
- 唯一业务文件：`/Volumes/Macssd/工单/20261103-local-ticket-smoke/relay-20261103-01/receipt.txt`。执行器可创建其父目录；worker 不得写第二个文件，不得派生工人或调用 fleet。
- 文件内容由脚本 `run` 计划固定为 UTF-8、LF 结尾；工单目录与 mandate/execution 必须逐字一致。旧文件、符号链接、额外文件均不能过关。
- IDs 不预编造：主 Session ID 从当前正式 state API 获取；trigger/ticket/assignment/worker/outbox/message IDs 从真实回执与事件读取。旧上线回执中的 `orchestrator-44c0487d61f2f73db45d19fdc9fb052d` 只是历史线索，不能替代 discover。
- `ADMITTED_NOT_ACCEPTED` 仅表示 API 接收；`LIVE_SINGLE_OBSERVATION_PASS` 才表示一次完整结果观测；`LIVE_REQUEST_REPLAY_PASS` 表示同一业务 request ID 重放后证据未变。
- `OFFLINE_ONLY_CHECK_PASS` 永远不能作为生产成功。HTTP 200、idle、enabled、工具已注册、“收到”、单独一个文件、单独 ready/完成状态均不充分。

## 最小执行步骤（仅主控执行）

先在当前已授权的桌面连接中确认 loopback origin；此任务没有探测生产监听端口，不猜测 3080 或其他端口。将当前页面实际 origin 放进 `BASE`。如果当前连接需要鉴权，使用既有已授权上下文；脚本可接收 `DSH_SMOKE_AUTHORIZATION`，不会读取凭据文件、打印请求头或自动登录。401/403 时停止，不更改鉴权设置。

以下为 shell 步骤；`EVIDENCE` 是本任务交接目录，和 worker 可写的业务目录分开。保存调查回执是主控的操作，不由 worker 代写。

```sh
cd /Volumes/Macssd/deepseek/superagent-20261031/dsh-superagent
: "${BASE:?先设为当前桌面端实际的 http://127.0.0.1:端口}"
EVIDENCE="$PWD/.fleet/tasks/20261103-finish-local-relay/evidence"
RUN_ID=relay-20261103-01
node scripts/local-ticket-smoke.mjs discover --base "$BASE" > "$EVIDENCE/live-discover.json"
MAIN_ID=$(node -e 'const f=require("fs");console.log(JSON.parse(f.readFileSync(process.argv[1],"utf8")).masterId)' "$EVIDENCE/live-discover.json")
node scripts/local-ticket-smoke.mjs run --session "$MAIN_ID" --run-id "$RUN_ID" > "$EVIDENCE/live-plan.json"
```

检查 discover：`localEnabled=true`、`localHealth=ready`、`paused=false`、`setupProblem=false`，且真实 `generalRoots` 包含目标路径。检查计划的 directory、path、requestId、正文与 hash。`run` 没有 `--execute` 时不联网、不写文件、不调用模型。前置状态不满足时只记录阻塞，不修改设置或准入。

在主控已获准执行本次真实验收后，提交一次：

```sh
node scripts/local-ticket-smoke.mjs run --base "$BASE" --session "$MAIN_ID" --run-id "$RUN_ID" --execute > "$EVIDENCE/live-admission.json"
```

只使用这一次提交；不要再手工发送相同文本。脚本拒绝已有目录、已入库 Trigger 或已接收的 requestId；提交失败或超时状态为 UNKNOWN，不自动重试，不换 ID 重发。

脚本还会只读检查主 Session thread 的已有订阅：源码 `src/core/intake.ts` 会把新消息投给订阅工单，甚至恢复非人工结束的旧工单。若存在可能接收消息的旧工单，脚本在提交前拒绝并列出其 IDs。不要在本验收中自动取消订阅/停止工单；主控另行审查隔离方案。这是现有线程路由行为，不是本卡已确认的核心实现缺陷。

主控观察主 Session，等工单完成后运行只读检查。可以在 30、60、120 秒各检查一次，最多 5 分钟；达到边界仍未满足即记为未通过/待处理，不无限轮询。检查命令每次网络总预算 60 秒、单请求 10 秒，历史最多 100 页/20000 事件：

```sh
node scripts/local-ticket-smoke.mjs inspect --base "$BASE" --session "$MAIN_ID" --run-id "$RUN_ID" > "$EVIDENCE/live-inspect.json"
```

检查器同时要求：

1. 主 Session 中恰好一条 `source.kind=user`、`source.rpcId=requestId` 的固定请求；local Trigger 的 messageId、内容及稳定 hash 对应它。
2. 恰好一个独立 general 工单，origin 对应该 Trigger，执行目录正确，`ended.outcome=completed`、`by=executor`、无 attention/delivery error/未投递输入；唯一 assignment 已开始且结束并报告 ready。
3. 文件内容、SHA-256、普通文件身份、真实路径、目录仅含 receipt.txt 全部匹配；独立 worker Session 为 `worker-<ticketId>`，实际日志存在 ready 的 `orchestrator_report` call/result。
4. 同一工单只有一条 result reply，`workerReport=true`、`status=sent`、无 dropped，正文逐字等于报告，channel 精确指向原主 Session，所有相关 reply effect 均已消失。工具最初返回 pending、随后真实送达可以接受；尚未送达一律拒绝。
5. 主 Session 中恰好一个来自 outbox 的 `user/message`，ID 为 `dsh-superagent:sha256(JSON.stringify(["local:" + outboxId]))[:32]`；其正文逐字相等。内部 JSON `worker_report` 通知不计入此项。
6. 该回投之后主 Session 有且仅有一个包含本次标识的最终 assistant 消息，正文逐字相同，并存在对应的 completed turn/end；worker 报告轮次也正常结束。

脚本输出实际 IDs、文件 hash/mtime、回投和最终消息 seq，便于恢复检查。严格的最终回答检查可能揭示“回投已到但没有展示最终回答”；此时保持失败，不放宽成 idle 或内部通知通过，也不在本卡修改核心提示词。

一次完整观测通过后，主控可执行显式的同 ID 重放：

```sh
node scripts/local-ticket-smoke.mjs replay --base "$BASE" --session "$MAIN_ID" --run-id "$RUN_ID" --execute > "$EVIDENCE/live-replay.json"
```

replay 先重新完成所有检查，再通过正式 `session/prompt` 重发完全相同的业务 `requestId` 和正文；外层 RPC correlation ID 使用新 UUID。等待固定 2 秒后检查所有 IDs、数量、回投 seq、final seq、文件 hash/mtime 不变。不得改 requestId、手工清 outbox 或重新触发 worker。

此项证明正式入口重复请求未新开工单，且观测窗口内没有重复回投；不声称模拟了 outbox 崩溃/重启重试。当前管理 API 没有“重发同一 outbox receipt”的操作。该部分由现有 adapter/delivery 专测补充，生产中不要直接改 effect/outbox 表来制造故障。

## 正式 curl 与 SDK 协议

管理 GET 路径来自 `src/app/http.ts`。只读示例（不保存全量 settings，避免无关资料进入回执）：

```sh
curl --fail --silent --show-error --max-time 10 \
  -H 'x-orchestrator-request: 1' -H "Origin: $BASE" \
  "$BASE/orchestrator/api/state"
# 已知 ticketId 后可读面板详情；它不是完整 outbox 证据。
curl --fail --silent --show-error --max-time 10 \
  -H 'x-orchestrator-request: 1' -H "Origin: $BASE" \
  "$BASE/orchestrator/api/tickets/$TICKET_ID"
```

提交协议来自本地依赖 `@deepseek-ai/dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc`、`dsh-api-gateway` 的 `remoteRequest`、`dsh-api-session-controller` 的 generated Remote contract。不能使用旧式裸 JSON 或伪造 `user/message` 日志。

下方 curl 是脚本提交的**替代方式**，只能二选一，不在脚本提交之外再发送。先从上面的计划构造 envelope；此步骤只写本任务 evidence：

```sh
node --input-type=module - "$EVIDENCE/live-plan.json" <<'JS' > "$EVIDENCE/live-request.json"
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
  method: 'session/prompt', payload: { args: { request: plan.request } } }));
JS
# 仅主控在批准执行后运行；不要把它当只读探针。
curl --fail --silent --show-error --max-time 10 \
  -H 'Content-Type: application/json' -H "Origin: $BASE" \
  --data-binary "@$EVIDENCE/live-request.json" \
  "$BASE/api/session/prompt" > "$EVIDENCE/live-curl-admission.json"
```

响应必须为 `type=server-response`、rpcId 对应请求、`result.ok=true`、`result.value.accepted=true`。HTTP 200 里也可能含 `result.ok=false`。不要记录或回显 Authorization；如果 curl 无已授权鉴权上下文，改用现有已登录桌面 SDK，勿读取凭据文件拼接。SDK 等价调用（运行于已有的 Cordis client context，`plan.request` 为上述 JSON）：

```js
const result = await ctx.remote.session.prompt(plan.request);
// result.accepted === true 仍只代表接收，不代表验收成功。
const projection = await ctx.remote.session.projections({ sessionId: plan.sessionId });
const page = await ctx.remote.session.page({
  address: { kind: 'session', sessionId: plan.sessionId },
  throughSeq: projection.asOfSeq, maxMessages: 200,
});
```

`session/projections`、`session/page` 虽是 POST RPC，属于不激活模型的冷读；不要用会激活 Session 的 follow/resume 替代。脚本只读取 state 返回的 `stateDir/orchestrator.sqlite`：`DatabaseSync({readOnly:true})` + `PRAGMA query_only=ON` + 只读事务，不加载会迁移/写入的项目 `Store`，不修改数据库、设置或 Session 日志。跨 DB/Session 的读取不是同一原子快照，正在结算时可能暂时拒绝，按上述有限观察窗口重读即可。

## fleet 的单独真实验收

本 receipt-only smoke 明确禁止 fleet。上线回执记录 fleet=false，本任务未核对/更改生产开关。开启开关只是前置条件，`status/ls/critics`、工具存在、`--dry-run`、job 返回 running 都不能证明外部工人执行。

主控另获 fleet 执行授权后，应在不同专用目录开另一张工单，并明确允许该目录的 `.fleet/tasks/<slug>/` 控制文件及其小型业务产物；不能复用只准写 receipt.txt 的合同。通过同一个正式主 Session 入口，让 worker 使用：

1. `orchestrator_fleet` 的 `card` 创建该工单目录下的卡，按新卡授权写清 whitelist/验收；随后 `argv=["run", "@<链类型>", "<本工单目录>/.fleet/tasks/<slug>"]`，不含 `--dry-run` 或绕过准入参数。工人位只填链类型（`@code`/`@complex`/`@bulk`/`@survey`/`@zh-text`/`@visual`），具体工人由宿主按 fleet 证据选定；指名工人会在工具参数校验阶段被拒。
2. 保存 worker Session 的真实 `tool/call` 与配对 `tool/result`：name=orchestrator_fleet、arguments.argv、callId、job_id。主 Session 不注册该工具，必须核对 Session 是该 ticket 的 worker。
3. 对照同 job_id 的 `fleet_result` 唤醒消息（或真实 job_output 终态）、任务目录最新 run 回执、实际开始/结束时间、实际工人/模型身份、退出码、结果文件 hash；成功状态与文件独立读回相互印证。单个 job_id/running、模拟回执、旧目录产物不能通过。
4. 异族评审与裁定是必经步骤，不得跳过。留存 `review` 的 tool/call（`arguments.argv=["review", "<本工单目录>/.fleet/tasks/<slug>"]`）、job_id、终态和评审回执（`review.md` 的结论行）；模型侧 argv 不含评审者，宿主按 `fleet critics --producer-family <生产者族>` 的证据注入实际评审者，再从 run 目录 `meta.json` 读出该评审者身份。随后留存 `verdict` 的 tool/call 与回执（`verdict.md`），并从生产者与评审者两次 run 的 `meta.json` 读出族名互证评审者族不同于生产者族。只有 `verdict pass` 之后才允许 `orchestrator_report` ready（设计文档 §8.4）。最后由主控独立检查产物，再核对 orchestrator_report → sent outbox → 主 Session 完整链路。

配置 timeoutMinutes 只是宿主预算；真实执行超过预算、后台失败、准入拒绝、缺少输出都按失败/未知记，不改健康、路由、模型或开关来伪装成功。此步骤不包含在本次执行授权中。

## 离线回归、缺口与源码交付

本次仅运行与本项目链路有关的测试，不 build、不全仓格式化：

```sh
node --check scripts/local-ticket-smoke.mjs
node scripts/local-ticket-smoke.mjs --help
pnpm exec vitest run --no-cache tests/local-source.spec.ts tests/general-ticket.spec.ts tests/fleet-tool.spec.ts tests/relay-verbatim.spec.ts tests/assistant.spec.ts
pnpm exec vitest run --no-cache tests/delivery.spec.ts tests/outbox.spec.ts tests/effects.spec.ts
```

现有测试分别覆盖 generalRoots/realpath/launch 二次复核、repo 兼容、主 Session Source 过滤、防回投循环、持久化去重、report 字节一致、报告长度拒绝、fleet argv/超时/后台唤醒与取消。临时离线 JSON 使用同一 `checkSnapshot` 和 CLI 验证：只有“收到”且无文件/完成工单、outbox 重试未送达、重复回投必须非零；另外保留正向合成控制，防止一个永远失败的检查器假装通过负例。

尚缺真实模型的接单/写盘/最终展示、真实 RPC 对当前安装版本的兼容性、生产投递与 ingress 重放、实际 fleet run/review、进程重启后的 outbox 恢复。离线测试不替代这些项目。若暴露核心缺陷，只列最小涉及文件/改动与失败证据，停止本卡实施；不修改白名单外代码。

归属附件：`../.fleet/tasks/20261103-finish-local-relay/evidence/source-ownership.md` 与 `source-manifest-candidate.json`，逐项记录 54 个继承 WIP 的 SHA-256、四卡局部贡献及未定作者。给定基线是四卡之后的脏工作树快照，不能据此宣称这些改动都由本卡或某一张卡完成。主控 HTML 第 58 行的后续自修与各工人中途 report 分别保留。本卡新交付源码仅本说明和 smoke 脚本；尚未生成可发布整树或证实 local.7 二进制对应此刻源码。

恢复检查点：固定使用 `live-plan.json` 的 run/request/session/path，保留 admission、各次 inspect 错误与成功摘要；未知时只读 DB/事件查清，不换 ID 重发、不手写 receipt、不删 outbox、不重启。源码交接固定 HEAD、文件哈希和各贡献记录，由主控审查后决定提交/打包。
