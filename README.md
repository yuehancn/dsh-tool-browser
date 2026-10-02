# dsh-tool-browser

浏览器工具插件，给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用。

**打开页面、按页面真正需要的方式等待、抽出正文、截图。** Playwright 装了就用真浏览器，没装就退回静态抓取 —— 并且**明确说出来**，因为「JavaScript 从没跑过」会改变抽出来的文字意味着什么。

```
browser_status      先说清楚有没有真浏览器
browser_fetch       拿到 HTML
browser_extract     只拿到可读正文（纯文本 / Markdown）
browser_screenshot  用真浏览器截 PNG
```

Playwright 是**可选依赖**。没有它，三个工具里有两个照常工作，第三个（截图）会明确报错而不是给一张空图。

---

## 为什么值得单独做

三件事单独看都简单，连起来才是问题。

**第一，"等页面加载完"是四种等待共用一个名字。**

| 策略 | 等的是什么 |
|---|---|
| `domcontentloaded` | DOM 树建好 |
| `load` | 所有资源（图片、样式）到齐 |
| `networkidle` | 网络安静下来（500ms 无请求） |
| `selector` | **某一个元素**出现 |

选错就是「把加载动画当成内容返回」。而且这里有个反直觉的细节：**`selector` 不能同时用 `networkidle` 导航** —— 一个带轮询请求的页面永远等不到网络安静，而你要等的那个元素其实早就到了。所以代码里选 `selector` 时会把 `goto` 降到 `domcontentloaded`，真正的条件交给 `waitForSelector`：

```js
await page.goto(url, {
  waitUntil: wait.strategy === "selector" ? "domcontentloaded" : wait.strategy,
  timeout: config.navTimeoutMs
});
if (wait.strategy === "selector") {
  await page.waitForSelector(wait.target, { timeout: config.navTimeoutMs });
}
```

**第二，"抽出正文"是最容易悄悄失败的一步。** 一个包着导航栏和 40 条页脚链接的 `<article>` 不是正文；靠猜 `<div>` 的嵌套层级也不是。这个插件按**正文密度**给候选子树打分，而不是相信标签名。

**第三，静默退回是最坏的失败方式。** 真浏览器挂了就悄悄用静态抓取，用户会以为拿到的是渲染后的页面。所以每个工具都返回 `engine` 和 `engineNote`：

```json
{ "engine": "static",
  "engineNote": "the browser failed (net::ERR_TIMED_OUT); the content below is what the server returned without running JavaScript." }
```

---

## 安装

```bash
dsh plugin add dsh-tool-browser
```

想用真浏览器，再装 Playwright：

```bash
npm install playwright
npx playwright install chromium
```

没装也能用，只是页面里的 JavaScript 不会执行。先跑 `browser_status` 确认当前是哪种情况。

```yaml
# cordis.patch.yml
plugins:
  dsh-tool-browser:
    workDir: "."
    outputDir: "browser-output"
    waitStrategy: domcontentloaded
```

---

## 抽取器是怎么选正文的

这是整个插件的核心，值得讲清楚。

### 打分的是**密度**，不是**体量**

第一版按「谁的总文字最多」选，结果**永远是 `<body>`**。原因是结构性的：任何页面的 `<body>` 都包含所有其他候选，所以「总文字最多」必然指向最外层元素 —— 连同导航栏和页脚一起返回，而这正是抽取器本该去掉的东西。

改成按**每个候选自己的文字密度**打分后，比较就被倒过来了：**容器 = 它最好的子节点 + 外围杂物，所以密度严格更低，它就输了。**

```js
const density = (1 - linkDensity) * 0.7      // 正文比例
              + paragraphDensity * 0.2        // 分段程度
              + punctuationDensity * 0.1;     // 标点密度
```

三项各管一件事：

- **正文比例** —— 不在链接里的文字占多少。200 条链接的站点地图可以很长，依然不是正文。
- **分段程度** —— 正文是成段的，链接农场不是。
- **标点密度** —— 句子有标点。这一项封了顶，免得一个超长页面靠体量压过比例。

这个改动之后，测试里那份夹具的 `<article>` 才终于赢过 `<body>`（149.5 vs 更低），导航栏、页脚链接农场、评论区一起消失。

### 剥杂物在打分**之前**

顺序不能反。`<nav>` `<footer>` `<aside>` `<script>` `<style>` 这些整体删除，**然后**才开始给候选打分 —— 否则一个塞满链接文字的导航栏会被当成正文参与评分。而扁平化必须放在最后，因为打分需要保留结构。

### 复数形式要认

类名在真实网页上**复数远多于单数**：`comments`、`links`、`related-articles`。第一版的提示词匹配只认单数，结果 `class="comments"`（最常见的评论区标记）完全没被惩罚 —— 这是测试逼出来的一个真实盲点。现在匹配器带一个可选的 `s`，同时保留词边界守卫，这样 `contest` 不会误伤 `content`、`adventure` 不会误伤 `ad`。

---

## HTML → Markdown 的三个细节

### 反引号按内容加宽

内容里本身有反引号时，外围栏必须更长，否则会提前闭合、把后面半句当正文漏出去：

```js
const longest = (text.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
const fence = "`".repeat(longest + 1);
```

### 顺序：代码在最里层

`<strong><code>x</code></strong>` 必须变成 `` **`x`** ``，不是 `` `**x**` `` —— 反引号会压制其他所有标记，代码必须包在最里面。

### 链接里的强调不能丢

链接分支必须**跑在强调分支之前**（那时 `href` 还能读），但这意味着它得自己处理内部标记。第一版用 `htmlToText` 扁平化标签文字，于是：

```html
<a href="/docs/rollback"><strong>only sanctioned path</strong></a>
```

变成了 `[only sanctioned path](/docs/rollback)` —— **粗体没了**。一个被加粗的警告变成了普通文字。修法是把强调转换抽成一个可复用的 `inlineEmphasis`，让链接分支也走它：

```
[**only sanctioned path**](/docs/rollback)
```

两个方向都在测试里钉了：`<a><strong>` 和 `<strong><a>`。

### 空标签的链接不能写成 `<url>`

`<a href="/x"></a>` 如果用 Markdown 的 `<url>` 写法，最后的通用标签清扫**分不清它和真正的闭合标签**，会整段删掉。所以用 `[](url)` —— 无歧义的 Markdown，能活过清扫。

---

## 一个被安全带出来的洞

`outputPath` 一开始就是 `path.resolve(dir, filename)`。看起来对，其实不是：

```js
resolve("/out", "C:/Windows/system32/evil.png")  // → "C:\Windows\system32\evil.png"
```

**`resolve` 会尊重绝对路径的第二个参数**，所以截图能写到配置目录之外。`../../` 穿越同理。修法是只取路径的**最后一段**，把盘符、前导斜杠和 `../` 一次丢掉：

```js
const segments = raw.replace(/\\/gu, "/").split("/").filter((p) => p !== "" && p !== "." && p !== "..");
const name = segments.length > 0 ? segments[segments.length - 1] : "";
```

**调用者选的是「文件名」，不是「位置」；位置是插件的事，永远是 `outputDir`。** 这一条在测试里钉了 8 种逃逸尝试。

---

## 三个工具

### `browser_status`

先问它。返回：有没有真浏览器、默认用哪个引擎、认识哪四种等待策略、输出目录在哪、当前默认值。

它**不发起任何请求、不启动浏览器** —— 「浏览器可用吗」这个检查不该比它守护的工作更贵。

### `browser_fetch`

拿到页面 HTML，可以顺手存盘。

| 参数 | 说明 |
|---|---|
| `url` | 必填，绝对 http(s) URL |
| `mode` | `auto`（默认，浏览器优先、失败退回）/ `browser`（必须是真浏览器）/ `static`（只要静态） |
| `waitStrategy` | 四种之一 |
| `waitForSelector` | CSS 选择器，隐含 `waitStrategy=selector` |
| `saveAs` | 存到 `outputDir` 下的这个文件名 |
| `maxChars` | 返回的 HTML 截断到这个长度 |

**`saveAs` 写的是完整页面**，即使返回值被 `maxChars` 截断过 —— 存盘的人要的是整页。

`mode` 是**承诺不是偏好**：说 `browser` 就一定给真浏览器，没有就报错，不会悄悄退回。配置里还有 `requireBrowser`，让 `auto` 也不许退回。

### `browser_extract`

只要正文。

| 参数 | 说明 |
|---|---|
| `url` | 必填 |
| `format` | `text`（默认）或 `markdown` |
| `keepLinks` | Markdown 里保留链接语法，默认 `true` |
| `includeLinks` | 附带返回整页链接表，默认 `false` |
| `maxChars` | 截断正文 |

返回里带 `selector`（选中了哪棵子树）和 `score`（它的密度得分），所以一个奇怪的答案可以被诊断，而不是盲目重跑。

**两个引擎必须对同一份文档抽出同一篇正文。** 测试里有一条断言专门钉这个：如果浏览器跑和静态跑结果不同，工具的输出就取决于「这台机器碰巧装没装浏览器」，那是最难查的一类 bug。

### `browser_screenshot`

真浏览器截 PNG。**没有静态兜底** —— 一张没人渲染过的页面截图，就是一张空文档的照片，返回它比失败更糟。

| 参数 | 说明 |
|---|---|
| `url` | 必填 |
| `filename` | 存到 `outputDir` 下的文件名，默认带时间戳 |
| `fullPage` | 整页还是只截视口，默认 `false` |
| `width` / `height` | 视口尺寸 |

---

## 一个框架规则：`required` 怎么写

`defineTool` 的 schema DSL 里，**`required` 是挂在单个属性上的布尔标记**，不是顶层的 `required: [...]` 数组：

```js
url: { type: "string", required: true }        // ✔ 这样写
required: ["url"]                              // ✘ 报错
```

自己写数组形式会在**插件加载时**直接抛 `JsonSchemaError: schema.required is not supported by the value schema DSL`。

框架编译后会把这些标记**上提成 `required: [...]` 数组**，放在每一个 object 层级（根、参数、嵌套对象都算）。所以读者看到的是数组、作者写的是标记。这个差别在本插件里踩了两次才彻底弄清：第一次以为「数组到处都不许」，第二次才发现是「数组不许自己写，但框架会自己生成」。

数组的 `items` 例外：**永远不带 `required` 数组**，因为 `allowRequired` 在 `items` 和 `oneOf` 分支上都是关掉的。

配套的另一条（系列里已经踩过三次）：**每个嵌套 `{type:"object"}` 都必须显式声明 `additionalProperties`**，数组的 `items` 也算嵌套对象。

---

## 依赖注入的坑：读对象，不要读字段

这个插件支持注入三样东西用于测试：`fetchImpl`、`playwrightLoader`、`playwrightModule`。它们挂在一个共享对象 `ctx.transport` 上。

第一版在 `apply` 里这么写：

```js
const transport = ctx.transport ?? {};
const fetchImpl = transport.fetchImpl ?? undefined;   // ← 快照，错在这
```

**对象是共享的，但字段被快照成了 `undefined`。** 测试之后再往 `transport` 上装假 fetch，工具读到的还是当初那个 `undefined`，于是**静默走真网络** —— 而测试以为自己装了假实现。

这比系列里之前踩过的版本更隐蔽：那个版本是「两个对象」，这个是「一个对象、字段被快照」。修法是**在使用点实时读**：

```js
const transport = ctx.transport ?? {};
// 调用点：
await staticFetch(url, { ..., fetchImpl: transport.fetchImpl });
```

配套的守卫是 `assertNoNetwork(calls, label)`：夹具装完假 fetch，工具跑完立刻断言「请求真的打到假实现了没有」。**请求列表为空却拿到「网络错误」= 注入没生效** —— 把静默联网变成响亮失败。

---

## 测试

```bash
node _test/run-all.mjs
```

三个套件跑在各自独立的子进程里 —— 每个套件都会用 `new Function` 重建一份插件副本，同进程会互相污染模块缓存。

```
browser logic:        217 passed, 0 failed
browser integration:  157 passed, 0 failed
browser end to end:    48 passed, 0 failed
```

**共 422 条断言，全套不碰网络。**

- **`test-logic.mjs`（217）** —— 纯函数白盒。密度打分、子树选择、实体解码、HTML 两个扁平化器、围栏加宽、标签配对计数器、等待策略解析、URL 校验、路径逃逸。
- **`test-integration.mjs`（157）** —— 通过 `defineTool` 注册后的真实调用。schema 形状、注册开关、错误路径、两种引擎的切换与退回、`saveAs` 落盘、截图的 8 种路径逃逸。**全部用假 fetch 和假 Playwright，一次真网络都不碰。**
- **`test-e2e.mjs`（48）** —— 一份故意难伺候的文档页，两个引擎各跑一遍。含：粘性导航栏、页脚站点地图、带 `#` shell 注释的代码围栏、粗体嵌套代码、粗体链接、有序/无序清单、相关文章块、30 条评论、以及一段**文字与正文重叠**的 `<script>`（漏剥就会多出正文）。

### 假浏览器

`fakePlaywright()` 只实现插件真正会调的那部分：`chromium.launch`、`newContext`、`newPage`、`goto`、`waitForSelector`、`content`、`title`、`url`、`screenshot`，以及两个 `close`。这样「导航超时后浏览器有没有被释放」这种事就能断言，而不需要真启动一个 Chromium —— 一个超时的抓取如果漏掉 `finally`，每次重试都会漏一个浏览器进程。

---

## 目录

```
dsh-tool-browser/
├── lib/index.js               插件本体（4 个工具 + 抽取器 + 两个引擎）
├── cordis.patch.yml           插件加载配置
├── _test/
│   ├── harness.mjs            用真实 dsh-tools 重建 apply，并暴露内部函数
│   ├── test-logic.mjs         217 条
│   ├── test-integration.mjs   157 条
│   ├── test-e2e.mjs            48 条
│   └── run-all.mjs            三个套件各自跑在子进程
├── LICENSE                    MIT
└── README.md
```

---

## License

MIT © yuehancn

---

*本插件属于 DeepSeek Harness 工具插件系列。同一系列还有 `dsh-tool-comfyui`、`dsh-tool-gzh-publisher`、`dsh-tool-ocr`、`dsh-tool-media`、`dsh-tool-subtitle`、`dsh-tool-invoice`、`dsh-tool-qrcode`、`dsh-tool-epub`、`dsh-tool-podcast`、`dsh-tool-mining`、`dsh-tool-notion`。*