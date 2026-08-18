# dsh-task-center

> 个人任务指挥中心:dsh(DeepSeek Harness)的任务全生命周期插件族。
> **人管一摊长期任务,agent 跨会话认领并推进,定时自己醒来干活,进度对人类永远可见。**

独立于 [deepseek-harness](https://github.com/deepseek-harness/deepseek-harness) 实现的 out-of-tree 插件仓库,依赖其公开发布的 npm 包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`)。已装 dsh 的机器上加载本插件族,见[「装进已安装的 dsh」](#装进已安装的-dsh)。设计档案见 [docs/design/](docs/design/)。

## 切片计划

实现进度与分期见 [docs/design/04-plan.md](docs/design/04-plan.md):P0 已全部落地;当前推进[抽取层](docs/design/06-extraction.md)(任务从闲置会话的 goal/计划/todo 自动出生为候选,人确认晋升)——6a 已落地,6b 起按切分表推进。

## 布局

```
docs/design/   设计档案(从 harness 仓库迁移的底稿)
packages/      @task-center/* 插件包(pnpm workspace)
```

## 装进已安装的 dsh

前置:已全局安装 [dsh CLI](https://www.npmjs.com/package/@deepseek-ai/dsh)(`npm i -g @deepseek-ai/dsh`),且 `dsh plugin` 能找到 `pnpm`(corepack 用户:`corepack enable`;若 node 目录无写权限,`corepack enable --install-directory <目录>` 后把该目录挂上 PATH)。

**1. 构建**:Node 不做 `node_modules` 下的 `.ts` 类型擦除,插件必须以 JS 产物装入 profile——

```sh
corepack pnpm install && corepack pnpm run build   # 产出 packages/*/dist
```

**2. 装包**:从仓库根装入 9 个插件包(`shell` 除外:它是自带 REPL 的独立启动器,与 dsh 的运行模式冲突)——

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
  file:./packages/task-source
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

**4. 使用**:

```sh
export DEEPSEEK_API_KEY=...                    # 或在 web 的 Models 页保存
dsh --profile headless "某任务"                 # 一次性:建 agent、干活、打印结果、退出
dsh web                                        # 浏览器 UI:任务工具进模型,/task 命令面进人类
dsh --profile <name> --dump-config             # 不启动,只检查组合树
```

## Web 看板(task-web)

`@task-center/task-web` 是插件族的 web 原生界面:侧栏底栏「任务看板」按钮点开全屏五列看板(待办/进行中/阻塞/待验收/已完成),与 headless 的 `/task` 面板读同一份账本、走同一个人身份动作面(approve/reject/release/abandon/block 全部 CAS 过版本号,冲突即刷新不覆盖)。

- **宿主半**:Typert Remote 服务,web 客户端经 `/api` 通道调 `task-board/board|show|act|create`。无推送通道,看板打开时 10 秒轮询 + 每次动作后即拉。
- **浏览器半**:esbuild 打成单个经典脚本,包进 `window.__ModuleLoader__.load({...})` 信封由 web 客户端加载;只 require react 系平台种子,槽位注册进 `sidebar.footer.action`(入口按钮)与 `shell.overlay`(看板浮层)。
- ⚠ 横幅与按钮上的 ⚠ 点:`staleDays`(默认 3)天内最久未动的开放任务,闲置天数按子树取新鲜值(委托进行中不算搁置)。

web profile 的 `cordis.patch.yml` 在 command-task 行后追加:

```yaml
    - id: task-web
      name: '@task-center/task-web'
      config:
        staleDays: 3
```

**坑**:client bundle 的判定与 rev 都按进程缓存——改客户端代码必须 `corepack pnpm run build` 后**重启** `dsh web`;`dist/client.js` 必须先于组合行存在(声明的 client 包缺 bundle 会让整个 web 启动失败),所以永远先 build 再 add。headless profile 不装此包(无 client 消费者)。

**迭代与坑**:

- 改了插件源码:`corepack pnpm run build` 后,对 profile 先 `remove` 再 `add` 同一批包——pnpm 缓存 `file:` 拷贝,`--force` 刷不掉。
- patch 插入的行必须带显式 `config`(空也给 `{}`):patch 路径不把缺失 config 归一化,apply 直读 config 的插件(如 task-quota)会当场崩。
- 账本位置:dsh profile 共用 `~/.dsh/storages`;独立 REPL 壳(下节 `corepack pnpm start`)默认 `~/.dsh-task-center`,两者互不相通。

## 开发

```sh
pnpm install
pnpm run build
pnpm run test
```

