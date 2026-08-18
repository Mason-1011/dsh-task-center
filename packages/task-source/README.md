# @task-center/task-source

**用途一句话**:任务接缝的抽取面(设计稿 [06-extraction.md](../../docs/design/06-extraction.md))——常驻扫描 dsh 自己的会话记录,把用户已经开始但被搁下的活自动出生为「候选」,人确认后才进任务台账;任务创建不再是会话之外的仪式。

三个结构档(6a/6b,全部零模型成本,纯日志 fold):

- **goal 档**:phase 为 active / paused / blocked 的 goal 产候选(objective 直取,blocker 写备注);complete / clear 把它还 pending 的候选 superseded。
- **已批计划档**:`exit_plan_mode` 调用与无 error 的 `tool/result` 配对 = 人点了 Approve(拒绝/取消都在工具内抛错、结果带 error;`/plan off` 不发这个调用,故不依赖滞后一步提交的 `plan/mode` 翻转)。计划 H1 = objective 草稿,全文 = 备注;未完 todo 即候选,从未写 todo 的只在批准后零模型动作时成候选(动过手没跟踪的停滞是 6c 总结档的案子);todo 全勾/清空 = 做完了,该会话 pending 的计划候选自动 superseded。
- **todo 锚定档**:相邻 `todo/write` 整表差分,新增条目锚定最近一条人类消息(`source.kind === 'user'`;插件通知/工具结果不算),用户原话第一非空行 = objective 草稿,未完条目 = 备注;origin key = 锚定消息 seq,新链 = 新候选;全勾后 pending 候选自动 superseded。

出生按 **goal > 已批计划 > todo** 优先级互斥(三个档常是同一件事的三个影子);撤销与出生无关——任一档出现"做完了"的正证据,该档 pending 候选即退场。

## Model Experience

**模型不可见,零模型成本**:三个档都是对会话日志的纯读取,不进任何模型请求,也不写会话回执;产出只有候选(域事件流里的第三族实体)。兜底「总结档」(起一次模型会话判定三必要条件)是后续 6c,届时配置面增加 `agent` 路由与每轮上限。

## 触发语义

- **闲置门**:会话最后一条事件距今 ≥ `idleHours` 才尝试抽取——"3 小时没人说话"区分"人还在,只是去倒杯水"与"这条线被搁下了"。
- **`session/disposed` 立即触发**,不等闲置(headless 一次性会话的主要通道);处置是读它的最后机会。
- **水位幂等**:每会话记"已抽取到哪个 seq";无新活动的会话不重复抽取。事件在抽取 await 期间追加的,水位只推进到 fold 实际覆盖的快照,不丢不跳。
- **启动扫描**:apply 内先跑一轮完整扫描(恢复的历史会话不用等一个 poll 周期)。水位播种**跳过 `session/end-seed` 附着标记**(store 挂载时补的簿记,不是会话活动)——闲置时钟锚定到最后一条持久事件,从盘上恢复的会话开机即可判闲置;空日志视为"现在刚发生",永不误抽。
- 水位是进程内存态;重启后由启动扫描 + 同源去重兜底(同 origin 任一状态的候选已存在即不再产——忽略过的来源天然永久忽略)。

## 配置(cordis.yml `config`,无硬编码可调项)

| 字段 | 含义 |
|---|---|
| `pollSeconds` | 扫描周期(秒),必须为正;挂载时先立即跑一轮 |
| `idleHours` | 闲置阈值(小时),必须为正;设计默认 3 |

## Known Limitations and Deferred Work

- 兜底总结档(无 goal/计划/todo 的会话,三必要条件判定)是 6c,未实现;本包配置面届时增加 `agent` 路由与每轮总结上限。
- 已批计划档"做完"的判据只有 todo 全勾/清空;没写 todo 又动过手的计划不成候选(留给总结档)。
- 未完 todo 并入该会话所持任务的备注:未做,随 7b 进度回流片定。
- 同会话多条未完 goal 各产一条候选(goal id 为 key);跨会话同一主题不去重(goal id 跨会话不复用);todo 多链取最近链(设计稿 §10.4)。
- 进度回流(7a–7c:展示侧闲置连接、回合末 pack 增量、goal 相变镜像)也规划住在本包,尚未实现。
