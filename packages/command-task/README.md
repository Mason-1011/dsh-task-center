# @task-center/command-task

**用途一句话**:任务接缝的人类面——一条 `/task` 斜杠命令(面板 / 详情 / 建任务 / 定时唤醒 / 验收 / 打回),approve 与 reject 只在这里合法。

## Model Experience

**模型不可见**:命令由分发 UI 直接执行,不进入模型请求;`recordInput: false`,人类输入(objective / acceptance / 打回理由)落任务域事件,不重复进会话日志。

**会话日志**:每次分发在派发会话记 `command/run` 与 `command/done` 回执(以 commandId 配对);人类的任务变更只落域事件,不写任何会话回执(权限矩阵:人类动作域事件即可重建)。

## 子命令

| 子命令 | 作用 | 主要错误 |
|---|---|---|
| `/task` | 全景面板:阻塞置顶,待验收、在办、待办分组计数 | — |
| `/task list <status>` | 按状态过滤 | 未知状态 |
| `/task show <id前缀>` | 单任务详情,含存活子任务与上下文包尾部 8 行 | 无匹配 / 前缀歧义(列出候选) |
| `/task create <objective> :: <acceptance> [under <id前缀>]` | 人类建任务,交给会话认领;under 指定父任务即分解 | 缺 `::` / 空段 / 父前缀无匹配或歧义(不建) |
| `/task wake <id前缀> after <秒> \| at <ISO> \| every <秒>` | 定时唤醒:到点由 task-wake 起新会话做该任务 | TASK_WAKE_INVALID_RULE(every 间隔 ≥ 300 秒等) |
| `/task nowake <id前缀>` | 取消定时唤醒 | 无规则 / 非待验收状态 |
| `/task approve <id前缀>` | 验收(review → done),释放持有会话 | 非待验收 / 已归档 |
| `/task reject <id前缀> <理由>` | 打回(review → active),理由写入 contextPack | 缺理由 / 非待验收 / 已归档 |

**id 前缀**:按前缀唯一匹配任务 id;歧义时报错并列出候选,不猜。匹配扫全量(含归档),不受列表默认条数限制。

## Known Limitations and Deferred Work

- 面板行内 `blockedOverdue` 恒为 false:阻塞超时推导随 task-wake 落地。
- 面板行以 `⊕N` 计子任务挂接;`show` 才展开子任务列表。子任务解除(subtask-remove)未暴露命令。
- 无分页:面板一次列出接缝 `listDefaultLimit` 条;`show`/`approve`/`reject` 走全量前缀匹配不受限。
- edit / abandon / wake-set 未暴露:留给后续命令扩展(P1)。
