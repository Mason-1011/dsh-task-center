# @task-center/tool-task

**用途一句话**:任务接缝的模型面——七个任务工具加一段系统提示词"任务纪律",全局注册(形态 4,仿 tool-goal)。

## Model Experience

**工具**(模型可见;输出为 JSON 投影,`{code,message}` 闭集错误):

| 工具 | 作用 | 主要错误码 |
|---|---|---|
| `task_create` | 建任务(objective / acceptance / workspace_ids?);parent_task_id 挂为父任务子任务,挂接被拒即回收新建任务;project_id 归入人类项目,被拒(缺/归档)则任务不建 | invalid_objective / invalid_acceptance / not_claimed / not_found / invalid_subtask |
| `task_claim` | 认领并取回完整 contextPack;投影含 `historySessionIds`——先前经手此任务的会话(执行史) | not_found / already_claimed |
| `task_update` | 记一条进展(note / next),自动解除阻塞 | not_claimed / stale_revision / invalid_note |
| `task_report` | 上报结果:blocked(附理由)或 review(附对照 acceptance 的自检) | invalid_reason / invalid_note / invalid_transition |
| `task_patrol` | 记一条巡检观察(note=现状,next=下一步?,blocker=卡点?)进 contextPack:不认领、不改状态、不刷新闲置时钟;他人持有的任务也可巡检 | stale_revision / invalid_note / invalid_transition |
| `task_query` | 按 status / workspace_id / project_id / limit 过滤;parent_task_id 改列该任务的存活子任务 | invalid_filter / not_found |
| `task_projects` | 列人类管理的项目(创建序,含归档标记)——project_id 只能用这里返回的精确 id,不许编 | — |

**权限**:approve/reject 仅人类,项目的建/改/归档也仅人类——工具面不注册这些动词,且接缝在执行器里拒绝模型 actor(模型只能把任务**归入**已存在的项目)。

**提示词**:system-prompt 段 `tool:task`(order 116):认领前读 pack、submit 必须逐条对照 acceptance、blocked 必须说清缺什么、patrol 只观察不动手。

**Token/缓存影响**:七工具 schema + 一段静态提示词进入每次请求;contextPack 大小受接缝 `contextPackByteLimit` 约束(作用于完整值)。

**会话日志**:模型的每次变更产生 `task/change` 回执,认领额外产生 `task/context-injected`(注入物全文可从日志重建)。

## Known Limitations and Deferred Work

- `task` 投影不含 wakeRule:唤醒规则对模型不可见,待 task-wake 落地后随工具面补齐。
- `task_update` 只覆盖 progress;edit(含移出项目)/ wake-set / wake-clear / subtask-remove 留给人类命令面。
- 快照测试(无 key 的真实可运行示例转写)随 headless 闭环示例补上。
