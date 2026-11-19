# Antigravity Session Monitor（`session-monitor`）

[English](README.en.md)

面向 **Antigravity 2.0 桌面端** 的 DSH（DeepSeek Harness）风格实时会话遥测与控制面板插件，挂载于右侧辅助面板（`Aux Pane`）。纯本地只读解析本地会话日志 `transcript.jsonl`，零外部网络请求，零第三方 npm 依赖。

## 核心指标与界面能力

1. **上下文引用占比（Context Window %）**
   - 读取当前会话最新模型步的 `input_tokens + cache_read_tokens` 作为活跃上下文长度。
   - 顶部紧凑速览胶囊 + 环形进度条，支持切换窗口参考基准（`128k` / `200k` / `1M` / `2M`，默认 `1M`），实时展示步间增量、会话峰值、剩余可用容量与三段构成比例（缓存读取 / 新增输入 / 本步输出）。
   - 仅在实际检测到上下文压缩时显示 `已压缩 N 次`，避免静态误报。
2. **前缀缓存命中率（Prefix Cache Hit Rate）**
   - 实时统计**当前步命中率** `cache_read_tokens / (input_tokens + cache_read_tokens)`、**热态累计命中率**（首步之后）与**全会话累计命中率**。
   - 展示累计缓存读取量、未命中输入量，并自动标记前缀缓存重置（Cache Miss / Reset）。
3. **每秒 Token 速率（`tok/s`）**
   - 基于步级起止时间戳计算单步等效输出速率 `output_tokens / 单步耗时`（含首字等待 TTFT 与思考 Token），同步展示单步耗时、会话平均速率、峰值速率、累计输出量及对话轮/模型步计数。
4. **趋势图与步级明细**
   - 内置纯 SVG 步级趋势图，支持 `速度 tok/s` / `上下文` / `缓存率` 三视图切换。
   - 展示最近 25 步遥测明细（含工具摘要与压缩/重置标记），提供一键复制 `/compact` 快捷按钮，并自动跟随宿主明暗主题与窗口当前会话。

## 架构与性能设计

- **字节偏移增量解析**：后端通过 `fs/promises` 按 `byteOffset` 仅读取日志新增字节段，单步更新 O(1)，内存中仅保留滚动窗口（最近 48 步）。
- **轻量最近会话列表**：拆出独立 `/api/recent` 接口（15s TTL + `brain/` 目录 `fs.watch` 失效 + 32 并发 `stat`），列表项仅读取文件头 16 KB 提取标题、文件尾 32 KB 提取最新上下文与状态。
- **事件驱动长轮询**：`/api/metrics` 的 ETag 仅绑定当前会话，结合 `fs.watch`（60ms 防抖）长轮询推送新步；面板隐藏时前端通过 `visibilitychange` + `AbortController` 自动暂停轮询。
- **前端局部重绘**：DOM 引用启动缓存，切换窗口基准仅重绘上下文卡；趋势图与明细表按步级签名跳过无效重绘；静态资源按 `mtimeMs` 校验内存缓存，支持关闭重开面板热加载。

## 快速安装

要求已安装 **Antigravity 2.0 桌面端** 与 **Node.js 18+**。将本仓库克隆至全局插件目录 `~/.gemini/config/plugins/session-monitor`：

### macOS / Linux

```bash
git clone https://github.com/bartholo4/antigravity-session-monitor.git ~/.gemini/config/plugins/session-monitor
```

### Windows (PowerShell)

```powershell
git clone https://github.com/bartholo4/antigravity-session-monitor.git "$HOME\.gemini\config\plugins\session-monitor"
```

克隆完成后：

1. 在 Antigravity 桌面端打开 **Plugins / Customizations** 确认 `session-monitor` 已启用（首次加载如未自动拉起侧栏进程，可重启 Antigravity 或在插件页停用后再启用）。
2. 打开右侧辅助面板（Aux Pane）中的 **状态监控** 视图，或在对话中输入“打开当前会话的状态监控面板”。

## 数据来源与隐私

- 仅以只读方式访问 `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`（优先按 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 推导，回退 `~/.gemini/antigravity/brain`）。
- 不修改任何会话文件或 Antigravity 配置文件，不发起任何外部网络请求。

## 目录结构

```text
.
├── plugin.json                        # Antigravity 全局插件清单
├── assets/logo.svg                    # 插件图标
├── sidecars/monitor_pane/
│   ├── sidecar.json                   # Sidecar 启动与 Aux Pane 视图配置
│   ├── package.json                   # ESM 模块声明
│   ├── main.mjs                       # Node 后端（增量解析、长轮询、静态缓存）
│   ├── index.html                     # 监控面板页面结构
│   ├── app.js                         # 前端交互与局部渲染
│   └── styles.css                     # 宿主明暗主题自适应样式
└── tests/monitor.test.mjs             # 端到端离线自动化测试（node --test）
```

## 已知说明与故障排查

- **Windows 含非 ASCII 用户名路径首启偶发重试**：`sidecar.json` 默认使用 `"command": "node"`，Windows 宿主在非 ASCII 用户目录下经包装脚本启动时偶发首次拉起失败；`sidecar.json` 已配置 `"restart_policy": "always"`，通常在 1–2 秒内自动恢复。如需彻底消除重试日志，可在本机副本中将 `sidecar.json` 的 `"command"` 改为本机 `node.exe` 的无非 ASCII 路径。
- **开发热更新**：修改 `index.html` / `styles.css` / `app.js` 后，关闭并重新打开右侧 **状态监控** 视图即可生效；修改 `main.mjs` 需在 Plugins Manager 中停用再启用插件或重启 Antigravity。

## 本地测试

使用 Node.js 内置测试运行器（无需安装任何依赖）：

```bash
node --test tests/monitor.test.mjs
```

## License

[MIT](LICENSE)
