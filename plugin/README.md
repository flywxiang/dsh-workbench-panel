# DSH 工作台面板（@dsh-workbench/panel）

在 DSH 里加一个「工作台」侧边栏页面：**只统计语言模型调用**。页面分三个 tab：

- **概览**：正在处理实时状态（会话/工具/批准/后台任务/待办）、汇总卡片、近 7 天花费卡片（调用次数/Token/估算花费/缓存已省）、调用热力图、每日趋势；延迟趋势默认隐藏，需要时用 `latencyEnabled: true` 打开。
- **花费与产出**：一键周报（可直接复制）、等你确认、上下文提醒、未完成待办、最近交付。
- **工作总结**（1.4.0）：由本机模型把当天/本周的对话材料写成书面日报与周报，可切历史、可复制；默认每天 18:30 出日报、每周五 18:30 出周报。详见下方「工作总结」。

切换 tab 后保持选中，30 秒刷新数据不会跳回；有等待或上下文提醒时 tab 上带数字角标。

- 数据来源：`$DSH_HOME/sessions/**/session*.jsonl.zstd` 会话日志，直接解析，不依赖任何其他插件。
- 统计口径：`step/start → step/end` 之间调用了语言模型的那一步记 1 次调用；会话标题、联网搜索等辅助模型调用不计入。
- 运行时：Node ≥ 22.15（用到 `node:zlib` 的 zstd 支持）与 DSH `web` profile。
- 依赖：**零第三方依赖**（宿主半边只用 Node 内置模块，浏览器半边是预构建产物）。

## 安装

```bash
# 1. 拿到包（二选一）
#    a) 本地 tarball：把 dsh-workbench-panel-1.4.0.tgz 发给对方
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-workbench-panel-1.4.0.tgz

#    b) 已发布到 npm：直接用包名
npx -y @deepseek-ai/dsh plugin --profile web add @dsh-workbench/panel

# 2. 重启 DSH
launchctl kickstart -k gui/$(id -u)/ai.openclaw.dsh-rc8   # macOS launchd 启动方式
# 其它启动方式：结束 dsh web 进程后重新启动即可

# 3. 刷新浏览器页面（重启后 token 会变，用 dsh web 新打印的地址重新打开）
```

打开后侧边栏会出现「工作台」入口（英文界面显示 Workbench），点开就是面板。

> tarball 的文件名不含 scope：`@dsh-workbench/panel@1.4.0` 打包出来是 `dsh-workbench-panel-1.4.0.tgz`，这是 npm 的规则，不是漏字。

### 如果 `dsh plugin add` 报 pnpm 错误

`ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF: This modules directory was created using a different public-hoist-pattern value`

这是该 profile 之前用别的 pnpm 配置装过插件，与这个包无关。任选一种：

```bash
# a) 先在 profile 目录里对齐一次，再重试
cd ~/.dsh/profiles/web && pnpm install --config.public-hoist-pattern='*'
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-workbench-panel-1.4.0.tgz

# b) 手工接线（不跑 pnpm）
#    注意 scope 目录要一起建，软链名是 @dsh-workbench/panel
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-workbench
ln -sfn /绝对路径/到/解压后的/package ~/.dsh/profiles/web/node_modules/@dsh-workbench/panel
# 然后在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 里追加 "@dsh-workbench/panel"
```

## 配置

插件行支持以下可选配置，写在 profile 的 `cordis.patch.yml`，或者由包内 `cordis.patch.yml` 提供默认值：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `timeZone` | 机器时区 | 按哪个时区切分「每天」和「每小时」，例如 `Asia/Shanghai` |
| `days` | `60` | 每日趋势的统计窗口天数（面板内可切） |
| `activeEnabled` | `true` | 是否显示「正在处理」实时状态 |
| `activeRefreshMs` | `10000` | 前端刷新间隔（1000~60000 毫秒） |
| `activeIdleMinutes` | `10` | 多久没活动的会话仍列在「正在处理」里（1~120 分钟；期间一直空闲的会话显示为「空闲」） |
| `activeMaxSessions` | `10` | 最多展示多少个会话（1~50） |
| `showToolTarget` | `false` | 是否显示脱敏后的工具目标（命令首行/文件名）；**默认关闭**，见下方隐私说明 |
| `latencyEnabled` | `false` | 是否显示「延迟趋势」图 |
| `costDays` | `7` | 花费估算与周报的统计窗口（天） |
| `todoDays` | `14` | 「未完成待办」回溯多少天（天） |
| `deliverableDays` | `14` | 「最近交付」回溯多少天（天） |
| `waitingDays` | `3` | 「等你确认」回溯多少天（天） |
| `contextDays` | `2` | 「上下文提醒」只看最近几天活跃的会话（天） |
| `contextWarnTokens` | `200000` | 上下文超过多少 token 就提醒（20000~2000000） |
| `prices` | 内置价目表 | 每百万 token 的估算单价（CNY），见下方「花费计算口径」 |
| `summaryEnabled` | `true` | 是否自动生成每日/每周工作总结；关掉后仍可手动点「立即生成」 |
| `summaryDailyTime` | `18:30` | 每天几点（本地时间 `HH:MM`）生成当天日报 |
| `summaryWeeklyTime` | `18:30` | 周报生成时间（`HH:MM`）。周五及以后保证本周（周一至周五）周报，其余时间保证上一周 |
| `summaryBackfillDays` | `7` | 往回补几天（1~30）：过了点没写成的日期，每次启动和每 5 分钟检查时自动补齐 |
| `summaryProvider` | `''` | 生成总结用的模型服务；与 `summaryModel` 都留空表示用「当前会话默认模型」 |
| `summaryModel` | `''` | 生成总结用的模型名，与 `summaryProvider` 配对使用 |
| `summaryMaxChars` | `60000` | 一次送进模型的对话材料字符上限（5000~200000） |
| `summaryMaxOutputTokens` | `4000` | 模型输出上限（300~8000）；推理模型的「思考」也占这个额度，1800 时周报被截断过。被截断时自动用 8000 重试一次 |

## 调用热力图

贡献图样式：一格一天，周为列，星期二/四/六标注在左侧，每出现一个新月份就在顶部标一次月份，下方是「少 → 多」的五级色例。鼠标悬停显示当天的调用次数。

**按卡片宽度自适应**：列间距按容器实际宽度计算，宽屏格子更大并铺满整张卡片，窄屏自动缩小不溢出；月份/星期文字走独立字号，不会随格子一起被放大。

配色跟随 DSH 主题强调色，浅色/深色界面都协调。

**热力图固定展示最近 365 天**，不跟随上面的 `days` 配置——一张 9 列的图看不出任何节奏，53 列才是贡献图该有的样子。趋势图和汇总卡片仍然按 `days` 走。没有数据的日子显示为浅灰，这正是贡献图在"还没开始用"时的样子。

## 正在处理（实时状态）

页面顶部一块实时面板，默认每 10 秒刷新：

- **会话行**：标题/项目目录、状态（等待模型返回 / 正在执行工具 / 等待你批准 / 等待重试 / 空闲）、已运行时长、第几回合第几步、当前模型；有 `todo_write` 计划时还会显示「待办 3/5 · 进行中：…」。
- **空闲会话**：最近 `activeIdleMinutes` 分钟内活动过、但此刻没在跑任务的会话也会列出（显示「空闲 · 上次活动 N 分钟前」）。
- **后台任务**：尚未结束的后台命令（job）单独一行，显示类型与已运行时长。
- **空状态**：没有任何活动时显示「当前没有正在处理的任务」。

数据同样来自会话日志：`turn/start`、`step/start`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`job/registered`、`job/settled`、`llm/retry`、`todo/write` 等事件按 id 配对。读取是增量的：只解压日志新追加的 zstd 帧，实测 1.5 MB 的活跃会话首次冷启动约 60 ms、之后每次刷新约 10 ms，不会拖慢 DSH。

### 隐私

默认**不显示**命令、参数、工具输出或消息正文，只显示工具名、状态、时长和待办标题。日志里的工具参数可能包含令牌、密码、SQL 正文，所以即使打开 `showToolTarget`，打码也在服务端完成：`github_pat_*`、`ghp_*`、`sk-*`、`AKIA*`、超长随机串、`token=` 类参数一律替换，命令只取首行前 60 字、路径只保留文件名。

该区块只读 `$DSH_HOME/sessions`；独立仪表盘是离线快照，不显示实时状态。

## 花费估算、周报与提醒

这些区块和热力图一样从会话日志推导，不需要额外数据源：

- **近 7 天概览**：调用次数、Token、估算花费、缓存读取省下的钱；下面是「一键周报」，点「复制周报」按钮把整段文字粘给领导/同事。
- **最近交付**：`deliverables/presented` 事件里的文件，按路径去重（同一文件多次交付只留最近一次），显示文件名、说明、所属会话和时间。
- **未完成待办**：跨会话汇总最近 `todoDays` 天里没做完的 `todo_write` 清单，卡在哪个会话、还剩哪几项。
- **等你确认**：最近 `waitingDays` 天里卡在「等你批准」或「等你回答」的会话，附已等待时长。
- **上下文提醒**：最近 `contextDays` 天活跃的会话，提示词侧（输入 + 缓存读取）超过 `contextWarnTokens`（默认 20 万 token）就提醒「建议开新会话或压缩历史」。
- **延迟趋势**：默认隐藏；它衡量「每次等多久」（首字延迟 / 整段生成时长），觉得有用再把 `latencyEnabled` 打开。

### 花费计算口径

- 内置一张 CNY/百万 token 的价目表（`src/insights.mjs` 的 `DEFAULT_PRICES`）：`deepseek-flash`、`deepseek-v4-flash`、`deepseek-chat` 按输入 2 元 / 缓存读取 0.5 元 / 输出 8 元；`deepseek-v4-pro`、`deepseek-reasoner` 按输入 4 元 / 缓存读取 1 元 / 输出 16 元。
- 未精确命中的模型按名称关键词归类（含 `flash`/`economy`/`chat` 走 flash 价，含 `pro`/`reasoner` 走 pro 价）；仍无法归类的标记为「未定价」，单独报数量，**不会假装 0 元**。
- 可以在插件行用 `prices` 覆盖或新增，例如 `prices: { "kimi-coding/k3": { input: 3, cacheRead: 1, output: 12 } }`（单位：元 / 百万 token）。
- 「缓存已省」= 缓存读取 token ×（输入单价 − 缓存读取单价），是相对「全部按输入价计费」的差额。
- **这是估算，不是账单**：价格会变、推理模型可能另有计费规则，界面上标注「估算」。
- **隐私**：交付物只显示文件路径/文件名（为了让你能找到文件），路径里的令牌形态串同样会打码；不显示文件内容。

## 工作总结（1.4.0）

「工作总结」tab 里放两份东西：**每日日报**和**每周周报**，都由本机模型写成**可以直接发给上级的书面总结**，不用自己再润色一遍。

- **材料从哪来**：还是 `$DSH_HOME/sessions` 的会话日志。只取时间窗口内**真人说的话**（按日志里的消息来源判定），整段丢掉系统注入的运行时上下文、时间注入、技能目录；寒暄（“好”“继续”“谢谢”）和一句话以下的碎消息也过滤掉。工具输出、命令参数、文件内容一律不进模型。
- **什么时候生成**：默认每天 18:30 出当天日报，每周五 18:30 出本周周报（周一至周五）；其余时间保证上一周缺的周报。**漏掉的日子会自动补齐**：每次启动和每 5 分钟检查一次，最近 `summaryBackfillDays`（默认 7）天里没有日报的日期都会补写，所以 18:30 时机器关着也不会整天丢报告（1.4.1 起）。
- **失败了会怎样**：同一篇最多试 3 次、间隔 10 分钟；仍然失败就写一行到 `$DSH_HOME/workbench/summaries.log`（`/api/health` 里能看到最近 5 行），面板顶部也会黄字提示原因——不会再出现"那几天为什么没有"查不到证据的情况。
- **周报的两种写法**：本周有日报 → 把日报合并润色；本周还没日报 → 直接取本周一至周五的原始材料写，所以功能一开就能用，不用等攒够五篇日报。
- **格式固定**：日报四段（今日主要工作 / 完成情况 / 问题与风险 / 明日计划，200~400 字），周报四段（本周重点 / 进展与产出 / 问题与风险 / 下周计划，300~500 字）；简体中文，不编造材料里没有的事。
- **脱敏**：模型输出落地前再打一遍码（`github_pat_*`、`ghp_*`、`sk-*`、`AKIA*`、超长随机串、`token=` 类参数），所以存档里不会留着密钥形态的串。
- **存哪**：`$DSH_HOME/workbench/summaries.json`，最多保留 200 篇；面板里可切最近 12 期，一键复制。
- **依赖**：需要 profile 里有 `llm` 服务（生成用）和模型路由。没有时报错是中文说明，不会崩：接口返回 503 + 原因，面板顶部黄字提示；已经存下来的总结照常能看。
- **注意**：18:30 那一刻生成的日报只覆盖到 18:30，当晚后续的工作会算进第二天。想手动补一篇，点面板里的「立即生成」。

## HTTP 路由

| 路由 | 说明 |
| --- | --- |
| `/dsh-workbench/api/summary` | 聚合后的 JSON 数据（面板拉取的就是它） |
| `/dsh-workbench/api/active` | 实时状态 JSON（会话/后台任务/计数），面板每 10 秒拉一次 |
| `/dsh-workbench/api/summaries` | 已存的日报/周报清单与配置（总结 tab 用它渲染） |
| `/dsh-workbench/api/summaries/generate` | `POST {"kind":"daily"\|"weekly"}` 立即生成一篇；成功 `{entry, summaries}`，没材料 `{skipped:true,reason}`，缺模型服务 503 + 中文原因 |
| `/dsh-workbench/api/health` | 采集与缓存状态，排查问题用 |
| `/dsh-workbench/dashboard.html` | 独立的单文件仪表盘页（需要宿主先构建一次，见下） |

## 独立仪表盘页

面板是紧凑布局；想要全屏版，在源码仓库里跑：

```bash
node tools/build.mjs --days 60        # 生成 out/dsh-workbench.html 与 plugin/lib/client/index.js
open out/dsh-workbench.html           # 直接双击也能看（数据内嵌在页面里）
```

`dashboard.html` 路由读取的是 `$DSH_HOME/workbench/out/dsh-workbench.html`，所以这个文件存在时面板端可以直接访问它作为兜底快照。

## 卸载

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove @dsh-workbench/panel
```

或手工删掉 profile `package.json` → `dsh.profile.bundles` 里的 `"@dsh-workbench/panel"` 与同名软链，再重启。

## License

MIT
