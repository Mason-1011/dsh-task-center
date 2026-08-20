# @task-center/task-quota

**用途一句话**:任务接缝的额度面——`llm/stream` 瀑布监听看着每一次模型调用;当请求以平台额度用尽(`QUOTA`)终死时,在**循环看见失败之前**把垂死会话持有的任务全部挂起:block 写结构化理由(contextPack 记下额度墙与恢复时间)→ release 释放持有(可被新会话认领)→ 到点自动唤醒续做。

## 平台无关是怎么来的

各平台(CLM/DeepSeek/GLM/火山/阿里云等)的限额报文各不相同,但归类发生在 dsh-llm 的适配器层:每个适配器把自己的平台错误翻译成 provider-neutral 的 `QUOTA` 码,并把平台要求的等待延时保留为 `providerRetryAfterMs`。本包只消费这个已归一化的信号,不知道也不需要知道身后是哪家平台——适配器覆盖一家,额度挂起就自动支持一家。

## 挂起决策(`src/signal.ts`,纯函数)

| 情形 | 决策 |
|---|---|
| 失败码非 `QUOTA`(鉴权错误、瞬时限流、传输失败) | `ignore`:接缝不介入 |
| `providerRetryAfterMs` 可用且 > 0 | `park`:now + 延时即恢复时间 |
| 平台没给延时,但声明了 `fallbackWindowSeconds` | `park`:now + 声明窗口(最坏情况:窗口刚开始) |
| 两处都没有恢复时间 | `park-without-wake`:挂起释放但不设唤醒,等人工 |

`parkLine()` 把决策写成 contextPack 里的一句话(含预计恢复时间),下一个会话从墙边续做,不从头来。

## 为什么 park 发生在 yield 之前

瀑布监听可以先 `await` 再产出 chunk:挂起三连(block → release → wake-set)在账本里**提交之后**,垂死会话的循环才观察到失败。状态只在决策点发布,不存在"循环已报错但任务还挂着"的中间态。

挂起以垂死会话自己的模型 actor 身份走服务面(不写会话回执):回执需要活着的会话,而 contextPack 才是抵达下一个模型的通道——唤醒会话认领时自然注入。

## 配置(cordis.yml `config`)

| 字段 | 含义 |
|---|---|
| `fallbackWindowSeconds` | 声明的套餐窗口(秒),平台未随错误给出延时的最坏情况估计(如 5 小时 coding plan = 18000);缺省时此类失败挂起后不设唤醒 |
| `resumeOnReset` | 自动续做旋钮的**默认值**(缺省 true;false = 只挂起释放,等人工唤醒) |

需要 task-wake 同装才构成闭环:本包只写唤醒规则,到点起会话由 task-wake 负责。

## 运行时旋钮(`task-quota/*` RPC)

本包是 Typert Remote 服务,暴露三个端点(web 看板头部的「自动续做」弹窗就是它们的消费方):

| 端点 | 行为 |
|---|---|
| `quotaGet` | 返回当前生效的旋钮值与续做会话(上次选择,否则配置默认) |
| `quotaSet` | 切换开关,立即生效于**下一次**额度墙(已挂起的唤醒规则不回滚);布尔值之外的入参被拒(`QUOTA_INVALID_VALUE`) |
| `quotaTargetSet` | 选择续做会话:`fresh`(默认,task-wake 起新会话)/ `origin`(撞墙的那个会话)/ `session`(指定会话,附会话 id);同样只对下一次额度墙生效 |

`origin` / `session` 的续做走 task-sched 的定时发送通道:挂起时在恢复时刻放一条发给目标会话的用户消息(内容含任务目标、验收与上下文包,指示先 `task_claim` 再续做),到点由 task-sched 送进会话——与人手定的 `cont` 完全同一条通道,在看板详情里可见、可取消。task-sched 未挂载(如 headless profile)或目标会话已不存在时,自动回退为 `fresh` 的唤醒规则并记日志。

上次的切换值持久化在本包自己的存储域(`task_quota`,与任务账本分居),重启后仍是最后一次的选择;无存储域设施挂载时退化为进程内存态,其余行为不变。

## Known Limitations and Deferred Work

- 无法用真实套餐 key 做无 key 测试:闭环测试用假适配器(首请求 QUOTA 死、后续成功)证明;真实平台路径依赖 dsh-llm 适配器各自的归类正确性。
- 到点是否重开火由 task-wake 的预检探测决定(探测阳性即顺延,不消费到点):本包只挂起与设规则,不起会话、不探测。
- 只处理"终死"的额度失败;带重试插件时瞬时 429 会在 dsh-llm-retry 层被消化,到不了本层(未装重试插件时 QUOTA 即终死,语义不变);探测请求本身不带会话身份,不会被本包误挂起。
