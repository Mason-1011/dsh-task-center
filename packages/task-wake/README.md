# @task-center/task-wake

**用途一句话**:任务接缝的时间面——宿主级定时器到点起新会话干活:先在账本里消费掉这次到点(一次性规则清除、every 推进锚点),再起一个全新代理会话,首条消息注入任务与上下文包。

## Model Experience

**被拉起的会话是普通模型 actor**:首条用户消息(`[task-wake]` 前缀)携带目标、验收、状态与 contextPack 全文,指示其 `task_claim` → 完成 → `task_report(review)` 提交。该消息落在会话日志里(注入物可从日志重建)。

**唤醒 actor 只做机械簿记**:wake-set(推进 every 锚点)/ wake-clear(消费一次性规则)在**起会话之前**提交——崩溃不会双重触发;claim / progress / submit 等工作动词一概不碰(权限矩阵:定时器列全空)。

**失败语义**:被拉起会话的 LLM 失败被包含并记日志;这一次到点已在账本中消费,不会重试(等到下个锚点)。持有人存活的到点任务同样只消费、不起会话。

## 配置(cordis.yml `config`,无硬编码可调项)

| 字段 | 含义 |
|---|---|
| `pollSeconds` | 轮询周期(秒),必须为正;挂载时跑一次立即检查 |
| `agent.provider` / `agent.model` | 被拉起会话的模型路由,必填 |

## 规则语义(与 dsh-schedule 记录形状一致)

- `after <秒>`:创建后 N 秒到点,一次性。
- `at <ISO>`:定点,一次性(接缝只校验可解析,是否过去由到点判断)。
- `every <秒>`:间隔下限 300 秒;锚点 `anchorAt` + 间隔即下次到点,每次触发把锚点推到**now 之后的第一个对齐点**(错过多次只按最新一次算,不补发)。

## Known Limitations and Deferred Work

- `done` 任务不触发唤醒(`wakeRules` 跳过):周期性例程需要"完成即重生"或模板机制(P2)。
- 到点起会话前不预检额度(task-quota 的挂起规则到点即触发):到点若额度未恢复,新会话会再撞一次墙并按 task-quota 逻辑重新挂起;探测滑动留 P1。
- 崩溃恢复不释放死持有者持有的任务:release 动词已在状态机中(命令面可人工释放),自动探测持有会话存活并代释放留 P1。
- 锚点推进失败(如 CAS 过期)只记日志跳过,不重试本周期。
- 工具面暂不暴露 wake-set/wake-clear:模型走 `/task wake`/`/task nowake` 命令面;工具面补齐待 P1。
