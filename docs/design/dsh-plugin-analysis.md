# dsh 插件如何基于 Cordis 实现 —— 全量分类分析

> 面向非工程背景读者。基于仓库 2026-08-14 状态(commit `47f943859b`)。
> 分析对象:`packages/` 下约 90 个主机端 Cordis 插件,按 10 个职能分类覆盖全部。
> 写法约定:机制讲解为主,只在关键处放短代码切片;每篇结尾有教学点小结。

## 目录

- [0. 公共骨架(先读这个)](#0-公共骨架)
- [① 核心脊柱](#1-核心脊柱9-个包)
- [② 模型层](#2-模型层)
- [③ 能力接缝](#3-能力接缝)
- [④ 会话数据层](#4-会话数据层)
- [⑤ 交互/审批/权限/命令](#5-交互审批权限命令)
- [⑥ 纯领域工具](#6-纯领域工具)
- [⑦ 上下文注入](#7-上下文注入)
- [⑧ 守卫/策略](#8-守卫策略)
- [⑨ 启动/运行模式/宿主](#9-启动运行模式宿主)
- [⑩ 外部集成](#10-外部集成)

---

## 0. 公共骨架

### 两种插件形态(全仓库只有这两种)

| 形态 | 长相 | 谁在用 |
|---|---|---|
| **A. Service 类** | `export default class X extends Service`,构造器里 `super(ctx, '键名')` | session、tools、agent-loop 等脊柱与各能力定义 |
| **B. 函数插件** | 具名导出 `name` / `inject` / `Config` / `apply(ctx, config)` 四件套 | 各种 provider、policy、tool 插件 |

仓库规则:两种形态不能混(Service 类 default-export 类;函数插件具名导出四件套,不能有 default export),混了 Loader 会丢弃 inject(postmortem 0001)。

### 声明合并:每个插件的"第一现场"

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore      // 占的"公告板"键名
  }
  interface Events {
    'session/created'(session: Session): void   // 事件频道 + @mode 喊话方式
  }
}
```

- **不改 Cordis 源码**,只在公共"电话簿"上登记:从此所有插件都能类型安全地用 `ctx.sessions`。
- 事件的 JSDoc 必须带 `@mode`(emit / waterfall / parallel / serial),生成目录会校验声明与实际派发一致。

### 五个反复出现的机制

1. **`super(ctx, 'key')`** —— Service 类把自己注册为 `ctx.key`,一行上公告板。
2. **`inject`** —— 依赖声明("等这些服务出现我才激活")。函数插件用 `export const inject`,Service 类用 `static inject`;软依赖用体内 `ctx.inject(['x'], cb)` 二段等待。
3. **`ctx.effect(...)`** —— 注册即副作用,返回 disposer(撤销单据);generator 形式可多步注册、抛错自动倒序回滚。
4. **`ctx.on(event, listener)`** —— 订阅事件;waterfall 监听器必须调 `next()` 委托,不调即短路。
5. **作用域** —— Agent 有自己的 `agent.ctx`(子 context),上面注册的东西自动只属于该 agent(scope 库提供标签与过滤)。

---

## 1. 核心脊柱(9 个包)

一句话:这 9 个包构成产品 API 主干,其他一切插件挂在它们暴露的服务与事件上。

| 包 | 形态 | ctx 键 | 依赖(inject) | 事件 | 教给你的 Cordis 用法 |
|---|---|---|---|---|---|
| core/session | Service | `sessions` | typert(软) | 4 个 | generator effect 回滚、事件 @mode |
| core/system-prompt | Service | `systemPrompt` | scope | 2 个(waterfall) | waterfall 短路、作用域过滤 |
| core/tools | Service | `tools` | systemPrompt | 5 个(3 waterfall) | register 返回 disposer、Config 校验 |
| core/agent | Service | `agents` | scope | agent/* | Context 带身份、能力句柄 |
| core/agent-loop | Service | `agentLoop` | **5 个服务** | — | 最重依赖图、软依赖二段等待 |
| core/scope | **库** | — | — | — | "包≠插件"的反例(纯函数,无生命周期) |
| core/agent-default-model | Service | `agentDefaultModel` | — | — | 配置即默认数据源 |
| core/agent-tool-presentation | 函数 | — | tools | — | 四件套、presentAs 自带 disposer |
| llm/llm | Service | `llm` | — | 1 个 | 抽象适配器 + 带 replace 的句柄 |

### 1.1 core/session —— 会话日志服务

**用途一句话**:事件溯源的会话存储——会话的创建、销毁、账本追加与 flush 都以它为唯一权威。

- `super(ctx, 'sessions')` 上公告板;构造器里 `ctx.inject(['typert'], ...)` 软等待类型服务再注册 lookup。
- **持久化不在这里**——注释明说:持久化插件订阅 `session/event`、在 `session/flush` 时落盘。定义与实现分离的第一实例。
- 创建会话走 generator effect:

```ts
this.ctx.effect(function* (this: SessionStore) {
  yield this.enter(session)      // yield 出"撤销函数"
  this.announce(session)         // 广播 session/created;有监听者抛错则自动回滚上面的 yield
}.bind(this), 'sessions.create()')
```

- 事件:`session/created`(emit,同步否决)、`session/disposed`(emit)、`session/event`(emit,账本追加通知——持久化/遥测/标题全靠它)、`session/flush`(parallel,全员等待)。

### 1.2 core/system-prompt —— 提示词装配线

**用途一句话**:系统提示词装配注册表——段落、动态上下文、工具 schema、变量统一在一条流水线里组装成模型看到的提示词。

- 占 `ctx.systemPrompt`;核心事件 `system-prompt/assemble` 是 **waterfall**:注册表把段落/动态上下文/工具 schema/变量组成 `assembly` 流水线传给每个监听者,可改、可 `next()` 传下、可不调 `next()` 短路定稿。
- `this: Scoped<SystemPrompt>` + 事件文档的 "Scope-filtered dispatch":装配事件按 agent 作用域过滤,A agent 的装配只有挂在 A 作用域的监听者能插手。
- 其他插件通过 `ctx.systemPrompt.section()/context()/variable()/tools()` 贡献内容,**每次调用返回 disposer**。

### 1.3 core/tools —— 工具注册表 + 执行流水线(最复杂)

**用途一句话**:工具的登记处与执行流水线——模型能调用哪些工具、调用怎么被层层加工,都从这里过。

- `static inject = ['systemPrompt']`;`static Config = z.object({...})` 用 schemastery 声明配置,Loader 启动时校验("错误配置大声失败")。
- 构造器里 `ctx.systemPrompt.tools(fn)` 把工具 schema 接进提示词装配——两个脊柱服务的第一次真实对话。
- 核心方法 `register(definition): () => void` —— 返回值类型就是 disposer:

```ts
register(definition: ToolDefinition): () => void {
  // ...校验 schema/timeout/保留名 run_code...
  return this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' })
}
```

- 执行流水线五事件,策略全外挂:`tools/pre-execute`(waterfall,审批插件在此拦截)→ `tools/execute`(waterfall,超时/重试插件在此包裹)→ `tools/post-execute`(waterfall,截断策略在此改写结果)。注册表自己一个策略都不写。

### 1.4 core/agent —— Agent 登记处

**用途一句话**:定义 Agent 接口与登记处(`ctx.agents`),管 agent 的创建/恢复/分叉和"哪个身份在说话"的作用域。

- 占 `ctx.agents`,并往 Context 加**可选字段** `agent?: Agent`——子 context(agent.ctx)上携带"当前身份",其上注册的东西自动只属于该 agent。
- **接口与驱动分离**:本包只定义 `Agent` 接口 + `create/resume/fork` + `setFactory()`;真正实现 Agent 的代码在 agent-loop(实现 `AgentFactory` 接口)。两个包靠接口解耦,loop 可被替换。
- `create()` 返回 `AgentHandle { agent, dispose() }`——dispose 是能力(capability),只有拿到句柄的人能拆。

### 1.5 core/agent-loop —— 主循环(依赖最重)

**用途一句话**:具体的主循环——驱动"请求模型 → 执行工具 → 再请求"直到任务完成,是整个产品的发动机。

```ts
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
```

- 一行声明 5 个依赖——整个脊柱的依赖图。Cordis 保证齐了才激活,加载顺序问题消失。
- 构造器是插件协作全景:

```ts
ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')   // 填 agent 包留的坑
ctx.systemPrompt.variable('provider', c => c.agent?.options.provider)     // 每次调用都是可逆注册
ctx.systemPrompt.variable('model',   c => c.agent?.options.model)
ctx.systemPrompt.variable('cwd',     c => c.agent?.session.header.cwd)
// 配置里声明的 agent:逐个 create;resume 的用 ctx.inject(['sessionPersistence'], ...) 软等待持久化
```

- `ctx.effect(() => ctx.agents.setFactory(this))` 演示 effect 的另一种形态:传入函数的返回值(撤销函数)直接成为副作用的一部分。

### 1.6 core/scope —— 作用域库(不是插件!)

**用途一句话**:作用域注册原语——给注册打上作用域标签、让事件按作用域过滤派发,是"A agent 的事不漏给 B"的基础。

- 没有 `extends Service`、没有 inject/apply——纯函数集合(`scopeOf`/`scopeTarget`/`createScope`)。架构文档原话 "library, no key"。
- 教学点:**"包"≠"插件"**。它没有自己的生命周期,作用域生灭跟随使用它的 context,所以是库。219 个包里这类"被插件调用的库"是一大类。

### 1.7 core/agent-default-model —— 默认模型选择(最小 Service 样本)

**用途一句话**:所有 Agent 入口共享的默认模型选择服务——没指定模型时用哪个,答案统一从这里来。

- 构造配置给默认值;`settings` 服务在场时 `setSource` 把数据源**换成实时读取**;保存时 `ctx.get('settings')?.replace(...)` 写回。
- 教学点:服务之间用"数据源替换"协作,而不是互相 import。

### 1.8 core/agent-tool-presentation —— 完整函数插件样本(72 行)

**用途一句话**:每个 agent 的工具呈现模式选择——模型写的工具调用以 Code Mode、原生呈现还是两者混合展示。

```ts
export const name = 'tool-presentation'
export const inject = ['tools']                       // 硬依赖
export const Config = z.object({
  mode: z.union(['native', 'code', 'both']).required(),  // 故意必填:默认值等于"部署默认",这行就白配了
})
export function apply(ctx: Context, config: Config): void {
  if (config.mode === 'native') { ctx.tools.presentAs('native'); return }
  ctx.inject(['codeRuntime'], (runtimeCtx) => {       // 软依赖二段等待
    runtimeCtx.tools.presentAs(config.mode)
  })
}
```

- `presentAs` 本身就是 effect(自带 disposer),apply 不用再包一层。
- native 模式可在没有 codeRuntime 的部署里挂载;code 模式等不到就 pending、大声失败。

### 1.9 llm/llm —— 模型运行时(空插座排)

**用途一句话**:商家中立的模型服务接口——一排空插座加一个适配器注册表,自己不写任何具体调用。

- 占 `ctx.llm`;定义抽象类 `LlmAdapter`(子类决定怎么调 API),自己不写任何具体调用。
- `registerAdapter(providers, adapter)` 返回**带 `replace` 方法的句柄**:撤销时清 Map 并广播 `llm/adapters-updated`(撤销也触发事件,让消费者知道拓扑变了)。
- `emitAdaptersUpdated()` 手写逐监听者容错:Cordis 的 emit 用 `Array.map`,一个同步抛错会饿死后面的监听者,所以逐个 try/catch——"用 Cordis 也要懂它内部语义"的例子。

### ① 小结:三个最重要的体会

1. **每个包只占一个键、只管一摊**——换掉谁就写个新插件占同一个键。
2. **"注册返回 disposer"无处不在**——全仓库统一的"押金单据"纪律。
3. **策略不进核心**——waterfall 让审批/超时/截断外挂,emit 让持久化/遥测/标题外挂;脊柱只提供插座。

---

## 2. 模型层

四个插件都围绕"模型调用"工作,但接入点各不相同:两个填插座、一个听事件、一个读日志。

| 插件 | 形态 | inject | 接入方式 |
|---|---|---|---|
| llm/llm-deepseek | 函数 | `['llm']` | `registerAdapter` 填插座 |
| llm/llm-pi-ai | 函数 | `['llm']` | 同上 + `registerModelDiscovery` 动态发现模型 |
| llm/llm-retry | 函数 | `['agents']`(注意:不是 llm!) | 监听 `agent/request-error` 在循环层重试 |
| llm/token-meter | Service | — | 订阅 `session/event` 从日志统计用量 |

### 2.1 llm-deepseek / llm-pi-ai —— Provider 型(填插座)

**用途一句话**:llm-deepseek 是 DeepSeek chat-completions 适配器;llm-pi-ai 是基于 pi-ai 库的 DeepSeek 适配器(deepseek 版的设计验证孪生),外加动态模型发现。

```ts
ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, ... }])
const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
```

- ①篇的"空插座排"在这里兑现:两个 provider 同时在场各占各的路由,按 `provider` 名路由。**换模型商 = 换一个插件,零改动别处。**
- 工程细节一:配置是"活的"——适配器持 `options()` 函数每次请求实时读设置;读到坏快照继续用上一份好的并报错一次(服务不死,错误不静默)。
- 工程细节二:`registration.replace([PROVIDER])` **原地改绑**重试策略,而不是"注销再注册"——后者中间有一瞬间路由为空,观察者会看到 provider 消失又出现。这就是 llm 句柄带 `replace` 的原因。

### 2.2 llm-retry —— 事件监听型

**用途一句话**:按路由的模型请求重试策略——监听 `agent/request-error`,在循环层决定何时重试。

- `inject = ['agents']`:不包装适配器,监听 `agent/request-error` 在**循环层**重试——"要不要重试"需要循环级语义(哪轮 step、错误在请求前还是流中),适配器层看不到。
- 教学点:同一需求有多个可挂位置(适配器层包流 vs 循环层听事件);选事件 = 零侵入,卸载只摘监听器。

### 2.3 token-meter —— 日志派生型

**用途一句话**:可回放的 token 用量统计服务——不碰模型调用本身,只从会话日志里读 usage 做统计。

```ts
ctx.on('session/event', (session) => { ... })
```

- 不挂模型的流,订阅会话日志统计 usage——因为"模型可见即已记录",usage 本来就随 `assistant/message` 事件进了账本,它只是读者。

### ② 教学点:参战三级梯

需要**改变**行为 → 填插座或包 waterfall;需要**观察** → 订阅事件;需要**统计** → 读日志。越靠右越解耦,卸载残痕越少。

---

## 7. 上下文注入

四个插件,三个用同一手法:**监听 `agent/pre-step`(step 开始前的 waterfall),往模型即将看到的内容里塞东西**。

| 插件 | 形态 | inject | 注入什么 |
|---|---|---|---|
| context/time-context | 函数 | `['agents']` | 当前日期时间(让模型知道"现在"几点) |
| context/tmux-context | 函数 | `['agents']` | tmux 终端会话状态 |
| context/agent-instructions | 函数 | — | AGENTS.md 类指令文件内容 |
| context/session-reference | **Service** | `['sessionQuery']` | 解析消息里的会话引用(如 @某会话) |

### 7.1 agent-instructions:有状态的注入器(挂三个事件)

**用途一句话**:加载 AGENTS.md / CLAUDE.md 工作区指令文件,并合入每一步的模型输入——文件被编辑后缓存自动失效。

- `session/event` —— 盯账本,**用户编辑了指令文件**时让缓存失效;
- `agent/pre-step` —— 真正的注入点,把解析好的指令并入这一步的输入;
- `tools/result` —— 工具(如 edit)改了文件后同样触发刷新。

### 7.2 session-reference:唯一的 Service

**用途一句话**:跨会话快照引用与持久化"不可信模型上下文"的解析器——消息里的 @某会话 由它展开成可读内容。

别人需要**主动调用**它(解析引用),所以它提供方法而不只被动监听。**分界线:提供"能力"用服务,实施"影响"用事件。**

### ⑦ 教学点

time-context 和 agent-instructions 都挂在 `agent/pre-step` 上,互相不知道对方存在;Cordis 按注册顺序串成流水线,注入叠加生效。**加一种新上下文来源 = 写一个监听 pre-step 的插件,不改任何现有代码。**

---

## 8. 守卫/策略

共同画像:**函数插件、不占任何 ctx 键、只往事件上挂监听器**。是"策略不进核心"的实体证据。

| 插件 | inject | 挂的事件 | 干什么 |
|---|---|---|---|
| guard/timeout-policy | `['tools']` | `tools/execute` | 按工具声明的预算强制超时 |
| spill/spill-policy | `['tools']` | `tools/post-execute` + `tools/code-dispatch-log` | 超大结果截断,完整版存盘(spill-local 后端) |
| guard/repeat-tool-reminder | — | `tools/post-execute` + `agent/pre-step` | 检测重复失败调用,下一步提醒模型换思路 |
| session/session-checkpoint-policy | `['llm','sessionPersistence','sessions','tools']` | `llm/stream` + `tools/execute` + `agent/pre-step` | 关键边界强制持久化 checkpoint |

### 8.1 timeout-policy:教科书级 around 中间件(全仓库最小 waterfall 包装样本)

**用途一句话**:工具超时策略——给每次工具调用装上该工具声明的期限,到期返回 TOOL_TIMEOUT。

```ts
ctx.on('tools/execute', async (exec, next) => {
  const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
  if (timeoutMs === undefined) return next()        // 无预算:原样放行
  using d = deadline(exec.signal, timeoutMs, ...)   // 造带期限的信号
  const upstream = exec.signal
  exec.signal = d.signal                            // 换给工具体看
  try {
    const result = await next()                     // 委托下一环(真正执行)
    if (/* 我们自己的定时器触发了 */) return toolTimeoutResult(timeoutMs)
    return result
  } finally {
    exec.signal = upstream                          // 务必还原,别污染下一环
  }
})
```

四个动作:**读预算 → 换信号 → 委托 → 还原**。`finally` 还原是 tools 事件文档"包装者只能动 exec.signal 且必须还原"的守约现场。`inject=['tools']` 因为要查工具的超时声明。

### 8.2 其余三个的"选口"差异

**用途一句话**:spill-policy 把超大工具结果截断、完整版存盘;repeat-tool-reminder 在模型反复调同一个失败工具时提醒它换思路;session-checkpoint-policy 在模型请求与工具副作用前强制落一次持久化 checkpoint。

- **spill-policy** 挂**事后**事件(post-execute):不改执行,只裁剪产物;
- **repeat-tool-reminder** 两事件组成**有状态**策略(post-execute 记次数,pre-step 提醒),策略状态完全私有;
- **session-checkpoint-policy** 三个事件口,在边界强制 checkpoint。

### ⑦⑧ 合并教学点

"注入上下文"和"执行策略"用的是**同一套机制**(ctx.on + waterfall),区别只在挂哪个事件、监听器里做什么。Cordis 不区分"策略"和"增强",它只提供事件;语义由插件赋予。这是整个架构极简的根源:**一个机制(事件)承载所有横切需求。**

---

## 4. 会话数据层

核心句式:**定义接缝(抽象 Service 基类)+ 换后端(子类)+ 一群"账本读者"**。

| 插件 | 形态 | inject | 角色 |
|---|---|---|---|
| session/session-persistence | **抽象 Service 基类** | — | 持久化接缝:基类订阅事件/管协议,子类管存储格式 |
| session/session-persistence-jsonl | Service 子类 | `['sessions']` | JSONL 文件后端(base 默认挂它) |
| session/session-persistence-sqlite | Service 子类 | `['sessions']` | SQLite 后端(可选) |
| session/session-projection | Service | — | 订阅 `session/event` 构建投影(会话的派生视图) |
| session/session-projection-cache | Service | `['storageDomain','sessionProjections','sessionPersistence','sessions']` | 投影缓存(4 依赖) |
| session/session-title | Service | `['sessions']` | 标题服务:挂 `session/event` + `llm/stream` + `session/disposed` 三事件 |
| session/session-title-first-prompt-llm | 函数 | `['sessionTitle','llm','sessions']` | 用首条消息+LLM 生成标题(base 默认挂它) |
| session/session-title-llm | 库(配置/类型助手) | — | 供 LLM 标题生成器共享的配置解析 |
| session/session-telemetry | **抽象 Service 基类** | — | 遥测 sink 接缝 |
| session/session-telemetry-otel | Service 子类 | `['sessions']` | OpenTelemetry 后端,订阅 `session/event` |
| session/session-stats | 函数 | `['sessionProjections']` | 从投影读统计 |
| session-query/session-query | **抽象 Service 基类** | `['sessions']` | 查询引擎接缝(tool-session-query 的后端) |
| session-query/session-query-sqlite | Service 子类 | — | SQLite 实现(base 默认挂它) |
| session-query/session-log-export | 函数 | `['commands']` | 注册"导出会话"人类命令 |

### 4.1 第三种挂载形态:抽象 Service 基类

**用途一句话**:session-persistence 是抽象持久化接缝(基类管协议与时序),session-persistence-jsonl 写 .jsonl 文件、session-persistence-sqlite 写 SQLite,是它的两个存储格式子类。

这一层教给我们的新形态——**接缝不用 `declare module` 声明,而是导出一个抽象基类**:

```ts
export abstract class SessionPersistence extends Service { ... }   // 基类:协议与公共逻辑
export class JsonlSessionPersistence extends SessionPersistence    // 子类 A:写 .jsonl 文件
  implements PersistenceBackend<JsonlTornMarker> { static inject = ['sessions'] }
export class SqliteSessionPersistence extends SessionPersistence   // 子类 B:写 SQLite
```

- 基类构造器里统一 `super(ctx, 'sessionPersistence')` 占键、订阅事件、管理 flush 时序;子类只实现 `append`/`load` 等**存储格式相关**方法——模板方法模式。
- 三个抽象基线(persistence / telemetry / query engine)如出一辙:**接缝 = 抽象基类;后端 = 子类插件;换后端不改消费者**。

### 4.2 "账本读者"大集合

**用途一句话**:session-projection 把日志构建成会话的派生视图;session-title 从日志和模型流生成会话标题;session-telemetry-otel 把会话记录交给 OpenTelemetry——它们与 ② 的 token-meter 一样,都只是账本的读者。

projection、title、telemetry-otel 与 ② 的 token-meter 全部是 `ctx.on('session/event', ...)`——**会话日志是全仓库最大的事件枢纽**:谁需要会话事实,谁就订阅它,没有例外。title 还额外挂 `llm/stream`(waterfall,从流里拿首段回复做标题素材)和 `session/disposed`(清理)。

### 4.3 依赖链的层次感

**用途一句话**:session-stats 从投影读整场对话的计数与耗时;session-title-first-prompt-llm 用首条用户消息生成标题,session-title-all-prompts-llm 用全部用户消息——同一接缝的两种策略。

session-stats 依赖 projections;projections 依赖事件;title 的 LLM 生成器是个**三依赖函数插件**(`['sessionTitle','llm','sessions']`)——接缝(标题服务)+ 能力(llm)+ 数据(sessions)各占一个,依赖列表读起来就是插件的角色说明书。

### ④ 教学点

1. **抽象基类是"接缝"的另一种表达**——比 `declare module` 更重(带公共逻辑),适合"协议复杂、后端多样"的场合。
2. **同一事实流(账本)派生一切**——持久化、投影、标题、遥测、统计、用量,全是读者,互不知道对方。
3. 函数插件 `session-log-export`(inject `['commands']`)预告了 ⑤:**命令也是一条能力接缝**。

---

## 5. 交互/审批/权限/命令

这一层的关键认知:**"问人"也是一条条接缝**——服务定义、工具消费、UI 提供者三角色齐全。

| 插件 | 形态 | inject | 角色 |
|---|---|---|---|
| interaction/commands | Service(TypertRemoteService) | — | `ctx.commands` 注册表:人类命令,**不经模型** |
| interaction/user-approval | Service(ApprovalService) | — | 审批接缝:UI 挂 provider,工具管线的 ask 决策流到这里 |
| interaction/user-questions | Service | — | 问用户接缝(结构化问答) |
| interaction/permission-presets | Service | `['shell','approval','sessions']` | 权限预设(如 workspace-write),挂 `session/created` |
| interaction/tool-ask-user | 函数 | `['tools','userQuestions']` | `ask_user_question` 工具:调用暂停直到人类作答 |
| feedback/command-feedback | 函数 | `['commands']` | `/feedback` 命令 |
| feedback/message-feedback | Service | `['storageDomain','sessionPersistence','sessions']` | 消息反馈存储 |

### 5.1 命令 vs 工具:平行世界,同一模式

**用途一句话**:commands 是人类命令注册表(slash 命令,不经模型);command-feedback、command-goal、session-log-export 都是往它上面注册命令的消费者。

`ctx.commands.register({...})` 与 `ctx.tools.register(...)` 是同构的注册-disposer 模式,但面向两个受众:**命令面向人类**(slash 命令,不产生模型轮次),**工具面向模型**。command-feedback、command-goal、session-log-export 都是 commands 的消费者——一个接缝养活一排插件。

### 5.2 审批链路:⑧策略 × ⑤接缝 的合流

**用途一句话**:user-approval 是审批接缝(`ctx.approval`)——一次性权限决策经 waterfall 派发给 UI 挂上来的作答者,默认失败关闭;user-questions 是它的"提问"姊妹接缝。

工具管线的 `tools/pre-execute` waterfall 里,权限插件的 `ask` 决策把调用导向 `ctx.approval`(user-approval 服务)——它再等 UI 挂上来的 provider 弹窗问人。**策略(事件)与接缝(服务)在这一刻合流**:策略说"要问",接缝负责"怎么问"。

### 5.3 权限预设是可回放的状态

**用途一句话**:permission-presets 提供用户可见的权限预设——一个产品级选择捆绑沙箱模式与审批策略,写进会话事件、断电重开照样恢复。

permission-presets 的 KnobState 是**会话事件的投影**(纯函数 `applyKnobState`),挂在 `session/created` 上初始化——权限不是内存里的开关,是账本里的记录,断电重开照样恢复。

---

## 6. 纯领域工具

不提供服务、只把"模型可见工具"挂上 `ctx.tools` 的插件。它们是**消费型插件的标准像**。

| 插件 | 形态 | inject | 内容 |
|---|---|---|---|
| todo/tool-todo | 函数 | `['tools']` | 最小样本:1 依赖 1 工具(`todo_write`) |
| goal/tool-goal | 函数 | `['agents','goals','tools','systemPrompt']` | 3 个 goal 工具 + 1 个提示词段 |
| plan/plan-mode | Service | `['tools','systemPrompt']` | `PlanModeController`:pre-step 监听 + 提示词段 + `exit_plan_mode` 工具 |
| session-query/tool-session-query | 函数 | `['tools','systemPrompt','sessionQuery']` | 5 个只读查询工具 |
| extensions/tool-cordis | 函数 | `['tools','systemPrompt','dynamicCordisRunner','cordisInspect']` | 自我修改工具集(6 个工具,**不进默认组合**,opt-in) |

### 6.1 消费型插件的标准骨架

**用途一句话**:tool-todo 是模型可见的待办清单工具(状态进会话日志,可回放);tool-cordis 是"检查运行时、挂载/卸载模型写的插件"的自我修改工具集——消费型插件两端的最小与最大样本。

```ts
export const inject = ['tools', ...后端接缝们]
export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'tool:xxx', order: 1xx, text: ... })  // 可选:教模型怎么用
  ctx.tools.register(defineTool({ name: 'xxx', ... }))                    // N 个工具
}
```

- `defineTool` 帮手把 schema + execute + 展示回调打包;每次 register 拿 disposer。
- tool-todo 是**最小样本**,tool-cordis 是**最大样本**(4 依赖 6 工具)——同一骨架的两端。
- plan-mode 特殊在它还挂 `agent/pre-step`:计划模式开/关本身是**记录在日志里的状态**,pre-step 里按状态改写本步输入。

### 6.2 goal 是一个"微生态"(单功能拆 4 插件)

**用途一句话**:goal 是事件溯源的同会话目标状态服务;tool-goal 给模型读写目标的工具;goal-round-driver 到点自动续轮;command-goal 给人类 /goal 命令——一个特性按角色拆成四个插件。

goal/goal(核心 Service)+ tool-goal(模型工具)+ goal-round-driver(自动续轮,函数插件)+ command-goal(人类命令)——**一个产品特性按角色拆成四个插件**,每个只挂自己那面的接缝。这就是"插件不是按功能切,是按角色切"。

### 6.3 工具状态 = 会话事件

todo 和 goal 的状态都不是服务私有内存,而是**账本事件的投影**(`applyGoalProjection` 是纯函数:上次状态 + 新事件 → 新状态)。任何持有日志的人都能重建 UI——可回放性贯彻到最小的工具。

### 6.4 新形态再+1:TypertRemoteService

**用途一句话**:goal、commands、message-feedback 的服务继承 TypertRemoteService——服务照常挂载,额外经 Typert RPC 网关可被浏览器前端直接调用。

goal、commands、message-feedback 的服务继承 `TypertRemoteService` 而非裸 `Service`——表示该服务同时通过 Typert RPC 网关**可被远程调用**(浏览器前端直接调)。挂载机制不变,多了一层"上 RPC 线"的能力。

---

## 3. 能力接缝(最大的一类)

13 条接缝,每条都是**定义(Service)→ 实现(Provider)→ 消费(Consumer)** 三件套,外加可选的 policy。**这是"一切皆插件"密度最高的地方。**

### 3.1 全景表:13 条接缝 × 四种角色

| 接缝 | 定义(占键) | Provider(填键/注册) | Consumer(工具) | Policy |
|---|---|---|---|---|
| **文件** | fs/fs → `ctx.fs` | fs-local(本机)、fs-e2b(远程) | tool-fs、tool-fs-search、tool-str-replace-editor | fs-observation-policy、fs-sandbox |
| **Shell** | shell → `ctx.shell` | bash-local、bash-sandbox、pwsh-* | tool-bash、tool-pwsh、tool-bash-persistent | sandbox-policy |
| **子进程** | subprocess → `ctx.subprocess` | subprocess-local、subprocess-e2b | (被 shell/lsp/fs-search 消费) | — |
| **终端** | terminal → `ctx.terminals` | terminal-bash | tool-terminal | sandbox-policy |
| **上网** | web → `ctx.web` | web-fetch-http、web-search-deepseek/exa/perplexity | tool-web | — |
| **LSP** | lsp → `ctx.lsp` | lsp-stdio | tool-lsp | — |
| **沙箱** | sandbox → `ctx.sandbox`;sandbox-policy → `ctx.sandboxPolicy` | sandbox-local、sandbox-windows-acl | (被 shell/fs/terminal 消费) | sandbox-policy 本身 |
| **子Agent** | subagent → `ctx.subagents` | spawn-in-process、fork-in-process、**claude-code、codex、acp、dsh-sdk** | tool-subagent(-fork)、tool-subagent-control、tool-subagent-report | — |
| **技能** | skill → `ctx.skills` | skill-filesystem | tool-skill | — |
| **后台任务** | jobs → `ctx.jobs` | jobs-local | tool-jobs | — |
| **工作流** | workflow → `ctx.workflowEngine` | workflow-worker-thread | tool-workflow、tool-ralph | — |
| **压缩** | compaction → `ctx.compaction` | compaction-basic | (命令 command-compact) | tool-result-pruner |
| **溢出/存储** | spill → `ctx.spillStore`;storage → `ctx.storageDomain` | spill-local;storage-json、storage-sqlite | (被 spill-policy 等消费) | spill-policy |

### 3.2 第四种挂载形态:子类替换(Provider 的方式一)

**fs-local 的用途一句话**:本机文件系统的实现——直接读写你电脑上的文件。

`fs-local` 的入口既不是函数四件套也不是抽象基类,而是——

```ts
export class LocalFileSystem extends FileSystem { ... }   // 继承定义服务的类
export default LocalFileSystem                            // Loader 直接实例化子类
```

- 基类 `FileSystem` 构造器里 `super(ctx, 'fs')` 占键;子类实例化时**顶替**键上的服务。
- **同一键同时只能有一个**:base 的 README 明说"fs-local 与 fs-sandbox 同时挂会 double-register `ctx.fs` 并在加载时失败"——不是静默覆盖,是**大声失败**。
- 适用:**整体行为不同**(本机 vs 沙箱 vs 远程),一次只有一个真身。

### 3.3 Provider 的方式二:注册进注册表(共存)

llm(②篇)之外,web/storage/subagent/terminal 都走这条路:provider 是**函数插件,inject 指向接缝键**,进场后调注册方法把后端挂进去(`storage-json` inject `['storage']`、`web-fetch-http` inject `['web']`、`subagent-spawn-in-process` inject `['subagents']`)。

- 适用:**多个后端并存**(DeepSeek 搜索 + http 抓取同时在;多个搜索商可换)。
- 两种方式的选择标准就一条:**真身是否唯一**。

### 3.4 接缝摞接缝(seam stacking)——最妙的结构

看 provider 的 inject 列表会发现它们自己也在消费别的接缝:

- `bash-local` inject `['subprocess']` —— shell 的实现建立在子进程接缝上;
- `terminal-bash` inject `['terminals','sandboxPolicy','subprocess']` —— 终端实现吃三个接缝;
- `lsp-stdio` inject `['fs','lsp','subprocess']` —— LSP 后端要读文件、起进程;
- `workflow-worker-thread` inject `['subagents']` —— 工作流引擎的实现就是"批量指挥子 Agent";
- `compaction-basic` inject `['llm','tokenMeter','sessions']` —— 压缩的实现是"调 LLM 总结 + 读账本"。

**接缝不是平铺的,是分层摞起来的。** 换掉最底层的 subprocess/fs,上面所有层自动跟着走。

### 3.5 e2b:一条接缝换后端 = 整个产品搬家的实证

**用途一句话**:e2b 提供共享的 E2B 远程沙箱客户端(`ctx.e2b`);fs-e2b 把文件接缝、subprocess-e2b 把子进程接缝的实现都指到那个远程沙箱。

`e2b` 包提供 `ctx.e2b`(沙箱客户端服务);`fs-e2b`、`subprocess-e2b` 两个 provider inject `['e2b']`,把**文件接缝和子进程接缝的实现指到远程沙箱**。因为 shell、terminal、lsp 都摞在这两根管子上(3.4),配置里换这两个 provider,Bash/PTY/LSP 就全部在远程执行——**没有任何上层插件改动一行代码**。"换一个 provider 改变整个产品"在这里是可验证的事实,不是口号。

### 3.6 subagent 接缝:provider 可以是"别的 Agent 产品"

**用途一句话**:spawn/fork-in-process 是进程内子 agent 后端(新建 / 以父日志前缀复制);claude-code、codex 经官方 SDK/协议起外部 CLI 当子 agent;acp、dsh-sdk 走协议/SDK 对接另一个进程里的 agent。

spawn/fork-in-process 是进程内子 Agent;而 `subagent-claude-code` / `subagent-codex`(inject `['subagents','subprocess']`)把委派目标换成**外部 CLI**:起子进程调 Claude Code / Codex 干活,把结果交回。`subagent-acp` / `subagent-dsh-sdk` 走协议/SDK 对接。**接缝抽象到"委派"这一层,连被委派者是不是本产品都无所谓**——这是抽象层级选得准的收益。

### 3.7 policy 在接缝上的位置

**用途一句话**:fs-observation-policy 实现"先读过才能改、改要带版本守护"的文件策略;sandbox-policy 是把"沙箱模式 + 工作区根"答案共享给所有执行类接缝的策略服务。

- `fs-observation-policy`(函数插件,无 inject)——订阅 `fs/*` 事件,实现"读后才能写"策略(⑦⑧ 的机制,作用于 fs 接缝);
- `sandbox-policy` 是 **Service**(占 `ctx.sandboxPolicy`)——它本身是被消费的接缝:`fs-sandbox`、`bash-sandbox`、`terminal-bash` 都 inject 它。策略不是散落的监听器,而是**一条被大家共享的服务**。

### ③ 教学点

1. **每条接缝 = 一个 Service 定义 + 一或多个 provider + 一或多个 consumer 工具**;定义件全部是"空壳 Service,零依赖",把一切留给 provider。
2. **Provider 两种挂法**:子类替换(真身唯一,冲突大声失败)vs 注册表共存(多后端并行)。
3. **接缝摞接缝**:依赖图有多层,底层一换,顶层全跟着走——e2b 是完整证明。
4. Consumer 的 inject 列表永远是 `['tools', 接缝键, 'systemPrompt']` 这类"工具+后端+提示词"组合——**inject 列表就是插件的角色自述**。

---

## 9. 启动/运行模式/宿主

核心认知:**"启动"和"运行模式"本身也是插件,没有特权代码。**

| 包 | 形态 | inject | 角色 |
|---|---|---|---|
| boot/app-boot | 函数 | — | 装配入口:读 profile/bundle 的 cordis.yml,用 vendored loader 拼出插件树 |
| boot/cmdline | 函数 | — | 提供 `ctx.cmdlineArgs`(命令行参数)与 `ctx.appExit`(请求退出)——宿主钩子 |
| bundle/headless | 函数×3 | 见下 | 一次性运行模式:runner + startup + invariant **三个插件装一个包** |
| acp/acp | 函数 | `['agents']` | 整个 ACP 自动化协议服务器 = agents 登记处的一个消费者 |
| host/webserver | Service | — | `ctx.webServer` HTTP 服务 |
| host/frontend-static | 函数 | `['webServer']` | 静态前端文件服务——**webserver 接缝的消费者** |
| host/directory-picker | Service | — | 目录选择服务 |
| host/plugin-inventory | TypertRemoteService | `['loader']` | 插件清单:消费 **Cordis 自己的 loader 服务**做自省 |
| host/apiproxy | Service | — | API 代理 |

### 9.1 "运行模式"= 一个 bundle

**用途一句话**:headless-startup 从命令行参数读任务文本;headless-runner 建 agent、提交任务、等安静、打印最后回复、请求退出;headless-invariant 登记该模式自己的运行时不变量。

web 模式 = base + webserver + frontend-static + 浏览器客户端插件;headless 模式 = base + 三个小插件:

- `headless-startup`(inject `['cmdlineArgs']`)——从命令行读位置参数当任务文本;
- `headless-runner`(inject `['agentDefaultModel','agents','sessions']`)——**等三个服务齐 → 建一个 agent → 把任务作为普通用户消息提交 → 等安静 → 把最后一条回复写 stdout → 调 `ctx.appExit` 退出**;
- `headless-invariant`(inject `['invariants']`)——登记自己的运行时不变量。

没有主程序、没有 main 里的 if-else 分支——**"无界面模式"就是三个普通插件**。

### 9.2 自引用:插件消费 Cordis 自身

**用途一句话**:plugin-inventory 是 Cordis Loader 插件状态的只读远程投影——插件系统反过来观察"哪些插件挂着",喂给 Web 的插件管理页。

plugin-inventory 的 inject 是 `['loader']`——loader 是 **Cordis(地基框架)自己的服务**。插件系统反过来观察"哪些插件挂着",喂给 UI 的插件管理页。地基的内部状态也走同一条公告板规则。

### 9.3 协议服务器都是 agents 的消费者

**用途一句话**:acp 是自动化专用的 ACP 协议服务器;sdk/server 是 stdio JSON-RPC 服务器(Python/TS SDK 的对端)——两个完整协议服务器的核心依赖都只有 agents 登记处。

ACP(inject `['agents']`)、sdk/server(inject `['agents']`)——两个完整的对外协议服务器,核心依赖都只有"agent 登记处"。**接入协议是壳,agent 世界是核**,与 headless-runner 共用同一根脊柱。

---

## 10. 外部集成

| 包 | 形态 | inject | 机制 |
|---|---|---|---|
| mcp/mcp-client | 函数 | `['tools']` | **整个 MCP 生态坍缩成一个插件**:连外部 MCP server,把它的工具注册到 `ctx.tools` |
| hooks/hook-protocol | **库** | — | Claude Code/Codex hook 的线协议解析,无生命周期 |
| hooks/hooks-claude-code | 函数 | `['shell']` | 订阅 5 个事件→翻译成外部 hook 命令→经 shell 接缝执行 |
| hooks/hooks-codex | 函数 | `['shell']` | 同上,Codex 版 |
| sdk/protocol | **库** | — | JSON-RPC 协议类型定义 |
| sdk/server | 函数 | `['agents']` | JSON-RPC 服务器(Python SDK 的对端) |

### 10.1 集成的两个方向

**用途一句话**:mcp-client 连接外部 MCP server 并把它的工具注册到 `ctx.tools`;hooks-claude-code / hooks-codex 把内部事件翻译成外部 hook 命令——一个把外面的东西拉进来,一个把里面的事件推出去。

- **拉进来(mcp-client)**:外部世界的工具,经一个插件进入 `ctx.tools`——对模型来说与原生工具无区别(工具目录里 MCP 工具就是原始 JSON Schema);
- **推出去(hooks-*)**:内部事件翻译给外部命令。hooks-claude-code 订阅 `agent/session-start`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping` **五个事件**,每个都映射为一次外部 hook 进程调用(经 shell 接缝),detached 的 hook 运行用 `ctx.effect` 登记清理——**桥 = 事件订阅 + 接缝调用**,没有一个新机制。

### 10.2 "线上的东西"是库

**用途一句话**:hook-protocol 是 Claude Code / Codex hook 线协议共享库(matcher 引擎、stdin/exit-code/stdout 编解码、多 hook 合并);sdk/protocol 是 JSON-RPC 线协议类型——都是纯库,不是插件。

hook-protocol、sdk/protocol 都不是插件——协议解析/类型定义没有生命周期,谁用谁 import。**插件/库的分界线在这里再次清晰:有挂载与卸载才配当插件。**

---

## 结语:全仓库一张图

10 个分类、约 90 个主机插件,挂载形态总共只有**六种**:

| # | 形态 | 典型 |
|---|---|---|---|
| 1 | Service 定义件(空壳占键) | fs、shell、llm、tools、session |
| 2 | Service 子类替换 provider | fs-local、bash-local、jsonl 持久化 |
| 3 | 注册进注册表的 provider | llm-deepseek、web-search-*、storage-json |
| 4 | 消费型函数插件(tools/commands) | tool-bash、tool-todo、command-feedback |
| 5 | 事件监听型(policy/injector/bridge) | timeout-policy、time-context、hooks-claude-code |
| 6 | 纯库(不是插件) | scope、typert-protocol、sdk/protocol、hook-protocol |

贯穿全部的纪律:**注册即副作用(一律有 disposer)、策略走事件不走核心、状态进账本(可回放)、inject 列表即角色自述、冲突大声失败。**

一句话总结:**Cordis 提供"插座与电线",dsh 用六种标准姿势把 ~90 个插件插上去;所有差异化能力(工具、provider、策略、协议、运行模式)都是插件,没有一处特权代码。**
