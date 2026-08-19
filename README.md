# websearch-plugins

个人用的 **DeepSeek Harness** 搜索插件包：不依赖任何 API Key 的**聚合搜索** + **目标网址直接抓取**，
用于 harness 的 web 能力接缝（`ctx.web`）。注册后 `web_search` 与 `web_fetch` 工具在
没有 `DEEPSEEK_API_KEY` 的环境里也能真实可用。

## 基座思路：PhantomJS 式无头抓取

基座是 [phantomjs](https://github.com/asdshuaishuai/phantomjs) 的无头抓取思想——
“可脚本化的无头浏览器”，不渲染 GUI、不依赖浏览器，直接用代码去拿网页数据给 **agent** 用。
这里把同一思路在 Node 里实现成 **全方面适配** 的聚合搜索：不针对某一台机器/某个网络，而是
把国内 + 海外的引擎全部配上；谁通谁用，网络异常/被墙/验证码/空结果的引擎直接在**结果层过滤**。

## 引擎清单（16 个，全部注册、按需过滤）

| 区域 | 引擎（provider id = `phantom-<id>`） |
|---|---|
| 国内 domestic | `baidu` 百度、`sogou` 搜狗、`so360` 360搜索、`smcn` 神马、`bingcn` 必应中国 |
| 海外 overseas | `bing` 必应国际、`google`、`duckduckgo`、`brave`、`mojeek`、`qwant`、`ecosia`、`yahoo`、`yandex`、`startpage`、`searx`（SearXNG searx.be） |

每个引擎既可单独用（`phantom-<id>`），也默认全部汇入聚合 `phantom-aggregate`。
某引擎在当前机器上不通（超时/403/JS验证/解析空）时，聚合自动把它过滤掉，绝不影响整体结果。

## 三个 provider

- **`phantom-aggregate`**（`web_search` 默认选中）：16 个引擎并行 fan-out，能通就收，
  留在结果层的只有成功项——失败/超时/被墙/空结果的引擎被过滤并把原因写进摘要；
  跨引擎按 URL 归一化去重（同一条目优先保留带摘要的），轮询交错排序让 top-N 覆盖多个引擎，
  按 `maxResults` 封顶。
- **`phantom-<engine>`**：16 个单引擎 provider，可单独指定。
- **`phantom-http`**（`web_fetch`）：直接抓取目标网址。手工逐跳处理重定向，每跳做
  **SSRF 防护**（拒绝环回/私网/链路本地/CGNAT/保留地址，域名先解析再校验）；
  非 2xx 视为结果而非错误；HTML 上限 1MB / 文本 512KB，超出截断并置 `truncated`。

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

零外部运行时依赖（Node 内建 `fetch`/`node:net`/`node:dns`）；`@deepseek-ai/dsh-web`
通过包内 `node_modules -> ~/.dsh/profiles/node_modules` 符号链接解析。

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

## 自检

```sh
node test/engines.mjs             # 16 引擎连通性矩阵（不通属正常，聚合会过滤）
node test/aggregate.mjs "query"   # 直接跑聚合，看过滤/去重/摘要
node test/plugin.mjs "query"      # 模拟 seam：聚合 + web_fetch + SSRF 防护
```
