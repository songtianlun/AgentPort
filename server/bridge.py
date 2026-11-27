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
import socket
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


def normalize_path(p: str | None) -> str:
    if not p:
        return ""
    try:
        resolved = str(Path(p).expanduser().resolve())
    except Exception:
        resolved = str(Path(p).expanduser())
    return resolved.rstrip("/\\") or resolved


def _find_running_daemon() -> dict[str, Any] | None:
    candidates = []
    env_dir = os.environ.get("LODY_DATA_DIR", "").strip()
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.extend([Path.home() / ".lody", Path.home() / ".lody-oss"])
    for d in candidates:
        rf = d / "run" / "daemon.json"
        if rf.exists():
            try:
                data = json.loads(rf.read_text(encoding="utf-8"))
                if data.get("socketPath") and data.get("controlSocketPath"):
                    data["_dataDir"] = d
                    return data
            except Exception:
                continue
    return None


def _unix_http_json(
    sock_path: str, method: str, path: str, token: str | None, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = json.dumps(body).encode("utf-8") if body is not None else b""
    headers = [f"{method} {path} HTTP/1.1", "Host: localhost", "Connection: close"]
    if token:
        headers.append(f"x-lody-local-token: {token}")
    if method == "POST":
        headers.append("x-lody-local-control: 1")
        headers.append("content-type: application/json")
        headers.append(f"content-length: {len(payload)}")
    req = ("\r\n".join(headers) + "\r\n\r\n").encode("utf-8") + payload
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(sock_path)
        s.sendall(req)
        chunks = []
        while True:
            b = s.recv(65536)
            if not b:
                break
            chunks.append(b)
    raw = b"".join(chunks)
    head, _, rest = raw.partition(b"\r\n\r\n")
    head_str = head.decode("utf-8", errors="replace")
    if "transfer-encoding: chunked" in head_str.lower():
        decoded = bytearray()
        idx = 0
        while idx < len(rest):
            nl = rest.find(b"\r\n", idx)
            if nl == -1:
                break
            size = int(rest[idx:nl].decode().split(";")[0], 16)
            if size == 0:
                break
            start = nl + 2
            decoded.extend(rest[start : start + size])
            idx = start + size + 2
        rest = bytes(decoded)
    return json.loads(rest.decode("utf-8"))


def _detect_local_agents(data_dir: Path, machine_id: str) -> list[dict[str, Any]]:
    bin_dir = data_dir / "bin"
    found: set[str] = set()
    if bin_dir.is_dir():
        for p in bin_dir.iterdir():
            n = p.name.lower()
            if "antigravity" in n or n == "agy":
                found.add("antigravity")
            elif "claude" in n:
                found.add("claude")
            elif "codex" in n:
                found.add("codex")
    if not found:
        found = {"antigravity", "claude", "codex"}
    res: list[dict[str, Any]] = []
    if "antigravity" in found:
        res.append(
            {
                "id": f"local-antigravity-{machine_id}",
                "name": "Antigravity",
                "machineId": machine_id,
                "agentType": "antigravity",
                "available": True,
                "modes": ["default", "accept-edits", "plan"],
                "models": [
                    "gemini-4-neon",
                    "gemini-4-carbon",
                    "gemini-4-argon",
                    "gemini-4-hydrogen",
                    "claude-opus-5-5",
                    "claude-sonnet-5-5",
                ],
                "planMode": True,
                "fastMode": False,
            }
        )
    if "claude" in found:
        res.append(
            {
                "id": f"local-claude-{machine_id}",
                "name": "Claude Code",
                "machineId": machine_id,
                "agentType": "claude",
                "available": True,
                "modes": ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
                "models": ["default", "opus", "sonnet", "haiku"],
                "planMode": True,
                "fastMode": True,
            }
        )
    if "codex" in found:
        res.append(
            {
                "id": f"local-codex-{machine_id}",
                "name": "Codex",
                "machineId": machine_id,
                "agentType": "codex",
                "available": True,
                "modes": ["read-only", "agent", "agent-auto-review", "agent-full-access"],
                "models": ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.4"],
                "planMode": True,
                "fastMode": True,
            }
        )
    return res


SAFE_DAEMON_ENV_KEYS = {
    "LODY_PLATFORM",
    "LODY_AUTH_URL",
    "LODY_AUTH_SITE_URL",
    "LODY_SERVER_URL",
    "LODY_ENV",
    "LODY_DATA_DIR",
    "LODY_LORO_STREAMS_WS_ENABLED",
}


def _collect_lody_cli_env(daemon: dict[str, Any] | None) -> dict[str, str]:
    extra: dict[str, str] = {}
    if daemon and daemon.get("pid"):
        env_p = Path(f"/proc/{daemon['pid']}/environ")
        if env_p.exists():
            try:
                for item in env_p.read_bytes().split(b"\x00"):
                    if not item:
                        continue
                    k, _, v = item.decode("utf-8", errors="replace").partition("=")
                    if k in SAFE_DAEMON_ENV_KEYS and v:
                        extra[k] = v
            except Exception:
                pass
    for k, v in (
        ("LODY_PLATFORM", "cloud"),
        ("LODY_AUTH_URL", "https://convex.lody.ai"),
        ("LODY_AUTH_SITE_URL", "https://backend.lody.ai"),
        ("LODY_SERVER_URL", "https://api.lody.ai"),
    ):
        if k not in extra and not os.environ.get(k):
            extra[k] = v
    return extra


def _find_lody_cli_command(daemon: dict[str, Any] | None) -> tuple[list[str], dict[str, str]] | None:
    inherited = _collect_lody_cli_env(daemon)
    which_lody = shutil.which("lody")
    if which_lody:
        return [which_lody], inherited
    for cand in [
        Path.home() / ".local" / "bin" / "lody",
        Path.home() / ".lody" / "daemon-managed" / "service",
        Path("/usr/local/bin/lody"),
        Path("/opt/homebrew/bin/lody"),
    ]:
        if cand.exists():
            return [str(cand)], inherited
    if daemon and daemon.get("pid"):
        proc_cmd = Path(f"/proc/{daemon['pid']}/cmdline")
        if proc_cmd.exists():
            try:
                parts = [p.decode("utf-8", errors="replace") for p in proc_cmd.read_bytes().split(b"\x00") if p]
                cli_js = next((a for a in parts[1:] if a.endswith("cli/index.js")), None)
                if parts and cli_js and Path(parts[0]).exists() and Path(cli_js).exists():
                    return [parts[0], cli_js], {**inherited, "ELECTRON_RUN_AS_NODE": "1"}
            except Exception:
                pass
    return None


def _run_lody_cli_json(cli: tuple[list[str], dict[str, str]], args: list[str]) -> dict[str, Any]:
    prefix, extra_env = cli
    env = {**os.environ, **extra_env}
    r = subprocess.run([*prefix, *args], env=env, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        detail = (r.stderr.strip() or r.stdout.strip())[:500]
        raise RuntimeError(f"Lody CLI 执行失败 (exit {r.returncode}): {detail}")
    decoder = json.JSONDecoder()
    first_valid: dict[str, Any] | None = None
    pos = 0
    while True:
        idx = r.stdout.find("{", pos)
        if idx < 0:
            break
        try:
            obj, end = decoder.raw_decode(r.stdout, idx)
            if isinstance(obj, dict):
                if any(k in obj for k in ("ok", "sessionId", "items")):
                    return obj
                if first_valid is None:
                    first_valid = obj
            pos = end
        except Exception:
            pos = idx + 1
    if first_valid is not None:
        return first_valid
    raise RuntimeError(f"Lody CLI 未返回有效 JSON: {r.stdout[:300]}")


def _discover_live_catalog() -> dict[str, Any] | None:
    daemon = _find_running_daemon()
    if not daemon:
        return None
    try:
        health = _unix_http_json(daemon["socketPath"], "GET", "/healthz", daemon.get("token"))
        machine_id = health["machineId"]
        cli_ver = health.get("cliVersion") or daemon.get("version") or "unknown"
        state = _unix_http_json(daemon["socketPath"], "GET", "/state", daemon.get("token"))
        ws_list = state.get("connectedWorkspaces") or []
        workspace_id = ws_list[0]["id"] if ws_list else "local-workspace"
        ws_name = ws_list[0].get("name") if ws_list else workspace_id

        proj_resp = _unix_http_json(
            daemon["controlSocketPath"],
            "POST",
            "/project-control",
            daemon.get("token"),
            {"type": "local-project/list", "machineId": machine_id},
        )
        projects: list[dict[str, Any]] = []
        for ws in (proj_resp.get("result") or {}).get("workspaces") or []:
            if workspace_id == "local-workspace" and ws.get("workspaceId"):
                workspace_id = ws["workspaceId"]
                ws_name = ws.get("workspaceName") or workspace_id
            for p in ws.get("projects") or []:
                projects.append(
                    {
                        "id": p["localProjectId"],
                        "name": p.get("name") or p["localProjectId"],
                        "kind": "local",
                        "machineId": machine_id,
                        "rootPath": p.get("rootPath"),
                        "repoFullName": None,
                        "available": True,
                    }
                )
        machines = [{"id": machine_id, "name": socket.gethostname(), "onlineStatus": "online"}]
        agent_configs = _detect_local_agents(daemon["_dataDir"], machine_id)
        source = "lody-daemon-ipc"
        cli = _find_lody_cli_command(daemon)
        if cli:
            try:
                a_json = _run_lody_cli_json(
                    cli, ["agent-config", "list", "--offline", "--json", "--all-pages"]
                )
                cli_agents = []
                for a in a_json.get("items") or []:
                    rc = a.get("runConfig") or {}
                    cli_agents.append(
                        {
                            "id": a["id"],
                            "name": a["name"],
                            "machineId": a["machineId"],
                            "agentType": a.get("agentType") or "unknown",
                            "available": (a.get("availability") or {}).get("state") == "available",
                            "modes": [m["id"] for m in rc.get("modes") or []],
                            "models": [m["id"] for m in rc.get("models") or []],
                            "planMode": bool(rc.get("planMode")),
                            "fastMode": bool(rc.get("fastMode")),
                        }
                    )
                if cli_agents:
                    agent_configs = cli_agents
                    source = "lody-daemon+cli"
            except Exception:
                pass

        return {
            "workspaceId": workspace_id,
            "defaultMachineId": machine_id,
            "machines": machines,
            "projects": projects,
            "agentConfigs": agent_configs,
            "source": source,
            "sourceDetail": f"已实时连接本机 Lody Daemon (v{cli_ver}) · 工作区「{ws_name}」· 发现 {len(projects)} 个本地项目",
            "daemonConnected": True,
        }
    except Exception:
        return None


def _merge_catalogs(live: dict[str, Any], file_cat: dict[str, Any]) -> dict[str, Any]:
    file_m_names = {m["id"]: m["name"] for m in file_cat.get("machines") or []}
    for m in live["machines"]:
        if m["id"] in file_m_names:
            m["name"] = file_m_names[m["id"]]
    seen_m = {m["id"] for m in live["machines"]}
    for m in file_cat.get("machines") or []:
        if m["id"] not in seen_m:
            live["machines"].append(m)
            seen_m.add(m["id"])

    seen_p = {p["id"] for p in live["projects"]}
    for p in file_cat.get("projects") or []:
        if p["id"] not in seen_p:
            live["projects"].append(p)
            seen_p.add(p["id"])

    file_agents = file_cat.get("agentConfigs") or []
    has_file_for_default = any(a.get("machineId") == live["defaultMachineId"] for a in file_agents)
    if has_file_for_default and all(a["id"].startswith("local-") for a in live["agentConfigs"]):
        live["agentConfigs"] = file_agents
    else:
        seen_a = {a["id"] for a in live["agentConfigs"]}
        for a in file_agents:
            if a["id"] not in seen_a:
                live["agentConfigs"].append(a)
                seen_a.add(a["id"])
    return live


def load_catalog() -> dict[str, Any]:
    file_cat: dict[str, Any] | None = None
    for cand in [Path.home() / ".agentport" / "lody-catalog.json", DEFAULT_CATALOG]:
        if cand.exists():
            try:
                file_cat = json.loads(cand.read_text(encoding="utf-8"))
                file_cat.setdefault("source", "local-file")
                file_cat.setdefault("sourceDetail", f"从本地快照加载: {cand}")
                file_cat.setdefault("daemonConnected", False)
                break
            except Exception:
                pass

    live = _discover_live_catalog()
    if live:
        return _merge_catalogs(live, file_cat) if file_cat else live
    if file_cat:
        return file_cat

    fallback = json.loads(EXAMPLE_CATALOG.read_text(encoding="utf-8"))
    fallback["source"] = "example-fallback"
    fallback["sourceDetail"] = "未检测到本机运行中的 Lody Desktop / Daemon，当前仅显示示例数据。"
    fallback["daemonConnected"] = False
    return fallback


def register_lody_local_project(root_path: str, workspace_id: str | None = None) -> dict[str, Any]:
    daemon = _find_running_daemon()
    if not daemon:
        raise RuntimeError("未检测到本机运行中的 Lody Desktop / Daemon，无法自动注册项目")
    health = _unix_http_json(daemon["socketPath"], "GET", "/healthz", daemon.get("token"))
    machine_id = health["machineId"]
    resolved = normalize_path(root_path)
    req: dict[str, Any] = {
        "type": "local-project/add",
        "machineId": machine_id,
        "rootPath": resolved,
    }
    if workspace_id:
        req["workspace"] = workspace_id
    resp = _unix_http_json(
        daemon["controlSocketPath"], "POST", "/project-control", daemon.get("token"), req
    )
    if not resp.get("ok"):
        raise RuntimeError(resp.get("message") or resp.get("error") or "Lody 注册项目失败")
    res = resp.get("result") or {}
    return {
        "id": res.get("localProjectId") or "local-project-added",
        "name": res.get("name") or Path(resolved).name,
        "kind": "local",
        "machineId": machine_id,
        "rootPath": res.get("rootPath") or resolved,
        "repoFullName": None,
        "available": True,
    }


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

    target_root_norm = normalize_path(project["workspaceRoot"])
    for lp in catalog["projects"]:
        if (
            lp["kind"] == "local"
            and lp.get("machineId") == target_machine_id
            and normalize_path(lp.get("rootPath")) == target_root_norm
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


def load_migration_state(output_dir: str) -> list[dict[str, Any]]:
    state_p = Path(output_dir).expanduser() / "migration-state.json"
    if not state_p.exists():
        return []
    try:
        return json.loads(state_p.read_text(encoding="utf-8")).get("records") or []
    except Exception:
        return []


def save_migration_state(state_p: Path, records: list[dict[str, Any]]) -> None:
    tmp = state_p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"version": 1, "updatedAt": utc_now(), "records": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(state_p)


def export_bundle(req: dict[str, Any]) -> dict[str, Any]:
    db_path = Path(req["dbPath"]).expanduser() if req.get("dbPath") else DEFAULT_DB
    out_dir = Path(req["outputDir"]).expanduser() if req.get("outputDir") else DEFAULT_OUTPUT
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

    existing_by_tid = {r["sourceThreadId"]: r for r in load_migration_state(str(out_dir))}
    seen_tids: set[str] = set()

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
        agent_name = next((c["name"] for c in catalog["agentConfigs"] if c["id"] == agent_id), None)

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
        attach_paths = [str(trans_p)]

        if detail["uncommittedDiff"]:
            patch_p = t_dir / "dirty.patch"
            patch_p.write_text(detail["uncommittedDiff"], encoding="utf-8")
            files_written.append(str(patch_p))
            attach_paths.append(str(patch_p))
            patches_saved += 1

        att_dir = t_dir / "attachments"
        for m in detail["messages"]:
            for a in m["attachments"]:
                if a.get("localPath") and Path(a["localPath"]).exists():
                    att_dir.mkdir(parents=True, exist_ok=True)
                    dst = att_dir / f"{a['id']}_{a['name']}"
                    shutil.copy2(a["localPath"], dst)
                    attachments_copied += 1
                    if len(attach_paths) < 8:
                        attach_paths.append(str(dst))

        op_id = deterministic_op_id(t["id"])
        ready = proj_status != "action_required" and agent_id is not None
        if ready:
            ready_for_lody += 1
            item: dict[str, Any] = {
                "sourceThreadId": t["id"],
                "operationId": op_id,
                "title": t["title"][:200],
                "label": t["title"][:120],
                "workspaceId": catalog["workspaceId"],
                "machineId": target_machine_id,
                "agentConfigId": agent_id,
                "agentName": agent_name,
                "useCurrentSessionAsParent": False,
                "workContext": work_context,
                "promptFile": str(handoff_p),
                "prompt": detail["handoffMarkdown"],
                "attachments": attach_paths,
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

        seen_tids.add(t["id"])
        old = existing_by_tid.get(t["id"])
        if old and old.get("status") == "imported" and old.get("lodySessionId"):
            state_records.append({**old, "title": t["title"], "warnings": warnings, "exportedAt": utc_now()})
        else:
            state_records.append(
                {
                    "sourceThreadId": t["id"],
                    "sourceProjectId": t["projectId"],
                    "title": t["title"],
                    "operationId": op_id,
                    "status": "planned_ready" if ready else "action_required",
                    "warnings": warnings,
                    "lodySessionId": None,
                    "lastError": None,
                    "exportedAt": utc_now(),
                    "importedAt": None,
                }
            )
        exported_threads += 1

    for tid, old in existing_by_tid.items():
        if tid not in seen_tids and old.get("status") == "imported":
            state_records.append(old)

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
    save_migration_state(state_p, state_records)

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


def import_to_lody(req: dict[str, Any]) -> dict[str, Any]:
    daemon = _find_running_daemon()
    cli = _find_lody_cli_command(daemon)
    if not cli:
        raise RuntimeError("未找到本机可用的 Lody CLI（请确认 Lody Desktop 正在运行，或已将 lody 加入 PATH）")

    export_res = export_bundle(req["exportRequest"])
    batch = json.loads(Path(export_res["lodyBatchPath"]).read_text(encoding="utf-8"))
    create_items = batch.get("createSessions") or []
    state_p = Path(export_res["statePath"])
    state_records = load_migration_state(export_res["outputDir"])

    max_count = req.get("maxCount")
    force_reimport = bool(req.get("forceReimport", False))

    items_out = []
    imported_now = 0
    skipped_already_imported = 0
    skipped_not_ready = export_res["actionRequiredCount"]
    failed = 0
    attempted = 0

    for item in create_items:
        tid = item.get("sourceThreadId") or ""
        op_id = item.get("operationId") or ""
        title = item.get("title") or "Imported Session"
        rec = next((r for r in state_records if r["sourceThreadId"] == tid), None)
        if rec and not force_reimport and rec.get("status") == "imported" and rec.get("lodySessionId"):
            skipped_already_imported += 1
            items_out.append(
                {
                    "sourceThreadId": tid,
                    "title": title,
                    "operationId": op_id,
                    "status": "skipped_imported",
                    "lodySessionId": rec["lodySessionId"],
                    "message": "已在历史迁移中导入，自动幂等跳过",
                }
            )
            continue

        if max_count is not None and attempted >= int(max_count):
            break
        attempted += 1

        args = ["session", "create", "--json"]
        ws = item.get("workspaceId")
        if ws and ws != "local-workspace":
            args += ["--workspace", ws]
        if item.get("machineId"):
            args += ["--machine", item["machineId"]]
        agent_sel = item.get("agentConfigId")
        if not agent_sel or str(agent_sel).startswith("local-"):
            agent_sel = item.get("agentName")
        if agent_sel:
            args += ["--agent", agent_sel]
        args += ["--title", title]

        wc = item.get("workContext") or {}
        if wc.get("kind") == "local" and wc.get("projectId"):
            args += ["--local-project", wc["projectId"]]
            if wc.get("branch"):
                args += ["--branch", wc["branch"]]
        elif wc.get("kind") == "github" and wc.get("repo"):
            args += ["--repo", wc["repo"]]
            if wc.get("branch"):
                args += ["--branch", wc["branch"]]

        if item.get("modelId"):
            args += ["--model", item["modelId"]]
        if item.get("modeId"):
            args += ["--mode", item["modeId"]]
        for ap in item.get("attachments") or []:
            if Path(ap).exists():
                args += ["--attach", ap]
        if item.get("promptFile"):
            args += ["--prompt-file", item["promptFile"]]

        try:
            resp = _run_lody_cli_json(cli, args)
            sid = resp.get("sessionId")
            if resp.get("ok") and sid:
                imported_now += 1
                if rec:
                    rec["status"] = "imported"
                    rec["lodySessionId"] = sid
                    rec["lastError"] = None
                    rec["importedAt"] = utc_now()
                save_migration_state(state_p, state_records)
                items_out.append(
                    {
                        "sourceThreadId": tid,
                        "title": title,
                        "operationId": op_id,
                        "status": "imported",
                        "lodySessionId": sid,
                        "message": "导入成功",
                    }
                )
            else:
                raise RuntimeError(resp.get("error") or resp.get("message") or "Lody 返回非成功状态")
        except Exception as exc:
            failed += 1
            if rec:
                rec["status"] = "failed"
                rec["lastError"] = str(exc)
            save_migration_state(state_p, state_records)
            items_out.append(
                {
                    "sourceThreadId": tid,
                    "title": title,
                    "operationId": op_id,
                    "status": "failed",
                    "lodySessionId": None,
                    "message": str(exc),
                }
            )

    return {
        "outputDir": export_res["outputDir"],
        "statePath": export_res["statePath"],
        "totalConsidered": len(create_items),
        "importedNow": imported_now,
        "skippedAlreadyImported": skipped_already_imported,
        "skippedNotReady": skipped_not_ready,
        "failed": failed,
        "items": items_out,
        "stateRecords": state_records,
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
                db = Path(qs["dbPath"][0]).expanduser() if "dbPath" in qs and qs["dbPath"][0] else DEFAULT_DB
                self._send_json(200, scan_database(db))
            elif parsed.path == "/api/catalog":
                self._send_json(200, load_catalog())
            elif parsed.path == "/api/state":
                out_dir = qs["outputDir"][0] if "outputDir" in qs and qs["outputDir"][0] else str(DEFAULT_OUTPUT)
                self._send_json(200, load_migration_state(out_dir))
            elif parsed.path.startswith("/api/thread/"):
                tid = parsed.path[len("/api/thread/") :]
                db = Path(qs["dbPath"][0]).expanduser() if "dbPath" in qs and qs["dbPath"][0] else DEFAULT_DB
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
            elif parsed.path == "/api/import-lody":
                self._send_json(200, import_to_lody(body))
            elif parsed.path == "/api/lody/register-project":
                self._send_json(
                    200,
                    register_lody_local_project(body["rootPath"], body.get("workspaceId")),
                )
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
