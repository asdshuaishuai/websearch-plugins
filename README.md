# websearch-plugins

个人用的 **DeepSeek Harness** 搜索插件包：**聚合搜索**（16 个国内+海外引擎，结果层过滤）+
**目标网址直接抓取**，全部**不依赖任何 API Key**。注册后 `web_search` / `web_fetch` 工具在
没有 `DEEPSEEK_API_KEY` 的环境里也能真实可用。

## 基座思路：PhantomJS 式无头抓取

基座是最上游的 [ariya/phantomjs](https://github.com/ariya/phantomjs)（**BSD-3-Clause**）的无头抓取
思想——“scriptable headless browser”：不渲染 GUI、不依赖浏览器，直接用代码把网页数据拿给 **agent** 用。
（本地基座素材来自我的 fork [asdshuaishuai/phantomjs](https://github.com/asdshuaishuai/phantomjs)，
与上游是同一份源码。）这里把同一哲学在 Node 里落地为 **全方面适配** 的聚合搜索：不针对某台机器/某个网络，
而是把国内 + 海外的引擎全部配上；谁通谁用，网络异常/被墙/验证码/空结果的引擎直接在**结果层过滤**。

## 引擎清单（16 个，全部注册、按需过滤）

| 区域 | 引擎（provider id = `phantom-<id>`） |
|---|---|
| 国内 domestic | `baidu` 百度、`sogou` 搜狗、`so360` 360搜索、`smcn` 神马、`bingcn` 必应中国 |
| 海外 overseas | `bing` 必应国际、`google`、`duckduckgo`、`brave`、`mojeek`、`qwant`、`ecosia`、`yahoo`、`yandex`、`startpage`、`searx`（SearXNG searx.be） |

每个引擎既可单独用（`phantom-<id>`），也默认全部汇入聚合 `phantom-aggregate`。

## 三个 provider

- **`phantom-aggregate`**（`web_search` 默认选中）：16 个引擎并行 fan-out，能通就收，
  留在结果层的只有成功项——失败/超时/被墙/空结果的引擎被过滤并把原因写进摘要；
  跨引擎按 URL 归一化去重（同一条目优先保留带摘要的），轮询交错排序让 top-N 覆盖多个引擎，
  按 `maxResults` 封顶。
- **`phantom-<engine>`**：16 个单引擎 provider，可单独指定。
- **`phantom-http`**（`web_fetch`）：直接抓取目标网址。手工逐跳处理重定向，每跳做
  **SSRF 防护**（拒绝环回/私网/链路本地/CGNAT/保留地址，域名先解析再校验）；
  非 2xx 视为结果而非错误；HTML 上限 1MB / 文本 512KB，超出截断并置 `truncated`。

## 实现原理

### 一条搜索请求怎么走

```
模型调用 web_search(query)
  └─ dsh-tool-web 工具 → ctx.web.search({query, maxResults})     ← harness 的 web 接缝
       └─ seam 按 web.searchProvider 选中 phantom-aggregate
            └─ AggregateSearchProvider.search()
                 ├─ 并行 fan-out：16 个 SerpSearchProvider（各自抓取 + 解析，互不阻塞）
                 │    ├─ 抓取层 = 浏览器式无头请求（见“关键设计”）
                 │    │    ├─ HTTP 主路：Chrome 桌面级完整标头 + cookie jar
                 │    │    └─ JS 壳/反爬页 → 专为本插件常驻的极简无头 Blink 渲染服务（CDP）渲染再解析
                 ├─ Promise.allSettled → 结果层过滤
                 │    ├─ rejected（超时/403/被墙/网络错误）→ 丢弃，计入“已过滤异常”
                 │    └─ fulfilled 但解析为空 → 丢弃，计入“已过滤无结果”
                 ├─ 跨引擎去重（URL 归一化）+ 轮询交错
                 └─ 按 maxResults 封顶 → WebSearchResult{ sources, content(聚合摘要) }
```

### 关键设计

- **能力接缝，不是工具**：插件只做 `ctx.web.registerSearchProvider({id, available(), search()})`。
  面向模型的 `web_search` 名称/描述/schema/呈现全部由 `dsh-tool-web` 拥有；provider 一行都不肖
  写进模型。`available()` 是廉价本地检查（无网络 IO）。
- **为什么是“结果层过滤”**：聚合的输入是“16 个引擎全上”= 通用适配（不针对本地）；输出层把
  不通的引擎滤掉 = 结果层过滤。所以这台机器通不了 Google/DDG 也不影响聚合结果，换到出口更宽的
  网络它们会自动开始贡献。
- **浏览器式无头请求层（PhantomJS 的法子）**：对端网站要看到的是一个真实浏览器——
  - 请求默认带完整 Chrome 桌面级标头（`sec-ch-ua`/`sec-fetch-*`/`upgrade-insecure-requests`/`accept-language` 等），
    而不是裸库 UA；
  - 进程内按域名维护 **cookie jar**，首次访问种下的 `BAIDUID`/`MUID` 之类延续到后续搜索，
    像浏览器会话一样；
  - 当返回体是 JS 壳/反爬页（无结果标记却有 `captcha/x5sec/are you not a robot` 等标记）时，
    `fetchMode: auto` 会把 URL 交给一个**专为本插件服务的常驻极简无头浏览器**：只起一次的
    Blink(Chromium) 无头进程，开标签→导航→等 `readyState=complete`→取 `outerHTML`→关页，
    全程走 CDP（内置 `WebSocket`，零依赖），跨搜索复用；没有完整浏览器时再回落
    `--headless=new --dump-dom` 一次性渲染。这就是上游 PhantomJS 那句 “scriptable headless
    browser”。对 IP 层风控（本机把 Shenma/Yandex/Mojeek 判断为自动查询）无头浏览器也过不去，
    结果层照样过滤；换到放行的网络/IP 上，这类 JS 壳引擎会自动被常驻渲染器解锁。
  - 每引擎的 Chrome 兜底带**负缓存**（连续失败 2 次本进程内不再试），避免被风控的引擎每次都白等几秒。
- **单引擎解析是 best-effort**：每个引擎一个轻量正则解析器（提取结果 URL/标题/摘要）；某引擎的
  专属选择器解析不到时自动回落通用 `<h3>` 锚点扫描；源头标记质量差（如百度/360 把结果包在
  `baidu.com/link`、`so.com/link` 跳转里）是引擎自身行为，不是插件缺陷。
- **fetch 的 SSRF 防护**：`web_fetch` 用手工逐跳跟随重定向，每一跳先把域名/字面 IP
  解析并校验——环回(127.0.0.0/8, ::1)、私网(10/8, 172.16/12, 192.168/16)、链路本地
  (169.254/16, fe80::/10)、CGNAT(100.64/10)、保留/组播地址一律拒绝，才发请求。
- **错误分类**：调用方取消 → `WEB_ABORTED`；单引擎超时/HTTP 失败 → `WEB_PROVIDER_ERROR`
  （聚合层整体捕获并过滤，不打断整次搜索）；`web_fetch` 抓非公网目标 → `WEB_PROVIDER_ERROR`。
- **零外部运行时依赖**：只用 Node 内建 `fetch` / `node:net` / `node:dns`；
  `@deepseek-ai/dsh-web` 的 `WebError` 通过包内 `node_modules -> ~/.dsh/profiles/node_modules`
  符号链接解析（与 harness 的 shared-module fallback 一致）。

## 结构

```
websearch-plugins/
  package.json            # 标准 DSH 插件声明：dsh.bundle.patch / exports / keywords / repository
  cordis.patch.yml        # 插件自带的 bundle 层：注册 + 选中聚合 + 挂 fetch + 打开 web_fetch
  lib/
    index.js              # Cordis 插件：name / inject(['web']) / apply()，注册全部 provider
    net.js                # 共享网络层（浏览器式标头 + cookie jar）+ 文本/URL工具 + SSRF 防护
    engines.js            # 16 个引擎的 URL 构造 + 解析器（失败回落通用 h3 锚点）+ JS 壳判定
    chrome.js             # 一次性无头 Chrome(--headless --dump-dom)渲染后端（兜底）
    headless.js           # 专为本插件的常驻极简无头 Blink 渲染服务（单例进程 + CDP，零依赖）
    search.js             # 单引擎 provider（HTTP/auto/Chrome）+ 聚合 provider
    fetch.js              # web_fetch 的目标网址抓取 provider
    types/index.d.ts
  test/
    engines.mjs           # 引擎连通性巡检矩阵（HTTP/auto/chrome 三档）
    diagnose.mjs          # 失败归因：网络 vs 风控/JS壳 vs 解析空
    aggregate.mjs         # 直接跑聚合 provider
    headless.mjs          # 常驻无头渲染服务：JS 执行 + 渲染 + 复用提速
    plugin.mjs            # 模拟 ctx.web 注册表：聚合搜索 + fetch + SSRF 验证
  README.md LICENSE
```

## 接入方式（标准 DSH 插件）

本包是一个**标准 DSH 插件**：`package.json` 声明了 `dsh.bundle.patch`（自带
`cordis.patch.yml` 层），因此可用 `dsh plugin` 直接装成 profile bundle，**不用手工改 profile 补丁**
（注册 provider、选中 `phantom-aggregate`、挂 `phantom-http`、打开 `web_fetch` 全部由插件自带层完成）。

本地安装：

```sh
dsh plugin --profile web add file:/home/kelthas/code/websearch/websearch-plugins
```

从 GitHub 安装（最上游发布源）：

```sh
dsh plugin --profile web add github:asdshuaishuai/websearch-plugins
```

`dsh plugin` 会把它加进 `dsh.profile.bundles`，之后**重启 GUI**（在启动 `dsh web` 的终端里
Ctrl+C 后重新运行）并刷新页面即生效。

**旧方式（手动）**——仅当不便 `dsh plugin` 时可选：软链
`~/.dsh/profiles/node_modules/websearch-plugins` → 本目录，并手工在
`~/.dsh/profiles/web/cordis.patch.yml` 写 `insert: [web-search-phantom]` +
`web.searchProvider/fetchProvider` + `tool-web.fetch` 三处。装了标准 bundle 后不要再叠加手工条目，
避免重复 id。

> 想切回 DeepSeek 官方搜索：把 profile 补丁（或本包 `cordis.patch.yml` 里的）
> `web.searchProvider` 改回 `deepseek-official` 即可（deepseek provider 从未被删除）。

## 仓库 topic（供 dshmk 插件市场收录）

本仓库声明了 `dsh-plugin`（[dshmk.com 的 DSH 插件市场](https://www.dshmk.com/)正是按此 topic
自动收录 GitHub 项目）以及 `deepseek-harness` / `web-search` / `headless-browser` / `phantomjs`。

## 配置

`web-search-phantom` 行 `config:` 里全部可选：

```yaml
config:
  engineCount: 5            # 聚合时每个引擎取的条数（默认 5）
  aggregateMaxResults: 10   # 无 maxResults 时的总条数上限
  engineTimeoutMs: 6000     # 每个引擎的默认超时（毫秒）；通不了的引擎按此快速过滤
  # 聚合“达标即回”：凑够 aggregateQuorum 个成功引擎（或结果数已够）且过了
  # aggregateMinWaitMs 就提前返回，不等最慢（往往不可达/被风控）的引擎
  aggregateQuorum: 3
  aggregateMinWaitMs: 800
  aggregateCacheMs: 30000   # 同 query 的短时缓存（毫秒，0=关闭；重复查询秒回）
  include: [baidu, bing, google]   # 只聚合这些引擎（默认全部）
  blockedHosts: [...]              # 额外过滤的域名
  fetchMode: auto           # http(纯浏览器式抓取) | chrome(恒走常驻无头渲染) | auto(HTTP优先,JS壳自动渲染兜底)
  chrome:                   # 常驻无头 Blink 渲染服务参数
    path: ""                # 留空自动探测（优先极简 headless-shell，其次 chrome/chromium）
    timeoutMs: 7000         # 单次渲染超时
    settleMs: 400           # 加载完成后再等 JS 出 markup 的缓冲
    virtualTime: 1500       # 一次性渲染兜底的 virtual-time 预算
    browserTimeoutMs: 12000 # 常驻浏览器启动超时
  engines:                  # 单引擎覆盖（可带 fetchMode）
    bing:    { count: 8, timeoutMs: 5000 }
    baidu:   { count: 5 }
    smcn:    { fetchMode: chrome }   # 例：神马强制无头渲染
  userAgent: "Mozilla/5.0 ..."
  fetch:                    # web_fetch
    timeoutMs: 15000
    maxBytesHtml: 1048576
    maxBytesText: 524288
    maxRedirects: 5
```

> 失败归因速查：**网络不通**（Google/DDG/Brave/Qwant/Yahoo/Startpage/SearXNG 在本机超时）
> 属出口环境问题，暂不处理；**IP 层风控**（神马/Yandex 验证码、Mojeek 403）连真无头浏览器都过不去，
> 结果层自动过滤；换到放行网络它们才会上。解析器对各引擎真模板均可用。

## 错误与取消

- 调用方取消 → `WebError` `WEB_ABORTED`
- 单引擎超时/HTTP 失败 → 各自 `WEB_PROVIDER_ERROR`；聚合层全部捕获并过滤，不抛错
- `web_fetch` 抓私网/环回/链路本地目标 → `WEB_PROVIDER_ERROR`（SSRF 防护）
- 所有 provider 均 honor `AbortSignal`；`available()` 为廉价本地检查（无网络 IO）

## 致谢

感谢最上游的 PhantomJS 项目 **[ariya/phantomjs](https://github.com/ariya/phantomjs)**
（**BSD-3-Clause**，已归档）：本项目只借用了它“scriptable headless browser / 用脚本直接取网页数据”
的思路，**未复制其代码**；这里把同一哲学在 Node 中实现为聚合搜索与直接抓取。
同时感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 web 能力接缝
（`@deepseek-ai/dsh-web` 定义 `ctx.web`，`dsh-tool-web` 承载面向模型的工具；provider 写法参考了
`@deepseek-ai/dsh-web-search-deepseek`）。本项目代码为原创，LICENSE 采用 MIT。

## 自检

```sh
node test/engines.mjs               # 引擎连通性矩阵（http；传 auto/chrome 可测无头兜底）
node test/diagnose.mjs              # 失败归因：网络不通 vs 风控/JS壳 vs 解析
node test/aggregate.mjs "query"     # 直接跑聚合，看过滤/去重/摘要
node test/headless.mjs              # 常驻无头渲染服务：JS 执行 + 渲染 + 复用提速
node test/plugin.mjs "query"        # 模拟 seam：聚合 + web_fetch + SSRF 防护
```

## 继续迭代（维护指南）

- **加引擎**：在 `lib/engines.js` 的 `ENGINES` 数组加一个 `engine(id, region, label, buildUrl, parse)`，
  解析器 Share 通用 `<h3>` 回落，无需改别处；聚合/单引擎/过滤自动生效。
- **调优某引擎**：profile 补丁 `web-search-phantom.config.engines.<id>` 里给 `count/timeoutMs/fetchMode`，
  或全局 `fetchMode` / `chrome` / `engineTimeoutMs`。
- **改配置形状**：动了 `index.js` 的 `DEFAULT_CONFIG` 后同步 `lib/types/index.d.ts`。
- **回归**：跑上面 `自检` 一节全部脚本再提交。
- **发布新版本**：`git tag vX.Y.Z && git push origin vX.Y.Z`，再 `gh release create vX.Y.Z`；
  标准 bundle 安装方（`dsh plugin add github:...`）会拿到新版本。仓库保持 `dsh-plugin` topic，
  dshmk 插件市场会自动收录/更新。
