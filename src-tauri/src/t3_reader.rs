use crate::models::*;
use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn expand_tilde(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    PathBuf::from(trimmed)
}

pub fn default_db_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let v2 = home.join(".t3/userdata/statev2.sqlite");
    if v2.exists() {
        return v2;
    }
    let v1 = home.join(".t3/userdata/state.sqlite");
    if v1.exists() {
        return v1;
    }
    v2
}

pub fn default_output_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AgentPort-migration-bundle")
}

pub fn resolve_db_path(db_path: Option<&str>) -> PathBuf {
    match db_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => expand_tilde(raw),
        None => default_db_path(),
    }
}

pub fn attachments_dir_for_db(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("attachments")
}

pub fn open_readonly(db_path: &Path) -> Result<Connection, String> {
    if !db_path.exists() {
        return Err(format!("T3 Code 数据库不存在: {}", db_path.display()));
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("以只读模式打开 SQLite 失败: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Ok(conn)
}

pub fn parse_github_repo(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches(".git");
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return Some(rest.to_string());
    }
    if let Some(idx) = trimmed.find("github.com/") {
        return Some(trimmed[idx + "github.com/".len()..].to_string());
    }
    None
}

pub fn inspect_git(dir: &str) -> GitInfo {
    let path = Path::new(dir);
    if !path.is_dir() {
        return GitInfo {
            exists: false,
            is_git_repo: false,
            remote_origin: None,
            github_repo: None,
            current_branch: None,
            dirty_files: vec![],
        };
    }
    let is_git = path.join(".git").exists();
    if !is_git {
        return GitInfo {
            exists: true,
            is_git_repo: false,
            remote_origin: None,
            github_repo: None,
            current_branch: None,
            dirty_files: vec![],
        };
    }
    let run_git = |args: &[&str]| -> Option<String> {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let remote_origin = run_git(&["remote", "get-url", "origin"]);
    let github_repo = remote_origin.as_deref().and_then(parse_github_repo);
    let current_branch = run_git(&["branch", "--show-current"]);
    let dirty_files = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()
        })
        .unwrap_or_default();

    GitInfo {
        exists: true,
        is_git_repo: true,
        remote_origin,
        github_repo,
        current_branch,
        dirty_files,
    }
}

pub fn capture_git_diff(dir: &str) -> Option<String> {
    let path = Path::new(dir);
    if !path.join(".git").exists() {
        return None;
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["diff", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

pub fn scan_database(db_path: &Path) -> Result<T3ScanResult, String> {
    let conn = open_readonly(db_path)?;
    let db_size_bytes = fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

    // Load thread counts per project
    let mut thread_counts: HashMap<String, usize> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT project_id, COUNT(*) FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL GROUP BY project_id")
            .map_err(|e| format!("查询 threads 计数失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            thread_counts.insert(row.0, row.1);
        }
    }

    // Load projects
    let mut projects = Vec::new();
    let mut project_titles: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT project_id, title, workspace_root, deleted_at, archived_at, created_at, updated_at FROM projection_projects ORDER BY updated_at DESC")
            .map_err(|e| format!("查询 projects 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                let workspace_root: String = r.get(2)?;
                let deleted_at: Option<String> = r.get(3)?;
                let archived_at: Option<String> = r.get(4)?;
                let created_at: String = r.get(5)?;
                let updated_at: String = r.get(6)?;
                Ok((id, title, workspace_root, deleted_at, archived_at, created_at, updated_at))
            })
            .map_err(|e| e.to_string())?;

        for row in rows.flatten() {
            let (id, title, workspace_root, deleted_at, archived_at, created_at, updated_at) = row;
            project_titles.insert(id.clone(), title.clone());
            if deleted_at.is_some() {
                continue;
            }
            let is_scratch = workspace_root.ends_with("/.t3/scratch") || title == "No project";
            let git = inspect_git(&workspace_root);
            let tc = *thread_counts.get(&id).unwrap_or(&0);
            projects.push(T3Project {
                id,
                title,
                workspace_root,
                is_scratch,
                deleted_at,
                archived_at,
                created_at,
                updated_at,
                thread_count: tc,
                git,
            });
        }
    }

    // Preload message counts & attachment counts per thread
    let mut msg_counts: HashMap<String, usize> = HashMap::new();
    let mut att_counts: HashMap<String, usize> = HashMap::new();
    let mut total_messages = 0usize;
    let mut total_attachments = 0usize;
    {
        let mut stmt = conn
            .prepare("SELECT thread_id, payload_json FROM orchestration_v2_projection_messages")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            let (tid, payload_str) = row;
            *msg_counts.entry(tid.clone()).or_insert(0) += 1;
            total_messages += 1;
            if let Ok(v) = serde_json::from_str::<Value>(&payload_str) {
                if let Some(arr) = v.get("attachments").and_then(|a| a.as_array()) {
                    let n = arr.len();
                    if n > 0 {
                        *att_counts.entry(tid).or_insert(0) += n;
                        total_attachments += n;
                    }
                }
            }
        }
    }

    // Preload turn item breakdowns per thread
    let mut item_counts: HashMap<String, usize> = HashMap::new();
    let mut item_breakdowns: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let mut total_turn_items = 0usize;
    {
        let mut stmt = conn
            .prepare("SELECT thread_id, type, COUNT(*) FROM orchestration_v2_projection_turn_items GROUP BY thread_id, type")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, usize>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            let (tid, kind, cnt) = row;
            *item_counts.entry(tid.clone()).or_insert(0) += cnt;
            total_turn_items += cnt;
            item_breakdowns.entry(tid).or_default().insert(kind, cnt);
        }
    }

    // Load threads
    let mut threads = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, payload_json, provider_instance_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC")
            .map_err(|e| format!("查询 threads 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows.flatten() {
            let (
                id,
                project_id,
                title,
                default_provider,
                runtime_mode,
                interaction_mode,
                created_at,
                updated_at,
                archived_at,
                payload_str,
                provider_instance_id,
            ) = row;
            let payload: Value = serde_json::from_str(&payload_str).unwrap_or(Value::Null);
            let model = payload
                .pointer("/modelSelection/model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let branch = payload
                .get("branch")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let worktree_path = payload
                .get("worktreePath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let worktree_dirty_count = worktree_path
                .as_deref()
                .map(|w| inspect_git(w).dirty_files.len())
                .unwrap_or(0);

            let mut pull_requests = Vec::new();
            if let Some(arr) = payload.get("pullRequests").and_then(|v| v.as_array()) {
                for pr in arr {
                    if let Some(url) = pr.get("url").and_then(|v| v.as_str()) {
                        pull_requests.push(T3PullRequest {
                            host: pr.get("host").and_then(|v| v.as_str()).map(String::from),
                            repository: pr.get("repository").and_then(|v| v.as_str()).map(String::from),
                            number: pr.get("number").and_then(|v| v.as_i64()),
                            url: url.to_string(),
                            state: pr.pointer("/snapshot/state").and_then(|v| v.as_str()).map(String::from),
                            title: pr.pointer("/snapshot/title").and_then(|v| v.as_str()).map(String::from),
                            head_branch: pr.pointer("/snapshot/headBranch").and_then(|v| v.as_str()).map(String::from),
                            base_branch: pr.pointer("/snapshot/baseBranch").and_then(|v| v.as_str()).map(String::from),
                        });
                    }
                }
            }

            let project_title = project_titles
                .get(&project_id)
                .cloned()
                .unwrap_or_else(|| project_id.clone());

            threads.push(T3ThreadSummary {
                id: id.clone(),
                project_id,
                project_title,
                title,
                provider: default_provider.clone(),
                provider_instance_id: provider_instance_id.unwrap_or(default_provider),
                model,
                runtime_mode,
                interaction_mode,
                branch,
                worktree_path,
                worktree_dirty_count,
                created_at,
                updated_at,
                archived_at,
                message_count: *msg_counts.get(&id).unwrap_or(&0),
                turn_item_count: *item_counts.get(&id).unwrap_or(&0),
                attachment_count: *att_counts.get(&id).unwrap_or(&0),
                pull_requests,
                turn_item_breakdown: item_breakdowns.remove(&id).unwrap_or_default(),
            });
        }
    }

    Ok(T3ScanResult {
        db_path: db_path.display().to_string(),
        db_size_bytes,
        schema_version: "statev2 (orchestration_v2)".to_string(),
        scanned_at: Utc::now().to_rfc3339(),
        projects,
        threads,
        total_messages,
        total_turn_items,
        total_attachments,
    })
}

pub fn load_thread_detail(db_path: &Path, thread_id: &str) -> Result<T3ThreadDetail, String> {
    let scan = scan_database(db_path)?;
    let summary = scan
        .threads
        .into_iter()
        .find(|t| t.id == thread_id)
        .ok_or_else(|| format!("未找到会话: {thread_id}"))?;
    let project = scan
        .projects
        .iter()
        .find(|p| p.id == summary.project_id);

    let conn = open_readonly(db_path)?;
    let att_root = attachments_dir_for_db(db_path);
    let mut messages = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT message_id, role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ?1 ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([thread_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            let (id, role, created_at, payload_str) = row;
            let payload: Value = serde_json::from_str(&payload_str).unwrap_or(Value::Null);
            let text = payload
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut attachments = Vec::new();
            if let Some(arr) = payload.get("attachments").and_then(|v| v.as_array()) {
                for a in arr {
                    let aid = a.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = a
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("attachment")
                        .to_string();
                    let mime = a.get("mimeType").and_then(|v| v.as_str()).map(String::from);
                    let ext = name
                        .rsplit('.')
                        .next()
                        .filter(|e| e.len() <= 5)
                        .unwrap_or("png");
                    let candidate = att_root.join(format!("{aid}.{ext}"));
                    let exists = candidate.exists();
                    attachments.push(T3Attachment {
                        id: aid,
                        name,
                        mime_type: mime,
                        size_bytes: a.get("sizeBytes").and_then(|v| v.as_u64()),
                        local_path: if exists {
                            Some(candidate.display().to_string())
                        } else {
                            None
                        },
                        exists,
                    });
                }
            }
            messages.push(T3Message {
                id,
                role,
                text,
                created_at,
                attachments,
            });
        }
    }

    let diff_dir = summary
        .worktree_path
        .as_deref()
        .or_else(|| project.map(|p| p.workspace_root.as_str()));
    let uncommitted_diff = diff_dir.and_then(capture_git_diff);

    let transcript_markdown = render_transcript(&summary, &messages);
    let handoff_markdown = render_handoff(&summary, project, &messages, uncommitted_diff.is_some());

    Ok(T3ThreadDetail {
        summary,
        messages,
        handoff_markdown,
        transcript_markdown,
        uncommitted_diff,
    })
}

pub fn render_transcript(summary: &T3ThreadSummary, messages: &[T3Message]) -> String {
    let mut out = format!(
        "# T3 Code 会话完整归档：{}\n\n- Thread ID: `{}`\n- Project: `{}`\n- Provider / Model: `{}` / `{}`\n- Branch: `{}`\n- Updated: `{}`\n\n---\n\n",
        summary.title,
        summary.id,
        summary.project_title,
        summary.provider,
        summary.model.as_deref().unwrap_or("default"),
        summary.branch.as_deref().unwrap_or("-"),
        summary.updated_at,
    );
    for (idx, m) in messages.iter().enumerate() {
        out.push_str(&format!(
            "## {}. {} ({})\n\n{}\n\n",
            idx + 1,
            if m.role == "user" { "User" } else { "Assistant" },
            m.created_at,
            m.text
        ));
        if !m.attachments.is_empty() {
            out.push_str("附件：\n");
            for a in &m.attachments {
                out.push_str(&format!("- `{}` ({})\n", a.name, a.id));
            }
            out.push('\n');
        }
    }
    out
}

pub fn render_handoff(
    summary: &T3ThreadSummary,
    project: Option<&T3Project>,
    messages: &[T3Message],
    has_dirty_patch: bool,
) -> String {
    let first_user = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| truncate(&m.text, 600))
        .unwrap_or_else(|| summary.title.clone());
    let last_assistant = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| truncate(&m.text, 900))
        .unwrap_or_else(|| "（无助手回复记录）".to_string());

    let mut pr_block = String::new();
    if !summary.pull_requests.is_empty() {
        pr_block.push_str("\n### 关联 Pull Requests\n");
        for pr in &summary.pull_requests {
            pr_block.push_str(&format!(
                "- {} (状态: {}, 分支: {} → {})\n",
                pr.url,
                pr.state.as_deref().unwrap_or("unknown"),
                pr.head_branch.as_deref().unwrap_or("-"),
                pr.base_branch.as_deref().unwrap_or("-")
            ));
        }
    }

    format!(
        "你正在接管一个从 **T3 Code** 迁移至 **Lody** 的历史工作会话，请基于以下上下文继续工作。\n\n### 会话元信息\n- 原标题：{}\n- 原项目：{} (`{}`)\n- 原分支：{}\n- 原智能体 / 模型：{} / {}\n- 历史消息数：{} 条（完整归档已随迁移包导出至 `transcript.md`）\n{}\n{}\n### 初始需求 / 目标\n{}\n\n### 最近一次助手进展摘要\n{}\n\n请先确认以上上下文已加载，等待我的下一步指示。",
        summary.title,
        summary.project_title,
        project.map(|p| p.workspace_root.as_str()).unwrap_or("-"),
        summary.branch.as_deref().unwrap_or("-"),
        summary.provider,
        summary.model.as_deref().unwrap_or("default"),
        messages.len(),
        if has_dirty_patch {
            "- ⚠ 未提交改动：原工作区存在未提交 diff，已保存为 `dirty.patch`。"
        } else {
            "- 工作区状态：干净（无未提交补丁）"
        },
        pr_block,
        first_user,
        last_assistant
    )
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let head: String = s.chars().take(max_chars).collect();
        format!("{head}\n…(已截断，完整内容见 transcript.md)")
    }
}
