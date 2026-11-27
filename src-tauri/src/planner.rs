use crate::models::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

pub fn deterministic_op_id(thread_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("t3-to-lody:{thread_id}"));
    let hex = hex::encode(hasher.finalize());
    format!("t3mig-{}", &hex[..16])
}

pub fn resolve_project_target(
    project: &T3Project,
    catalog: &LodyCatalog,
    target_machine_id: &str,
    overrides: &HashMap<String, ProjectMappingOverride>,
) -> (String, Value, Vec<String>) {
    if let Some(ov) = overrides.get(&project.id) {
        return match ov.target_kind.as_str() {
            "local" => (
                "exact".into(),
                json!({ "kind": "local", "projectId": ov.target_project_id }),
                vec![],
            ),
            "github" => (
                "fallback".into(),
                json!({ "kind": "github", "repo": ov.target_repo }),
                vec!["使用手动指定的 GitHub 仓库 worktree".into()],
            ),
            "chat" => ("exact".into(), json!({ "kind": "chat" }), vec![]),
            _ => ("skipped".into(), json!(null), vec!["用户选择跳过该项目".into()]),
        };
    }

    if project.is_scratch {
        return ("exact".into(), json!({ "kind": "chat" }), vec![]);
    }

    // 1. Exact local path match on target machine
    if let Some(lp) = catalog.projects.iter().find(|lp| {
        lp.kind == "local"
            && lp.machine_id.as_deref() == Some(target_machine_id)
            && lp.root_path.as_deref() == Some(project.workspace_root.as_str())
    }) {
        return (
            "exact".into(),
            json!({ "kind": "local", "projectId": lp.id }),
            vec![],
        );
    }

    // 2. Fallback to GitHub repository enabled in Lody
    if let Some(gh) = project.git.github_repo.as_deref() {
        if let Some(gp) = catalog.projects.iter().find(|p| {
            p.kind == "github"
                && p.repo_full_name
                    .as_deref()
                    .map(|r| r.eq_ignore_ascii_case(gh))
                    .unwrap_or(false)
        }) {
            return (
                "fallback".into(),
                json!({ "kind": "github", "repo": gp.repo_full_name }),
                vec![format!(
                    "本地目录 {} 尚未在目标机器注册，已自动降级匹配到 GitHub 仓库 {}",
                    project.workspace_root,
                    gp.repo_full_name.as_deref().unwrap_or(gh)
                )],
            );
        }
    }

    // 3. Action required: unregistered
    (
        "action_required".into(),
        json!({ "kind": "unregistered", "localRootPath": project.workspace_root }),
        vec![format!(
            "项目 {} ({}) 未在 Lody 注册，请先在 Lody 添加该本地项目，或在页面中手动指定目标",
            project.title, project.workspace_root
        )],
    )
}

pub fn resolve_agent_target(
    provider: &str,
    model: Option<&str>,
    runtime_mode: &str,
    catalog: &LodyCatalog,
    target_machine_id: &str,
    overrides: &HashMap<String, AgentMappingOverride>,
) -> (Option<String>, Option<String>, Option<String>, Vec<String>) {
    let key = format!("{}::{}", provider, model.unwrap_or("default"));
    if let Some(ov) = overrides.get(&key) {
        return (
            Some(ov.agent_config_id.clone()),
            ov.model_id.clone(),
            ov.mode_id.clone(),
            vec![],
        );
    }

    let provider_norm = if provider.starts_with("codex") {
        "codex"
    } else if provider.contains("claude") {
        "claude"
    } else {
        provider
    };

    let configs: Vec<&LodyAgentConfig> = catalog
        .agent_configs
        .iter()
        .filter(|c| c.machine_id == target_machine_id)
        .collect();

    let cfg = configs
        .iter()
        .find(|c| c.agent_type.eq_ignore_ascii_case(provider_norm))
        .or_else(|| configs.first())
        .copied();

    let Some(cfg) = cfg else {
        return (None, None, None, vec!["目标机器无可用 Agent Config".into()]);
    };

    let mut warnings = Vec::new();
    if !cfg.agent_type.eq_ignore_ascii_case(provider_norm) {
        warnings.push(format!(
            "原 Provider `{provider}` 在目标机器不可用，已降级为 `{}`",
            cfg.name
        ));
    }

    let resolved_model = match model {
        Some(m) if cfg.models.iter().any(|cm| cm == m) => Some(m.to_string()),
        Some(m) => {
            let fallback = cfg.models.first().cloned();
            warnings.push(format!(
                "模型 `{m}` 不在 {} 支持列表，已降级为 `{}`",
                cfg.name,
                fallback.as_deref().unwrap_or("default")
            ));
            fallback
        }
        None => cfg.models.first().cloned(),
    };

    let resolved_mode = match runtime_mode {
        "full-access" => {
            if cfg.modes.iter().any(|m| m == "agent-full-access") {
                Some("agent-full-access".to_string())
            } else if cfg.modes.iter().any(|m| m == "bypassPermissions") {
                Some("bypassPermissions".to_string())
            } else if cfg.modes.iter().any(|m| m == "accept-edits") {
                warnings.push(format!(
                    "权限模式差异：T3 `full-access` 在 {} 无完全对等项，已映射为 `accept-edits`",
                    cfg.name
                ));
                Some("accept-edits".to_string())
            } else {
                cfg.modes.first().cloned()
            }
        }
        _ => cfg.modes.first().cloned(),
    };

    (Some(cfg.id.clone()), resolved_model, resolved_mode, warnings)
}

const EMBEDDED_EXAMPLE_CATALOG: &str = include_str!("../../data/lody-catalog.example.json");

pub fn load_catalog_file(path: &Path) -> Result<LodyCatalog, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 Lody Catalog 失败 ({}): {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 Lody Catalog JSON 失败: {e}"))
}

pub fn load_catalog_with_fallback(explicit_path: Option<&Path>) -> Result<LodyCatalog, String> {
    if let Some(p) = explicit_path {
        return load_catalog_file(p);
    }
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".agentport/lody-catalog.json"));
    }
    candidates.push(Path::new("data/lody-catalog.json").to_path_buf());
    candidates.push(Path::new("../data/lody-catalog.json").to_path_buf());
    candidates.push(Path::new("data/lody-catalog.example.json").to_path_buf());
    candidates.push(Path::new("../data/lody-catalog.example.json").to_path_buf());

    for c in candidates {
        if c.exists() {
            return load_catalog_file(&c);
        }
    }
    serde_json::from_str(EMBEDDED_EXAMPLE_CATALOG)
        .map_err(|e| format!("解析内嵌示例 Lody Catalog 失败: {e}"))
}
