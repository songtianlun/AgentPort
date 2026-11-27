use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub exists: bool,
    pub is_git_repo: bool,
    pub remote_origin: Option<String>,
    pub github_repo: Option<String>,
    pub current_branch: Option<String>,
    pub dirty_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Project {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
    pub is_scratch: bool,
    pub deleted_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub thread_count: usize,
    pub git: GitInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3PullRequest {
    pub host: Option<String>,
    pub repository: Option<String>,
    pub number: Option<i64>,
    pub url: String,
    pub state: Option<String>,
    pub title: Option<String>,
    pub head_branch: Option<String>,
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub local_path: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub attachments: Vec<T3Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3ThreadSummary {
    pub id: String,
    pub project_id: String,
    pub project_title: String,
    pub title: String,
    pub provider: String,
    pub provider_instance_id: String,
    pub model: Option<String>,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_dirty_count: usize,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub message_count: usize,
    pub turn_item_count: usize,
    pub attachment_count: usize,
    pub pull_requests: Vec<T3PullRequest>,
    pub turn_item_breakdown: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3ThreadDetail {
    pub summary: T3ThreadSummary,
    pub messages: Vec<T3Message>,
    pub handoff_markdown: String,
    pub transcript_markdown: String,
    pub uncommitted_diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3ScanResult {
    pub db_path: String,
    pub db_size_bytes: u64,
    pub schema_version: String,
    pub scanned_at: String,
    pub projects: Vec<T3Project>,
    pub threads: Vec<T3ThreadSummary>,
    pub total_messages: usize,
    pub total_turn_items: usize,
    pub total_attachments: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodyMachine {
    pub id: String,
    pub name: String,
    pub online_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodyProject {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub machine_id: Option<String>,
    pub root_path: Option<String>,
    pub repo_full_name: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodyAgentConfig {
    pub id: String,
    pub name: String,
    pub machine_id: String,
    pub agent_type: String,
    pub available: bool,
    pub modes: Vec<String>,
    pub models: Vec<String>,
    pub plan_mode: bool,
    pub fast_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodyCatalog {
    pub workspace_id: String,
    pub default_machine_id: String,
    pub machines: Vec<LodyMachine>,
    pub projects: Vec<LodyProject>,
    pub agent_configs: Vec<LodyAgentConfig>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_detail: Option<String>,
    #[serde(default)]
    pub daemon_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMappingOverride {
    pub target_kind: String, // "local" | "github" | "chat" | "skip"
    pub target_project_id: Option<String>,
    pub target_repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMappingOverride {
    pub agent_config_id: String,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub db_path: Option<String>,
    pub output_dir: String,
    pub target_machine_id: String,
    pub selected_thread_ids: Vec<String>,
    pub include_archived: bool,
    pub project_overrides: HashMap<String, ProjectMappingOverride>,
    pub agent_overrides: HashMap<String, AgentMappingOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_dir: String,
    pub exported_threads: usize,
    pub ready_for_lody: usize,
    pub action_required_count: usize,
    pub warning_count: usize,
    pub patches_saved: usize,
    pub attachments_copied: usize,
    pub files_written: Vec<String>,
    pub lody_batch_path: String,
    pub state_path: String,
}
