# @task-center/command-task

**用途一句话**:任务接缝的人类面——一条 `/task` 斜杠命令(项目分组并标闲置天数的面板 / 详情 / 建任务 / 定时唤醒 / 验收 / 打回 / 候选看管)加 `/task project` 项目管理,approve、reject、候选晋升/忽略与项目的建改归档只在这里合法。

## Model Experience

**模型不可见**:命令由分发 UI 直接执行,不进入模型请求;`recordInput: false`,人类输入(objective / acceptance / 打回理由)落任务域事件,不重复进会话日志。

**会话日志**:每次分发在派发会话记 `command/run` 与 `command/done` 回执(以 commandId 配对);人类的任务变更只落域事件,不写任何会话回执(权限矩阵:人类动作域事件即可重建)。

## 子命令

| 子命令 | 作用 | 主要错误 |
|---|---|---|
| `/task` | 全景面板:按项目两级分组(项目 → 状态),阻塞置顶于各状态内;未完结任务标 `闲置 N 天`,最久搁置且达到 `staleDays` 的置顶标 ⚠;`🗑 无项目` 收尾 | — |
| `/task list <status>` | 按状态过滤(平铺,不分项目) | 未知状态 |
| `/task show <id前缀>` | 单任务详情,含项目、存活子任务与上下文包尾部 8 行 | 无匹配 / 前缀歧义(列出候选) |
| `/task create <objective> :: <acceptance> [under <id前缀>] [in <项目名或前缀>]` | 人类建任务,交给会话认领;under 指定父任务即分解,in 归入项目 | 缺 `::` / 空段 / 父或项目无匹配、歧义、已归档(均不建) |
| `/task project` | 列项目:名称、任务数、已归档标记 | — |
| `/task project create <名称>`, `rename <键> <新名>`, `archive <键>` | 建改归档项目(仅人类);键为项目名前缀或 id 前缀 | 名称空 / 无匹配 / 歧义 / 已归档 |
| `/task project <键>` | 该项目的局部面板(只这一个项目的任务) | 无匹配 / 歧义 |
| `/task candidates` | 候选清单(共 N 条 / 待确认 M 条):目标、来源档位与源会话、备注;含已晋升/已忽略/已失效的终态候选 | — |
| `/task promote <候选前缀> [新目标 ::] <验收标准>` | 候选晋升为任务;验收必填(候选抽不出验收,这一段由人补),`::` 前段可覆写目标 | 验收空 / 无匹配 / 前缀歧义 / TASK_STALE_REVISION / 已晋升(CANDIDATE_ALREADY_EXISTS) |
| `/task ignore <候选前缀>` | 忽略候选(终态;同来源不再产) | 无匹配 / 前缀歧义 / CAS |
| `/task wake <id前缀> after <秒> \| at <ISO> \| every <秒>` | 定时唤醒:到点由 task-wake 起新会话做该任务 | TASK_WAKE_INVALID_RULE(every 间隔 ≥ 300 秒等) |
| `/task nowake <id前缀>` | 取消定时唤醒 | 无规则 / 非待验收状态 |
| `/task approve <id前缀>` | 验收(review → done),释放持有会话 | 非待验收 / 已归档 |
| `/task reject <id前缀> <理由>` | 打回(review → active),理由写入 contextPack | 缺理由 / 非待验收 / 已归档 |

**id 前缀**:按前缀唯一匹配任务 id;歧义时报错并列出候选,不猜。匹配扫全量(含归档),不受列表默认条数限制。**项目键**同理:按项目名前缀或 id 前缀唯一匹配,歧义列出候选。**候选前缀**同理(按候选 id 前缀唯一匹配,含终态——已晋升的再晋升会报 CANDIDATE_ALREADY_EXISTS 而不是查无此候选)。

**面板分组**:项目按创建序排列,已归档项目标注 `· 已归档` 并继续展示其任务(只是不再接收新任务);每组内部再按阻塞 → 待验收 → 在办 → 待办分组;`🗑 无项目` 收尾。

**闲置与搁置告警**:闲置天数 = 距任务最后一次**被动手**(workedAt)的整天数,不足 1 天不显示;patrol(巡检观察)与唤醒簿记(wake-set/wake-clear)不改状态、也不刷新它——巡检过的搁置任务依然显示搁置。只有未完结(非已完成、非归档)任务计闲置,口径为**子树感知**——自身或任一后代(不论其状态)有更近的动作就算不闲,委派进行中的父任务不会被误报搁置。触点还与**持有会话的活事件**取 max(经 `ctx.sessions.get` 连接,设计稿 06 §7 第一层):持有会话正在干活,面板就不显示闲置,零账本写入;会话不在进程内退回 workedAt。项目组头与 `/task project` 列表的闲置取组内未完结任务的最长值。最久闲置达到 `staleDays` 时,该任务钉在面板顶部:`⚠ 搁置最久(闲置 N 天)`。

## 配置(cordis.yml `config`,无硬编码可调项)

| 字段 | 含义 |
|---|---|
| `staleDays` | 搁置告警阈值(正整数天):最久闲置的未完结任务达到该天数即置顶 ⚠ 横幅;行内 `闲置 N 天` 标记不受它影响(满 1 天即显示)。非法值挂载即抛错 |

## Known Limitations and Deferred Work

- 闲置在面板渲染时计算,不落账本;`workedAt` 由 fold 从事件流推导(创建时初始化,除 patrol 与唤醒簿记外的每个操作刷新)。
- 面板行内 `blockedOverdue` 恒为 false:阻塞超时推导随 task-wake 落地。
- 面板行以 `⊕N` 计子任务挂接;`show` 才展开子任务列表。子任务解除(subtask-remove)未暴露命令。
- 无分页:面板一次列出接缝 `listDefaultLimit` 条;`show`/`approve`/`reject` 走全量前缀匹配不受限。
- edit / abandon / wake-set 未暴露:留给后续命令扩展(P1)。
- 候选不进 `/task` 全景面板(面板只看任务);单独 `/task candidates` 列出,Web 看板另有「待确认」列。
