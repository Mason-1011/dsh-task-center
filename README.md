# dsh-task-center

> 个人任务指挥中心:dsh(DeepSeek Harness)的任务全生命周期插件族。
> **人管一摊长期任务,agent 跨会话认领并推进,定时自己醒来干活,进度对人类永远可见。**

独立于 [deepseek-harness](https://github.com/deepseek-harness/deepseek-harness) 实现的 out-of-tree 插件仓库,依赖其公开发布的 npm 包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`)。设计档案见 [docs/design/](docs/design/)。

## 切片计划

| 切片 | 包 | 产出 |
|---|---|---|
| 1(进行中) | `packages/task` | 任务接缝定义件:状态机、双账本事件、`ctx.tasks` 服务 |
| 2 | `packages/task-local` | storage-domain 后端 provider |
| 3 | `packages/tool-task` | 模型五工具 + 提示词段,headless 跑通"创建→认领→推进→提交"闭环 |
| 4 | `task-wake` + 面板/命令 | 定时唤醒与人类看板 |

## 布局

```
docs/design/   设计档案(从 harness 仓库迁移的底稿)
packages/      @task-center/* 插件包(pnpm workspace)
```

## 开发

```sh
pnpm install
pnpm run build
pnpm run test
```
