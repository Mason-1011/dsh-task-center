# 03 插件族

## 1. 接缝拆分(标准四件套 + 时间面)

| 包 | 角色 | 说明 |
|---|---|---|
| `task/task` | 定义件(Service) | `ctx.tasks`:状态机转换、项目(§1.2 of 05)、contextPack 读写、`task/*` 与 `project/*` 事件 |
| `task/task-local` | Provider | 经 `ctx.storageDomain.open(taskDomainSpec)` 开域;后端由配置路由(json/sqlite) |
| `task/tool-task` | Consumer(模型) | `task_create(可带父/项目) / task_claim / task_update / task_report / task_query(可按父查子/按项目收窄) / task_projects` 六工具 + 提示词段 |
| `task/command-task` + `client/ui-task` | Consumer(人类) | `/task` 命令(面板按项目两级分组)+ `/task project` 建改归档;Web 面板(全景/过滤/阻塞置顶/待验收队列/跳转会话) |
| `task/task-wake` | Provider(时间) | 宿主级定时器,见 §2 |
| `task/task-quota` | Provider(额度) | 观察 `llm/stream` 会话失败,QUOTA 即挂起并释放持有;重置点经 task-wake 唤醒续做 |
| `task/task-reaper` | Provider(存活) | 会话处置事件 + 挂载清扫,system actor 释放死持有(崩溃恢复) |
| `task/shell` | Consumer(人类·壳) | 一条命令经真实 Loader 组装全部插件(cordis.yml)+ 交互 REPL;斜杠行走命令注册表,普通行进交互会话 |

## 2. 修正:定时干活不能复用 schedule

schedule 源码:`ScheduleDeliveryMode = 'session-local'`——提醒**只投递给仍活着的原会话**,管"会话内稍后提醒我",不管"到点起新会话"。

定时干活需要 `task-wake`:宿主进程里的定时器读各任务 `wakeRule`,到点 `ctx.agents.create()` 起新会话,首条消息注入 contextPack,会话结束回写执行记录与摘要。它是新接缝,将来"跨设备远程唤醒"也是它的 provider。

## 3. 执行链(与现有接缝的摞接)

```
task-wake(到点) ──▶ agents.create ──▶ tool-task 认领 ──▶ 上下文包注入
   │                                            │
   │                                     subagents/workflow(委派拆分)
   ▼                                            ▼
面板/命令(人类验收) ◀── task/* 事件 ◀── 状态机转写 + 会话事件回执
```

三个锚定场景在链上的落点:

- **并行看管**:`task/*` 事件 → 面板实时刷新;
- **跨会话续命**:认领时 `task/context-injected` 注入;
- **定时干活**:task-wake 到点起会话。

## 4. 挂载形态对照(接 03 的六种姿势)

- `task/task`、`task-wake`:Service 定义件(形态 1);
- `task-local`:函数插件,inject `['storageDomain','tasks']`,注册进域(形态 3);
- `tool-task`、`command-task`、`task-quota`、`task-reaper`、`shell`:消费型函数插件(形态 4);
- `ui-task`:浏览器侧插件,经 Typert RPC 读宿主服务。
