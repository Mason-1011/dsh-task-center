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

- [ ] 子任务委派(subagents 摞接),父任务聚合子进度
- [ ] 阻塞告警:超过 N 分钟面板置顶/通知
- [ ] 执行史:任务下任意一次执行一键跳转会话
- [ ] 完成复盘归档:自动生成"做了什么/改了什么/结论",可检索

## P2(二期与远期)

- [ ] 跨设备同步:可换的远程 storage 后端 + 匿名 id 关联;一期策略"后写覆盖、历史可查"
- [ ] 任务模板/例程("每周五跑一次代码审查"存成可复用定义)
- [ ] 与 hooks/mcp 互通(任务事件推给外部系统)

## 仓库纪律自检清单(实现时逐项勾)

- [ ] 每个包 `./invariant`:任务域事件流与 TaskRecord 的一致性关系
- [ ] `task/change` 会话事件带 `@mode`,声明合并进 `SessionEventMap`(required-on-read 默认)
- [ ] 注册即副作用:工具/命令/事件监听全部返回 disposer
- [ ] contextPack 字节上限作用于完整值(bounds to the complete result)
- [ ] 状态只在提交点发布:转写先落域事件、后发通知
- [ ] REAL-composition 测试:过 Loader 启测试 cordis.yml,不手拼 `ctx.plugin`
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
