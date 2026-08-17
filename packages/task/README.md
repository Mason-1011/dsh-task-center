# @task-center/task

**用途一句话**:任务接缝的定义件——状态机、双账本写入与 `task/changed` 活事件的唯一事实源。

Service Definition(`ctx.tasks`)。所有其他 task-center 包的依赖根。

## 组成

- `src/types.ts`:词汇类型(品牌化 id、状态、14 个动词、双账本事件元数据)与品牌工厂
- `src/fold.ts`:纯状态机——`TRANSITIONS` 转换表、`applyMutation` 守卫(权限矩阵、持有者检查、有界 contextPack)、`foldTasks` 回放折叠(损坏流即抛错)
- `src/store.ts`:`TaskStore` 端口(append 异步、先落盘后通知)+ 内存默认实现
- `src/index.ts`:`TaskService`——CAS 变更、域事件先行、会话回执(`task/change` / `task/context-injected`)后写、活事件在提交点后派发

## Config

| 字段 | 说明 |
|---|---|
| `contextPackByteLimit` | 上下文包字节上限,作用于完整值 |
| `listDefaultLimit` | list/query 默认返回上限 |

## Known Limitations and Deferred Work

- `blockedOverdue` 恒为 `false`:阻塞超时派生随 task-wake(P1 阻塞告警)落地。
- `wakeRules()` 的 `every` 规则把每次调用视为到点;锚点数学随 task-wake 实现。
- `workspaceIds` 可引用不存在的工作区;P1 再校验。
