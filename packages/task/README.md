# @task-center/task

**用途一句话**:任务接缝的定义件——状态机、双账本写入与 `task/changed` 活事件的唯一事实源。

Service Definition(`ctx.tasks`)。所有其他 task-center 包的依赖根。

## 组成

- `src/types.ts`:词汇类型(品牌化 id、状态、动词、双账本事件元数据)与品牌工厂
- `src/fold.ts`:纯状态机——`TRANSITIONS` 转换表、`applyMutation` 守卫(权限矩阵、持有者检查、有界 contextPack)、`applyCandidateMutation` 候选守卫、回放折叠(损坏流即抛错;`workedAt` 从事件流推导,patrol 与唤醒簿记不刷新它)
- `src/store.ts`:`TaskStore` 端口(append 异步、先落盘后通知)+ 内存默认实现
- `src/index.ts`:`TaskService`——CAS 变更、域事件先行、会话回执(`task/change` / `task/context-injected`)后写、活事件(`task/changed` / `project/changed` / `candidate/changed`)在提交点后派发

## 候选(第三族实体)

候选与任务、项目共用一条域事件流(设计稿 05 §1.3):`create` 仅 source actor、`promote`/`ignore` 仅人类、`supersede` 仅 source;同源(sessionId+tier+key)任一状态去重;晋升先建任务(origin 记候选与源会话)后落晋升,崩溃重放被已存在的任务挡住。候选动词全部 pending-only,终态 `promoted` / `ignored` / `superseded`。

## Config

| 字段 | 说明 |
|---|---|
| `contextPackByteLimit` | 上下文包字节上限,作用于完整值 |
| `listDefaultLimit` | list/query 默认返回上限 |

## Known Limitations and Deferred Work

- `blockedOverdue` 恒为 `false`:阻塞超时派生随 task-wake(P1 阻塞告警)落地。
- `wakeRules()` 的 `every` 规则把每次调用视为到点;锚点数学随 task-wake 实现。
- `workspaceIds` 可引用不存在的工作区;P1 再校验。
- 候选去重键是同会话三元组;goal id 跨会话不复用,跨会话同主题各产一条(设计稿 06 §10.2)。
