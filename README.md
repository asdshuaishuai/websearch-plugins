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
                 ├─ 并行 fan-out：16 个 SerpSearchProvider（各自 fetch + 解析，互不阻塞）
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
  package.json            # 私有 ESM 包，主入口 lib/index.js
  lib/
    index.js              # Cordis 插件：name / inject(['web']) / apply()，注册全部 provider
    net.js                # 共享网络层 + 文本/URL工具 + SSRF 防护
    engines.js            # 16 个引擎的 URL 构造 + 解析器（失败回落通用 h3 锚点）
    search.js             # 单引擎 provider + 聚合 provider（并行/过滤/去重/交错）
    fetch.js              # web_fetch 的目标网址抓取 provider
    types/index.d.ts
  test/
    engines.mjs           # 引擎连通性巡检矩阵
    aggregate.mjs         # 直接跑聚合 provider
    plugin.mjs            # 模拟 ctx.web 注册表：聚合搜索 + fetch + SSRF 验证
  README.md LICENSE
```

## 接入方式

1. 软链到 harness 共享 fallback，让 loader 能按名解析：

   ```sh
   ln -s /home/kelthas/code/websearch/websearch-plugins ~/.dsh/profiles/node_modules/websearch-plugins
   ```

2. `~/.dsh/profiles/web/cordis.patch.yml`：

   ```yaml
   - insert:
       - id: web-search-phantom
         name: websearch-plugins
         config: {}
   # web 接缝选中聚合搜索，并挂上直接抓取 provider
   - id: web
     config:
       searchProvider: phantom-aggregate
       fetchProvider: phantom-http
   # base 默认禁用 web_fetch，这里打开（保留 base 的搜索预算）
   - id: tool-web
     config:
       fetch: true
       searchTimeoutMs: 60000
   ```

3. 重启 GUI（在启动 `dsh web` 的终端里 Ctrl+C 后重新运行），刷新页面。

> 想切回 DeepSeek 官方搜索：把 `searchProvider` 改回 `deepseek-official` 即可（deepseek
> provider 从未被删除）。

## 配置

`web-search-phantom` 行 `config:` 里全部可选：

```yaml
config:
  engineCount: 5            # 聚合时每个引擎取的条数（默认 5）
  aggregateMaxResults: 10   # 无 maxResults 时的总条数上限
  engineTimeoutMs: 7000     # 每个引擎的默认超时（毫秒）；通不了的引擎按此快速过滤
  include: [baidu, bing, google]   # 只聚合这些引擎（默认全部）
  blockedHosts: [...]              # 额外过滤的域名
  engines:                  # 单引擎覆盖
    bing:    { count: 8, timeoutMs: 5000 }
    baidu:   { count: 5 }
  userAgent: "Mozilla/5.0 ..."
  fetch:                    # web_fetch
    timeoutMs: 15000
    maxBytesHtml: 1048576
    maxBytesText: 524288
    maxRedirects: 5
```

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
node test/engines.mjs             # 16 引擎连通性矩阵（不通属正常，聚合会过滤）
node test/aggregate.mjs "query"   # 直接跑聚合，看过滤/去重/摘要
node test/plugin.mjs "query"      # 模拟 seam：聚合 + web_fetch + SSRF 防护
```
