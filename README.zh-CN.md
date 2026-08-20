# dsh-task-center

**[English](README.md) | 简体中文**

[![CI](https://github.com/Mason-1011/dsh-task-center/actions/workflows/ci.yml/badge.svg)](https://github.com/Mason-1011/dsh-task-center/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%7C%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](./package.json)
[![DeepSeek Harness](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4C6EF5)](https://github.com/deepseek-ai/deepseek-harness)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-74C0FC?logo=github&logoColor=white)](https://github.com/topics/dsh-plugin)

> 个人任务指挥中心:[dsh(DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 的任务全生命周期插件族。
> **人管一摊长期任务,agent 跨会话认领并推进,定时自己醒来干活,进度对人类永远可见。**

## 简介

dsh(以及 Claude Code / Codex 这类 agent 工具)的工作单位是**会话**——会话结束,主动性就死。本仓库解决四类断点:

- **跨时间**:任务一搁置便没了下文,隔段时间想续做,连当时的进展都难以找回;
- **跨项目**:一个功能动三个仓库,三个会话互不知晓;
- **跨窗口/设备**:能带走日志文件,带不走"进行中的工作";
- **跨执行者**:人与子 agent 分头做,谁也不知道整体进度。

dsh-task-center 把任务做成**宿主外的一族插件**,同一份任务账本服务两类用户:**人**(看板看全景、验收裁决)与**模型**(认领任务、恢复上下文、推进汇报)。一句话:**面板负责"看见",工具负责"推进",闹钟负责"活着"。**

独立于 harness 主仓实现,只依赖其公开发布的 npm 包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`),不侵入主仓。完整设计档案见 [docs/design/](docs/design/)。

## 功能特性

- **任务全生命周期**——五态状态机(待办/进行中/阻塞/待验收/已完成),append-only 事件账本,所有变更 CAS 过版本号,重启即恢复;
- **跨会话交接**——新会话认领任务时自动注入上下文包与 `PRIOR SESSIONS` 前序会话清单,不需要人复述背景;看板上每个会话 id 都可点击直达对话;
- **子任务委派**——一个任务挂多个子任务,不同会话并行持有、各自推进,父任务聚合子进度;
- **项目与工作区分组**——人类管理的项目 + 任务出生时自动盖戳的工作区目录,看板四类筛选(全部/项目/工作区/无分组);
- **定时干活**——任务挂唤醒规则(一次/定点/周期),到点自动起新会话认领续干;每日巡检会话刷新全部未完结任务现状;看板详情与卡片直接展示已挂的唤醒规则与下次到点时间;
- **定时发送**——会话页与看板详情均可定一条消息(内容默认 `cont`)与发送时间(附快捷片),到点自动作为用户输入送进目标会话,挂在半路的任务到点自己续上;
- **额度感知**——API 额度用尽自动挂起并释放持有,额度重置点自动续做;看板头部的「自动续做」弹窗可随时开关并**指定续做会话**(默认新会话 / 撞墙的会话 / 任选一个会话,后两者走定时发送通道);每个会话页顶部的 ⏰「定时」弹窗里也可以一键把额度恢复后的续做发进**本会话**,选择跨重启保留,配置里的 `resumeOnReset` 只是默认值;阻塞卡片标注阻塞原因类别(额度/人工等);
- **崩溃恢复**——持有任务的会话死亡(崩溃/被杀),自动释放持有,任务回到可认领;
- **自动抽取**——闲置会话里的 goal/已批计划/todo 自动出生为候选,人确认晋升;做完却无人回应的 goal 直接进待验收;验收打回自动把理由推回原对话重做;
- **双界面**——Web 全屏看板(五列、筛选、阻塞置顶、详情、新建)与 `/task` 命令面板读同一份账本。

### 杀手级流程:从旧聊天记录里挖任务

配合 [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import):把 Claude Code / Codex 的历史会话导入为可继续的 dsh 会话,task-center 的抽取层会自动总结每条闲置对话,判断有没有留下未完成的工作(可命名的结果 / 可判定的验收 / 真实的续做意图),合格的直接出生为看板上的待确认候选——不用人工翻聊天记录。

## 架构总览

任务数据采用**双账本**:权威事件流(`~/.dsh/storages/task.json`,append-only)+ 会话日志回执(`task/change`、`task/context-injected` 事件)——账本保证重启恢复与跨会话一致性,回执保证模型输入可从日志重建。

| 包 | 角色 | 说明 |
|---|---|---|
| [`task`](packages/task) | 核心(Service) | `ctx.tasks`:状态机、项目、子任务、contextPack、事件;`workspacePath` 出生盖戳 |
| [`task-local`](packages/task-local) | 存储 Provider | 经 storage-domain 开域,后端路由 json/sqlite |
| [`tool-task`](packages/tool-task) | 模型面(Consumer) | 七个模型工具 + 提示词段 |
| [`command-task`](packages/command-task) | 人类面(Consumer) | `/task` 命令:面板、项目、候选看管 |
| [`task-web`](packages/task-web) | 人类面(Consumer) | Web 看板:Typert 服务 + 浏览器 bundle |
| [`task-wake`](packages/task-wake) | 时间面(Provider) | 到点起新会话干活 + 每日巡检 |
| [`task-sched`](packages/task-sched) | 时间面(Provider) | 定时发送:到点向既有会话投用户消息(默认 `cont`) |
| [`task-quota`](packages/task-quota) | 额度(Provider) | QUOTA 失败挂起释放,重置点续做 |
| [`task-reaper`](packages/task-reaper) | 存活(Provider) | 释放死持有,崩溃恢复 |
| [`task-source`](packages/task-source) | 抽取(Provider) | 扫描闲置会话产候选;回合末差分回流;验收出生与打回回流 |
| [`shell`](packages/shell) | 独立 REPL 壳 | 一条命令组装全部插件的交互启动器 |

```
docs/design/   设计档案(产品定义、数据模型、接缝规格、计划、抽取层)
packages/      @task-center/* 插件包(pnpm workspace)
```

## 安装

要求 dsh ≥ 0.1.0-rc.8。前置:已全局安装 [dsh CLI](https://www.npmjs.com/package/@deepseek-ai/dsh)(`npm i -g @deepseek-ai/dsh`),且 `dsh plugin` 能找到 `pnpm`(corepack 用户:`corepack enable`;若 node 目录无写权限,`corepack enable --install-directory <目录>` 后把该目录挂上 PATH)。

**1. 构建**(Node 不做 `node_modules` 下的 `.ts` 类型擦除,插件必须以 JS 产物装入 profile):

```sh
corepack pnpm install && corepack pnpm run build   # 产出 packages/*/dist
```

**2. 装包**(从仓库根装入;`shell` 除外——它是自带 REPL 的独立启动器,与 dsh 运行模式冲突):

```sh
dsh plugin --profile headless add \
  file:./packages/task file:./packages/task-local file:./packages/tool-task \
  file:./packages/command-task file:./packages/task-wake \
  file:./packages/task-quota file:./packages/task-reaper \
  file:./packages/task-source
dsh plugin --profile web add \
  file:./packages/task file:./packages/task-local file:./packages/tool-task \
  file:./packages/command-task file:./packages/task-wake \
  file:./packages/task-quota file:./packages/task-reaper file:./packages/task-web \
  file:./packages/task-source file:./packages/task-sched
```

profile 首次使用会自动从模板初始化(`web`/`headless` 有随附模板,其他名字从 `dsh-base` 起)。

**3. 注册插件行**:写进 `~/.dsh/profiles/<name>/cordis.patch.yml`(不是 `cordis.yml`,那是空根)。headless 需附带 storage 三行;web bundle 自带 storage,**不要重插**(duplicate id 会大声失败),从下模板删掉前三行即可。

<details>
<summary>cordis.patch.yml 模板(headless)</summary>

```yaml
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')   # 与 web bundle 同根:两个 profile 共用一份任务账本
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
        routes: {}
    - id: tasks
      name: '@task-center/task'
      config:
        contextPackByteLimit: 2000
        listDefaultLimit: 20
    - id: task-local
      name: '@task-center/task-local'
      config: {}
    - id: task-source
      name: '@task-center/task-source'
      config:
        pollSeconds: 30
        idleHours: 3
        agent:
          provider: deepseek-official
          model: !!js process.env.TASK_CENTER_MODEL ?? 'deepseek-v4-flash'
        summariesPerTick: 2
        transcriptEvents: 40
    - id: tool-task
      name: '@task-center/tool-task'
      config: {}
    - id: command-task
      name: '@task-center/command-task'
      config:
        staleDays: 3
    - id: task-wake
      name: '@task-center/task-wake'
      config:
        pollSeconds: 30
        agent:
          provider: deepseek-official
          model: !!js process.env.TASK_CENTER_MODEL ?? 'deepseek-v4-flash'
        patrol:
          at: '09:30'
    - id: task-quota
      name: '@task-center/task-quota'
      config: {}
    - id: task-reaper
      name: '@task-center/task-reaper'
      config: {}
```

</details>

**4. 验证组合树**:

```sh
dsh --profile <name> --dump-config   # 不启动,只检查组合树
```

## 使用

```sh
export DEEPSEEK_API_KEY=...          # 或在 web 的 Models 页保存
dsh --profile headless "某任务"       # 一次性:建 agent、干活、打印结果、退出
dsh web                              # 浏览器 UI:任务工具进模型,/task 命令面进人类
```

### 模型工具(tool-task)

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务(objective / acceptance),可挂父任务或归入项目;出生工作区由会话目录自动盖戳 |
| `task_claim` | 认领并取回完整上下文包;注入前序会话清单 |
| `task_update` | 记一条进展(note / next),自动解除阻塞 |
| `task_report` | 上报:blocked(附理由)或 review(附对照验收标准的自检) |
| `task_patrol` | 记巡检观察:不认领、不改状态、不刷新闲置时钟 |
| `task_query` | 按 status / workspace_path / project_id 过滤;按父任务列存活子任务 |
| `task_projects` | 列人类管理的项目(创建序,含归档标记) |

### 人类动作

验收裁决(approve / reject)、释放、弃置、阻塞、项目建改归档、候选晋升——全部仅人类可操作,模型工具面不注册这些动词。Web 看板与 `/task` 命令面走同一个人动作面,冲突即刷新不覆盖。验收打回时,理由自动作为用户消息推回原对话并代为认领重做。

### Web 看板(task-web)

侧栏底栏「任务看板」点开全屏五列看板(待办/进行中/阻塞/待验收/已完成),附「待确认」候选收件箱。头部操作行带「自动续做」弹窗(开关 + 续做会话选择,task-quota 的运行时旋钮;指定会话的下拉列出运行中与历史会话);会话页 ⏰「定时」弹窗内另有「额度感知续作」开关,把续做目标直接指到该会话。筛选栏:全部 / 项目 / 工作区(任务出生目录)/ 无分组;详情弹窗含验收标准、历史对话(可点击直达会话页)、子任务、上下文包尾部、定时唤醒规则与定时发送栏。阻塞卡片与详情标注阻塞原因类别(额度/人工等)。⚠ 横幅提示 `staleDays` 天内最久未动的开放任务(闲置按子树取新鲜值,委派进行中不算搁置)。

web profile 的 `cordis.patch.yml` 在 command-task 行后追加:

```yaml
    - id: task-web
      name: '@task-center/task-web'
      config:
        staleDays: 3
    - id: task-sched
      name: '@task-center/task-sched'
      config:
        pollSeconds: 30
        agent:
          provider: deepseek-official
          model: !!js process.env.TASK_CENTER_MODEL ?? 'deepseek-v4-flash'
```

## 配置

| 字段 | 所属插件 | 默认 | 说明 |
|---|---|---|---|
| `contextPackByteLimit` | task | — | 上下文包字节上限 |
| `listDefaultLimit` | task | — | list/query 默认返回上限 |
| `pollSeconds` | task-source / task-wake / task-sched | 30 | 扫描/唤醒/发送轮询间隔 |
| `idleHours` | task-source | 3 | 会话闲置判定窗口 |
| `summariesPerTick` | task-source | 2 | 每轮总结会话上限(装机风暴防护) |
| `transcriptEvents` | task-source | 40 | 总结提示词携带的近端消息条数 |
| `staleDays` | command-task / task-web | 3 | 搁置告警阈值(天) |
| `patrol.at` | task-wake | — | 每日巡检时刻(如 `'09:30'`;错过即跳过) |
| `agent` | task-source / task-wake / task-sched | — | 唤醒/总结/定时发送会话的路由(provider + model) |
| `resumeOnReset` | task-quota | true | 自动续做的默认值;看板头部弹窗在运行时切换开关并选择续做会话(持久化在 task-quota 自己的存储域) |

## 开发

```sh
pnpm install
pnpm run build       # 全量构建(含 web client bundle)
pnpm run test        # 构建 + vitest;真模型 e2e 无 DEEPSEEK_API_KEY 时自跳过
pnpm run typecheck
```

独立 REPL 壳(不经 dsh profile,默认账本 `~/.dsh-task-center`):

```sh
corepack pnpm start                  # 也可 --root <目录> 指定工作根
```

### 常见问题与坑

- **改了插件源码**:`corepack pnpm run build` 后,对 profile 先 `remove` 再 `add` 同一批包——pnpm 缓存 `file:` 拷贝,`--force` 刷不掉;
- **改了 web 客户端代码**:client bundle 的判定与版本按进程缓存,必须 build 后**重启** `dsh web`;`dist/client.js` 必须先于组合行存在(声明的 client 包缺 bundle 会让整个 web 启动失败),所以永远先 build 再 add;headless profile 不装 task-web(无 client 消费者);
- **patch 插入的行必须带显式 `config`**(空也给 `{}`):patch 路径不把缺失 config 归一化,apply 直读 config 且无默认值的插件会当场崩;
- **账本位置**:dsh profile 共用 `~/.dsh/storages`;独立 REPL 壳默认 `~/.dsh-task-center`,两者互不相通。
- **task-sched 只装 web profile**:同一张发送表同一时刻只应有一个进程轮询(两个运行器会对同一行各投一次),headless 与独立壳不装;不装的 profile 仍可通过 web 界面下发送。

## 路线图

实现进度与分期见 [docs/design/04-plan.md](docs/design/04-plan.md):P0/P1、抽取层(6a–6f,含验收出生与打回回流)、进度回流三层、看板历史对话与工作区融合均已落地。当前里程碑:**真实使用一周**,按实际痛点迭代。

## 许可

[MIT](LICENSE)
