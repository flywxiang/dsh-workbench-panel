# DSH 工作台面板（@dsh-workbench/panel）

在 DSH 里加一个「工作台」侧边栏页面：**只统计语言模型调用**。顶部是**「正在处理」实时状态**（会话/工具/批准/后台任务/待办）和汇总卡片，下面依次是**调用热力图**、每日趋势（调用次数 / Token 用量 / 模型耗时 / 响应与首字延迟，按模型分色堆叠）和延迟趋势。

- 数据来源：`$DSH_HOME/sessions/**/session*.jsonl.zstd` 会话日志，直接解析，不依赖任何其他插件。
- 统计口径：`step/start → step/end` 之间调用了语言模型的那一步记 1 次调用；会话标题、联网搜索等辅助模型调用不计入。
- 运行时：Node ≥ 22.15（用到 `node:zlib` 的 zstd 支持）与 DSH `web` profile。
- 依赖：**零第三方依赖**（宿主半边只用 Node 内置模块，浏览器半边是预构建产物）。

## 安装

```bash
# 1. 拿到包（二选一）
#    a) 本地 tarball：把 dsh-workbench-panel-1.2.0.tgz 发给对方
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-workbench-panel-1.2.0.tgz

#    b) 已发布到 npm：直接用包名
npx -y @deepseek-ai/dsh plugin --profile web add @dsh-workbench/panel

# 2. 重启 DSH
launchctl kickstart -k gui/$(id -u)/ai.openclaw.dsh-rc8   # macOS launchd 启动方式
# 其它启动方式：结束 dsh web 进程后重新启动即可

# 3. 刷新浏览器页面（重启后 token 会变，用 dsh web 新打印的地址重新打开）
```

打开后侧边栏会出现「工作台」入口（英文界面显示 Workbench），点开就是面板。

> tarball 的文件名不含 scope：`@dsh-workbench/panel@1.2.0` 打包出来是 `dsh-workbench-panel-1.2.0.tgz`，这是 npm 的规则，不是漏字。

### 如果 `dsh plugin add` 报 pnpm 错误

`ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF: This modules directory was created using a different public-hoist-pattern value`

这是该 profile 之前用别的 pnpm 配置装过插件，与这个包无关。任选一种：

```bash
# a) 先在 profile 目录里对齐一次，再重试
cd ~/.dsh/profiles/web && pnpm install --config.public-hoist-pattern='*'
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-workbench-panel-1.2.0.tgz

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

## HTTP 路由

| 路由 | 说明 |
| --- | --- |
| `/dsh-workbench/api/summary` | 聚合后的 JSON 数据（面板拉取的就是它） |
| `/dsh-workbench/api/active` | 实时状态 JSON（会话/后台任务/计数），面板每 10 秒拉一次 |
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
