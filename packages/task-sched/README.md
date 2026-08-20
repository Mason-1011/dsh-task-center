# @task-center/task-sched

**用途一句话**:定时发送——人定好时间与内容(默认 `cont`),到点把这条消息作为用户输入送进目标会话,让挂着的任务到点自己续上。

## 与 task-wake 的分工

两者都到点动手,但角色不同:

| | task-wake | task-sched |
|---|---|---|
| 面向 | 任务账本(任务级) | 会话(回合级) |
| 到点动作 | 起新会话认领任务续干 | 向既有会话投一条用户消息 |
| 定的规则 | 唤醒规则(一次/定点/周期),挂在任务上 | 单条发送记录,人从界面下 |

配合用法:任务挂唤醒规则管"该开工了",定时发送管"这个会话里再戳一下"(最常见:额度挂起恢复后发一句 `cont` 让它接着说)。定时弹窗内的「额度感知续作」开关就是把这一步自动化的入口:开了之后额度恢复的续做消息自动发进本会话(经 task-quota 的续做目标,装了 task-quota 才出现)。

## 数据与闭环

发送记录存自己的 storage 域(`task_sched` 域,单表 `sends`),不进任务账本——发送是调度簿记,不是任务域状态,与抽取层 marks 同一拆分。无 storage-domain 设施时退化为进程内存(当次有效,重启即空,最小组装仍可跑)。

一条记录的生命周期:`pending → firing → fired/failed`。轮询到点后先落 `firing` 再投递;投递成功 `fired`(记 `settledAt`),失败 `failed`(记 `note`,可取消清除)。投递复用 task-source 的模式:会话活着直接投,不活则 `resume` 起一个临时 agent(带原 preset),等回合结束即处置。

两个恢复路径:

- **崩溃卡壳**:挂载时把遗留的 `firing` 行交还 `pending`,重新进入管线;
- **记录持久**:pending 行经全量重挂载仍在。

## 两个人口

- **会话页**:头部「⏰ 定时」按钮弹窗(内容默认 `cont`,时间默认 5 分钟后,附 +5 分/+30 分/+1 时/明早 9 点快捷片),下方列出本会话未发送的记录,可取消;
- **看板详情弹窗**:定时发送栏,目标会话下拉(持有者 + 历史会话),同样的时间与快捷片。

## 部署假设:单运行器

同一张 `sends` 表同一时刻只应有一个进程在轮询(两个运行器会对同一行各投一次)。因此 task-sched 只装进 **web profile**(常驻进程),headless 与独立 REPL 壳不装——它们仍能通过 web 界面下发送。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `pollSeconds` | — | 轮询间隔(秒,必须 > 0) |
| `agent` | — | 恢复死会话所用的路由(provider + model) |

配置非法(间隔非正、provider 空白)挂载即大声失败。

## RPC 面(SRC)

`task-sched` 命名空间三个方法,浏览器 bundle 经 `/api` 通道调用:`schedList` / `schedCreate` / `schedCancel`。校验码稳定:`SCHED_INVALID_SESSION` / `SCHED_INVALID_CONTENT` / `SCHED_INVALID_TIME` / `SCHED_UNKNOWN_SESSION` / `SCHED_NOT_FOUND` / `SCHED_FIRING`。
