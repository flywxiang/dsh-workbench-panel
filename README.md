# dsh-workbench

DSH（DeepSeek Harness）的「工作台」插件：**只统计语言模型调用**，把调用热力图、每日趋势和延迟趋势放进侧边栏面板，同时提供一个可离线打开的单文件仪表盘。

零第三方依赖——宿主半边只用 Node 内置模块，浏览器半边是预构建产物。

## 装插件

想用的人**不需要 clone 这个仓库**，直接装 Release 里的 tgz：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-workbench-panel-1.1.1.tgz
launchctl kickstart -k gui/$(id -u)/ai.openclaw.dsh-rc8
```

完整说明见 [`plugin/README.md`](plugin/README.md)。

## 仓库里有什么

```
src/       引擎源码 —— 采集、会话解析、统计塑形、图表渲染
tools/     构建与验证工具（build / pack / test）
plugin/    可发布的 npm 包，由 tools/build.mjs 从 src/ 生成
out/       构建产物（已 gitignore）
cache/     会话解析缓存，含真实对话数据（已 gitignore）
```

`plugin/lib/` 和 `plugin/lib/shared/` 是从 `src/` 同步过去的**生成物**，提交进来是为了保证任何人 clone 下来都能直接 `npm pack` 出可用的包。改逻辑请改 `src/`，然后跑 `node tools/build.mjs`。

## 开发

```bash
node tools/build.mjs            # 采集 + 生成独立仪表盘 + 重建插件 bundle
node --test tools/*.test.mjs    # 跑测试（14 个）
node tools/pack.mjs             # npm pack 出 dist/dsh-workbench-panel-<version>.tgz
```

### 为什么 build 会先做语法体检

浏览器半边是**预构建产物**，源码里的一个语法错误不会在 `node tools/build.mjs` 报错，而是等到浏览器加载 bundle 时才炸成一句没用的 `import failed`。所以 `build.mjs` 生成后会先用 `vm.Script` 编译一遍，编译不过就直接构建失败——把这条烂链断在构建阶段。

### 改完插件半边必须重启 dsh

两半的加载机制不一样：

- **浏览器半边**：revision 是文件内容 hash，刷新页面就重取。
- **宿主半边**：`import` 静态加载，进程启动时 import 一次并缓存。

所以改完 `plugin/lib/` 下的东西，在磁盘上重建**对正在运行的 dsh 无效**，必须：

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.dsh-rc8
```

（重启会换 token，用 dsh 新打印的地址重新打开页面。）

## 统计口径

- 数据来源：`$DSH_HOME/sessions/**/session*.jsonl.zstd`，直接解析，不依赖其他插件。
- `step/start → step/end` 之间调用了语言模型的那一步记 1 次调用；会话标题、联网搜索等辅助调用不计入。
- 每日趋势跟随插件行的 `days` 配置（默认 60 天）。
- **调用热力图固定展示最近 365 天**，不跟随 `days`——9 列的图看不出节奏，53 列才是贡献图该有的样子。
- 热力图**按卡片宽度自适应**：列间距跟着容器实际宽度计算，宽屏格子更大、铺满整张卡片，窄屏不会溢出。

## License

MIT
