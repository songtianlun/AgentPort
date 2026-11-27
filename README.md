# AgentPort

**Portable Workspace & Context Migrator for AI Coding Agents**

AgentPort 是一款基于 **Tauri v2 + React + Rust** 构建的可视化桌面迁移工作台，用于在各类 AI 编程工具（如 T3 Code、Lody、Claude Code、Codex、OpenCode 等）之间迁移 **项目元数据、智能体配置、会话上下文、附件以及未提交代码变更**。

> 当前版本（v0.1.0）首发支持 **T3 Code (`statev2.sqlite`) → Lody** 完整迁移链路，并采用「源端适配 → 标准化中间表示（IR）→ 目标端适配」三段式架构，便于后续持续扩展更多源端与目标端适配器。

---

## 核心特性

- **零侵入只读扫描**：以只读模式（`SQLITE_OPEN_READ_ONLY`）解析源库，不锁定、不改动正在运行的源工具。
- **项目一致性对齐**：
  - 优先按本地路径精确匹配目标工作区项目；
  - 跨机器或未注册本地目录时，自动通过 Git `remote.origin.url` 降级匹配 GitHub 仓库；
  - 未注册项目显式标红拦截，支持界面交互式覆盖（Local / GitHub / Chat / Skip）。
- **智能体与权限语义对齐**：
  - 基于目标端真实的 Agent 能力矩阵（可用 `models` / `modes`）自动映射；
  - 明确标注模型降级与权限模式差异（例如 T3 `full-access` → Lody `accept-edits`），绝不静默错配。
- **三层上下文保真（完整性保障）**：
  - **L1 全量归档**：`raw.json` + 完整 `transcript.md` + 真实图片附件副本；
  - **L2 结构化交接（Handoff）**：提炼初始目标、最近进展、关联 PR 与分支，生成新会话启动 Prompt；
  - **未提交代码保护**：自动检测 Git 脏工作区并导出 `dirty.patch`，避免切换 worktree 丢改；
  - **幂等状态跟踪**：基于确定性 `operationId` 生成 `lody-mcp-batch.json` 与 `migration-state.json`，支持断点续传。

---

## 架构概览

```text
Source Adapters (T3 Code / future: Claude Code, Codex, Cursor...)
        │  [Read-only Extractor]
        ▼
Canonical Migration IR (migration-bundle/)
  ├── manifest.json         # 项目元数据、Git 信息、源端快照
  ├── migration-state.json  # 幂等状态与断点续传记录
  └── threads/<id>/
        ├── raw.json        # 原始结构化数据留底
        ├── transcript.md   # L1 完整对话归档
        ├── handoff.md      # L2 接续交接摘要
        ├── dirty.patch     # 未提交代码补丁（若有）
        └── attachments/    # 原始附件副本
        │  [Consistency Planner & Target Adapter]
        ▼
Target Adapters (Lody / future: OpenCode, Claude Code...)
```

---

## 快速开始

### 1. 准备目标端目录配置
复制示例文件并填入你的目标 Lody Catalog（`data/lody-catalog.json` 已被 `.gitignore` 忽略，不会提交隐私信息）：

```bash
cp data/lody-catalog.example.json data/lody-catalog.json
```

### 2. 方式 A：原生 Tauri v2 桌面应用（推荐）

需要安装 Rust 与对应平台的 WebView 构建依赖：

```bash
# Ubuntu / Debian 依赖示例
sudo apt install -y build-essential libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

npm install
npm run tauri dev    # 启动桌面开发窗口
npm run tauri build  # 打包为 AppImage / deb / dmg / msi
```

### 3. 方式 B：浏览器预览模式（无需 Rust，开箱即用）

前端自动探测 `window.__TAURI_INTERNALS__`，在浏览器中自动切换至本地只读桥接服务：

```bash
npm install
python3 server/bridge.py   # 监听 127.0.0.1:4179（镜像 Tauri Rust 命令）
npm run dev                # 启动 Vite 前端 http://127.0.0.1:5173
```

---

## Roadmap

- [x] T3 Code (`statev2.sqlite`) 只读解析与 Git / 附件抽取
- [x] Lody 项目、智能体、模型、权限模式可视化对齐与覆盖
- [x] 标准化 IR 迁移包与 Lody MCP 批量创建清单导出
- [ ] 一键直连 Lody MCP / CLI 执行导入并实时回写 `migration-state.json`
- [ ] 新增适配器：Claude Code (`~/.claude/projects`)、Codex、OpenCode、Cursor
- [ ] 支持双向迁移与跨机器增量同步
