use crate::models::*;
use crate::planner::{deterministic_op_id, resolve_agent_target, resolve_project_target};
use crate::t3_reader::{load_thread_detail, scan_database};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub fn export_bundle(
    db_path: &Path,
    catalog: &LodyCatalog,
    req: &ExportRequest,
) -> Result<ExportResult, String> {
    let scan = scan_database(db_path)?;
    let out_dir = PathBuf::from(&req.output_dir);
    let threads_dir = out_dir.join("threads");
    fs::create_dir_all(&threads_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let selected: HashSet<&String> = req.selected_thread_ids.iter().collect();
    let mut files_written = Vec::new();
    let mut lody_create_items: Vec<Value> = Vec::new();
    let mut lody_rename_items: Vec<Value> = Vec::new();
    let mut state_records: Vec<Value> = Vec::new();

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

        let detail = load_thread_detail(db_path, &t.id)?;
        let t_dir = threads_dir.join(&t.id);
        fs::create_dir_all(&t_dir).map_err(|e| e.to_string())?;

        // Write raw.json, transcript.md, handoff.md
        let raw_path = t_dir.join("raw.json");
        let transcript_path = t_dir.join("transcript.md");
        let handoff_path = t_dir.join("handoff.md");
        fs::write(&raw_path, serde_json::to_string_pretty(&detail).unwrap()).map_err(|e| e.to_string())?;
        fs::write(&transcript_path, &detail.transcript_markdown).map_err(|e| e.to_string())?;
        fs::write(&handoff_path, &detail.handoff_markdown).map_err(|e| e.to_string())?;
        files_written.push(raw_path.display().to_string());
        files_written.push(transcript_path.display().to_string());
        files_written.push(handoff_path.display().to_string());

        // Write dirty.patch if present
        if let Some(diff) = &detail.uncommitted_diff {
            let patch_path = t_dir.join("dirty.patch");
            fs::write(&patch_path, diff).map_err(|e| e.to_string())?;
            files_written.push(patch_path.display().to_string());
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
                    }
                }
            }
        }

        let op_id = deterministic_op_id(&t.id);
        let ready = proj_status != "action_required" && agent_config_id.is_some();
        if ready {
            ready_for_lody += 1;
            let mut item = json!({
                "operationId": op_id,
                "label": t.title.chars().take(120).collect::<String>(),
                "machineId": req.target_machine_id,
                "agentConfigId": agent_config_id,
                "useCurrentSessionAsParent": false,
                "workContext": work_context,
                "prompt": detail.handoff_markdown,
                "attachments": [transcript_path.display().to_string()]
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

        state_records.push(json!({
            "sourceThreadId": t.id,
            "sourceProjectId": t.project_id,
            "operationId": op_id,
            "status": if ready { "planned_ready" } else { "action_required" },
            "warnings": warnings,
            "lodySessionId": null,
            "exportedAt": Utc::now().to_rfc3339()
        }));
        exported_threads += 1;
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
    fs::write(
        &state_path,
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "updatedAt": Utc::now().to_rfc3339(),
            "records": state_records
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;

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
