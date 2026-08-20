# dsh-task-center-shell

**用途一句话**:指挥中心的一张脸——一条命令把整套组装(cordis.yml:任务接缝 + 工具/命令面 + wake/quota/reaper 常驻)经真实 Loader 拉起来,交互终端接一个行式 REPL:斜杠行走命令注册表(不进模型),普通行作为一条用户消息发给常驻交互会话,助手文本与工具调用从会话事件流实时回显。

## 启动

```sh
corepack pnpm start                      # 数据根 ~/.dsh-task-center
corepack pnpm start --root <目录>        # 指定数据根(账本与持久化都落这里)
corepack pnpm start --config <yml>       # 换一份组装文件
```

`.env`(`DEEPSEEK_API_KEY` 等)从启动目录加载;交互模型路由可用 `TASK_CENTER_MODEL` 覆盖(默认 `deepseek-v4-flash`)。

## REPL 语义

- `/task …`、`/task project …` 等斜杠行经 `ctx.commands.execute` 分发;未知命令提示而不进模型;命令错误前缀 `⚠`。
- 非斜杠行:先武装 `agent.whenIdle()` 再 `followup`,回合内助手文本逐条回显、工具调用回显 `→ 工具名`;回合结束无文本输出补 `(本回合无文本输出)`;回合死于模型请求错误时回显 `⚠ 模型请求失败:…`。
- `/exit` `/quit` 结束循环并处置整个组装后退出进程。
- 非交互 stdin(管道、测试):REPL 不挂载,进程在 stdin EOF 时干净退出——组装本身照常完成(供 keyless 冒烟)。

## Model Experience

**交互会话是普通模型 actor**(`SessionId('shell')`,路由取本插件 config):它看得见 `/task` 工具面(task_* 六工具)与提示词段;人类在 REPL 里打的每行普通文本就是它的用户消息,回复经会话事件流回显。斜杠命令**不进**它的上下文——命令输出只有人类可见,模型侧需主动 `task_query` 才知道账本变化。

**唤醒 actor 不受影响**:task-wake/reaper 用自己的路由与独立会话;shell 会话闲置不占任何后台轮次。

## 配置(cordis.yml `config`)

| 字段 | 含义 |
|---|---|
| `agent.provider` / `agent.model` | 交互会话的模型路由,必填非空 |

数据根、轮询周期等属于各自插件的 config,在组装文件里改,shell 不重复可调项。

## Known Limitations and Deferred Work

- 交互会话按次启动、不持久恢复:`/exit` 后重启 shell,任务账本原样(域存储),但交互会话历史是新的(会话与账本分离,续做靠任务认领注入,不靠 REPL 历史)。
- REPL 的模型回合路径(普通行 → 回显)没有真模型 e2e,只有 keyless 组装/分发测试覆盖;命令面闭环由 command-task 的测试与快照保证。
- 同一数据根并行多个 shell 进程:域存储是整文件读改写,无跨进程锁,不建议。
- 组装文件里 19 个条目全部从 workspace 源码加载(Node `--experimental-transform-types`);打包成免转换单文件是后续事。
