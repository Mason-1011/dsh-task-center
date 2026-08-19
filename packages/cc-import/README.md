# @task-center/cc-import

**用途一句话**:把 Claude Code 的会话转录(`~/.claude/projects/**/*.jsonl`)**物化**成真正的 dsh 会话(写入 sessions root)——本工具只做格式翻译,不做任何任务判断;task-source 抽取层(见 [task-source README](../task-source/README.md))的史扫会用它自己的档位与门把历史对话重新出生为候选。旧导入器(模型写的 TaskCreate 直接进台账)的三种病——步骤级粒度、精确去重、机械 completed→submit——由此根除:判断权全部收回抽取层。一次性可重跑的 CLI,不是 cordis 插件。

## 两次转换 + 一次收编

```
CC .jsonl 转录 ──parse──> ops 序列 ──map──> dsh SessionEvent[] ──materialize──> ~/.dsh/sessions/<project>/cc-<uuid>/
                                                    │
                                        ──adopt──> 工作区注册表:每个 cwd 一个工作区,cc- 会话逐个挂载
```

- **parse**(`parse.ts`):流式逐行(真实转录 40+ MB),只认 `type: user/assistant` 信封行,产出 人话/助手/工具结果 三种 op。`sessionId` 字段优先、文件名兜底;cwd 取首条 user/assistant 行的 `cwd`(`isAbsolute` 守卫);时间戳缺失回退上一条的时间。
- **map**(`map.ts`):op 序列 → 连续 `SessionEvent[]`。seq 恒等于下标;`surfaceOp:'append'` 恰在 `user/message`/`assistant/message`/`tool/result` 三类上;回合按人类提示合成(一条人话一个回合,人话先闭上一回合)。
- **materialize**(`materialize.ts`):SessionStore + JSONL 持久层 seed 创建——事件时间与 header `createdAt` 双回填,导入史保持原年龄(闲置门按真实时间判定)。幂等靠 `sessionPersistence.list()` 预检:`sessions.create` 对已存在 id **静默收养不抛错**,跳过决定权必须在自己手里。
- **adopt**(`adopt.ts`):物化后把全部存储的 `cc-` 会话归入 dsh 工作区注册表(`registry.create` + `attachSession`,与 web UI 的挂载动作同一 API)。工作区按 cwd 实路径一一对应;注册表的一次性 cwd bootstrap 早已跑完,UI 外写入的会话**永远不会**自动出现——没有这一步,导入的会话在 web 的工作区视图里全部悬空。cwd 在本机解析不了的(从别的操作系统同步来的转录)先**原位重写**到 fallback 目录(id、事件、createdAt 全不动,只换 header cwd 与盘上项目目录),再挂进 fallback 工作区。

## 映射表(工具名)

| Claude Code | dsh | 说明 |
| --- | --- | --- |
| `ExitPlanMode` | `exit_plan_mode` | **唯一改名**:计划档靠这个配对(调用 + 无 error 结果 = 人点了 Approve),H1 即 objective |
| `TodoWrite` | `todo/write` 整表快照 | 调用/结果对**双双抑制**(dsh 的 todo 不是工具),条目去 `activeForm`,状态沿用 CC 词表 |
| 其余工具(Read/Edit/Bash/TaskCreate/…) | 同名 `tool/call` + `tool/result` | 身份保留;结果块为 `content[0]`,正文取扁平文本 |
| `message.model` | `source: {kind:'model', provider:'claude-code', model}` | 非空字符串契约;缺模型名回退 `unknown` |
| `message.usage` | `usage: {inputTokens, outputTokens}` | 原样换驼峰 |
| assistant 的 `tool_use` 块 | assistant 消息内的 `tool-call` 块 + 独立 `tool/call` 事件 | provider-valid,将来 resume 不破 |
| `is_error: true`(工具结果) | 块 `isError:true` + 事件 `error:{name:'ToolError', code:'TOOL_ERROR'}` | **拒绝的计划 = 结果带 error** → 不算已批准;被拒计划的负路径由此闭环 |

## 丢弃清单(parse 层,静默计数不进日志)

`type` 非 user/assistant 的行(mode/system/queue-operation/ai-title/last-prompt…)、`isSidechain`(子代理)、`isMeta`、`isCompactSummary`(续接摘要)、人类文本以这些前缀开头的 harness 合成行:`[Request interrupted`、`<task-notification`、`</task-notification`、`<command-name`、`<command-message`、`<local-command-stdout`、`<system-reminder`、`[warn]`;user 数组里含 `tool_result` 的行(机器行,文本不进人话);assistant 的 `thinking`/`server_tool_use`/块内 tool_result;JSON 解析失败的行(计警告)。**子代理转录文件本身不扫**(它们在 `<uuid>/subagents/` 子目录,发现层只取项目目录顶层 `.jsonl`)。

## 会话身份与幂等

物化 id = `cc-<sessionId>`。重复运行:已落盘的 id 全部跳过,不改写不追加。删除一个 `cc-*` 会话目录后重跑会重建(抽取层的持久覆盖标记按 id 记在 storage domain,水位对得上,不会误重抽)。

## 预测(dry-run)与诚实边界

`predict.ts` 用与抽取器**同一组 fold**(`foldApprovedPlan`/`foldTodos` + conversationLines 复刻)逐会话报告将落入哪一档、是否出生:

- **plan 出生**:已批准 + todo 未完,或已批准 + 批准后零模型活动(尚未开工)。
- **不出生的 plan(诚实边界)**:已批准、批准后有模型活动、但从未写 todo——「动过手没跟踪的停滞」在 v1 无档接手(task-source Known Limitations 同款),既不出生也不进总结。dry-run 报告里会明说。
- **todo 出生**:无 plan、未完条目、锚到人类消息(seq)。
- **summary 队列**:无任何结构信号且 ≥1 条人类发言——每条一次模型调用,受闲置门与每轮上限节流。
- **goal 档对 CC 不可达**:CC 没有 goal 概念,旧的「82 条 review 堆积」现象(验收档)在 CC 源头上不存在。

本机实测口径(2026-08-19):11 个项目目录、20 个主转录、18 个子代理文件(自动跳过)、~379 条人类提示、7 次计划批准、TodoWrite 0 次——即绝大多数会话落 summary 队列。

## 运行序

```bash
# 1) 彩排:只解析+映射+预测,零写入
pnpm cc:import --dry-run

# 2) 真跑:先清旧账(可选,只在换导入方案时用)再物化 + 收编工作区
#    停 dsh(web/headless 都停,避免与 sweep/注册表竞态)
pnpm cc:import --wipe-ledger
pnpm cc:import

# 3) 重启 dsh,task-source 史扫自动拾取,工作区视图出现导入会话
```

`--wipe-ledger`:abandon 全部非 done 任务(done 是历史事实,保留)、ignore 全部 pending 候选、归档无任务的空项目;全部 `{kind:'human'}` actor;事件账本只追加不删除,事后可审计;抽取层的持久覆盖标记(task_source 域)**不动**。

### CLI 旗标

| 旗标 | 默认 | 含义 |
| --- | --- | --- |
| `--cc-home` | `~/.claude/projects` | CC 转录根目录 |
| `--sessions-root` | `~/.dsh/sessions` | dsh 会话落盘根(与 profile 一致才被扫到) |
| `--ledger-root` | `~/.dsh/storages` | 任务台账 storage 根(`--wipe-ledger` 与工作区收编用) |
| `--adopt-fallback` | `~/.dsh/cc-imported` | cwd 在本机解析不了的会话重写到这里,并挂进同名工作区 |
| `--compression` | `zstd` | 与 profile 持久层一致;`none` 便于人工检查 |
| `--project` | 全部 | 项目目录名子串过滤(彩排单个项目用) |
| `--dry-run` | 关 | 只报告,零写入 |
| `--wipe-ledger` | 关 | 物化前清旧导入的台账残留 |

## 成本

- 解析/映射/物化:零模型调用,纯本地 IO(40 MB 转录秒级)。
- summary 队列:每会话**一次**模型调用,且要过闲置门(本机导入史的 readyAt 已在过去,开机即逐条判定,受 `summariesPerTick` 每轮上限节流)。路由配额/退避语义与 task-source 完全一致——那边的逻辑,不是这里的。
