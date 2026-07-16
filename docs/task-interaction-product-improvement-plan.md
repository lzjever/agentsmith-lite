# AgentSmith Lite Task Interaction 产品改进计划

状态：handoff-ready

日期：2026-07-13

适用仓库：`agentsmith-lite`

参考实现：`.reference/agentsmith` 的 Agent Task 工作区，以及 `.reference/botified` 的最新
TUI Interaction 投影。Botified TUI 只作为交互语义参考，不进入 AgentSmith 运行时。

## 1. 决策摘要

AgentSmith Lite 的 Task Detail 必须恢复原 AgentSmith 的 Conversation、Terminal 和
Artifacts 工作区体验，同时将 task 对话核心从旧 Codex/NDJSON 展示心智改为 Botified
原生 Interaction 语义。

最终实现只有一条路径：

1. AgentSmith Server 通过 Botified service API 读取结构化 state、timeline、message receipt、
   abort 和 transient LLM preview。
2. 服务端将 Botified timeline event 投影成稳定的 `TaskInteractionItem`，完成生命周期合并、
   状态判定、权限判定、脱敏和持久化。
3. Web 只消费 AgentSmith `/api/v1` 返回的 interaction、task capabilities 和流式更新，
   不读取 Botified、不解析 NDJSON、不合并事件、不推断业务状态。
4. 用户始终通过 Task Conversation 的同一个 composer 继续工作。服务端根据 task 状态决定
   消息进入当前 Botified session、进入等待队列，或创建已链接的 successor task，并返回明确
   disposition。Web 不根据提交期间的 task 状态竞态自行选择路径。
5. `Stop current turn` 只中止当前 Botified turn；`Cancel task` 才终止整个 AgentSmith task
   并进入 sandbox 回收。二者不能共用 API、按钮或状态。

NDJSON 继续只是 AgentSmith Server 与 Botified 之间的 transport format。它不是 Web API
contract，也不是用户可见 conversation model。

## 2. 为什么必须修改

当前 Lite 已经能读取 Botified timeline，但仍将事件粗略压成
`user_input/assistant_message/tool_execution/runtime_error`，再压成
`user/assistant/tool/system + text`。这会造成以下产品缺陷：

- 同一 tool call 的 started/completed/failed 被拆成多条日志或无结构文本；
- 同步工具、detached background task、task ask/tell/result 和 subagent 失去区别；
- queued、running、failed、delivery failed 等状态不能稳定呈现；
- 用户输入、assistant 回复、文件发布和错误缺少稳定 interaction identity；
- Web 只能展开一段工具 JSON，无法呈现 Botified 正在做什么和最终结果；
- 当前 transcript SSE 实际返回一页后关闭，Web 定时重连，既不是真正的 live stream，
  也无法表达同一个 interaction 的原位更新；
- 原 AgentSmith 的 active run、pending queue、connection recovery 和消息内 execution
  experience 没有完整恢复。
- 当前无 cursor 或 stale cursor 时退回 Botified `tail=1`，可能跳过未投影历史后仍推进 durable
  cursor，页面却无法告诉用户发生过 history gap。
- 当前持久化任意 event payload 并通过 `/events` 返回，字段黑名单不足以约束未知 tool output、
  header、URL credential 和 provider-specific secret。

最新 Botified TUI 已经用 `Interaction` 作为默认 timeline 模式，并按稳定业务 ID 合并
User、Assistant、Tool、TaskQuestion、TaskNotice、Task、Subagent 和 File 生命周期。
Lite 应采用这套语义，但必须把投影放在 AgentSmith Server，而不是照搬 TUI 的本地状态机。

## 3. 产品目标

### 3.1 用户目标

- 用户打开 task 后首先看到可连续阅读的对话，而不是底层事件列表。
- 用户能看见 agent 当前是否生成回复、调用工具、运行后台任务或等待 task question。
- 工具和后台工作默认显示短摘要、状态和结果，必要时可展开受控详情。
- 用户在 agent 运行时仍可提交后续消息，并看见消息是 accepted、queued 还是 rejected。
- 页面刷新、SSE 重连或 API 进程重启后，同一 interaction 不重复、不倒退、不丢失终态。
- 文件发布后在对话中出现可识别条目，并通过 AgentSmith artifact API 预览或下载。
- Conversation、Terminal 和 Artifacts 保持原 AgentSmith Task 工作区的信息关系。

### 3.2 工程目标

- 一个服务端 interaction projector，一份最终 API contract，一套 Web renderer。
- Botified timeline 是输入事实，AgentSmith interaction 是授权后的产品读模型。
- 所有生命周期合并、状态转换、消息投递和可用 action 都由服务端完成。
- 删除旧 transcript role projection、raw browser event path、前端 trace 拼装和独立 follow-up
  展示路径。
- 只增加完成核心 task experience 所需的数据和代码，不建立通用事件平台或 UI DSL。

## 4. 明确非目标

本计划不做：

- 调用、嵌入、发布或改造 Botified TUI；
- 在浏览器中连接 Botified `/v1/*`、读取 NDJSON 或持有 Botified service key；
- 复制 TUI 的 Ratatui 布局、F8 三模式、终端快捷键、profile setup 或 debug overlay；
- 恢复 Codex event parser、Codex runner core 或 Codex 特有 message schema；
- 新建 adapter、兼容层、双 transcript contract 或第二套 Task Detail；
- 把 raw timeline、audit、usage 或诊断链接变成主对话；
- 搜索 DSL、任意事件过滤器、插件式 renderer、用户可编辑 raw JSON；
- 新的 repo、独立 interaction service、消息总线或事件仓库；
- 生成 evidence、report、rehearsal、测试报告、视觉基线仓库或发布 gate；
- 对测试脚本、fixture、SSE wrapper 或 command wrapper 再做测试。
- 将 Project Chat 与 Task Conversation 合并。Project Chat 继续是无 sandbox/tool/artifact 的
  直接模型对话，不共享 Task message mutation、retry、branch 或 execution lifecycle。

原 AgentSmith 已明确删除的 i18n URL、LLMUP、JVS、WebDAV、远程/本地挂载、文件模板/
savepoint/version/restore、独立 runner 管理和治理页面仍不恢复。

## 5. 固定业务边界

### 5.1 AgentSmith Server 拥有

- project membership、task view/update 权限和 task-scoped Botified credential；
- Botified timeline ingestion、cursor recovery 和 event 去重；
- interaction identity、事件合并、状态单调性和显示字段脱敏；
- task run state、message admission、排队、幂等、重试和 successor task 创建；
- initial message delivery、runtime reachability、history completeness 和 successor disposition；
- `Stop current turn` 与 `Cancel task` 的合法性和执行；
- artifact 投影以及 Botified file ID 到 AgentSmith artifact ID 的转换；
- Conversation、Terminal 和 Task action 的服务端 capabilities；
- SSE history catch-up、live update、重连 cursor 和授权；
- usage、quota 和 light audit 的必要业务记录。

### 5.2 Web 只拥有

- 布局、展开/收起、滚动位置、composer draft 和 dialog open state；
- 按 API 返回的 `kind/status/capabilities` 选择既定组件和启用按钮；
- 将 server-sent `interaction/preview/run_state/connection/reset` 应用到本地列表；
- Markdown、plain text、code block 和受控 metadata 的安全显示；
- desktop、窄屏、light/dark 和无障碍交互。

Web 禁止：

- 从 `botifiedType`、cursor、正文、ID 前缀或事件顺序推断 interaction kind；
- 在浏览器中合并 tool/task/subagent 生命周期；
- 根据 task status 自己决定能否 send、abort、cancel、delete 或 open terminal；
- 将 raw tool payload 直接渲染为 HTML；
- 用本地 optimistic 业务状态覆盖服务端 receipt 或终态。

### 5.3 Botified TUI 的参考边界

可以复用其产品语义和稳定 key 规则：

- `User:<input_id>`
- `Assistant:<assistant_message_id>`
- `Tool:<tool_call_id>`
- `Task:<task_id>`
- `TaskQuestion:<ask_id>`
- `TaskNotice:<tell_id>`
- `Subagent:<subagent_id>`
- `File:<file_id>`

不能复用其 TUI 状态归属。Botified TUI 可以在本地 reducer 中投影；AgentSmith Web 不可以。

## 6. 最终用户体验

### 6.1 Task 工作区

Task Detail 继续使用原 AgentSmith 的主工作区：

- 顶部 Task Header：title、status、run state、Conversation/Terminal 切换和 task actions；
- 主列 Conversation：interaction list、active run state、connection state 和 composer；
- Terminal workspace：登录 bash executor 容器的独立 shell experience；
- 右侧 Artifacts：只有存在 artifact 时显示，可预览、下载和刷新；
- 窄屏：Conversation、Terminal 和 Artifacts 使用明确切换或 drawer，不并排挤压正文。

Task 页面不再把 sandbox namespace、cleanup internals 和 event count 放在对话上方抢占主路径。
这些只在克制的 task details 区域按需查看。

### 6.2 Interaction 类型

主 Conversation 只显示以下高价值类型：

| kind | 用户语义 | 主要显示 |
| --- | --- | --- |
| `user_message` | 用户输入 | 完整正文、accepted/queued/rejected |
| `assistant_message` | agent 最终回复 | Markdown 正文、生成状态、复制 |
| `tool` | 同步工具调用 | 工具名、命令/参数摘要、running/completed/failed、受控 output tail |
| `background_task` | detached 工作 | label、work summary、running/terminal 状态、结果或错误 |
| `task_question` | 后台工作向 main agent 提问 | question、expect、waiting/answered/expired/rejected |
| `task_notice` | 后台工作通知 main agent | notice、sender、accepted/rejected |
| `task_result` | 后台 task 终态结果 | completed/failed/lost/cancelled/timed_out 与结果摘要 |
| `subagent_result` | subagent 终态结果 | name、purpose、completed/failed/cancelled 与结果摘要 |
| `file` | Botified 发布文件 | artifact name、media type、bytes、preview/download action |
| `execution_boundary` | 当前 task 已续接到另一个 execution | successor 状态、target task 和明确打开入口 |
| `system_error` | 用户可感知且影响继续工作的错误 | 安全错误信息、retryable 状态和可用 action |

以下事件不进入默认 Conversation：provider request update、cycle started/completed、heartbeat、
queue drained、service status、重复 progress update 和无用户影响的 diagnostic。它们可以留在
interaction item 自带的受控 `Execution details` 中，但不创建 raw event API 或第二套对话。

### 6.3 生命周期合并

- 同一 stable key 始终对应一个 interaction item。
- started/update/completed/failed 通过服务端 upsert 原位更新，不能在 Web 中追加多行。
- 状态只能按规定单调前进。迟到的 running event 不能覆盖 completed/failed/cancelled。
- detached bash 从 `Tool:<tool_call_id>` 转成 `Task:<task_id>` 时，服务端必须合并旧 tool
  interaction，不留下重复的“工具仍运行”。
- detached work 的公开 interaction ID 以最早稳定的 work identity 为锚，创建后永不改变；
  task ID 与 tool call ID 的 correlation 由服务端保存。后续事件只将同一 item 的 kind 从
  `tool` 提升为 `background_task` 并增加 task 字段，不执行客户端 alias、remove 或 replace。
- task ask 与 reply 以 `ask_id` 合并；task tell 以 `tell_id` 合并；callback 用明确的
  `semantic_kind` 合并到 task/subagent result。
- Work item 的 execution status 与 callback delivery status 是两个正交字段。`completed` 不能
  覆盖 `delivery_failed`，也不能把 callback pending 误显示为 task 仍在运行。
- running background task 可按服务端返回的 `canStop` 显示 Stop work；服务端解析 interaction
  identity 并调用 Botified service API。Subagent 不提供直接 stop，用户仍通过普通 composer 告诉
  main agent；Task question 也不向浏览器暴露 `task_reply`，由 main agent 负责回复。
- 未识别 event 不投影为 User、Tool 或 System interaction，只安全推进已处理 source cursor；
  不为未知 payload 建 raw browser event store。

### 6.4 正文和详情

- User 与 Assistant 优先展示 timeline 的完整 `text/content/message`。
- 只有 preview 时，服务端返回明确 `contentMode=preview`；Web 显示“Preview only”，不能假装完整。
- 只有 Botified 明确提供 truncation metadata 时才显示 truncated，禁止匹配字符串 marker 猜测。
- Tool 默认显示工具名、命令或参数摘要和终态；output tail、exit code、错误和 log/artifact
  引用放在可展开详情中。
- Tool output、task result 和错误在服务端先按 7.6 的自由文本规则脱敏并限制大小。Web 不接收
  provider key、Botified service key、Kubernetes secret、session token 或 task 已知 credential value。
- Markdown 只用于 User/Assistant 和明确的语义文本；command/output 使用 plain text/code block。
- File interaction 只链接 AgentSmith artifact endpoint，不暴露 Botified internal URL 或 file path。

### 6.5 Active run 与 transient preview

- Task API 返回服务端 `runState`：`idle/starting/running/reconnecting/aborting/finalizing/terminal`。
- 运行时主 Conversation 显示一处 active run state，不在 header、banner 和每条 message 中
  分别推导三份状态。
- AgentSmith Server 可通过 Botified `/v1/llm-text-preview` 接收 transient preview，并通过
  AgentSmith SSE 转发 `assistant_preview`。浏览器绝不直接连接 Botified。
- Preview 只用于当前 active assistant item，不写成最终 interaction truth；
  `assistant_message.completed` 到达后由正式 item 替换。
- Preview 不可用或暂时断开时，服务端发送明确 connection/run status；最终 timeline message
  仍能完成对话。不得回退到浏览器直连 provider。

### 6.6 Composer 与消息队列

Conversation 只有一个 composer：

- Enter 发送，Shift+Enter 换行；发送按钮有明确 disabled/busy state。
- active run 期间仍允许提交普通消息。服务端 receipt 决定 accepted、queued、duplicate 或 rejected。
- queued message 在服务端允许时可编辑或删除；Web 使用服务端 capability，不自己判断状态窗口。
- 每次提交返回明确 disposition：`accepted_by_active_run`、`queued_for_active_run`、
  `successor_pending`、`successor_created` 或 `failed`，以及实际 `targetTaskId`。
- terminal task 上提交消息时，服务端沿现有产品规则创建 linked successor task；原页面保留
  conversation context，并显示 `Continued in new execution` boundary 和打开入口，不自动跳转，
  也不在已终态 Botified session 上伪造继续运行。
- 初始 task prompt 是服务端创建的第一条 `user_message`，不能由 Web 拼进 transcript。
- 初始消息必须呈现 `pending/dispatching/retrying/accepted/failed`，sandbox 尚未启动时不能只显示
  空 Conversation。
- 旧页面中 Conversation 下方独立的 Follow-ups 列表移除。排队消息直接显示在 composer
  附近；已接受消息进入 interaction list；successor relation 由 Task Header/linked task 表示。

### 6.7 两种停止语义

`Stop current turn`：

- 仅在服务端 capability `abortTurn=true` 时显示；
- 调用 task-scoped AgentSmith abort endpoint，再由服务端调用 Botified `/v1/abort`；
- 中止当前 agent cycle，不删除 task，不停止已 detached background task，不启动 sandbox cleanup；
- 完成后 task 可继续接收消息。

`Cancel task`：

- 仅在服务端 capability `cancelTask=true` 时显示；
- 终止整个 AgentSmith task，围栏后续投递，完成 artifact drain，并进入 sandbox cleanup；
- 使用现有 app-owned labels、UID 和 run fence，只回收本 task 资源；
- 终态为 cancelled，不允许继续同一 Botified session。

Web 文案、按钮位置和 confirmation 必须让两者不可能被误认为同一操作。

### 6.8 Connection 与恢复

- 初次进入先加载授权后的 authoritative interaction snapshot，再打开同一 AgentSmith SSE。
- SSE 使用不透明 `streamCursor`/`Last-Event-ID` 恢复，客户端只存储和回传，不解析。
- 服务端负责 Botified history 分页、timeline catch-up、去重和 projection replay。首次同步、
  runtime state 丢失或 stale cursor 时必须从 Botified 当前可用 history boundary 正向分页追平，
  禁止 `tail=1` 后宣称恢复完成。
- 如果缺失区间已经不在 Botified durable history 中，服务端返回 `historyStatus=gap` 和安全说明，
  保留已有 interaction，但不伪造缺失内容，也不生成诊断报告。
- SSE 发送完整 `upsert` item；重连后重复 upsert 必须幂等。
- 用户离开 tail 阅读历史时，新 interaction 不强制滚动页面，显示“new activity”入口。
- snapshot 返回 `runtimeReachability`、`historyStatus` 和 `lastSyncedAt`。Connection banner 只显示
  connecting、reconnecting、disconnected、history gap 和 recovered；不把 audit、
  report 或诊断页作为恢复主操作。可恢复时直接提供 Retry。

### 6.9 必须诚实呈现的边界状态

计划实施时不得把下列不同事实压成一个 `running/failed`：

- 初始消息 `pending/dispatching/retrying/accepted/failed`；
- input accepted 与 agent cycle started；
- queued message、delivery claim、`terminal_pending` 和 successor creation；
- task question `waiting/answered/expired/rejected/reply_failed`；
- work execution `running/completed/failed/cancelled/timed_out/lost`；
- callback delivery `pending/delivered/failed`；
- abort requested、turn aborted、task cancelled 和 sandbox cleaned；
- agent terminal、artifact draining、cleanup pending/running/failed；
- runtime unreachable、history gap、content preview/truncation 和 unknown semantic source；
- membership/endpoint 变化后 history 仍可读，但 composer、terminal 或 action 已不可用。

这些状态由服务端 snapshot、interaction union 和 capabilities 表达。Web 只显示，不补状态机。

## 7. 最终服务端契约

### 7.1 Interaction read model

在 `packages/contracts` 定义 discriminated union，不使用任意 `role + text`：

```ts
type TaskInteractionKind =
  | "user_message"
  | "assistant_message"
  | "tool"
  | "background_task"
  | "task_question"
  | "task_notice"
  | "task_result"
  | "subagent_result"
  | "file"
  | "execution_boundary"
  | "system_error";

interface TaskInteractionBase {
  id: string;
  revision: number;
  taskId: string;
  kind: TaskInteractionKind;
  title: string;
  body: string | null;
  contentMode: "full" | "preview" | "none";
  position: number;
  occurredAt: string;
  updatedAt: string;
}
```

每个 union member 自己定义有限 status union，并只增加该 kind 必需的 typed fields，例如 tool 的
`toolName/command/exitCode`
和 file 的 `artifactId/name/mediaType/bytes`。Tool、background task、task result 和 subagent result
分别使用 typed `executionStatus` 与 `deliveryStatus`，不把二者压成一个模糊 status。不要创建通用
`metadata: Record<string, unknown>` 让 Web 重新理解 Botified payload。Botified source cursor、type、
session ID 和 raw data 都是服务端内部字段，不进入此公开 contract。

Task detail 同时返回服务端 capabilities：

```ts
interface TaskCapabilities {
  sendMessage: boolean;
  editQueuedMessage: boolean;
  abortTurn: boolean;
  cancelTask: boolean;
  openTerminal: boolean;
  deleteTask: boolean;
}
```

capabilities 是当前用户、task state 和 terminal occupancy 的服务端结果，不是前端权限常量。
Interaction snapshot 还必须返回：

```ts
interface TaskInteractionSnapshot {
  items: TaskInteractionItem[];
  queuedMessages: TaskQueuedMessage[];
  nextPageCursor: string | null;
  hasMoreBefore: boolean;
  streamCursor: string;
  runState: "idle" | "starting" | "running" | "reconnecting" | "aborting" | "finalizing" | "terminal";
  runtimeReachability: "unknown" | "reachable" | "unreachable";
  historyStatus: "complete" | "gap";
  lastSyncedAt: string | null;
  capabilities: TaskCapabilities;
}

interface TaskQueuedMessage {
  id: string;
  content: string;
  deliveryStatus: "pending" | "dispatching" | "terminal_pending" | "failed";
  editable: boolean;
  deletable: boolean;
  updatedAt: string;
}
```

`items`、pagination state 和 `streamCursor` 必须在同一个 repeatable-read 数据库 snapshot 中生成：
先确定该 snapshot 可见的最大 `change_seq`，只读取不超过该值的最新 interaction revision，并将
该值编码为 `streamCursor`。禁止先查 items、再从另一个数据库时点读取 cursor；否则两次读取
之间的更新会被永久跳过。

### 7.2 HTTP API

最终只保留以下 task conversation 路径：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/v1/tasks/:taskId/interactions` | 向后分页的 interaction history 与当前 stream cursor |
| `GET` | `/api/v1/tasks/:taskId/interactions/stream` | catch-up 后持续发送 upsert/preview/run_state/connection/reset |
| `POST` | `/api/v1/tasks/:taskId/messages` | 唯一的 task composer 提交入口 |
| `PATCH` | `/api/v1/tasks/:taskId/messages/:messageId` | 修改仍可编辑的 queued message |
| `DELETE` | `/api/v1/tasks/:taskId/messages/:messageId` | 删除仍可删除的 queued message |
| `POST` | `/api/v1/tasks/:taskId/turn/abort` | 中止当前 Botified turn |
| `POST` | `/api/v1/tasks/:taskId/work/:interactionId/stop` | 停止允许单独终止的 background work |
| `POST` | `/api/v1/tasks/:taskId/cancel` | 取消整个 AgentSmith task |

写 API 全部使用现有 idempotency key 和 request hash 规则。服务端响应返回最终 receipt、
message disposition、capabilities 变化和实际 `targetTaskId`。

旧 `/transcript`、`/transcript/stream`、面向 UI 的 `/follow-ups` 和公开 `/events` 路径在新页面
切换时直接删除。不保留 alias、deprecated response 或 adapter。展开详情只能来自 interaction
union 中服务端 allowlist 后的 typed detail，浏览器没有绕过脱敏边界读取 raw payload 的路径。

Interaction SSE 是真正的长连接，不是一页响应加浏览器定时重连：

- 建连前完成 OIDC session 与 task view authorization；
- 先按 `Last-Event-ID` 或首次 `streamCursor` 从数据库补发 durable changes；
- durable change 使用 `event: interaction`、`id: <opaque cursor>` 和完整 interaction item；
- transient preview、run state 和 connection state 使用独立 typed event，不伪造 durable revision；
- 定期发送 SSE comment heartbeat；task terminal 后保持流可用，因为用户仍可能提交消息并产生
  successor boundary，artifact drain 和 cleanup 状态也可能继续变化；
- 每条连接设置有限寿命，到期发送 `reconnect` 后正常关闭。浏览器携带最后 durable cursor 重连，
  从而重新执行 OIDC session 和 membership authorization；task 删除后才发送 `done`；
- cursor 格式非法或不属于该 task 返回 `400`；未来若实施 change retention，确实过期才返回
  `410 cursor_expired` 和 authoritative snapshot reset；
- 使用简单的数据库 catch-up loop 和进程内 wake-up 优化即可，不引入 Redis、Kafka、消息总线
  或单独 realtime service。数据库检查保证进程重启或多副本时仍能续传。

### 7.3 存储

新增唯一 `task_interaction_changes` 表，同时承担 durable interaction change log 和 SSE catch-up，
避免维护 raw event 表、current interaction 表和第二条 change feed。每行保存一个完整、已脱敏的
interaction upsert：

- `task_id + change_seq` 作为 task 内单调变化顺序；
- `source_kind + source_id + source_revision` 与 task 组成唯一约束。`source_kind=botified` 时
  source ID 是内部 cursor 且 revision 固定为 0；`source_kind=product` 时 source ID 是稳定的
  task/message/successor identity，source revision 是该产品 lifecycle record 的单调版本；
- stable `interaction_id` 与单调 `revision`；
- internal correlation keys，用于 task ID、tool call ID 和 callback ID 命中同一 interaction；
- kind-specific typed interaction JSON，只包含公开 allowlist 字段；
- `occurred_at` 使用 Botified event time，`updated_at` 使用实际投影更新时间。

History snapshot 取每个 `interaction_id` 的最新 revision 后按首次发生顺序分页；SSE 按
`change_seq` catch up。公开 stream cursor 是 AgentSmith 生成的 task-scoped opaque cursor，
不是 Botified source cursor。

Botified timeline 和 AgentSmith 自身的 task/message lifecycle 都写入同一 change log。初始 prompt
的 pending/dispatching/retrying、queued message 和 successor boundary 不等待 Botified timeline，
由 application service 以 `source_kind=product` 写入；Botified receipt 或 timeline 到达后按同一
interaction ID 提升 revision。

每批 timeline 同步或产品 lifecycle mutation 必须在同一个数据库事务中：

1. 锁定 task/runtime sync row，避免并发 ingestion；
2. 插入 interaction changes 和 artifact；
3. 应用 task lifecycle signal；
4. Botified timeline batch 才推进 runtime `sourceTimelineCursor`；product lifecycle mutation 不改
   Botified cursor。

不要先推进 source cursor 再异步补 read model，也不要每次全量读取历史 event 构造 O(n) cursor Set。
不新增 interaction event bus、event sourcing framework 或第二个数据库。

现有 `agent_task_events` 已丢失 canonical `time/trace/item`，不得作为完整 envelope 喂给新
projector，也不编写 legacy adapter 猜测 identity。迁移规则只有一条：仍能访问 Botified durable
timeline 的 task 从当前 history boundary 用 canonical envelope 重投影；其余旧 task 返回
`historyStatus=gap`。切换完成后删除 `agent_task_events`、`AgentTaskEvent/TaskEventKind` 和对应
store/API，不长期双写，也不从旧 transcript 文本伪造历史。

### 7.4 Botified timeline ingestion

扩充当前 `BotifiedTimelineEvent` 读取完整稳定 envelope 字段：

- `version/seq/cursor/time/session_id/type/trace/item/data`；
- 不再丢弃 `item.id/type/status` 和 Botified event time；
- 只支持当前选定 Botified release 的 canonical event names；
- 删除 `assistant.message`、`tool.*` 等无实际 runtime 需要的 Codex/legacy alias；
- unknown event 只影响 ingestion cursor，不持久化 raw arbitrary payload；必要的安全错误由明确
  allowlist 投影为 `system_error`。
- Botified client 必须消费 `hasMoreAfter` 直到追平 checkpoint。首次、state 丢失和 stale cursor
  从当前可用 history boundary 正向重放；如果 boundary 前数据已过期则标记 history gap，禁止
  自动 tail reset 后宣称成功。

Projector 使用明确 allowlist 和稳定 key，不从自由文本反推 source、kind、task ID 或状态。

### 7.5 Projector 规则

Canonical Botified envelope parser 保留在 `packages/botified-runtime`；唯一产品 projector 位于
`packages/application`，因为它同时处理 Botified 事实和 AgentSmith message/task lifecycle。
Projector 接受两种明确的 typed source：canonical Botified timeline envelope，以及 application
service 产生的有限
`task_created/message_admitted/message_delivery/successor_created` product lifecycle input。
这不是通用 event framework，不能接受任意 payload 或由 Web 写入。

- 输入：一个 typed source 和该 stable interaction 的最新 state；
- 输出：零个或一个 interaction upsert，可选 artifact upsert 和 task lifecycle signal；
- 不访问 HTTP、数据库、React 或 Kubernetes；
- 状态 rank、body ownership、tool-to-task alias 和 semantic callback mapping 只有一份实现；
- application service 负责事务、授权、history recovery 和调用顺序；store 只持久化，不复制投影规则。

Botified TUI `InteractionProjection` 的事件 allowlist、stable key、monotonic status 和 body
ownership 可作为移植参考。由于源代码为 Rust、Lite 为 TypeScript，应按同一规则实现小型
typed projector，不复制 Ratatui model、render、viewport、debug 或 input 代码。

### 7.6 安全与授权

- history、stream、message、work stop、abort 和 cancel 每次都要求 task/project membership；
- SSE 建连和重连都重新授权，不能仅信任旧 cursor；
- interaction 先按 kind 做字段 allowlist，再处理允许保留的自由文本，不能只依赖字段名黑名单。
- AgentSmith 为每个 task 建立仅驻留服务端内存的 redaction set，包含它注入或可读取的 provider
  credential、Botified service key、sandbox credential、token 和 secret env value。投影前对
  command summary、output tail、result 和 error message 做已知 secret value 精确替换；redaction
  set 本身不写入 interaction、audit 或日志。
- 自由文本 redactor 还必须结构化清洗 URL userinfo 和常见敏感 query parameter，以及
  `Authorization`/cookie/header、`KEY=value` 和 JSON key/value 中的 token、key、secret、password、
  credential、signature 等值。继续保留现有高置信 token-shape 识别，但不能把它当唯一防线。
- 默认不持久化 raw shell command/arguments，只保留 Botified `arguments_summary` 或安全的 tool name；
  output/error 只保留有界 redacted tail。结构无法安全处理、包含控制字符或超过允许边界时省略正文，
  返回 `contentMode=none` 和 `detailsOmitted=true`，不能为了“可诊断”放宽安全边界。
- prompt 和 assistant 正文属于 task product data，只返回有 task view 权限的用户；
- light audit 只记录 message/abort/cancel 等动作元数据，不记录正文、tool output 或 secret；
- artifact interaction 只返回 AgentSmith artifact ID，下载仍经过 project authorization；
- 不向 Web 返回 Botified base URL、service key、sandbox credential 或内部绝对路径。

## 8. Web 实施范围

### 8.1 优先复制和适配

从 `.reference/agentsmith/src/components/agent-tasks/` 复制以下用户体验骨架后直接修改：

- `TaskPageContent.tsx`
- `ConversationPanel.tsx`
- `ConversationInput.tsx`
- `MessageList.tsx`
- `MessageItem.tsx`
- `ArtifactsPanel.tsx`
- `TaskHeader.tsx`
- Conversation/Terminal mode 和 responsive workspace 相关组件

复制后立即删除：

- `next-intl` 和 locale key；
- Codex NDJSON decode、trace recovery、runner-test badge 和 governance diagnostics link；
- 前端 `activeRunView` 拼装、trace-by-message backfill 和 failure explainability；
- mock/BFF/legacy permission hook；
- 与已删除 runner、LLMUP、治理报告相关的按钮和状态。

然后直接连接最终 `/api/v1/tasks/:id/interactions*`、message、abort、cancel、artifact 和 terminal
API。不要先接旧 transcript 再写 adapter。

### 8.2 唯一组件结构

- `TaskConversationWorkspace`：布局、history loading、SSE 和 composer 展示状态；
- `TaskInteractionList`：按服务端 order 和 key upsert，不理解 Botified；
- `TaskInteractionItem`：按 discriminated union 选择固定 renderer；
- `TaskComposer`：draft、submit 和 queued message UI；
- `TaskRunStatus`：只展示服务端 run state 与 abort capability；
- `TaskArtifactsPanel` 与 `TaskTerminalWorkspace`：继续使用各自现有 API 和生命周期。

不要为每种 event 建插件注册表。十一种固定 kind 使用明确 TypeScript switch，并让 exhaustive
check 在新增 kind 时编译失败。

### 8.3 列表和流式行为

- 首屏加载最新一页，向上滚动加载更早 history；
- SSE interaction 按 `id + revision` 替换或插入，不能按接收顺序重复 append；
- preview 按 server-provided active key 更新临时 assistant surface；
- 用户靠近底部时自动跟随；阅读历史时保持位置并显示 new activity；
- reconnect 后先应用 catch-up，再显示 recovered；
- queued message edit/delete 成功后使用服务端返回对象替换，不做业务 optimistic guess；
- terminal task 创建 successor 后显示服务端返回的 execution boundary 和打开入口；不自动导航，
  不在前端复制 task create 参数。

### 8.4 可访问性和响应式

- Interaction list 使用语义化 list/article；run/connection update 使用克制的 live region；
- 展开工具详情是 button + controlled region，支持键盘、focus 和 `aria-expanded`；
- Stop current turn 与 Cancel task 有独立 accessible name、颜色和 confirmation；
- output/code block 可水平滚动，长词和路径不能撑破容器；
- 窄屏 composer 固定在可用 viewport 内，不能遮住最新消息；
- light/dark 均使用迁回的原 AgentSmith tokens，不新建 Lite 专用对话主题；
- 不在界面展示 TUI 快捷键、Botified event name、cursor 或 raw JSON。

## 9. 删除和替换清单

以下旧实现应随对应新路径落地直接删除，不保留“以后再清理”的双实现：

- `TaskTranscriptRole`、`TaskTranscriptEntry`、`TaskTranscriptPage`；
- `taskTranscriptEntry()` 的 `role + text` projection；
- `/tasks/:id/transcript` 和 `/tasks/:id/transcript/stream`；
- 当前 `TaskTranscript.tsx`；
- Web 端定时断开/重连 transcript page 的 polling loop；
- Conversation 下方独立 `FollowUpList` 及其平行 composer；
- UI-facing follow-up API 和 client methods，改由唯一 messages API 取代；
- `decodeCodexEventText` 及 Codex-specific message/trace parser；
- 浏览器端 `activeRunView`、run activity 和 trace lifecycle 拼装；
- runner-test、trace diagnostics、audit/usage recovery links 和 SSE debug panel；
- Botified event compatibility alias 中没有当前 release 真实来源的分支；
- 因旧 transcript contract 失效且不再验证业务行为的测试。

`task_interaction_changes`、artifact store、task lifecycle、terminal API、quota/usage/audit 核心
业务不能因删除旧 UI 投影而删除。

## 10. 实施阶段与产出物

### 阶段 1：最终 contract 和服务端 projector

产出：

- `packages/contracts` 中 typed interaction union、capabilities、page 和 SSE event；
- `packages/ports` 中 interaction store port；
- PostgreSQL migration 与 in-memory/PostgreSQL store 实现；
- `packages/botified-runtime` 中 canonical envelope parser，`packages/application` 中唯一
  InteractionProjector；
- application service 在 timeline ingestion 事务中 append interaction change、upsert artifact、
  更新 task lifecycle 并推进 source cursor；
- 对仍可访问 Botified durable history 的 task 执行 canonical 重投影；不可无损恢复的旧 task
  标记 history gap，不转换有损旧 event。

完成判断：选定 Botified canonical fixture 输入后，服务端得到稳定 User、Assistant、Tool、
detached Task、Question/Reply、Subagent Result、File 和 Error interaction；重复和乱序终态不倒退。

### 阶段 2：最终 message、abort 和 live interaction API

产出：

- interactions history 与持续 SSE；
- 唯一 messages create/update/delete API；
- terminal task successor 创建响应；
- background work stop、turn abort 与既有 task cancel 的明确分离；
- task detail capabilities；
- Botified preview 的服务端转发和 final message 收敛。
- Lite task-scoped Botified 配置启用 `llm_text_preview`，仅允许 AgentSmith Server 通过 sandbox
  internal service 读取；preview 不经公开 Ingress 暴露。

完成判断：同一授权用户刷新和重连后不重复 interaction；active task 可 queue/edit/delete message；
abort 后 task 可继续；cancel 后进入现有回收；terminal task message 创建 linked successor。

### 阶段 3：恢复原 Task Web 工作区并接最终 API

产出：

- 从原 AgentSmith 复制并瘦身后的 Task Header、Conversation、Message、Composer、Terminal
  mode 和 Artifacts workspace；
- 十一种 fixed interaction renderer；
- active run、preview、connection recovery、history pagination 和 new activity behavior；
- server capabilities 驱动的 send/abort/cancel/terminal/delete action；
- desktop、窄屏、light/dark 完整状态。

完成判断：用户不需要打开 Execution details 即可理解一次真实 task 的输入、agent 回复、工具、
后台工作、文件和错误；Web bundle 不包含 Codex parser、Botified client 或业务投影规则。

### 阶段 4：删除旧路径并收敛文档

产出：

- 删除第 9 节列出的 transcript、follow-up UI、Codex parser 和前端 run projection；
- 更新 `docs/api-contract.md`、`docs/architecture.md` 和 `docs/botified-runtime.md`；
- 更新主产品计划阶段 3/4 的 Task Detail 描述，指向本计划的最终 interaction contract；
- 删除只覆盖已移除 contract、组件或 legacy alias 的测试。

完成判断：代码搜索不存在 UI-facing `TaskTranscriptEntry`、`decodeCodexEventText`、旧 transcript
route 或第二个 task composer；文档不再声称 Lite runner 禁用本计划所需的 Botified preview。

## 11. 最小核心逻辑验证

验证服务于实现，不形成 gate、报告或治理流程。

### 11.1 小型自动测试

只保留和新增以下窄测试：

- projector：每种 canonical high-value event 的映射；同 key 合并；状态单调；tool-to-task alias；
- redaction：task 已知 secret 分别出现在 command、output、error、URL、header 和 `KEY=value` 时不会
  进入 interaction change；无法安全处理的正文被省略；
- application：interaction + artifact + lifecycle + source cursor 原子写入；unknown event 不进入
  conversation 且不会阻塞后续 canonical event；
- API：membership、history pagination、SSE catch-up、message receipt、abort 与 cancel 分离；
- Web component：typed kind renderer、upsert by `id + revision`、server capability 控制、queued
  message 操作。

不要测试 fixture loader、测试 helper、SSE test wrapper、migration runner 或命令脚本本身。
不要为 projector 建通用仿真框架；使用少量手写 canonical Botified envelope 即可。

### 11.2 本地真实路径

实现完成后由 agent 在本地单节点 K8s 串行执行一次真实路径：

1. 通过 Keycloak 登录并打开一个 project。
2. 使用本机 DeepSeek OpenAI-compatible endpoint 创建 task。
3. 观察 User、Assistant、Tool 和 active run 原位更新。
4. 在 agent 运行时提交 queued message，并编辑或删除一条仍 pending 的消息。
5. 触发 detached bash 或后台 task，确认 tool/task 不重复且终态正确。
6. 发布文件并从 Conversation 和 Artifacts 下载同一 AgentSmith artifact。
7. Stop current turn，随后在同一 task 再发送消息。
8. Cancel 另一个 task，确认只清理该 task 的 app-owned sandbox 资源。
9. 打开 Terminal，确认登录 bash executor 容器且与 Botified 共享受控 PVC、进程隔离。
10. 刷新页面并短暂中断 SSE，确认 history 和 interaction 状态恢复。

Playwright 只用于开发者主动检查 desktop/narrow、light/dark、长正文、展开 tool、preview、
reconnect、queued message、abort/cancel 和 artifact 状态。发现问题立即在实现处修正。
不提交 Playwright 测试脚本、截图基线、证据目录或测试报告，也不把人工 visual/e2e 设为发布 gate。

## 12. Handoff 修改范围

预计主要修改：

- `packages/contracts/src/api.ts`
- `packages/ports/src/store.ts`
- `packages/ports/src/botified.ts`
- `packages/botified-runtime/src/projection.ts`
- `packages/botified-runtime/src/config.ts`
- `packages/application/src/taskInteractionProjector.ts`
- `packages/application/src/taskService.ts`
- `packages/adapters-postgres/src/inMemoryProductStore.ts`
- `packages/adapters-postgres/src/postgresProductStore.ts`
- `packages/adapters-postgres/migrations/*`
- `packages/api-entry-node/src/server.ts`
- `src/lib/api/client.ts`
- `src/components/tasks/*`
- 从 `.reference/agentsmith/src/components/agent-tasks/*` 复制并适配的最终 Next 组件
- `docs/api-contract.md`
- `docs/architecture.md`
- `docs/botified-runtime.md`
- `docs/agentsmith-lite-product-development-plan.md`

不修改 substrates repo，不新建 repo，不要求云环境，也不引入新的基础服务。

## 13. 完成定义

只有同时满足以下产品事实，才算本计划完成：

- Task Conversation 默认呈现 Botified Interaction，而不是 Codex/NDJSON event rows；
- 原 AgentSmith Conversation、Terminal、Artifacts 工作区体验在 Lite 保留范围内恢复；
- 服务端是 interaction、run state、message queue、action legality 和 recovery 的唯一业务实现；
- User、Assistant、Tool、Task、Question/Notice/Result、Subagent、File 和 Error 可正确显示；
- queued message、successor task、Stop current turn、Cancel task 和 SSE recovery 行为明确可用；
- Web 不连接 Botified、不解析 NDJSON、不合并 lifecycle、不推断 capabilities；
- 旧 transcript、独立 follow-up UI、Codex parser 和前端 run projection 已删除；
- 本地单节点 K8s 使用真实 DeepSeek 后端走通核心路径；
- 没有新增 report、evidence、rehearsal、默认 gate 或测试治理层。

开发中遇到协议或 UI 缺陷时直接在 projector、application service、API contract 或对应组件
中修正。不要用兼容 adapter、诊断产物或后续治理任务代替当场修复。
