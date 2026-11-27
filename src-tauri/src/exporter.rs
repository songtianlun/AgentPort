use crate::lody_discovery;
use crate::models::*;
use crate::planner::{deterministic_op_id, resolve_agent_target, resolve_project_target};
use crate::t3_reader::{expand_tilde, load_thread_detail, scan_database};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

pub fn load_migration_state(output_dir: &str) -> Vec<MigrationStateRecord> {
    let out_dir = expand_tilde(output_dir);
    let state_path = out_dir.join("migration-state.json");
    let Ok(raw) = fs::read_to_string(&state_path) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return vec![];
    };
    let Some(records_val) = v.get("records") else {
        return vec![];
    };
    serde_json::from_value::<Vec<MigrationStateRecord>>(records_val.clone()).unwrap_or_default()
}

fn save_migration_state(state_path: &Path, records: &[MigrationStateRecord]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&json!({
        "version": 1,
        "updatedAt": Utc::now().to_rfc3339(),
        "records": records
    }))
    .map_err(|e| e.to_string())?;
    let tmp = state_path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("写入状态临时文件失败: {e}"))?;
    fs::rename(&tmp, state_path).map_err(|e| format!("保存 migration-state.json 失败: {e}"))?;
    Ok(())
}

pub fn export_bundle(
    db_path: &Path,
    catalog: &LodyCatalog,
    req: &ExportRequest,
) -> Result<ExportResult, String> {
    let scan = scan_database(db_path)?;
    let out_dir = expand_tilde(&req.output_dir);
    let threads_dir = out_dir.join("threads");
    fs::create_dir_all(&threads_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    // Preserve previously imported records for true idempotency across re-exports
    let existing_records = load_migration_state(&req.output_dir);
    let mut existing_by_thread: HashMap<String, MigrationStateRecord> = existing_records
        .into_iter()
        .map(|r| (r.source_thread_id.clone(), r))
        .collect();

    let selected: HashSet<&String> = req.selected_thread_ids.iter().collect();
    let mut files_written = Vec::new();
    let mut lody_create_items: Vec<Value> = Vec::new();
    let mut lody_rename_items: Vec<Value> = Vec::new();
    let mut state_records: Vec<MigrationStateRecord> = Vec::new();
    let mut seen_thread_ids: HashSet<String> = HashSet::new();

    let mut exported_threads = 0usize;
    let mut ready_for_lody = 0usize;
    let mut action_required_count = 0usize;
    let mut warning_count = 0usize;
    let mut patches_saved = 0usize;
    let mut attachments_copied = 0usize;

    for t in &scan.threads {
        if !selected.is_empty() && !selected.contains(&t.id) {
            continue;
        }
        if !req.include_archived && t.archived_at.is_some() {
            continue;
        }
        let Some(proj) = scan.projects.iter().find(|p| p.id == t.project_id) else {
            continue;
        };

        let (proj_status, mut work_context, mut warnings) =
            resolve_project_target(proj, catalog, &req.target_machine_id, &req.project_overrides);
        if proj_status == "skipped" {
            continue;
        }
        if proj_status == "action_required" {
            action_required_count += 1;
        }
        if let Some(branch) = &t.branch {
            if let Some(obj) = work_context.as_object_mut() {
                if obj.get("kind").and_then(|k| k.as_str()) != Some("chat") {
                    obj.insert("branch".into(), json!(branch));
                }
            }
        }

        let (agent_config_id, model_id, mode_id, agent_warnings) = resolve_agent_target(
            &t.provider,
            t.model.as_deref(),
            &t.runtime_mode,
            catalog,
            &req.target_machine_id,
            &req.agent_overrides,
        );
        warnings.extend(agent_warnings);
        warning_count += warnings.len();

        let agent_name = agent_config_id
            .as_deref()
            .and_then(|aid| catalog.agent_configs.iter().find(|c| c.id == aid))
            .map(|c| c.name.clone());

        let detail = load_thread_detail(db_path, &t.id)?;
        let t_dir = threads_dir.join(&t.id);
        fs::create_dir_all(&t_dir).map_err(|e| e.to_string())?;

        // Write raw.json, transcript.md, handoff.md
        let raw_path = t_dir.join("raw.json");
        let transcript_path = t_dir.join("transcript.md");
        let handoff_path = t_dir.join("handoff.md");
        fs::write(&raw_path, serde_json::to_string_pretty(&detail).unwrap())
            .map_err(|e| e.to_string())?;
        fs::write(&transcript_path, &detail.transcript_markdown).map_err(|e| e.to_string())?;
        fs::write(&handoff_path, &detail.handoff_markdown).map_err(|e| e.to_string())?;
        files_written.push(raw_path.display().to_string());
        files_written.push(transcript_path.display().to_string());
        files_written.push(handoff_path.display().to_string());

        let mut attach_paths = vec![transcript_path.display().to_string()];

        // Write dirty.patch if present
        if let Some(diff) = &detail.uncommitted_diff {
            let patch_path = t_dir.join("dirty.patch");
            fs::write(&patch_path, diff).map_err(|e| e.to_string())?;
            files_written.push(patch_path.display().to_string());
            attach_paths.push(patch_path.display().to_string());
            patches_saved += 1;
        }

        // Copy real attachments
        let att_out = t_dir.join("attachments");
        for m in &detail.messages {
            for a in &m.attachments {
                if let Some(src) = &a.local_path {
                    fs::create_dir_all(&att_out).ok();
                    let dst = att_out.join(format!("{}_{}", a.id, a.name));
                    if fs::copy(src, &dst).is_ok() {
                        attachments_copied += 1;
                        if attach_paths.len() < 8 {
                            attach_paths.push(dst.display().to_string());
                        }
                    }
                }
            }
        }

        let op_id = deterministic_op_id(&t.id);
        let ready = proj_status != "action_required" && agent_config_id.is_some();
        if ready {
            ready_for_lody += 1;
            let mut item = json!({
                "sourceThreadId": t.id,
                "operationId": op_id,
                "title": t.title.chars().take(200).collect::<String>(),
                "label": t.title.chars().take(120).collect::<String>(),
                "workspaceId": catalog.workspace_id,
                "machineId": req.target_machine_id,
                "agentConfigId": agent_config_id,
                "agentName": agent_name,
                "useCurrentSessionAsParent": false,
                "workContext": work_context,
                "promptFile": handoff_path.display().to_string(),
                "prompt": detail.handoff_markdown,
                "attachments": attach_paths
            });
            if let Some(mid) = &model_id {
                item["modelId"] = json!(mid);
            }
            if let Some(md) = &mode_id {
                item["modeId"] = json!(md);
            }
            lody_create_items.push(item);
            lody_rename_items.push(json!({
                "sourceThreadId": t.id,
                "operationId": op_id,
                "title": t.title.chars().take(200).collect::<String>()
            }));
        }

        seen_thread_ids.insert(t.id.clone());
        let prev = existing_by_thread.remove(&t.id);
        let record = match prev {
            Some(old) if old.status == "imported" && old.lody_session_id.is_some() => {
                MigrationStateRecord {
                    title: Some(t.title.clone()),
                    warnings,
                    exported_at: Utc::now().to_rfc3339(),
                    ..old
                }
            }
            _ => MigrationStateRecord {
                source_thread_id: t.id.clone(),
                source_project_id: t.project_id.clone(),
                title: Some(t.title.clone()),
                operation_id: op_id,
                status: if ready {
                    "planned_ready".into()
                } else {
                    "action_required".into()
                },
                warnings,
                lody_session_id: None,
                last_error: None,
                exported_at: Utc::now().to_rfc3339(),
                imported_at: None,
            },
        };
        state_records.push(record);
        exported_threads += 1;
    }

    // Retain previously imported records that were not in the current selection
    for (tid, old) in existing_by_thread {
        if !seen_thread_ids.contains(&tid) && old.status == "imported" {
            state_records.push(old);
        }
    }

    let manifest_path = out_dir.join("manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&json!({
            "formatVersion": "1.0.0",
            "source": "t3-code",
            "target": "lody",
            "sourceDbPath": scan.db_path,
            "targetMachineId": req.target_machine_id,
            "exportedAt": Utc::now().to_rfc3339(),
            "projects": scan.projects
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let lody_batch_path = out_dir.join("lody-mcp-batch.json");
    fs::write(
        &lody_batch_path,
        serde_json::to_string_pretty(&json!({
            "generatedAt": Utc::now().to_rfc3339(),
            "createSessions": lody_create_items,
            "renameSessions": lody_rename_items
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let state_path = out_dir.join("migration-state.json");
    save_migration_state(&state_path, &state_records)?;

    files_written.push(manifest_path.display().to_string());
    files_written.push(lody_batch_path.display().to_string());
    files_written.push(state_path.display().to_string());

    Ok(ExportResult {
        output_dir: out_dir.display().to_string(),
        exported_threads,
        ready_for_lody,
        action_required_count,
        warning_count,
        patches_saved,
        attachments_copied,
        files_written,
        lody_batch_path: lody_batch_path.display().to_string(),
        state_path: state_path.display().to_string(),
    })
}

pub fn import_to_lody(
    db_path: &Path,
    catalog: &LodyCatalog,
    req: &ImportToLodyRequest,
) -> Result<ImportToLodyResult, String> {
    let daemon = lody_discovery::find_running_daemon();
    let cli = lody_discovery::find_lody_cli_command(daemon.as_ref()).ok_or_else(|| {
        "未找到本机可用的 Lody CLI（请确认 Lody Desktop 正在运行，或已将 lody 加入 PATH）"
            .to_string()
    })?;

    // Step 1: Ensure bundle & handoff files are up-to-date while preserving prior imported state
    let export_res = export_bundle(db_path, catalog, &req.export_request)?;
    let batch_raw = fs::read_to_string(&export_res.lody_batch_path)
        .map_err(|e| format!("读取迁移清单失败: {e}"))?;
    let batch_json: Value =
        serde_json::from_str(&batch_raw).map_err(|e| format!("解析迁移清单失败: {e}"))?;
    let create_items = batch_json
        .get("createSessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let state_path = Path::new(&export_res.state_path);
    let mut state_records = load_migration_state(&export_res.output_dir);

    let mut items_out = Vec::new();
    let mut imported_now = 0usize;
    let mut skipped_already_imported = 0usize;
    let skipped_not_ready = export_res.action_required_count;
    let mut failed = 0usize;
    let mut attempted_creates = 0usize;

    for item in &create_items {
        let tid = item
            .get("sourceThreadId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let op_id = item
            .get("operationId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Imported Session")
            .to_string();

        // Check idempotent state record
        if let Some(existing) = state_records.iter().find(|r| r.source_thread_id == tid) {
            if !req.force_reimport
                && existing.status == "imported"
                && existing.lody_session_id.is_some()
            {
                skipped_already_imported += 1;
                items_out.push(ImportItemOutcome {
                    source_thread_id: tid,
                    title,
                    operation_id: op_id,
                    status: "skipped_imported".into(),
                    lody_session_id: existing.lody_session_id.clone(),
                    message: Some("已在历史迁移中导入，自动幂等跳过".into()),
                });
                continue;
            }
        }

        if let Some(limit) = req.max_count {
            if attempted_creates >= limit {
                break;
            }
        }
        attempted_creates += 1;

        let mut args: Vec<String> = vec!["session".into(), "create".into(), "--json".into()];

        if let Some(ws) = item
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "local-workspace")
        {
            args.push("--workspace".into());
            args.push(ws.into());
        }
        if let Some(mid) = item
            .get("machineId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            args.push("--machine".into());
            args.push(mid.into());
        }

        // Prefer real UUID agentConfigId; fall back to agentName if only synthetic local-* id exists
        let agent_selector = item
            .get("agentConfigId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && !s.starts_with("local-"))
            .or_else(|| item.get("agentName").and_then(|v| v.as_str()))
            .filter(|s| !s.is_empty());
        if let Some(agent) = agent_selector {
            args.push("--agent".into());
            args.push(agent.into());
        }

        args.push("--title".into());
        args.push(title.clone());

        if let Some(wc) = item.get("workContext") {
            let kind = wc.get("kind").and_then(|v| v.as_str()).unwrap_or("chat");
            if kind == "local" {
                if let Some(pid) = wc.get("projectId").and_then(|v| v.as_str()) {
                    args.push("--local-project".into());
                    args.push(pid.into());
                }
                if let Some(branch) = wc.get("branch").and_then(|v| v.as_str()) {
                    args.push("--branch".into());
                    args.push(branch.into());
                }
            } else if kind == "github" {
                if let Some(repo) = wc.get("repo").and_then(|v| v.as_str()) {
                    args.push("--repo".into());
                    args.push(repo.into());
                }
                if let Some(branch) = wc.get("branch").and_then(|v| v.as_str()) {
                    args.push("--branch".into());
                    args.push(branch.into());
                }
            }
        }

        if let Some(model) = item
            .get("modelId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(mode) = item
            .get("modeId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            args.push("--mode".into());
            args.push(mode.into());
        }

        if let Some(atts) = item.get("attachments").and_then(|v| v.as_array()) {
            for a in atts {
                if let Some(path_str) = a.as_str() {
                    if Path::new(path_str).exists() {
                        args.push("--attach".into());
                        args.push(path_str.into());
                    }
                }
            }
        }

        if let Some(pf) = item.get("promptFile").and_then(|v| v.as_str()) {
            args.push("--prompt-file".into());
            args.push(pf.into());
        }

        match lody_discovery::run_lody_cli_json_cmd(&cli, &args) {
            Ok(resp) => {
                let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let sid = resp
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if ok && sid.is_some() {
                    imported_now += 1;
                    let now = Utc::now().to_rfc3339();
                    if let Some(rec) = state_records.iter_mut().find(|r| r.source_thread_id == tid)
                    {
                        rec.status = "imported".into();
                        rec.lody_session_id = sid.clone();
                        rec.last_error = None;
                        rec.imported_at = Some(now);
                    }
                    let _ = save_migration_state(state_path, &state_records);
                    items_out.push(ImportItemOutcome {
                        source_thread_id: tid,
                        title,
                        operation_id: op_id,
                        status: "imported".into(),
                        lody_session_id: sid,
                        message: Some("导入成功".into()),
                    });
                } else {
                    let err_msg = resp
                        .get("error")
                        .or_else(|| resp.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Lody 返回非成功状态")
                        .to_string();
                    failed += 1;
                    if let Some(rec) = state_records.iter_mut().find(|r| r.source_thread_id == tid)
                    {
                        rec.status = "failed".into();
                        rec.last_error = Some(err_msg.clone());
                    }
                    let _ = save_migration_state(state_path, &state_records);
                    items_out.push(ImportItemOutcome {
                        source_thread_id: tid,
                        title,
                        operation_id: op_id,
                        status: "failed".into(),
                        lody_session_id: None,
                        message: Some(err_msg),
                    });
                }
            }
            Err(err_msg) => {
                failed += 1;
                if let Some(rec) = state_records.iter_mut().find(|r| r.source_thread_id == tid) {
                    rec.status = "failed".into();
                    rec.last_error = Some(err_msg.clone());
                }
                let _ = save_migration_state(state_path, &state_records);
                items_out.push(ImportItemOutcome {
                    source_thread_id: tid,
                    title,
                    operation_id: op_id,
                    status: "failed".into(),
                    lody_session_id: None,
                    message: Some(err_msg),
                });
            }
        }
    }

    Ok(ImportToLodyResult {
        output_dir: export_res.output_dir,
        state_path: export_res.state_path,
        total_considered: create_items.len(),
        imported_now,
        skipped_already_imported,
        skipped_not_ready,
        failed,
        items: items_out,
        state_records,
    })
}
