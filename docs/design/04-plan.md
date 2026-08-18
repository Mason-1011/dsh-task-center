# 04 分期计划

## P0(没有它就不是这个产品)

- [x] 任务对象与状态机(`task` + `task-local`)——S1/S2 已实现
- [x] 跨会话认领 + 上下文包注入——claim 写 `task/context-injected` 回执
- [x] 模型工具(task_create / task_claim / task_update / task_report / task_query)——S3 已实现
- [x] 真模型 headless 闭环(创建→认领→推进→提交)——2026-08-17 deepseek-v4-flash 实测通过(loop.e2e.spec.ts)
- [x] 任务面板:全景、按状态过滤、阻塞置顶、待验收队列——S4 `/task` 命令(command-task)
- [x] 定时唤醒(task-wake)——S5:every 锚点数学 + 唤醒 actor 机械簿记(先消费后触发);实测:到点自动起会话,认领并提交(fire.e2e.spec.ts,2026-08-17,10.6s)
- [x] 人类验收 / 打回(打回附理由)——S4 `/task approve|reject` 落地;实测:模型提交后人类 `/task approve` 闭环到 done(loop.e2e.spec.ts,2026-08-17)

## P1(用起来顺的必要件)

- [x] 子任务委派(subagents 摞接),父任务聚合子进度——见「下一步」2026-08-17 三条
- [ ] 阻塞告警:超过 N 分钟面板置顶/通知
- [ ] 执行史:任务下任意一次执行一键跳转会话
- [ ] 完成复盘归档:自动生成"做了什么/改了什么/结论",可检索

## P2(二期与远期)

- [ ] ~~跨设备同步:可换的远程 storage 后端 + 匿名 id 关联~~——2026-08-17 校准降级:真实痛点全部在同一设备;不再排期
- [ ] 任务模板/例程("每周五跑一次代码审查"存成可复用定义)
- [ ] 与 hooks/mcp 互通(任务事件推给外部系统)

## 真实痛点与推进计划(2026-08-17 校准,取代原"下一步"排序)

**三条真实痛点**(产品定位见 01 §2/§3 校准):

1. **并行看管**:大项目多模块(或多个独立项目)同时推进,每条线独立会话上下文,需要直观展示子进度并分类;
2. **搁置不丢**:急事先干、其余搁置,事后忘记进度、忘记捡回来;
3. **额度经济**:额度撞墙后到重置点(含凌晨)自动接着跑;plan 快到期时把搁置项目全速推进、吃满余额。

**审查结论**:已建件无一偏离三条痛点(续命机制是"换会话交接"的必要件,不是主卖点——叙事已在 01 纠正);最大未达成不是功能而是**从未被真实使用**——所有证明仍是数数演示。

| # | 片 | 对应痛点 | 验收 |
|---|---|---|---|
| 1 | **壳**:一条命令启动指挥中心(cordis.yml 经 Loader 的 REAL-composition + 交互 REPL + 常驻 wake/reaper/quota)——✅ 2026-08-17 | 全部前置 | 你本机一条命令进入可打字会话,`/task` 可用;keyless 冒烟快照(PTY 冒烟 + composition/repl 双测试经真实 Loader) |
| 2 | **搁置可见性**:面板显示项目/任务闲置天数,最久搁置置顶标 ⚠——✅ 2026-08-17 | 2 | 面板测试(标记/横幅/阈值/委派不误报)+ composition 快照(经真实 Loader 渲染;落盘账本回拨 5 天重启后横幅仍在) |
| 3 | **巡检例行**:复用 wake 的每日盘点会话,刷新各搁置项目"现状/下一步/卡点"——✅ 2026-08-17 | 2 | 无 key 闭环(假适配器)+ 真模型一次 |
| 4 | **全速推进 `/task push`**:激活全部非阻塞待办并行干活,并发上限可配;撞墙由现有 quota 挂起+重置唤醒接管 | 3 | 并发守卫测试 + 真 key 小 e2e |
| 5 | **第一个真实使用周**:录入你手头 2–3 个搁置项目实际用,修暴露的摩擦 | 1+2+3 | 产生真实完成任务 ≥1 件 |

backlog(不排期):任务间依赖动词(迁移交错场景)、webui 适配、任务模板、hooks/mcp、跨设备同步。

## 仓库纪律自检清单(实现时逐项勾)

- [ ] 每个包 `./invariant`:任务域事件流与 TaskRecord 的一致性关系
- [ ] `task/change` 会话事件带 `@mode`,声明合并进 `SessionEventMap`(required-on-read 默认)
- [ ] 注册即副作用:工具/命令/事件监听全部返回 disposer
- [ ] contextPack 字节上限作用于完整值(bounds to the complete result)
- [ ] 状态只在提交点发布:转写先落域事件、后发通知
- [x] REAL-composition 测试:过 Loader 启测试 cordis.yml,不手拼 `ctx.plugin`(packages/shell/tests/boot.ts,双 spec 共用)
- [ ] 快照测试:认领注入、验收往返是模型可见行为,须有无 key 快照
- [ ] 非平凡变更附带 Agent Note;README 用 Model Experience 格式;Known Limitations 节

## 下一步

- [x] 细化 `task/task` 定义件:状态机转换表 + 会话事件 schema + 工具 schema(→ [05-seam-spec.md](05-seam-spec.md))
- [x] 动工决策:另起仓库实现(dsh-task-center),P0 全部落地
- [x] 额度感知挂起(task-quota + release 动词)——2026-08-17:额度用尽 → 挂起释放 → 到点自动唤醒续做,闭环无 key 测试通过(假适配器:首请求 QUOTA 死、后续成功,task-wake 到点起新会话);平台无关性来自 dsh-llm 适配器的 QUOTA 归一化
- [x] 唤醒前预检探测——2026-08-17:task-wake 到点先发 maxTokens:1 探测,QUOTA 阳性即顺延(不消费到点、按平台延时退避),其余一律开火(探测失败不挡活);真实 key 实测通过(fire.e2e.spec.ts 9.6s)
- [x] 崩溃恢复自动释放死持有(task-reaper)——2026-08-17:会话处置事件 + 挂载清扫两个确定信号,system actor 释放并持久化往返;顺带把权限矩阵收紧到规格(approve/reject 仅人类、wake/system 钉死在簿记动词),修复 zod 持久化枚举缺 release 的真 bug
- [x] 跨会话续做演示——2026-08-17 真模型实测(continue.e2e.spec.ts,30.7s):会话 A 认领并数到 3 留交接说明后被终止,reaper 释放,会话 B 认领注入上下文包、从 4 续到 10 提交,人类验收;1 到 10 每步恰好一行是"续做而非重做"的硬证明
- [x] P1:子任务委派·域动词(subtask-add/remove)——2026-08-17:转换表行(todo/active/blocked,不动状态)、per-record 查重在 fold、跨记录守卫(存在/非自身/防环 BFS)在服务提交层、`children()` 聚合读取;tool-task 错误映射补 `invalid_subtask`,zod 持久化枚举同步(吃过的亏),重启往返含挂接事件
- [x] P1:子任务委派·工具/命令面——2026-08-17:`task_create` 带可选 `parent_task_id`(挂接被拒即回收新建任务,单一效果),任务投影带 `subtasks`,`task_query` 带 `parent_task_id` 走 `children()` 聚合;命令面 `create … under <父>`、`show` 展开子任务、面板行 `⊕N` 计数
- [x] P1:子任务委派·真模型闭环(delegate.e2e.spec.ts,26.1s)——2026-08-17:会话 A 认领父任务并以 parent_task_id 分解出数数子任务,会话 B(父任务的陌生人)以 parent_task_id 查子、认领子任务数到 3 提交,人类验收;父任务全程由 A 持有,`children()` 聚合读到子任务 done——两个会话同时持有两个任务,委派而非转手
- [x] P1:项目分组·域动词——2026-08-17:任务与项目共用一条域事件流(一次 fold 产出 `{tasks, projects, archivedTasks}`),项目仅人类建改归档(PROJECT_FORBIDDEN),无状态机只有 archived 标记;create/edit 携带 projectId(键在且非空即挂入、null 即移出),提交层 append 前校验、fold 重放后查悬挂引用
- [x] P1:项目分组·工具/命令面——2026-08-17:`task_projects` 六号工具(创建序含归档标记),`task_create`/`task_query` 带 project_id(被拒挂入连任务都不建);命令面 `/task project` 建改归档与局部面板、`create … in <项目名或前缀>`、面板两级分组(项目 → 状态,已归档项目标注并继续展示,`🗑 无项目` 收尾)、`show` 带项目行
- [x] P1:项目分组·真模型闭环(project.e2e.spec.ts,8.7s)——2026-08-17:人类建「文档维护」项目,模型 task_projects 发现它、task_create 以列表返回的精确 id 归入、task_query 按项目收窄确认——模型全程没有编造 id
- [x] 痛点计划·片 1「壳」——2026-08-17:`packages/shell`(`task-shell` 插件 + bin):一条命令 `corepack pnpm start [--root <目录>]` 经真实 Loader 组装 19 插件 cordis.yml(接缝 + 工具/命令面 + wake/quota/reaper 常驻),TTY 进 REPL(斜杠行走命令注册表、普通行进交互会话、事件流实时回显、`/exit` 处置退出),管道 stdin EOF 干净退出;修复 service 包缺 default export 导致原生 Loader 拒载;composition/repl 双测试经真实 Loader(shipped yml),PTY 冒烟建项目→归入→面板→落盘全通
- [x] 痛点计划·片 2「搁置可见性」——2026-08-17:command-task 面板闲置天数(距最后一次域事件,满 1 天显示,仅未完结任务),项目组头与 `/task project` 列表按组内最长闲置聚合;`staleDays` 配置(默认 3)触发 `⚠ 搁置最久` 置顶横幅;闲置为子树感知口径——任一后代有更近动作即不闲,委派中的父任务不误报;composition 快照含落盘账本回拨 5 天重启后面板横幅照常(搁置不丢的完整持久链路)
- [x] 痛点计划·片 3「巡检例行」——2026-08-17:域动词 `patrol`(todo/active/blocked/review 可用,done 拒绝;note=现状/next=下一步/blocker=卡点写 pack;不认领、不改状态、不刷新 workedAt——TaskRecord 新增 `workedAt` 由 fold 推导,闲置口径随之从 updatedAt 切换,巡检永远不把搁置洗白);七号工具 `task_patrol`(陌生人可巡检他人持有的任务);task-wake `patrol.at` 每日定时(错过即跳过,进程内存态判定,重启不补跑不重跑;额度墙退避顺延首火;无预检探测,失败包含不重试)起一个观察会话刷新全部未完结任务;验收双绿:无 key 闭环(假适配器发真实 tool-call 走 agent-loop 工具执行,`vi.useFakeTimers({toFake:['Date']})` 让真实 tick 读假钟跨过槽位)+ 真模型一次(patrol.e2e.spec.ts,6.7s,两个搁置任务各得一条现状/下一步观察,workedAt 纹丝不动)
- [x] 抽取层·片 6a「候选 + goal 档」——2026-08-18(设计见 [06-extraction.md](06-extraction.md)):候选实体族进共享域事件流(create 仅 source、promote/ignore 仅人类、supersede 仅 source;同源任一状态去重;晋升先建任务后落晋升,崩溃重放被 origin.candidateId 挡住);`task-source` 插件——水位跟踪(播种跳过 `session/end-seed` 附着标记,闲置锚定最后持久事件)、闲置门(默认 3 小时)、`session/disposed` 立即触发、启动扫描在 apply 内先跑一轮;goal fold → 候选(active/paused/blocked 产,complete/clear 把 pending 候选 superseded,blocker 进备注);人面 `/task candidates|promote|ignore` + Web 看板「待确认」列(晋升时人补验收、可覆写目标);全 keyless:fold/抽取/触发 11 测 + 看板宿主 2 测,composition 经真实 Loader
- [x] 抽取层·片 6b「已批计划档 + todo 锚定档」——2026-08-18:两个纯日志 fold 进 `extractSession`——已批计划:`exit_plan_mode` 调用与无 error 结果配对即"人点了 Approve"(拒绝/取消都带 error,`/plan off` 不发此调用,不依赖滞后提交的 plan/mode 翻转),计划 H1 = objective、全文 = 备注,未完 todo 或"批准后零模型动作"即候选,todo 全勾/清空自动 superseded;todo 锚定:整表差分新增条目锚定最近人类消息(`source.kind === 'user'`),用户原话首行 = objective、未完条目 = 备注,origin key = 锚定消息 seq;出生按 goal > 已批计划 > todo 优先级互斥,撤销独立于出生(各档正证据各自 retire);keyless 10 测(种子事件按 surface 规则带 append 标记)
- [x] 抽取层·片 6c「兜底总结档」——2026-08-18:无任何结构信号、至少一条人类消息的会话,闲置(或处置)后由 `agent` 路由起一次总结会话:配额 probe(maxTokens=1,QUOTA 阳性顺延,复用 task-wake 退避)+ 每轮 `summariesPerTick` 上限(超额活会话水位不推进、下轮重试;被墙的处置请求入队由 tick 重试);提示词内置三必要条件、正反例表、现有 objective 去重清单与近 `transcriptEvents` 条 surface 消息,只回一个 JSON(objective+acceptance 必填,否则 `{"none": 原因}`;解析失败/留空一律按无任务);origin key 固定 `summary`,`none` 判定 supersede 该会话 pending 总结候选;keyless 8 测(脚本适配器闭环、限流、配额墙、处置即时)+ 真模型 e2e 自跳过(summary.e2e.spec.ts:搁置意图产候选、已解答问答产 none,5.6s 实测)
- [x] 抽取层·片 7a「进度第一层·闲置显示连接」——2026-08-18(设计见 [06-extraction.md](06-extraction.md) §7 第一层):闲置口径再进化 —— `effectiveIdle` 增第 4 参 `holderActivity` 连接器,每条记录的触点取 `max(台账 workedAt, 持有会话最后事件时间)`,持有会话在动 = 这条线没被搁下,零账本写入、不撞 CAS;`lastSessionActivity` 跳过 `session/end-seed`(挂载时打的账面标记,恢复会话不能因被挂载显得新鲜);会话不在进程内(已死/未启动)读 undefined 退回 workedAt,只会更新鲜、永不变陈。归属:`@task-center/task` 的 `idle.ts`(纯函数)+ 面板(command-task)与看板(task-web)各自经 `ctx.sessions.get` 提供连接 —— 纯展示 join 不进 task-source,7b/7c(产生账本事件)才住那边;task-web composition 测试随之补挂 dsh-session;keyless 4 纯函数测 + 面板双持对照测(活持有不显示闲置、死持有照常 4 天)+ 全套 131 绿
- [x] 抽取层·片 7b「进度第二层·回合末差分回流」——2026-08-18(设计见 [06-extraction.md](06-extraction.md) §7 第二层):持有会话每个 `turn/end`(任何 reason)结算一次窗口 `(上次结算, 本回合结束]` —— `foldEvidence` 取"窗口前最后一表 vs 窗口内最后一表"的 todo 差分(add/move/remove 判别联合)+ 窗口内 goal 变化渲染(clear 用更早快照报目标名),`renderEvidence` 拼一行 `自动回流 todo: … | goal: …`(纯闲聊回合为空串、零写入);`reflowHeldTasks` 对该会话持有的每条 active/blocked 任务写一条 `progress`,actor = 持有会话本身(权限矩阵结构满足,活会话带 task/change 回执、disposed 终冲不带);CAS 撞版读最新 revision 重试一次、再败丢弃(下回合差分补上);结算标记首个 await 前同步推进防双结算,种子只数严格早于本次回合的 turn/end → 挂载后结束的回合整回合回流(崩溃恢复),纯历史永不回流;调试中修过的真 bug:种子曾把**正在结算的 turn/end 自己**算进"最后一回合",挂载前已有历史的会话首回合窗口恒空(什么都不回流);未完 todo 静态并入备注的开放问题随之关闭——差分进度行替代;keyless 8 测(窗口 fold、goal 渲染、闭环含回执与闲聊零写、非持有/待验收跳过、CAS 重试后丢、disposed 终冲、纯历史不回流)+ 全套 139 绿
- [x] 抽取层·片 7c「进度第三层·goal 相变镜像」——2026-08-18(设计见 [06-extraction.md](06-extraction.md) §7 第三层):与 7b 同一结算窗口、在其后应用——`foldGoalMirrors` 只认**判定性转移**(operation 进入 blocked/complete;blocked 中 edit、resume 不镜像),同 goal 窗口内多次变化取最终相、按最终事件序返回;`mirrorHeldTasks` 对该会话持有的每条 active 任务:blocked(非配额码,配额码归 task-quota)带卡点原因置 blocked,complete 自动提交进待验收(note 注明自动提交、人仍是终审);分层顺序是关键——7b 的 progress 写入先把 blocked 归一化回 active(progress 从 active/blocked 合法且清除 blockedReason),goal"先阻塞后完成"的窗口因此仍能从 active 合法提交;submit 保留持有(验收才释放);CAS 重试一次再丢(证据行已在 pack);keyless 4 测 + 全套 143 绿
- [x] 抽取层·触发修订「结构即时,纯对话才等闲置」——2026-08-18(用户验收时定案:原 §4 把闲置门套给了所有档位,过宽):结构信号(goal 设置/计划批准/todo 写入)在事件落地一刻即时抽取出生——显式工作声明无被搁置歧义、零模型成本、人工晋升才是噪声闸门;挂载启动结构扫让恢复的历史同样即时;goal 当场做完即时 superseded;闲置门收窄到兜底总结档,即时通道忽略总结请求(模型花费只经闲置/处置两门);同批修订 todo 锚定——无前置人类消息的模型自主链退而锚定最近一条有正文的助手消息(溯源 Query,无 Query 溯源模型输出);改写两个前提过期的旧测试(启动扫新鲜会话也出生、goal 不再等闲置),新增 5 测;全套 146 绿
- [x] 抽取层·片 6d「存量回灌(装机扫史)」——2026-08-18(设计见 [06-extraction.md](06-extraction.md) §8):`ctx.sessions.list()` 只见活会话,新装用户的历史全在盘上——挂载后一次史扫经可选 `sessionPersistence.list()/inspect()`(`ctx.get` 读,没挂后端记日志跳过)枚举落盘会话只读回灌:结构档即扫即出生(零模型成本),纯对话史排队走同一道闲置门与每轮上限(装机风暴不成立);覆盖水位落本插件自己的 storage domain(`task_source` 域 `covered` 表——抽取器簿记不进账本事件流,dsh 投影缓存同款先例),重启/重装零重读零重付,无 facility 退内存标记;机器会话守卫(id 前缀 `summary-`/`wake-`/`patrol-` + header `origin === 'subagent'`)永不当源,防把自家输出喂回抽取器;总结会话起不来(没配 key)报 failed 不覆盖地、按 pollSeconds 指数退避(封顶 32 倍轮距),补配自动流。顺带修两个真 bug:总结句柄从不注销(注册表累积、失败后同 id 重试撞车致 tick 连环抛——改 `ctx.agents.create` 拿 AgentHandle、判定读完即 dispose)与模型路由失败被 whenIdle 静默吞成"无判定即已覆盖"(改盯 `agent/error` 事件);部署验证再发现两个真 bug:机器会话无 cwd 时部署 persona 的 `{{cwd}}` 渲染失败、总结会话首回合即死——总结/唤醒/巡检会话创建时锚定 cwd(总结锚来源会话目录,唤醒/巡检锚进程目录);确定性机器会话 id 在重启后重试会撞上失败尝试留下的落盘工件(持久层对同 id 不同 cwd 的创建报碰撞),抛错还会把排队请求静默丢掉——每次尝试现铸新 id(尾缀时间戳)、summarize 抛错按 failed 处理不丢队;keyless 回归测试各锁一件;keyless 7 测(真实持久化栈两阶段"先落盘后抽取":新鲜安装回灌、重启零重读零重付、机器会话零模型输入、失败退避恢复、persona 渲染 cwd 锚定、失败工件不挡重试)+ 全套 153 绿
