# 02 数据模型

## 1. 任务域(storage-domain)

权威数据放 storage-domain 的 KV 域,仿 workspace 的 `defineDomain` 范本(`packages/workspace/workspace/src/spec.ts`):

```ts
defineDomain({
  name: 'task',
  version: 1,
  global: { schema: taskDomainState, initial: { ... } },   // 顺序、归档集合
  tables: {
    tasks: domainTable<TaskId, TaskRecord>(taskRecord),
    events: domainTable<TaskEventId, TaskEvent>(taskEvent), // 任务自己的事件日志(权威流)
  },
})
```

### TaskRecord 关键字段

| 字段 | 说明 |
|---|---|
| `objective` | 目标(人话一句话) |
| `acceptance` | **验收标准**——agent 自判"完成"的依据,与普通 todo 的本质区别 |
| `status` | 状态机:`todo / active / blocked / review / done` |
| `blockedReason` | 阻塞原因(结构化 code + message,仿 goal) |
| `workspaceIds` | 关联工作区(跨项目在此发生) |
| `sessionIds` | 挂接的会话(有序执行史,`claim` 追加);历史对话 = `origin.sessionId` 置首 + sessionIds,纯派生 `historySessionIds(record)` |
| `contextPack` | 上下文包(见 §4) |
| `wakeRule` | 可选唤醒规则(after / at / every) |
| `subtasks` | 子任务 id 列表(父聚合子进度) |
| `createdAt / updatedAt` | ISO-8601(仿 workspace) |

## 2. 双账本:权威流 + 回放凭证

仓库铁律 "model-visible ⟺ logged"(凡是进模型请求的东西必须能从会话日志重建)对跨会话任务的推论:

- **权威数据在任务域事件流**(`events` 表)——任务横跨 N 个会话,不属于任何一个会话日志;
- 模型在会话 S 里每次任务读写,**同时**追加一条会话事件 `task/change`(进 `SessionEventMap`)记录"该会话看到/改了什么"——会话日志因此能完整回放模型视角;
- 人类面板、定时器触发的变更**只写任务域事件流**(不经过模型,不触发铁律),变更通知照发。

goal 包是单会话版同构范本(`goal/change` 会话事件 + fold);本设计把权威流挪到域内,会话事件降级为回放凭证。

## 3. 状态机

```
todo ──认领──▶ active ──自报完成──▶ review ──人确认──▶ done
  ▲              │ │                   │
  │              │ └──遇阻──▶ blocked  └─打回(附理由)─▶ active
  └──────── 归档/放弃 ◀──────────────┘
```

- `active → review`:模型填完成说明 + 对照 acceptance 自检;
- `review → active`:打回必须附理由,理由写进 contextPack;
- `blocked`:超过配置时长面板置顶告警(P1)。

## 4. 上下文包(跨会话续命的核心)

- 内容:做了什么 / 决定了什么(含打回理由)/ 踩过什么坑 / 下一步;
- **有字节上限**(用 util/output-retention 的保留原语),超限由"执行结束后的摘要步骤"压缩——摘要本身是一次普通会话轮次,产物回写任务域;
- 认领注入 = 往新会话追加 `task/context-injected` 会话事件(满足铁律:注入物从日志可重建)。
