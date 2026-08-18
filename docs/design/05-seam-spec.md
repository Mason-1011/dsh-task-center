# 05 定义件规格:`task/task`

> 所有其他包的依赖根。模式范本:`packages/goal/goal/src/domain.ts`(版本化判别联合 + 快照变更 + 错误码联合 + 活事件)。
> 本文件是规格草案,实现时逐节落进 `packages/task/task/src/`。

## 1. 状态机:完整转换表

状态:`todo / active / blocked / review / done`。归档不是第六个状态——用域全局的归档集合(仿 workspace 的 `archivedSessionIds`),归档保留 `sessionIds` 槽位。

| 起始 | 操作 | 终态 | 守卫条件 | 失败错误码 |
|---|---|---|---|---|
| — | `create` | todo | objective、acceptance 非空;workspaceIds 可引用不存在的工作区(P1 再校验) | `TASK_INVALID_OBJECTIVE` / `TASK_INVALID_ACCEPTANCE` |
| todo | `claim` | active | 任务未被活会话持有;调用会话挂入 `sessionIds` 尾部 | `TASK_NOT_FOUND` / `TASK_ALREADY_CLAIMED` |
| active | `progress` | active | note 非空;contextPack 重算不超上限 | `TASK_NOT_CLAIMED` / `TASK_INVALID_NOTE` |
| active | `block` | blocked | 携带 `{code, message}` 理由 | `TASK_INVALID_REASON` |
| active / blocked | `release` | todo | 释放持有:清 holder 与 blockedReason;contextPack 保留(续做凭记忆不凭持有) | `TASK_NOT_CLAIMED` |
| blocked | `progress` | active | 同 active/progress(自动解除阻塞) | 同上 |
| active | `submit` | review | completion note 非空,含对照 acceptance 的自检结论 | `TASK_INVALID_NOTE` |
| review | `approve` | done | **仅人类**(命令/面板通道;工具面不注册此操作) | `TASK_FORBIDDEN` |
| review | `reject` | active | **仅人类**;理由必填并写入 contextPack | `TASK_FORBIDDEN` / `TASK_INVALID_REASON` |
| 非归档非终态 | `abandon` | (归档) | 操作者或创建者 | `TASK_FORBIDDEN` |
| 任意 | `edit` | 不变 | 仅 objective/acceptance/wakeRule 可改;改 acceptance 时若在 review 需先 reject | `TASK_STALE_REVISION` |
| todo / active / blocked | `subtask-add` | 不变 | 挂接一个已存在的子任务;per-record 查重,跨记录守卫(存在/非自身/防环,见 §1.1)在服务提交层 | `TASK_SUBTASK_SELF` / `TASK_SUBTASK_CYCLE` / `TASK_SUBTASK_DUPLICATE` / `TASK_NOT_FOUND` |
| todo / active / blocked | `subtask-remove` | 不变 | 解除已挂接的子任务;父子自身状态均不变 | `TASK_SUBTASK_NOT_CHILD` |
| 任意 | `wake-set` / `wake-clear` | 不变 | 规则仿 schedule 记录形状;every 间隔有下限 | `TASK_WAKE_INVALID_RULE` |
| todo / active / blocked / review | `patrol` | 不变 | 巡检观察:note 非空(现状),可选 next(下一步)/ blocker(卡点)写进 contextPack;不认领、不改状态与持有、**不刷新 workedAt**(搁置时钟不被观察重置) | `TASK_INVALID_NOTE` |

并发控制:每次变更带 `revision` 比较并置换(仿 goal 的 `GOAL_STALE_REVISION`)。

**权限矩阵**(在执行器里强制,不靠 schema 省略——仓库规则"决策在做出决策的操作里强制";机械 actor 被钉死在自己的簿记动词上,存活/到点判断在账本之外的对应插件里):

| 操作 | 模型(工具) | 人类(命令/面板) | 定时器(task-wake) | 系统(task-reaper) |
|---|---|---|---|---|
| create / edit / abandon | ✓ | ✓ | **✗** | **✗** |
| claim / progress / block / submit | ✓(限当前持有会话) | ✓ | **✗**(被拉起的会话以模型 actor 走工具面) | **✗** |
| patrol | ✓(不限持有:巡检会话是任务的陌生人) | ✓ | **✗** | **✗** |
| release | ✓(限当前持有会话) | ✓ | **✗** | ✓(仅死持有;存活判断在 task-reaper) |
| subtask-add / subtask-remove | ✓(限父任务持有会话) | ✓ | **✗** | **✗** |
| approve / reject | **✗** | ✓ | **✗** | **✗** |
| wake-set / wake-clear | ✓ | ✓ | 仅机械簿记(S5 实现):消费到点——一次性清除、every 推进锚点,且先于起会话提交 | **✗** |

### 1.1 子任务挂接的跨记录守卫

`subtask-add` 的守卫分两层:查重在 fold(纯、单记录、重放可见);存在性、自身、防环在服务提交层(需要看到**其他**任务的记录,fold 拿不到)。防环规则:从候选 child 出发沿 `subtasks` 下行可达 parent 即成环——A→B 已挂时 B→A 拒绝。聚合读取 `children(taskId)` 按 `subtasks` 顺序返回子任务视图(含归档),供父任务侧汇总进度。

### 1.2 项目:同一账本里的第二族实体

项目与任务共用一条域事件流(一个 store、一次 fold),不是独立服务。操作闭集 `project-create / project-rename / project-archive`:

| 操作 | 守卫条件 | 失败错误码 |
|---|---|---|
| `project-create` | 仅人类 actor;名称非空;id 未被占用 | `PROJECT_FORBIDDEN` / `PROJECT_INVALID_NAME` / `PROJECT_ALREADY_EXISTS` |
| `project-rename` | 仅人类 actor;目标存在且未归档;新名称非空 | `PROJECT_FORBIDDEN` / `PROJECT_NOT_FOUND` / `PROJECT_ARCHIVED` / `PROJECT_INVALID_NAME` |
| `project-archive` | 仅人类 actor;目标存在且未归档 | `PROJECT_FORBIDDEN` / `PROJECT_NOT_FOUND` / `PROJECT_ARCHIVED` |

项目没有状态机,只有 `archived` 标记(记录内字段,不同于任务的域全局归档集合)。归档项目不再接收新任务,但其分组与任务保持可读——面板继续展示,`PROJECT_ARCHIVED` 只拦新的挂入。

任务的 `create`/`edit` 可携带 `projectId`:**键存在且非空即挂入,键存在且为 null 即移出**(edit 专用)。引用完整性双向强制:服务提交层在 append 前校验项目存在且未归档(被拒的挂入不产生任何事件);fold 重放后做悬挂引用检查,任务指向不存在的项目即抛错——账本损坏要炸在明处。

### 1.3 候选:待确认的轻实体族(6a 已实现)

候选与任务、项目共用一条域事件流,同一 fold 聚合返回 `{tasks, projects, archivedTasks, candidates}`。候选没有状态机,只有 `pending` 到三个终态之一的单向转换,**每个动词只在 pending 时合法**:

| 操作 | 守卫条件 | 失败错误码 |
|---|---|---|
| `candidate-create` | 仅 source actor(抽取器);objective 非空;同源(完整 origin 三元组)任一状态已存在即拒 | `CANDIDATE_FORBIDDEN` / `CANDIDATE_DUPLICATE_ORIGIN` / `CANDIDATE_INVALID_OBJECTIVE` |
| `candidate-promote` | 仅人类;验收非空(候选抽不出验收,这一段由人补);服务层**先建任务(origin 记候选与源会话)后落晋升**——崩溃窗口内重放由"同 origin.candidateId 的任务已存在"挡住重复晋升 | `CANDIDATE_NOT_FOUND` / `TASK_STALE_REVISION` / `CANDIDATE_ALREADY_EXISTS` / `CANDIDATE_INVALID_ACCEPTANCE` / `CANDIDATE_INVALID_TRANSITION` |
| `candidate-ignore` | 仅人类;终态 | 同上 CAS 两码 + `CANDIDATE_FORBIDDEN` / `CANDIDATE_INVALID_TRANSITION` |
| `candidate-supersede` | 仅 source actor(来源会话把事做完了);理由必填;终态 | 同上 + `CANDIDATE_INVALID_REASON` |

记录字段:id、origin(`sessionId` + tier + key;tier ∈ goal / plan / todo / summary,key 稳定于来源记录)、objective / acceptance 草稿(结构档 acceptance 留空由人补;总结档是唯一自动填验收草稿的档——三必要条件要求它写得出来)、note(blocker / 计划正文 / 未完 todo / 总结补充说明)、promotedTaskId(晋升后)、createdAt、revision。候选不持上下文包——它只有草稿,不是工作现场。人类与 source 的候选变更只落域事件,不写会话回执(它们不经会话内的模型)。

## 2. 会话事件(进 `SessionEventMap`,required-on-read)

### `task/change` —— 模型视角的回执

快照式(仿 goal 的全量快照变更,不做增量):

```ts
interface TaskSnapshotChangeMeta {
  readonly kind: 'task/change'
  readonly version: 1
  readonly operation: TaskOperation          // 上述动词闭集
  readonly taskId: TaskId
  readonly revision: number                  // 变更后版本
  readonly task: TaskView                    // 变更后完整视图
}
```

仅当变更**由会话内的模型**触发时写入(人类面板/定时器路径只写域事件流,不写会话事件)。

### `task/context-injected` —— 认领注入的凭证

```ts
interface TaskContextInjectedMeta {
  readonly kind: 'task/context-injected'
  readonly version: 1
  readonly taskId: TaskId
  readonly revision: number                  // 注入时的任务版本
  readonly content: string                   // 注入的 contextPack 全文(铁律:日志可重建注入物)
}
```

## 3. 域事件流(权威账本,storage-domain `events` 表)

```ts
type TaskDomainEvent = {
  readonly eventId: TaskEventId              // 单调递增,域内唯一
  readonly taskId: TaskId
  readonly revision: number                  // 变更后版本,域流内严格递增
  readonly actor: { kind: 'model'; sessionId: SessionId } | { kind: 'human' } | { kind: 'wake' } | { kind: 'system' } | { kind: 'source' }
  readonly at: string                        // ISO-8601
  readonly change: TaskSnapshotChangeMeta    // 与会话事件同构
}
```

**双账本一致性(包 invariant 的内容)**:任一 `taskId+revision` 的会话 `task/change` 事件,必能在域事件流找到同 `taskId+revision`、且 actor.sessionId 属于该任务 `sessionIds` 的域事件;`TaskRecord` 等于域事件流的 fold 结果。

域事件流是任务与项目两族实体共用的账本:`change.kind === 'project/change'` 的事件走 `ProjectDomainEvent`(同构 envelope,`actor` 仅人类)。fold 一次产出 `{ tasks, projects, archivedTasks }`,重放后校验跨族引用(§1.2)。

## 4. 服务 API(`ctx.tasks`)

| 方法 | 说明 |
|---|---|
| `create(input): Promise<TaskHandle>` | 建任务;handle 含 disposer(未 claim 前可撤) |
| `get(taskId): Promise<TaskView \| undefined>` | 单个读 |
| `list(filter): Promise<TaskView[]>` | 按 status / workspaceId / projectId / archived 过滤 |
| `claim(taskId, session): Promise<TaskView>` | 持有者登记 |
| `mutate(taskId, expectedRevision, change): Promise<TaskView>` | 所有转换的单一入口(比较置换) |
| `wakeRules(): AsyncIterable<WakeDue>` | task-wake 消费:当前到点的唤醒规则 |
| `projects(): readonly ProjectView[]` | 项目列表,创建序,含已归档 |
| `project(projectId): ProjectView \| undefined` | 单个项目读 |
| `projectCreate(name, actor): Promise<ProjectHandle>` | 建项目;handle 含 disposer(dispose 即归档) |
| `projectMutate(id, expectedRevision, mutation, actor): Promise<ProjectView>` | 项目改名/归档(比较置换) |
| `candidates(): readonly CandidateView[]` | 候选列表(创建序,终态含内) |
| `candidateByOrigin(origin): CandidateView \| undefined` | 同源查重(抽取器用) |
| `candidateCreate(input, actor): Promise<CandidateView \| TaskError>` | 产候选(仅 source,§1.3) |
| `candidatePromote(id, expectedRevision, input, actor): Promise<{ task; candidate } \| TaskError>` | 晋升为任务(仅人类;先建任务后落晋升) |
| `candidateIgnore(id, expectedRevision, actor)` / `candidateSupersede(id, expectedRevision, reason, actor)` | 终态转换(比较置换) |

`TaskView` = TaskRecord 的只读投影 + 派生项(持有会话、是否阻塞超时)。

## 5. 活事件(Cordis Events,emit)

```ts
'task/changed'(payload: { operation: TaskOperation; task: TaskView }): void
'project/changed'(payload: { operation: ProjectOperation; project: ProjectView }): void
'candidate/changed'(payload: { operation: CandidateOperation; candidate: CandidateView }): void
```

- **非 agent 作用域**(任务跨会话,面板全局订阅)——与 goal 的 agent-scoped 派发是刻意的不对称;
- 每次域事件提交后派发(先落账、后通知——"状态只在提交点发布")。

## 6. 模型工具(`tool-task`)

| 工具 | 输入 | 成功值 | 错误并集 |
|---|---|---|---|
| `task_create` | objective, acceptance, workspaceIds?, parentTaskId?, projectId? | TaskView(含 subtasks id 列表) | invalid_objective / invalid_acceptance / not_claimed / not_found / invalid_subtask / stale_revision |
| `task_claim` | taskId | TaskView + contextPack(同时产生 `task/context-injected` 会话事件) | not_found / already_claimed |
| `task_update` | taskId, revision, note, next? | TaskView | not_claimed / stale_revision / invalid_note |
| `task_report` | taskId, revision, outcome: `'blocked' \| 'review'`, reason?, completionNote? | TaskView | invalid_transition / invalid_reason / invalid_note |
| `task_query` | filter(status?, workspaceId?, projectId?, parentTaskId?, limit?) | TaskView[] | invalid_filter / not_found |
| `task_projects` | —(无参数) | ProjectView[](创建序,含已归档标记) | —(读路径无失败分支) |

`parentTaskId` 语义:先建子任务、再以调用会话挂接到父;挂接被拒(非父持有者、父不存在、成环)即**回收刚建的任务**(abandon,同一 model actor)并返回拒绝码——工具保持单一效果。`projectId` 同理但更简单:seam 在 append 前校验项目存在且未归档,被拒的挂入**连任务都不建**(无需回收)。`task_query` 带 parentTaskId 时改走 `children()` 聚合读取(滤归档),模型据此看委派子任务的实时状态;带 projectId 时按项目收窄任一列表。

错误形状一律 `{ code, message }`(仿 schedule 的 ScheduleToolError 闭集)。提示词段:一段"任务纪律"(claim 前先读 pack;submit 必须对照 acceptance;blocked 要说清缺什么),order 仿 tool-goal。

## 7. Config(schemastery,无硬编码可调项)

| 字段 | 说明 |
|---|---|
| `contextPackByteLimit` | 上下文包字节上限(作用于完整值) |
| `wakeMinIntervalSeconds` | every 规则的间隔下限 |
| `listDefaultLimit` | task_query 默认返回上限 |

## 8. 与 03 的对应检查

- [x] 三个锚定场景全覆盖:看管(§5 活事件→面板)、续命(§2 注入凭证)、定时(§4 wakeRules + §1 wake-set/clear)
- [x] 权限矩阵在执行器强制(§1)
- [x] 铁律双账本(§2 vs §3,§3 invariant)
- [x] 错误码闭集、版本化判别联合(§2 §6)
- [x] 注册返回 disposer(§4 TaskHandle)
