# dsh-task-center-task-local

**用途一句话**:任务账本的落盘 Provider——在 dsh storage domain 上开 `task` 域,把接缝的内存账本换成持久实现。

函数插件(形态 3):inject `['tasks','storageDomain']`。后端路由(storage-domain 插件的 `backend`/`routes` 配置)不属于本包;json/sqlite 由组装层决定。

## 组成

- `src/spec.ts`:`taskDomainSpec`(zod 校验持久信封;mutation 与视图语义由 `foldTasks` 在加载时复核)
- `src/store.ts`:`DomainTaskStore`——定宽序列号作 KV 键即流序;每次 append 走域的耐久链后才 resolve
- `src/index.ts`:开域、`ctx.tasks.use(store)` 挂载、dispose 时还原

## 持久格式

`task` 域 version 1,一张 `events` 表;预发布阶段不承诺兼容,域版本不符即拒绝打开(测试覆盖)。

## Known Limitations and Deferred Work

- 事件 `eventId` 在 append 时分配(UUID);`taskId+revision` 才是回放定位用的稳定坐标。
- 跨设备同步(P2)将引入可替换的远程后端,路由仍由 storage-domain 配置决定。
