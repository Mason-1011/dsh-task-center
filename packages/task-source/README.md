# @task-center/task-source

**用途一句话**:任务接缝的抽取面(设计稿 [06-extraction.md](../../docs/design/06-extraction.md))——常驻扫描 dsh 自己的会话记录,把用户已经开始但被搁下的活自动出生为「候选」,人确认后才进任务台账;任务创建不再是会话之外的仪式。

本片(6a)只做 **goal 档**:一个会话闲置后,fold 它的 `goal/change` 事件——phase 为 active / paused / blocked 的 goal 产 pending 候选(objective 直取,blocker 写备注);goal complete 或被 clear 则把它还 pending 的候选 superseded(做完的事不该在「待确认」里排队)。

## Model Experience

**模型不可见,零模型成本**:fold 是对会话日志的纯读取,不进任何模型请求,也不写会话回执;产出只有候选(域事件流里的第三族实体)。兜底「总结档」(起一次模型会话判定三必要条件)是后续 6c,届时配置面增加 `agent` 路由与每轮上限。

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

- 只做 goal 档:已批计划档与 todo 锚定 Query 档是 6b(同为纯日志 fold,进 `extractSession`),兜底总结档是 6c。
- 同会话多条未完 goal 各产一条候选(goal id 为 key);跨会话同一主题不去重(goal id 跨会话不复用)。
- 进度回流(7a–7c:展示侧闲置连接、回合末 pack 增量、goal 相变镜像)也规划住在本包,尚未实现。
