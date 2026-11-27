#!/usr/bin/env python3
"""
Dual-mode local preview bridge for T3 Code -> Lody Migrator.
Mirrors the exact Tauri Rust #[tauri::command] API over HTTP so the visual UI
can run interactively in Vite / Lody Browser Preview when Rust/WebKitGTK are
not yet installed on this host. Reads T3 Code SQLite strictly in READ-ONLY mode.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

APP_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"
DEFAULT_CATALOG = APP_ROOT / "data" / "lody-catalog.json"
EXAMPLE_CATALOG = APP_ROOT / "data" / "lody-catalog.example.json"
DEFAULT_OUTPUT = APP_ROOT / "migration-bundle"
PORT = int(os.environ.get("MIGRATOR_BRIDGE_PORT", "4179"))


def load_catalog() -> dict[str, Any]:
    path = DEFAULT_CATALOG if DEFAULT_CATALOG.exists() else EXAMPLE_CATALOG
    return json.loads(path.read_text(encoding="utf-8"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def open_readonly(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"T3 Code 数据库不存在: {db_path}")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def parse_github_repo(remote: str | None) -> str | None:
    if not remote:
        return None
    s = remote.strip()
    if s.endswith(".git"):
        s = s[:-4]
    if s.startswith("git@github.com:"):
        return s[len("git@github.com:") :]
    marker = "github.com/"
    if marker in s:
        return s.split(marker, 1)[1]
    return None


def inspect_git(directory: str) -> dict[str, Any]:
    p = Path(directory)
    if not p.is_dir():
        return {
            "exists": False,
            "isGitRepo": False,
            "remoteOrigin": None,
            "githubRepo": None,
            "currentBranch": None,
            "dirtyFiles": [],
        }
    if not (p / ".git").exists():
        return {
            "exists": True,
            "isGitRepo": False,
            "remoteOrigin": None,
            "githubRepo": None,
            "currentBranch": None,
            "dirtyFiles": [],
        }

    def run_git(args: list[str]) -> str | None:
        try:
            r = subprocess.run(
                ["git", "-C", directory, *args],
                capture_output=True,
                text=True,
                timeout=4,
            )
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except Exception:
            pass
        return None

    remote = run_git(["remote", "get-url", "origin"])
    branch = run_git(["branch", "--show-current"])
    dirty_raw = run_git(["status", "--porcelain"]) or ""
    dirty_files = [ln for ln in dirty_raw.splitlines() if ln.strip()]
    return {
        "exists": True,
        "isGitRepo": True,
        "remoteOrigin": remote,
        "githubRepo": parse_github_repo(remote),
        "currentBranch": branch,
        "dirtyFiles": dirty_files,
    }


def capture_git_diff(directory: str | None) -> str | None:
    if not directory or not (Path(directory) / ".git").exists():
        return None
    try:
        r = subprocess.run(
            ["git", "-C", directory, "diff", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout
    except Exception:
        pass
    return None


def scan_database(db_path: Path) -> dict[str, Any]:
    con = open_readonly(db_path)
    try:
        cur = con.cursor()
        thread_counts: dict[str, int] = dict(
            cur.execute(
                "SELECT project_id, COUNT(*) FROM orchestration_v2_projection_threads "
                "WHERE deleted_at IS NULL GROUP BY project_id"
            ).fetchall()
        )

        projects: list[dict[str, Any]] = []
        project_titles: dict[str, str] = {}
        for row in cur.execute(
            "SELECT project_id, title, workspace_root, deleted_at, archived_at, created_at, updated_at "
            "FROM projection_projects ORDER BY updated_at DESC"
        ).fetchall():
            pid = row["project_id"]
            title = row["title"]
            root = row["workspace_root"]
            project_titles[pid] = title
            if row["deleted_at"] is not None:
                continue
            is_scratch = root.endswith("/.t3/scratch") or title == "No project"
            projects.append(
                {
                    "id": pid,
                    "title": title,
                    "workspaceRoot": root,
                    "isScratch": is_scratch,
                    "deletedAt": row["deleted_at"],
                    "archivedAt": row["archived_at"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                    "threadCount": thread_counts.get(pid, 0),
                    "git": inspect_git(root),
                }
            )

        msg_counts: dict[str, int] = {}
        att_counts: dict[str, int] = {}
        total_messages = 0
        total_attachments = 0
        for row in cur.execute(
            "SELECT thread_id, payload_json FROM orchestration_v2_projection_messages"
        ).fetchall():
            tid = row["thread_id"]
            msg_counts[tid] = msg_counts.get(tid, 0) + 1
            total_messages += 1
            try:
                payload = json.loads(row["payload_json"])
                atts = payload.get("attachments") or []
                if atts:
                    att_counts[tid] = att_counts.get(tid, 0) + len(atts)
                    total_attachments += len(atts)
            except Exception:
                pass

        item_counts: dict[str, int] = {}
        item_breakdowns: dict[str, dict[str, int]] = {}
        total_turn_items = 0
        for row in cur.execute(
            "SELECT thread_id, type, COUNT(*) AS cnt "
            "FROM orchestration_v2_projection_turn_items GROUP BY thread_id, type"
        ).fetchall():
            tid, kind, cnt = row["thread_id"], row["type"], row["cnt"]
            item_counts[tid] = item_counts.get(tid, 0) + cnt
            total_turn_items += cnt
            item_breakdowns.setdefault(tid, {})[kind] = cnt

        threads: list[dict[str, Any]] = []
        for row in cur.execute(
            "SELECT thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, "
            "created_at, updated_at, archived_at, payload_json, provider_instance_id "
            "FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC"
        ).fetchall():
            tid = row["thread_id"]
            pid = row["project_id"]
            payload = json.loads(row["payload_json"] or "{}")
            model = (payload.get("modelSelection") or {}).get("model")
            branch = payload.get("branch")
            wt_path = payload.get("worktreePath")
            wt_dirty = len(inspect_git(wt_path)["dirtyFiles"]) if wt_path else 0
            prs = []
            for pr in payload.get("pullRequests") or []:
                if pr.get("url"):
                    snap = pr.get("snapshot") or {}
                    prs.append(
                        {
                            "host": pr.get("host"),
                            "repository": pr.get("repository"),
                            "number": pr.get("number"),
                            "url": pr["url"],
                            "state": snap.get("state"),
                            "title": snap.get("title"),
                            "headBranch": snap.get("headBranch"),
                            "baseBranch": snap.get("baseBranch"),
                        }
                    )
            threads.append(
                {
                    "id": tid,
                    "projectId": pid,
                    "projectTitle": project_titles.get(pid, pid),
                    "title": row["title"],
                    "provider": row["default_provider"],
                    "providerInstanceId": row["provider_instance_id"] or row["default_provider"],
                    "model": model,
                    "runtimeMode": row["runtime_mode"],
                    "interactionMode": row["interaction_mode"],
                    "branch": branch,
                    "worktreePath": wt_path,
                    "worktreeDirtyCount": wt_dirty,
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                    "archivedAt": row["archived_at"],
                    "messageCount": msg_counts.get(tid, 0),
                    "turnItemCount": item_counts.get(tid, 0),
                    "attachmentCount": att_counts.get(tid, 0),
                    "pullRequests": prs,
                    "turnItemBreakdown": item_breakdowns.get(tid, {}),
                }
            )

        return {
            "dbPath": str(db_path),
            "dbSizeBytes": db_path.stat().st_size,
            "schemaVersion": "statev2 (orchestration_v2)",
            "scannedAt": utc_now(),
            "projects": projects,
            "threads": threads,
            "totalMessages": total_messages,
            "totalTurnItems": total_turn_items,
            "totalAttachments": total_attachments,
        }
    finally:
        con.close()


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n…(已截断，完整内容见 transcript.md)"


def render_transcript(summary: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    lines = [
        f"# T3 Code 会话完整归档：{summary['title']}",
        "",
        f"- Thread ID: `{summary['id']}`",
        f"- Project: `{summary['projectTitle']}`",
        f"- Provider / Model: `{summary['provider']}` / `{summary.get('model') or 'default'}`",
        f"- Branch: `{summary.get('branch') or '-'}`",
        f"- Updated: `{summary['updatedAt']}`",
        "",
        "---",
        "",
    ]
    for i, m in enumerate(messages, 1):
        role = "User" if m["role"] == "user" else "Assistant"
        lines.append(f"## {i}. {role} ({m['createdAt']})")
        lines.append("")
        lines.append(m["text"])
        lines.append("")
        if m["attachments"]:
            lines.append("附件：")
            for a in m["attachments"]:
                lines.append(f"- `{a['name']}` (`{a['id']}`)")
            lines.append("")
    return "\n".join(lines)


def render_handoff(
    summary: dict[str, Any],
    project: dict[str, Any] | None,
    messages: list[dict[str, Any]],
    has_dirty_patch: bool,
) -> str:
    first_user = next((truncate(m["text"], 600) for m in messages if m["role"] == "user"), summary["title"])
    last_assistant = next(
        (truncate(m["text"], 900) for m in reversed(messages) if m["role"] == "assistant"),
        "（无助手回复记录）",
    )
    pr_lines = []
    if summary["pullRequests"]:
        pr_lines.append("\n### 关联 Pull Requests")
        for pr in summary["pullRequests"]:
            pr_lines.append(
                f"- {pr['url']} (状态: {pr.get('state') or 'unknown'}, 分支: {pr.get('headBranch') or '-'} → {pr.get('baseBranch') or '-'})"
            )
    pr_block = "\n".join(pr_lines)
    dirty_line = (
        "- ⚠ 未提交改动：原工作区存在未提交 diff，已保存为 `dirty.patch`。"
        if has_dirty_patch
        else "- 工作区状态：干净（无未提交补丁）"
    )
    root = project["workspaceRoot"] if project else "-"
    return (
        "你正在接管一个从 **T3 Code** 迁移至 **Lody** 的历史工作会话，请基于以下上下文继续工作。\n\n"
        "### 会话元信息\n"
        f"- 原标题：{summary['title']}\n"
        f"- 原项目：{summary['projectTitle']} (`{root}`)\n"
        f"- 原分支：{summary.get('branch') or '-'}\n"
        f"- 原智能体 / 模型：{summary['provider']} / {summary.get('model') or 'default'}\n"
        f"- 历史消息数：{len(messages)} 条（完整归档已随迁移包导出至 `transcript.md`）\n"
        f"{dirty_line}\n"
        f"{pr_block}\n\n"
        "### 初始需求 / 目标\n"
        f"{first_user}\n\n"
        "### 最近一次助手进展摘要\n"
        f"{last_assistant}\n\n"
        "请先确认以上上下文已加载，等待我的下一步指示。"
    )


def load_thread_detail(db_path: Path, thread_id: str) -> dict[str, Any]:
    scan = scan_database(db_path)
    summary = next((t for t in scan["threads"] if t["id"] == thread_id), None)
    if not summary:
        raise KeyError(f"未找到会话: {thread_id}")
    project = next((p for p in scan["projects"] if p["id"] == summary["projectId"]), None)

    att_root = db_path.parent / "attachments"
    con = open_readonly(db_path)
    try:
        rows = con.execute(
            "SELECT message_id, role, created_at, payload_json "
            "FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY created_at ASC",
            (thread_id,),
        ).fetchall()
    finally:
        con.close()

    messages: list[dict[str, Any]] = []
    for r in rows:
        payload = json.loads(r["payload_json"] or "{}")
        atts = []
        for a in payload.get("attachments") or []:
            aid = a.get("id") or ""
            name = a.get("name") or "attachment"
            ext = name.rsplit(".", 1)[-1] if "." in name else "png"
            if len(ext) > 5:
                ext = "png"
            candidate = att_root / f"{aid}.{ext}"
            exists = candidate.exists()
            atts.append(
                {
                    "id": aid,
                    "name": name,
                    "mimeType": a.get("mimeType"),
                    "sizeBytes": a.get("sizeBytes"),
                    "localPath": str(candidate) if exists else None,
                    "exists": exists,
                }
            )
        messages.append(
            {
                "id": r["message_id"],
                "role": r["role"],
                "text": payload.get("text") or "",
                "createdAt": r["created_at"],
                "attachments": atts,
            }
        )

    diff_dir = summary.get("worktreePath") or (project["workspaceRoot"] if project else None)
    diff = capture_git_diff(diff_dir)
    return {
        "summary": summary,
        "messages": messages,
        "handoffMarkdown": render_handoff(summary, project, messages, diff is not None),
        "transcriptMarkdown": render_transcript(summary, messages),
        "uncommittedDiff": diff,
    }


def deterministic_op_id(thread_id: str) -> str:
    h = hashlib.sha256(f"t3-to-lody:{thread_id}".encode()).hexdigest()
    return f"t3mig-{h[:16]}"


def resolve_project_target(
    project: dict[str, Any],
    catalog: dict[str, Any],
    target_machine_id: str,
    overrides: dict[str, Any],
) -> tuple[str, Any, list[str]]:
    ov = overrides.get(project["id"])
    if ov:
        kind = ov.get("targetKind")
        if kind == "local":
            return "exact", {"kind": "local", "projectId": ov.get("targetProjectId")}, []
        if kind == "github":
            return "fallback", {"kind": "github", "repo": ov.get("targetRepo")}, ["使用手动指定的 GitHub 仓库 worktree"]
        if kind == "chat":
            return "exact", {"kind": "chat"}, []
        return "skipped", None, ["用户选择跳过该项目"]

    if project["isScratch"]:
        return "exact", {"kind": "chat"}, []

    for lp in catalog["projects"]:
        if (
            lp["kind"] == "local"
            and lp.get("machineId") == target_machine_id
            and lp.get("rootPath") == project["workspaceRoot"]
        ):
            return "exact", {"kind": "local", "projectId": lp["id"]}, []

    gh = project["git"].get("githubRepo")
    if gh:
        for gp in catalog["projects"]:
            if gp["kind"] == "github" and (gp.get("repoFullName") or "").lower() == gh.lower():
                return (
                    "fallback",
                    {"kind": "github", "repo": gp["repoFullName"]},
                    [f"本地目录 {project['workspaceRoot']} 尚未在目标机器注册，已自动降级匹配到 GitHub 仓库 {gp['repoFullName']}"],
                )

    return (
        "action_required",
        {"kind": "unregistered", "localRootPath": project["workspaceRoot"]},
        [f"项目 {project['title']} ({project['workspaceRoot']}) 未在 Lody 注册，请先在 Lody 添加该本地项目，或在页面中手动指定目标"],
    )


def resolve_agent_target(
    provider: str,
    model: str | None,
    runtime_mode: str,
    catalog: dict[str, Any],
    target_machine_id: str,
    overrides: dict[str, Any],
) -> tuple[str | None, str | None, str | None, list[str]]:
    key = f"{provider}::{model or 'default'}"
    ov = overrides.get(key)
    if ov:
        return ov.get("agentConfigId"), ov.get("modelId"), ov.get("modeId"), []

    norm = "codex" if provider.startswith("codex") else ("claude" if "claude" in provider else provider)
    configs = [c for c in catalog["agentConfigs"] if c["machineId"] == target_machine_id]
    cfg = next((c for c in configs if c["agentType"].lower() == norm.lower()), configs[0] if configs else None)
    if not cfg:
        return None, None, None, ["目标机器无可用 Agent Config"]

    warnings: list[str] = []
    if cfg["agentType"].lower() != norm.lower():
        warnings.append(f"原 Provider `{provider}` 在目标机器不可用，已降级为 `{cfg['name']}`")

    if model and model in cfg["models"]:
        resolved_model = model
    elif model:
        resolved_model = cfg["models"][0] if cfg["models"] else None
        warnings.append(f"模型 `{model}` 不在 {cfg['name']} 支持列表，已降级为 `{resolved_model or 'default'}`")
    else:
        resolved_model = cfg["models"][0] if cfg["models"] else None

    if runtime_mode == "full-access":
        if "agent-full-access" in cfg["modes"]:
            resolved_mode = "agent-full-access"
        elif "bypassPermissions" in cfg["modes"]:
            resolved_mode = "bypassPermissions"
        elif "accept-edits" in cfg["modes"]:
            resolved_mode = "accept-edits"
            warnings.append(f"权限模式差异：T3 `full-access` 在 {cfg['name']} 无完全对等项，已映射为 `accept-edits`")
        else:
            resolved_mode = cfg["modes"][0] if cfg["modes"] else None
    else:
        resolved_mode = cfg["modes"][0] if cfg["modes"] else None

    return cfg["id"], resolved_model, resolved_mode, warnings


def export_bundle(req: dict[str, Any]) -> dict[str, Any]:
    db_path = Path(req.get("dbPath") or DEFAULT_DB)
    out_dir = Path(req.get("outputDir") or DEFAULT_OUTPUT)
    target_machine_id = req["targetMachineId"]
    selected = set(req.get("selectedThreadIds") or [])
    include_archived = bool(req.get("includeArchived", False))
    project_overrides = req.get("projectOverrides") or {}
    agent_overrides = req.get("agentOverrides") or {}

    catalog = load_catalog()
    scan = scan_database(db_path)
    proj_map = {p["id"]: p for p in scan["projects"]}

    threads_dir = out_dir / "threads"
    threads_dir.mkdir(parents=True, exist_ok=True)

    files_written: list[str] = []
    lody_create_items: list[dict[str, Any]] = []
    lody_rename_items: list[dict[str, Any]] = []
    state_records: list[dict[str, Any]] = []

    exported_threads = 0
    ready_for_lody = 0
    action_required_count = 0
    warning_count = 0
    patches_saved = 0
    attachments_copied = 0

    for t in scan["threads"]:
        if selected and t["id"] not in selected:
            continue
        if not include_archived and t.get("archivedAt"):
            continue
        proj = proj_map.get(t["projectId"])
        if not proj:
            continue

        proj_status, work_context, warnings = resolve_project_target(
            proj, catalog, target_machine_id, project_overrides
        )
        if proj_status == "skipped":
            continue
        if proj_status == "action_required":
            action_required_count += 1
        if t.get("branch") and isinstance(work_context, dict) and work_context.get("kind") != "chat":
            work_context = {**work_context, "branch": t["branch"]}

        agent_id, model_id, mode_id, agent_warnings = resolve_agent_target(
            t["provider"], t.get("model"), t["runtimeMode"], catalog, target_machine_id, agent_overrides
        )
        warnings.extend(agent_warnings)
        warning_count += len(warnings)

        detail = load_thread_detail(db_path, t["id"])
        t_dir = threads_dir / t["id"]
        t_dir.mkdir(parents=True, exist_ok=True)

        raw_p = t_dir / "raw.json"
        trans_p = t_dir / "transcript.md"
        handoff_p = t_dir / "handoff.md"
        raw_p.write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")
        trans_p.write_text(detail["transcriptMarkdown"], encoding="utf-8")
        handoff_p.write_text(detail["handoffMarkdown"], encoding="utf-8")
        files_written.extend([str(raw_p), str(trans_p), str(handoff_p)])

        if detail["uncommittedDiff"]:
            patch_p = t_dir / "dirty.patch"
            patch_p.write_text(detail["uncommittedDiff"], encoding="utf-8")
            files_written.append(str(patch_p))
            patches_saved += 1

        att_dir = t_dir / "attachments"
        for m in detail["messages"]:
            for a in m["attachments"]:
                if a.get("localPath") and Path(a["localPath"]).exists():
                    att_dir.mkdir(parents=True, exist_ok=True)
                    dst = att_dir / f"{a['id']}_{a['name']}"
                    shutil.copy2(a["localPath"], dst)
                    attachments_copied += 1

        op_id = deterministic_op_id(t["id"])
        ready = proj_status != "action_required" and agent_id is not None
        if ready:
            ready_for_lody += 1
            item: dict[str, Any] = {
                "operationId": op_id,
                "label": t["title"][:120],
                "machineId": target_machine_id,
                "agentConfigId": agent_id,
                "useCurrentSessionAsParent": False,
                "workContext": work_context,
                "prompt": detail["handoffMarkdown"],
                "attachments": [str(trans_p)],
            }
            if model_id:
                item["modelId"] = model_id
            if mode_id:
                item["modeId"] = mode_id
            lody_create_items.append(item)
            lody_rename_items.append(
                {
                    "sourceThreadId": t["id"],
                    "operationId": op_id,
                    "title": t["title"][:200],
                }
            )

        state_records.append(
            {
                "sourceThreadId": t["id"],
                "sourceProjectId": t["projectId"],
                "operationId": op_id,
                "status": "planned_ready" if ready else "action_required",
                "warnings": warnings,
                "lodySessionId": None,
                "exportedAt": utc_now(),
            }
        )
        exported_threads += 1

    manifest_p = out_dir / "manifest.json"
    manifest_p.write_text(
        json.dumps(
            {
                "formatVersion": "1.0.0",
                "source": "t3-code",
                "target": "lody",
                "sourceDbPath": scan["dbPath"],
                "targetMachineId": target_machine_id,
                "exportedAt": utc_now(),
                "projects": scan["projects"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    batch_p = out_dir / "lody-mcp-batch.json"
    batch_p.write_text(
        json.dumps(
            {
                "generatedAt": utc_now(),
                "createSessions": lody_create_items,
                "renameSessions": lody_rename_items,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    state_p = out_dir / "migration-state.json"
    state_p.write_text(
        json.dumps(
            {
                "version": 1,
                "updatedAt": utc_now(),
                "records": state_records,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    files_written.extend([str(manifest_p), str(batch_p), str(state_p)])
    return {
        "outputDir": str(out_dir),
        "exportedThreads": exported_threads,
        "readyForLody": ready_for_lody,
        "actionRequiredCount": action_required_count,
        "warningCount": warning_count,
        "patchesSaved": patches_saved,
        "attachmentsCopied": attachments_copied,
        "filesWritten": files_written,
        "lodyBatchPath": str(batch_p),
        "statePath": str(state_p),
    }


class BridgeHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "runtime": "web-bridge",
                        "defaultDbPath": str(DEFAULT_DB),
                        "defaultOutputDir": str(DEFAULT_OUTPUT),
                    },
                )
            elif parsed.path == "/api/scan":
                db = Path(qs["dbPath"][0]) if "dbPath" in qs and qs["dbPath"][0] else DEFAULT_DB
                self._send_json(200, scan_database(db))
            elif parsed.path == "/api/catalog":
                self._send_json(200, load_catalog())
            elif parsed.path.startswith("/api/thread/"):
                tid = parsed.path[len("/api/thread/") :]
                db = Path(qs["dbPath"][0]) if "dbPath" in qs and qs["dbPath"][0] else DEFAULT_DB
                self._send_json(200, load_thread_detail(db, tid))
            else:
                self._send_json(404, {"error": f"Unknown endpoint: {parsed.path}"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            body = json.loads(raw)
            if parsed.path == "/api/export":
                self._send_json(200, export_bundle(body))
            else:
                self._send_json(404, {"error": f"Unknown endpoint: {parsed.path}"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def log_message(self, fmt: str, *args: Any) -> None:
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), BridgeHandler)
    print(f"T3->Lody bridge listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
