use crate::models::*;
use crate::t3_reader::{load_thread_detail, scan_database};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agentport/cloud-config.json")
}

fn default_hostname() -> String {
    if let Ok(out) = Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "desktop".to_string())
}

pub fn load_cloud_config() -> CloudServerConfig {
    let p = config_path();
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(cfg) = serde_json::from_str::<CloudServerConfig>(&raw) {
            return cfg;
        }
    }
    CloudServerConfig {
        server_url: String::new(),
        api_token: String::new(),
        device_name: default_hostname(),
        auto_backup_enabled: false,
        auto_backup_interval_minutes: 30,
        last_sync_at: None,
    }
}

pub fn save_cloud_config(mut cfg: CloudServerConfig) -> Result<CloudServerConfig, String> {
    cfg.server_url = cfg.server_url.trim().trim_end_matches('/').to_string();
    cfg.api_token = cfg.api_token.trim().to_string();
    if cfg.device_name.trim().is_empty() {
        cfg.device_name = default_hostname();
    }
    if cfg.auto_backup_interval_minutes == 0 {
        cfg.auto_backup_interval_minutes = 30;
    }
    let p = config_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&p, body).map_err(|e| format!("保存云配置失败: {e}"))?;
    Ok(cfg)
}

fn make_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(45))
        .timeout_write(Duration::from_secs(45))
        .build()
}

fn format_ureq_err(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, resp) => {
            let text = resp.into_string().unwrap_or_default();
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(msg) = v.get("error").and_then(|s| s.as_str()) {
                    return format!("HTTP {code}: {msg}");
                }
            }
            format!("HTTP {code}: {}", text.chars().take(240).collect::<String>())
        }
        ureq::Error::Transport(t) => format!("网络连接失败: {t}"),
    }
}

pub fn test_connection(server_url: &str, api_token: &str) -> CloudConnectionStatus {
    let base = server_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return CloudConnectionStatus {
            ok: false,
            server_url: base,
            username: None,
            server_version: None,
            error: Some("请先填写服务器地址（例如 https://agentport.example.com）".into()),
        };
    }
    let agent = make_agent();
    let url = format!("{base}/api/v1/auth/me");
    let res = agent
        .get(&url)
        .set("Authorization", &format!("Bearer {}", api_token.trim()))
        .call();

    match res {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(v) => CloudConnectionStatus {
                ok: v.get("ok").and_then(|b| b.as_bool()).unwrap_or(true),
                server_url: base,
                username: v.pointer("/user/username").and_then(|s| s.as_str()).map(String::from),
                server_version: v.get("version").and_then(|s| s.as_str()).map(String::from),
                error: None,
            },
            Err(e) => CloudConnectionStatus {
                ok: false,
                server_url: base,
                username: None,
                server_version: None,
                error: Some(format!("解析服务器响应失败: {e}")),
            },
        },
        Err(e) => CloudConnectionStatus {
            ok: false,
            server_url: base,
            username: None,
            server_version: None,
            error: Some(format_ureq_err(e)),
        },
    }
}

fn compute_thread_hash(t: &T3ThreadSummary) -> String {
    let mut h = Sha256::new();
    h.update(format!(
        "v1|{}|{}|{}|{}|{}|{}",
        t.id,
        t.updated_at,
        t.message_count,
        t.turn_item_count,
        t.attachment_count,
        t.title
    ));
    hex::encode(h.finalize())
}

fn upload_attachment_if_needed(
    agent: &ureq::Agent,
    base: &str,
    auth: &str,
    local_path: &str,
    mime_type: Option<&str>,
) -> Result<(String, bool), String> {
    let bytes = fs::read(local_path).map_err(|e| format!("读取附件失败 ({local_path}): {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = hex::encode(hasher.finalize());

    let head_url = format!("{base}/api/v1/blobs/{sha}");
    if agent.head(&head_url).set("Authorization", auth).call().is_ok() {
        return Ok((sha, false));
    }

    let mime = mime_type.unwrap_or("application/octet-stream");
    agent
        .put(&head_url)
        .set("Authorization", auth)
        .set("Content-Type", mime)
        .send_bytes(&bytes)
        .map_err(format_ureq_err)?;
    Ok((sha, true))
}

fn build_sync_payload_and_upload_blobs(
    agent: &ureq::Agent,
    base: &str,
    auth: &str,
    db_path: &Path,
    proj: Option<&T3Project>,
    t: &T3ThreadSummary,
    machine_name: &str,
    content_hash: &str,
) -> Result<(Value, usize), String> {
    let detail = load_thread_detail(db_path, &t.id)?;
    let mut blobs_uploaded = 0usize;

    let mut msgs = Vec::with_capacity(detail.messages.len());
    for m in &detail.messages {
        let mut atts = Vec::new();
        for a in &m.attachments {
            let mut blob_sha = None;
            if let Some(lp) = &a.local_path {
                if Path::new(lp).exists() {
                    if let Ok((sha, uploaded)) =
                        upload_attachment_if_needed(agent, base, auth, lp, a.mime_type.as_deref())
                    {
                        if uploaded {
                            blobs_uploaded += 1;
                        }
                        blob_sha = Some(sha);
                    }
                }
            }
            atts.push(json!({
                "id": a.id,
                "name": a.name,
                "mimeType": a.mime_type,
                "sizeBytes": a.size_bytes.unwrap_or(0),
                "blobSha256": blob_sha.unwrap_or_default()
            }));
        }
        msgs.push(json!({
            "id": m.id,
            "role": m.role,
            "text": m.text,
            "createdAt": m.created_at,
            "attachments": atts
        }));
    }

    let prs: Vec<Value> = t
        .pull_requests
        .iter()
        .map(|pr| {
            json!({
                "url": pr.url,
                "repository": pr.repository.as_deref().unwrap_or(""),
                "number": pr.number.unwrap_or(0),
                "state": pr.state.as_deref().unwrap_or(""),
                "title": pr.title.as_deref().unwrap_or(""),
                "headBranch": pr.head_branch.as_deref().unwrap_or(""),
                "baseBranch": pr.base_branch.as_deref().unwrap_or(""),
            })
        })
        .collect();

    let payload = json!({
        "sourceTool": "t3-code",
        "machineId": machine_name,
        "machineName": machine_name,
        "sourceThreadId": t.id,
        "sourceProjectId": t.project_id,
        "projectTitle": t.project_title,
        "workspaceRoot": proj.map(|p| p.workspace_root.as_str()).unwrap_or(""),
        "title": t.title,
        "provider": t.provider,
        "model": t.model.as_deref().unwrap_or(""),
        "branch": t.branch.as_deref().unwrap_or(""),
        "contentHash": content_hash,
        "messageCount": detail.messages.len(),
        "turnItemCount": t.turn_item_count,
        "attachmentCount": t.attachment_count,
        "sourceCreatedAt": t.created_at,
        "sourceUpdatedAt": t.updated_at,
        "messages": msgs,
        "handoffMarkdown": detail.handoff_markdown,
        "transcriptMarkdown": detail.transcript_markdown,
        "dirtyPatch": detail.uncommitted_diff.unwrap_or_default(),
        "pullRequests": prs
    });
    Ok((payload, blobs_uploaded))
}

pub fn backup_to_cloud_with_progress<F>(
    db_path: &Path,
    req: &CloudBackupRequest,
    mut on_progress: F,
) -> Result<CloudBackupResult, String>
where
    F: FnMut(CloudBackupProgress),
{
    let mut cfg = load_cloud_config();
    if cfg.server_url.trim().is_empty() || cfg.api_token.trim().is_empty() {
        return Err("请先配置云端服务器地址和 API Token".into());
    }
    let base = cfg.server_url.trim().trim_end_matches('/').to_string();
    let auth = format!("Bearer {}", cfg.api_token.trim());
    let machine_name = if cfg.device_name.trim().is_empty() {
        default_hostname()
    } else {
        cfg.device_name.clone()
    };

    let scan = scan_database(db_path)?;
    let selected: HashSet<&String> = req.selected_thread_ids.iter().collect();
    let threads: Vec<&T3ThreadSummary> = scan
        .threads
        .iter()
        .filter(|t| (selected.is_empty() || selected.contains(&t.id)) && (req.include_archived || t.archived_at.is_none()))
        .collect();

    on_progress(CloudBackupProgress {
        phase: "diff".into(),
        total: threads.len(),
        processed: 0,
        uploaded: 0,
        unchanged: 0,
        blobs_uploaded: 0,
        failed: 0,
        current_title: Some("正在与服务器对比增量哈希…".into()),
    });

    let agent = make_agent();
    let hashes: Vec<(String, String)> = threads
        .iter()
        .map(|t| (t.id.clone(), compute_thread_hash(t)))
        .collect();
    let diff_items: Vec<Value> = hashes
        .iter()
        .map(|(tid, h)| {
            json!({
                "sourceTool": "t3-code",
                "machineId": machine_name,
                "sourceThreadId": tid,
                "contentHash": h
            })
        })
        .collect();

    let diff_resp = agent
        .post(&format!("{base}/api/v1/sync/diff"))
        .set("Authorization", &auth)
        .send_json(json!({ "items": diff_items }))
        .map_err(format_ureq_err)?
        .into_json::<Value>()
        .map_err(|e| format!("解析增量对比响应失败: {e}"))?;

    let need_set: HashSet<String> = diff_resp
        .get("needUpload")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let mut uploaded = 0usize;
    let mut unchanged = 0usize;
    let mut blobs_uploaded = 0usize;
    let mut failed = 0usize;
    let mut processed = 0usize;
    let mut errors = Vec::new();

    for (t, (_, chash)) in threads.iter().zip(hashes.iter()) {
        if !need_set.contains(&t.id) {
            unchanged += 1;
            processed += 1;
            on_progress(CloudBackupProgress {
                phase: "uploading".into(),
                total: threads.len(),
                processed,
                uploaded,
                unchanged,
                blobs_uploaded,
                failed,
                current_title: Some(t.title.clone()),
            });
            continue;
        }

        on_progress(CloudBackupProgress {
            phase: "uploading".into(),
            total: threads.len(),
            processed,
            uploaded,
            unchanged,
            blobs_uploaded,
            failed,
            current_title: Some(t.title.clone()),
        });

        let proj = scan.projects.iter().find(|p| p.id == t.project_id);
        match build_sync_payload_and_upload_blobs(
            &agent,
            &base,
            &auth,
            db_path,
            proj,
            t,
            &machine_name,
            chash,
        ) {
            Ok((payload, b_cnt)) => {
                blobs_uploaded += b_cnt;
                match agent
                    .post(&format!("{base}/api/v1/sync/sessions"))
                    .set("Authorization", &auth)
                    .send_json(payload)
                {
                    Ok(_) => uploaded += 1,
                    Err(e) => {
                        failed += 1;
                        errors.push(format!("{}: {}", t.title, format_ureq_err(e)));
                    }
                }
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {e}", t.title));
            }
        }
        processed += 1;
        on_progress(CloudBackupProgress {
            phase: "uploading".into(),
            total: threads.len(),
            processed,
            uploaded,
            unchanged,
            blobs_uploaded,
            failed,
            current_title: Some(t.title.clone()),
        });
    }

    let now = Utc::now().to_rfc3339();
    cfg.last_sync_at = Some(now.clone());
    let _ = save_cloud_config(cfg);

    on_progress(CloudBackupProgress {
        phase: "done".into(),
        total: threads.len(),
        processed,
        uploaded,
        unchanged,
        blobs_uploaded,
        failed,
        current_title: None,
    });

    Ok(CloudBackupResult {
        total_considered: threads.len(),
        uploaded,
        unchanged,
        blobs_uploaded,
        failed,
        errors,
        synced_at: now,
    })
}

pub fn create_cloud_share(db_path: &Path, req: &CloudShareRequest) -> Result<CloudShareResult, String> {
    let cfg = load_cloud_config();
    if cfg.server_url.trim().is_empty() || cfg.api_token.trim().is_empty() {
        return Err("请先在「云备份与分享」页配置服务器地址和 API Token".into());
    }
    let base = cfg.server_url.trim().trim_end_matches('/').to_string();
    let auth = format!("Bearer {}", cfg.api_token.trim());
    let machine_name = if cfg.device_name.trim().is_empty() {
        default_hostname()
    } else {
        cfg.device_name.clone()
    };

    let scan = scan_database(db_path)?;
    let thread = scan
        .threads
        .iter()
        .find(|t| t.id == req.thread_id)
        .ok_or_else(|| format!("未找到会话: {}", req.thread_id))?;
    let proj = scan.projects.iter().find(|p| p.id == thread.project_id);

    let agent = make_agent();
    let chash = compute_thread_hash(thread);
    let (payload, _) = build_sync_payload_and_upload_blobs(
        &agent,
        &base,
        &auth,
        db_path,
        proj,
        thread,
        &machine_name,
        &chash,
    )?;

    let up_resp = agent
        .post(&format!("{base}/api/v1/sync/sessions"))
        .set("Authorization", &auth)
        .send_json(payload)
        .map_err(format_ureq_err)?
        .into_json::<Value>()
        .map_err(|e| format!("解析同步响应失败: {e}"))?;

    let remote_session_id = up_resp
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "服务器未返回 sessionId".to_string())?
        .to_string();

    let share_resp = agent
        .post(&format!("{base}/api/v1/shares"))
        .set("Authorization", &auth)
        .send_json(json!({
            "sessionId": remote_session_id,
            "title": req.title.as_deref().unwrap_or(&thread.title),
            "password": req.password.as_deref().unwrap_or(""),
            "expiresInHours": req.expires_in_hours.unwrap_or(0),
            "redactSecrets": req.redact_secrets,
            "hidePaths": req.hide_paths,
            "includePatch": req.include_patch
        }))
        .map_err(format_ureq_err)?
        .into_json::<Value>()
        .map_err(|e| format!("解析分享响应失败: {e}"))?;

    let slug = share_resp
        .pointer("/share/slug")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "服务器未返回分享 slug".to_string())?
        .to_string();
    let share_url = share_resp
        .get("shareUrl")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("{base}/s/{slug}"));
    let has_password = share_resp
        .pointer("/share/hasPassword")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let redaction_count = share_resp
        .pointer("/share/redactionCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let expires_at = share_resp
        .pointer("/share/expiresAt")
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(CloudShareResult {
        slug,
        share_url,
        session_id: remote_session_id,
        has_password,
        redaction_count,
        expires_at,
    })
}
