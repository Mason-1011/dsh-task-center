# 设计档案

本目录是任务指挥中心的设计底稿(2026-08-14 定稿),从 deepseek-harness 仓库的设计过程原样迁移。实现若与设计偏离,以实现后的 Agent Note 为准并回改此处。

| 文档 | 内容 |
|---|---|
| [01-product.md](01-product.md) | 产品定义:定位决策、锚定场景、与现有概念的分界 |
| [02-data-model.md](02-data-model.md) | 数据模型:任务域、双账本、状态机、上下文包 |
| [03-plugins.md](03-plugins.md) | 插件族:接缝拆分、task-wake 修正、执行链 |
| [04-plan.md](04-plan.md) | 分期计划(P0/P1/P2)与纪律自检清单 |
| [05-seam-spec.md](05-seam-spec.md) | 定义件规格:状态机转换表、事件 schema、服务 API、工具 schema |
| [06-extraction.md](06-extraction.md) | 抽取与同步草案:闲置会话自动抽取任务(三必要条件防噪声)+ 持有会话进度自动回流台账 |
| [dsh-plugin-analysis.md](dsh-plugin-analysis.md) | 背景参考:dsh 现有插件如何基于 Cordis 实现(机制字典) |

## 关键决策(摘要)

- 定位:个人任务指挥中心——连续性为主、编排为辅,不做团队协作;
- 跨设备同步二期;待验收必须人确认(产品纪律);
- 定时唤醒不复用 dsh-schedule(它是 session-local),新建宿主级 task-wake;
- 任务权威数据放 storage-domain 事件流,`task/change` 会话事件做回放凭证;
- 第一切片:`packages/task` → `task-local` → `tool-task`,先不做面板与定时器。
