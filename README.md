# dsh-session-cost

在 DSH（DeepSeek Harness）Web / 桌面端的**输入框状态栏**里，精确显示**当前会话累计花了多少钱**。

它长在「`3 轮 16 步 · 269 tok/s`」「`364K tok · 缓存命中 93%`」那一排的**最左边**，
样式和内置胶囊完全一致（同一套主题变量、同样的字号 / 圆角 / 内边距），深浅色主题都跟邻居对齐。

```
 ¥0.42    ⏱ 3 轮 16 步 · 269 tok/s    ⛁ 364K tok · 缓存命中 93%    ◯ 5%
└─ 本插件
```

## 为什么是「精确」而不是估算

DSH 自己**不记钱**，只记提供方回报的 token。所以金额是算出来的，但算法是精确的：

**每一次请求，按它自己发生的那一刻的时段价、用它自己用的那个模型，分别计费**，然后累加。
不是「把整个会话的总 token 乘当前价格」——那样跨了峰谷就会错。

具体地，宿主半边折叠会话自己的日志（DSH 已经把它写下来了）：

| 事件 | 作用 |
|---|---|
| `request/header` | 记住这次请求的**模型**和**发起时刻** |
| `assistant/message` / `assistant/attempt` | 用上面记住的模型与时刻，给这次用量计价 |
| `llm/retry-started` | 重新开槽——重试是**另一次计费请求**，两次都要算 |
| 同一 `(turn, step)` 再次出现 | **替换**前一条而不是累加，与 DSH 自己的 `tokenUsage` 折叠语义一致 |

因此它同时做对了这几件事：

- **峰谷按请求各自判定**：一个会话里上午一次、晚上一次，两次分别按高峰 / 空闲价计费。
- **换模型跟着变**：中途从 Flash 切到 Pro，前一次仍按 Flash、后一次按 Pro。
- **法定节假日**（2026 年安排）全天按空闲价；周末同理。
- **缓存写入**按未命中价计（与提供方「缓存未命中」计费一致）。
- **金额用整数微元累加**，几万次请求也不会出现浮点漂移。

它不缓存也不持久化任何账目：每次被问就把会话日志重算一遍，所以刷新页面、重开会话、重启应用、
甚至打开一个很久以前的会话，算出来都一样。

数据通路很直白：宿主注册一个只读路由 `/dsh-session-cost/cost.json?session=<会话 id>`，
浏览器半边每秒取一次并显示（和余额挂件同一套做法）。

鼠标悬停在胶囊上会显示：`已计费请求 N 次` 与口径说明。

## 安装

> ⚠️ **不要填裸包名 `dsh-session-cost`。** npm 上已有一个**同名的第三方包**
> （`github.com/ChengChe106/dsh-session-cost`，最新 `0.1.3`），填裸包名装到的是**它**，不是本仓库；
> 两个包的 patch 行 id、价格表（flash 输出价 4.5/9 对官方的 4/9，偏高）和计费口径都不同，
> 装错之后「有胶囊但数字不对」或「装完没有任何反应」都由此而来。
> 本仓库唯一正确的安装源是 **仓库地址** 或 **本地目录**（两种都写在下面）。

**A. 仓库地址（推荐，朋友之间直接发这一行）**

1. DSH → 左侧边栏 **「插件」** → **「添加插件」**。
2. **「包名或地址」** 填：

   ```
   github:ZhaoCang-QWQ/dsh-session-cost
   ```

3. **「安装」** → **「立即启用」** → **完全退出 DSH 再打开一次**。

**B. 本地目录（离线 / 自己改动过）**

1. 把 `dsh-session-cost` 目录放到本机任意位置（例如 `D:\Plugins\dsh-session-cost`）；**路径不要带空格**。
2. **「添加插件」** → **「包名或地址」** 粘这个目录的绝对路径：

   ```
   D:\Plugins\dsh-session-cost
   ```

3. **「安装」** → **「立即启用」** → **完全退出 DSH 再打开一次**。

> 第一次装完要重启一次：浏览器半边刷新页面就能加载，但宿主半边（负责算钱与那条约只读路由）是随 profile 组合加载的，需要重启进程。之后改价目表同理。

**卸载**：同一个「插件」页面里点卸载。

## 需要你维护的两样东西

都在 [`index.js`](index.js) 顶部，是唯一可能过期的输入：

1. **价目表** `PRICING` —— 单位「元 / 百万 token」，格式 `[空闲价, 高峰价]`。
   官方调价后改这里（[官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）。
2. **法定节假日** `HOLIDAY_VALLEY` —— 目前是 **2026 年**的安排。
   国务院公布下一年安排后要补，否则那一年的节假日会被按高峰价多算。漏了只会多算，不会少算。

## 已知限制

- **子代理是独立会话**，各自计各自的；本胶囊只统计当前会话自身发出的请求。
- 认不出的模型（第三方路由）退回 Flash 价目。
- 如果宿主半边没加载起来（例如装完没重启），路由不存在，胶囊**什么都不显示**——
  它不会退回去显示一个不准的数字。顺手可查：浏览器打开
  `http://127.0.0.1:19387/dsh-session-cost/cost.json?session=<会话 id>`，正常应返回
  `{"ok":true,"cost":…,"requests":…}`。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | 挂载声明，把本插件插进 profile 配置树 |
| `index.js` | **宿主半边**：价目 / 节假日 / 折叠会话日志 + 只读 HTTP 路由 |
| `client.js` | **浏览器半边**：注册到 `conversation.composer.dock`（`order: -10`），每秒取数并渲染胶囊 |

宿主半边只读 DSH 已经写下来的会话日志，不联网、不读凭据、不请求任何外部接口；
浏览器半边除了这个本地路由之外也不请求任何东西。

## 分发方式

| 渠道 | 填什么 | 状态 |
|---|---|---|
| **GitHub（推荐）** | `github:ZhaoCang-QWQ/dsh-session-cost` | ✅ 已验证可装 |
| **本地目录** | 目录绝对路径（不带空格） | ✅ 已验证可装 |
| **tarball** | `npm pack` 产出的 `.tgz` 路径 | ✅ 已验证可装 |
| **npm 包名** | `dsh-session-cost` | ⛔ 不可用，装到的是别人的包 |

**npm 为什么不能发**：`dsh-session-cost` 这个包名已被第三方 `ChengChe106` 占用
（npm 上最新 `0.1.3`，2026 年发布）。直接 `npm publish` 会被拒（403），而用户填裸包名装到的是他那份。
要用 npm 分发，先改名 —— 三处必须一起改：

1. `package.json` 的 `name`
2. `client.js` 里 `window.__ModuleLoader__.load({ id })` 的 `id`（**必须等于新包名**，模块表以包名为 key）
3. `cordis.patch.yml` 里那一行的 `name`

改完本地已装的那份要卸载重装（profile 里记的是旧名）。

### 让对方自己装（可直接粘贴给他）

```
帮我装一个插件：dsh-session-cost，作用是显示本会话花了多少钱。
安装源：github:ZhaoCang-QWQ/dsh-session-cost
请用内置的 plugin_manager 工具装进当前 profile 并启用。
不要用 dsh plugin 命令行（它按设计拒绝操作 desktop profile）；
如果 plugin_manager 不可用（那是 Creator 模式才启用），别去手改 profile 文件，先告诉我怎么切换。
装完告诉我需不需要重启 —— 算钱的那半边随启动加载，通常要完全退出 DSH 再打开。
```

## 兼容性

在 DSH `0.2.0-rc.2` 上开发，在 `0.2.2-rc.1` 上实测通过（本地目录 / tarball / `github:` 三种装法均验证：
配置组合出 `- id: dsh-session-cost` 行、`__DSH_BOOT__` 里有对应 row、`/plugins/??dsh-session-cost/client.js`
返回 200、`/dsh-session-cost/cost.json` 返回 200）。依赖这些接口：

- 插槽 `conversation.composer.dock`（`kind: 'list'`、`scope: 'session'`、按 `order` 升序渲染，标准 props 含 `sessionId`）
- 宿主服务 `ctx.webServer.register({ kind: 'exact', path, handler })`
- 会话对象 `ctx.on('session/created' | 'session/event' | 'session/disposed')`、`session.seq`、`session.snapshotEvents()`
- locale 服务 `ctx.locale.register(ns, { zh, en })`
- 客户端模块 `dsh.client`（`platform: 'web'`、`immediately`、`inject`）与 `exports['./client']`

**已知接口债**：`session.snapshotEvents()` 在 `0.2.2` 的官方文档里已被标注
`@deprecated`（"new calls are prohibited"），目前仍可用、本插件功能正常；
官方替代接口（分段读取 / projection）落地后这里要迁移一次，否则某个版本会静默返回 `{"ok":false}`
—— 那就表现为「胶囊消失」，不会显示错数字。

DSH 若改动其中任一接口，插件需要跟着改。
