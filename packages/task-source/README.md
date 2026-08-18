# @task-center/task-source

**用途一句话**:任务接缝的抽取面(设计稿 [06-extraction.md](../../docs/design/06-extraction.md))——常驻扫描 dsh 自己的会话记录,把用户已经开始但被搁下的活自动出生为「候选」,人确认后才进任务台账;任务创建不再是会话之外的仪式。同一条流还做**进度回流**:持有会话每回合的 todo/goal 证据自动写进它所持任务的上下文包(§ 进度回流)。

三个结构档(6a/6b,零模型成本,纯日志 fold)加一个兜底总结档(6c,一次模型调用):

- **goal 档**:phase 为 active / paused / blocked 的 goal 产候选(objective 直取,blocker 写备注);complete / clear 把它还 pending 的候选 superseded。
- **已批计划档**:`exit_plan_mode` 调用与无 error 的 `tool/result` 配对 = 人点了 Approve(拒绝/取消都在工具内抛错、结果带 error;`/plan off` 不发这个调用,故不依赖滞后一步提交的 `plan/mode` 翻转)。计划 H1 = objective 草稿,全文 = 备注;未完 todo 即候选,从未写 todo 的只在批准后零模型动作时成候选(动过手没跟踪的停滞 v1 无档接手,见 Known Limitations);todo 全勾/清空 = 做完了,该会话 pending 的计划候选自动 superseded。
- **todo 锚定档**:相邻 `todo/write` 整表差分,新增条目锚定最近一条人类消息(`source.kind === 'user'`;插件通知/工具结果不算),没有前置人类消息时锚定最近一条有正文的助手消息(模型自主开工的链溯源到模型输出);锚点文本第一非空行 = objective 草稿,未完条目 = 备注;origin key = 锚定消息 seq,新链 = 新候选;全勾后 pending 候选自动 superseded。
- **兜底总结档(6c)**:无 goal、未批计划、没写 todo、至少一条人类消息的会话,闲置(或处置)后起一次总结会话判定三必要条件(可命名的结果 / 可判定的完成 / 未完成需后续):全满足才产候选(objective + acceptance 必填——四档中唯一自动填验收草稿的),否则记"无任务";origin key 固定 `summary`(同会话单候选),后续活动的 `none` 判定把该会话 pending 的总结候选自动 superseded。

结构档出生按 **goal > 已批计划 > todo** 优先级互斥(三个档常是同一件事的三个影子);撤销与出生无关——任一档出现"做完了"的正证据,该档 pending 候选即退场。总结档只在**任何结构信号都不存在**时启动,截断因此只需处理纯对话(近 `transcriptEvents` 条 surface 消息)。

## Model Experience

**结构档模型不可见、零模型成本**;总结档花**一次**模型调用:先以 maxTokens=1 探测 `agent` 路由配额(QUOTA 阳性即顺延、按平台延时退避;探测失败不挡),再受每轮 `summariesPerTick` 上限约束(超额的活会话水位不推进、下轮重试;被墙的处置请求入队由后续 tick 重试)。提示词内置三必要条件、正反例表与现有任务/候选 objective 去重清单;判定失败(解析失败、字段留空)一律按无任务处理——宁缺毋滥,一次活动至多花一次总结。候选仍是域事件流里的第三族实体,不进任何模型请求。

## 触发语义

- **结构信号即时**:goal 被设置、计划被批准、todo 被写入的那一刻就走一次结构抽取(零模型成本)——显式的工作声明不等闲置,噪声闸门是人工晋升;挂载时对全部存活会话做一次启动结构扫,goal 当场做完同样即时 superseded。
- **闲置门只属于兜底总结档**:会话最后一条事件距今 ≥ `idleHours` 才起总结会话——"3 小时没人说话"区分"人还在,只是去倒杯水"与"这条线被搁下了";即时通道忽略总结请求,模型花费只经闲置/处置两条门。
- **`session/disposed` 立即触发**,不等闲置(headless 一次性会话的主要通道);处置是读它的最后机会,处置请求被配额墙挡住时入队,由后续 tick 重试。
- **水位幂等**:每会话记"已抽取到哪个 seq";无新活动的会话不重复抽取。事件在抽取 await 期间追加的,水位只推进到 fold 实际覆盖的快照,不丢不跳。被限流顺延的总结会话水位不推进,下轮重试。
- **启动扫描**:apply 内先跑一轮完整扫描(恢复的历史会话不用等一个 poll 周期)。水位播种**跳过 `session/end-seed` 附着标记**(store 挂载时补的簿记,不是会话活动)——闲置时钟锚定到最后一条持久事件,从盘上恢复的会话开机即可判闲置;空日志视为"现在刚发生",永不误抽。
- 水位与处置队列都是进程内存态;重启后由启动扫描 + 同源去重兜底(同 origin 任一状态的候选已存在即不再产——忽略过的来源天然永久忽略)。已处置会话的入队请求在重启后丢失(v1 已知限制)。

## 进度回流(7b)

持有会话每个 `turn/end`(完成/中止/任何 reason 同待遇——证据与结局无关)结算一个窗口 `(上次结算 seq, 本回合结束 seq]`:

- **todo 差分**:"窗口前最后一表"对"窗口内最后一表"——新增 `+ 条目(状态)`、状态迁移 `条目 旧→新`、移除 `− 条目`;窗口内没写 `todo/write` 即无差分。
- **goal 变化**:逐事件渲染 `goal 目标: 相态(码: 说明)`,clear 用更早快照报出目标名而非裸 id。
- 两者拼成一行 `自动回流 todo: … | goal: …` 写进该会话持有的每条 active/blocked 任务(`progress`,actor = 持有会话本身,权限矩阵结构满足);`自动回流` 前缀与模型自己的 task_update 汇报区分。纯闲聊回合为空串、零写入;沿用 contextPack 字节上限。
- 撞 revision(模型同回合自己汇报过):读最新 revision 重试一次,再败丢弃——下回合差分带着表格前进,进度不丢。
- 结算标记在首个 await 前同步推进,背靠背回合不双结算;首次结算种子只数**严格早于本次回合**的 turn/end——挂载后才结束的回合整回合回流(补上本进程错过的回流,崩溃恢复),纯历史回合永不回流。
- `session/disposed` 终冲:死在半回合的 headless 会话在处置时冲刷它没能闭合的那回合,不写回执(日志已闭合)。

**goal 相变镜像(7c,同一窗口、progress 之后应用)**:goal 的判定性转移镜像进所持任务的状态——`blocked`(非配额码;配额码是 task-quota 的职责)带卡点原因置 blocked,`complete` 自动提交进"待验收"(completion note 注明自动提交,人仍是终审,submit 保留持有)。只认 operation 进入 blocked/complete 的转移(blocked 中 edit、resume 不镜像);同 goal 窗口内多次变化取最终相;仅 active 任务镜像(block/submit 的唯一合法源);progress 写入在前会把 blocked 归一化回 active,故"先阻塞后完成"仍能提交。CAS 同款重试一次再丢——证据行已在 pack 里,状态丢了看得见。

## 配置(cordis.yml `config`,无硬编码可调项)

| 字段 | 含义 |
|---|---|
| `pollSeconds` | 扫描周期(秒),必须为正;挂载时先立即跑一轮 |
| `idleHours` | 闲置阈值(小时),必须为正;设计默认 3 |
| `agent` | 总结会话路由(`provider` + `model`),两项必填 |
| `summariesPerTick` | 每轮 tick 允许启动的总结会话数,正整数;超额顺延 |
| `transcriptEvents` | 总结提示词携带的近 N 条 surface 消息,正整数 |

## Known Limitations and Deferred Work

- 看板手动抽取入口(对未到闲置时间的会话立即可抽,设计 §6)未实现;v1 只自动触发。
- 已批计划档"做完"的判据只有 todo 全勾/清空;没写 todo 又动过手的计划不成候选(总结档只在全无结构信号时启动,这类"有计划但没跟踪"的停滞两档都不接——真实使用出现再定归属)。
- 同会话多条未完 goal 各产一条候选(goal id 为 key);跨会话同一主题不去重(goal id 跨会话不复用);todo 多链取最近链(设计稿 §10.4);总结档同会话固定单候选,会话中途换主题不另生新候选。
- 已处置会话的入队总结请求不落盘,进程重启即丢;活会话无此问题(水位重播)。
- 多 goal 并发于同一任务:镜像按事件序应用,后到者可能撞转换表被丢(block 后 complete 来自不同 goal 时 submit 从 blocked 不合法)——v1 已知限制,人从面板与 pack 证据行可见。
- goal resume 不反向镜像(阻塞任务不会因 goal 恢复自动回 active):解阻塞仍由模型的 task_update/progress 承担。
- 第一层闲置显示连接是纯展示 join,住 `@task-center/task`。
