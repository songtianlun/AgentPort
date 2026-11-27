# AgentPort

**Portable Workspace Migrator, Cloud Backup & Share Hub for AI Coding Agents**

AgentPort 是一款基于 **Tauri v2 + React + Rust + Go** 的 AI 编程会话资产管理套件，提供：

- **跨工具无损迁移**：本地只读解析 AI Agent 会话数据，自动对齐目标项目、模型与权限模式，一键幂等迁入目标平台（首发支持 **T3 Code → Lody**）。
- **本地与云端增量自动备份**：支持导出到本地归档目录，或按 SHA256 增量同步至自建 / 官方 **AgentPort Server**（纯 Go 单二进制 + SQLite FTS5 全文搜索 + Blob 附件去重）。
- **一键脱敏与密码分享**：将任意会话生成独立只读快照链接（`/s/<slug>`），支持自动脱敏 API Key / Token、隐藏本机用户路径、可选访问密码与过期时间，一键撤销。

---

## 架构概览

```text
AgentPort/
├── src/                # 共用 React + TS 前端（桌面客户端 / 服务端管理台 / /s/:slug 公开分享页）
├── src-tauri/          # Tauri v2 原生桌面客户端（只读扫描、Lody 幂等导入、增量云备份）
├── server-go/          # Go 服务端（go:embed 前端 + 纯 Go SQLite/FTS5 + Blob + Sync/Share API）
├── Dockerfile          # 多阶段构建（amd64 / arm64 单二进制容器）
└── docker-compose.yml  # 一键自建部署模板
```

---

## 快速自建服务端（Docker）

```bash
docker compose up -d
```

或直接运行多架构镜像（`linux/amd64` & `linux/arm64`）：

```bash
docker run -d \
  --name agentport-server \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e AGENTPORT_PUBLIC_URL=https://agentport.example.com \
  ghcr.io/songtianlun/agentport:latest
```

首次访问 `http://localhost:8080` 按页面提示初始化管理员账号，在「**设备与 Token**」中签发同步 Token，填入 AgentPort 桌面端「**云备份与分享**」页即可开启一键增量备份与分享。

---

## 桌面客户端本地开发

### 方式 A：原生 Tauri v2 桌面端
```bash
npm install
npm run tauri dev
npm run tauri build
```

### 方式 B：Go 服务端开发
```bash
npm install && npm run build
cp -r dist/* server-go/static/dist/
cd server-go && go mod tidy && go run . --addr :8080 --data-dir ./data
```

---

## 自动构建与发版（GitHub Actions）

- **CI（`.github/workflows/ci.yml`）**：每次推送 `main` 或 PR 自动运行前端构建、Rust `cargo check` 和 Go 单元测试（`go test ./...`）。
- **桌面端发版（`.github/workflows/release.yml`）**：推送 `vX.Y.Z` 标签自动构建 macOS (arm64/x64 `.dmg`)、Linux (`.AppImage`/`.deb`)、Windows (`.msi`/`-setup.exe`) 并创建/更新 GitHub Release。
- **服务端 Docker 发布（`.github/workflows/docker-build.yml`）**：推送 `main`（`devel`）或 `v*`（`vX.Y.Z` + `latest`）自动构建 `linux/amd64` + `linux/arm64` 多架构镜像，推送至 GHCR（`ghcr.io/<owner>/agentport`），配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 后自动同步镜像至 Docker Hub。

---

## Roadmap

- [x] T3 Code (`statev2.sqlite`) 只读扫描、Lody 实时探测、项目一键注册与异步幂等导入
- [x] Go 服务端（SQLite/FTS5 + Blob 去重 + 设备 Token + `/s/:slug` 密码与自动脱敏分享）
- [x] 共用 React 前端（桌面端 + 服务端管理台 + 公开分享页）与多架构 Docker CI
- [ ] 更多 Agent 源端适配器：Claude Code (`~/.claude/projects`)、Codex (`~/.codex/sessions`)、Lody、OpenCode
- [ ] 官方云同步多租户托管（OAuth + S3/R2 存储 + 跨设备恢复）
