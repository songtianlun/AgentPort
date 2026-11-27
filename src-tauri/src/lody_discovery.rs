use crate::models::*;
use crate::t3_reader::expand_tilde;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct DaemonRunInfo {
    pub pid: Option<u64>,
    pub data_dir: PathBuf,
    pub socket_path: String,
    pub control_socket_path: String,
    pub token: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LodyCliCommand {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
    pub extra_env: Vec<(String, String)>,
}

fn candidate_lody_data_dirs() -> Vec<PathBuf> {
    let mut dirs_list = Vec::new();
    if let Ok(env_dir) = std::env::var("LODY_DATA_DIR") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            dirs_list.push(PathBuf::from(trimmed));
        }
    }
    if let Some(home) = dirs::home_dir() {
        dirs_list.push(home.join(".lody"));
        dirs_list.push(home.join(".lody-oss"));
    }
    dirs_list
}

pub fn find_running_daemon() -> Option<DaemonRunInfo> {
    for data_dir in candidate_lody_data_dirs() {
        let run_file = data_dir.join("run/daemon.json");
        if !run_file.exists() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&run_file) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(socket_path) = v.get("socketPath").and_then(|s| s.as_str()) else {
            continue;
        };
        let Some(control_socket_path) = v.get("controlSocketPath").and_then(|s| s.as_str()) else {
            continue;
        };
        return Some(DaemonRunInfo {
            pid: v.get("pid").and_then(|p| p.as_u64()),
            data_dir,
            socket_path: socket_path.to_string(),
            control_socket_path: control_socket_path.to_string(),
            token: v.get("token").and_then(|s| s.as_str()).map(String::from),
            version: v.get("version").and_then(|s| s.as_str()).map(String::from),
        });
    }
    None
}

#[cfg(unix)]
fn unix_http_json(
    socket_path: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<Value, String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|e| format!("连接 Lody 本地 IPC Socket 失败 ({socket_path}): {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let payload = body
        .map(|b| serde_json::to_vec(b).unwrap_or_default())
        .unwrap_or_default();

    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    if let Some(tok) = token {
        req.push_str(&format!("x-lody-local-token: {tok}\r\n"));
    }
    if method == "POST" {
        req.push_str("x-lody-local-control: 1\r\n");
        req.push_str("content-type: application/json\r\n");
        req.push_str(&format!("content-length: {}\r\n", payload.len()));
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送 Lody IPC 请求头失败: {e}"))?;
    if !payload.is_empty() {
        stream
            .write_all(&payload)
            .map_err(|e| format!("发送 Lody IPC 请求体失败: {e}"))?;
    }

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取 Lody IPC 响应失败: {e}"))?;

    let split_pos = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "无效的 Lody IPC HTTP 响应".to_string())?;

    let head = String::from_utf8_lossy(&buf[..split_pos]);
    let mut body_bytes = &buf[split_pos + 4..];

    let decoded_chunked: Vec<u8>;
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decoded_chunked = decode_chunked(body_bytes);
        body_bytes = &decoded_chunked;
    }

    serde_json::from_slice::<Value>(body_bytes)
        .map_err(|e| format!("解析 Lody IPC JSON 响应失败: {e}"))
}

#[cfg(unix)]
fn decode_chunked(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < input.len() {
        let Some(rel) = input[i..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&input[i..i + rel]);
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(hex_part, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = i + rel + 2;
        if start + size > input.len() {
            break;
        }
        out.extend_from_slice(&input[start..start + size]);
        i = start + size + 2;
    }
    out
}

#[cfg(not(unix))]
fn unix_http_json(
    _socket_path: &str,
    _method: &str,
    _path: &str,
    _token: Option<&str>,
    _body: Option<&Value>,
) -> Result<Value, String> {
    Err("Windows Named Pipe IPC 暂未启用，请使用 lody CLI 或导入本地 Catalog 文件".to_string())
}

fn local_hostname() -> String {
    if let Ok(out) = Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Ok(s) = fs::read_to_string("/etc/hostname") {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this-machine".to_string())
}

fn detect_local_agent_configs(data_dir: &Path, machine_id: &str) -> Vec<LodyAgentConfig> {
    let bin_dir = data_dir.join("bin");
    let mut found_types: HashSet<String> = HashSet::new();

    if let Ok(entries) = fs::read_dir(&bin_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.contains("antigravity") || name == "agy" {
                found_types.insert("antigravity".into());
            } else if name.contains("claude") {
                found_types.insert("claude".into());
            } else if name.contains("codex") {
                found_types.insert("codex".into());
            } else if name.contains("opencode") {
                found_types.insert("opencode".into());
            } else if name.contains("grok") {
                found_types.insert("grok".into());
            }
        }
    }

    // Ensure at least the standard built-in Lody agents exist for mapping
    if found_types.is_empty() {
        found_types.insert("antigravity".into());
        found_types.insert("claude".into());
        found_types.insert("codex".into());
    }

    let mut configs = Vec::new();
    if found_types.contains("antigravity") {
        configs.push(LodyAgentConfig {
            id: format!("local-antigravity-{machine_id}"),
            name: "Antigravity".into(),
            machine_id: machine_id.to_string(),
            agent_type: "antigravity".into(),
            available: true,
            modes: vec!["default".into(), "accept-edits".into(), "plan".into()],
            models: vec![
                "gemini-4-neon".into(),
                "gemini-4-carbon".into(),
                "gemini-4-argon".into(),
                "gemini-4-hydrogen".into(),
                "claude-opus-5-5".into(),
                "claude-sonnet-5-5".into(),
            ],
            plan_mode: true,
            fast_mode: false,
        });
    }
    if found_types.contains("claude") {
        configs.push(LodyAgentConfig {
            id: format!("local-claude-{machine_id}"),
            name: "Claude Code".into(),
            machine_id: machine_id.to_string(),
            agent_type: "claude".into(),
            available: true,
            modes: vec![
                "default".into(),
                "acceptEdits".into(),
                "plan".into(),
                "auto".into(),
                "bypassPermissions".into(),
            ],
            models: vec![
                "default".into(),
                "opus".into(),
                "sonnet".into(),
                "haiku".into(),
            ],
            plan_mode: true,
            fast_mode: true,
        });
    }
    if found_types.contains("codex") {
        configs.push(LodyAgentConfig {
            id: format!("local-codex-{machine_id}"),
            name: "Codex".into(),
            machine_id: machine_id.to_string(),
            agent_type: "codex".into(),
            available: true,
            modes: vec![
                "read-only".into(),
                "agent".into(),
                "agent-auto-review".into(),
                "agent-full-access".into(),
            ],
            models: vec![
                "gpt-6.2-sol".into(),
                "gpt-6.1-sol".into(),
                "gpt-6-astra".into(),
                "gpt-5.4".into(),
            ],
            plan_mode: true,
            fast_mode: true,
        });
    }
    configs
}

#[cfg(target_os = "linux")]
fn discover_bundled_cli_from_pid(pid: u64) -> Option<LodyCliCommand> {
    let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let parts: Vec<String> = raw
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let exe = PathBuf::from(&parts[0]);
    let cli_js = parts
        .iter()
        .skip(1)
        .find(|a| a.ends_with("cli/index.js") || a.ends_with("cli\\index.js"))?
        .clone();
    if !exe.exists() || !Path::new(&cli_js).exists() {
        return None;
    }
    Some(LodyCliCommand {
        program: exe,
        prefix_args: vec![cli_js],
        extra_env: vec![("ELECTRON_RUN_AS_NODE".into(), "1".into())],
    })
}

#[cfg(not(target_os = "linux"))]
fn discover_bundled_cli_from_pid(_pid: u64) -> Option<LodyCliCommand> {
    // Check macOS Lody.app bundle as fallback
    #[cfg(target_os = "macos")]
    {
        let app_exe = PathBuf::from("/Applications/Lody.app/Contents/MacOS/Lody");
        let cli_js = PathBuf::from(
            "/Applications/Lody.app/Contents/Resources/app.asar.unpacked/resources/cli/index.js",
        );
        if app_exe.exists() && cli_js.exists() {
            return Some(LodyCliCommand {
                program: app_exe,
                prefix_args: vec![cli_js.display().to_string()],
                extra_env: vec![("ELECTRON_RUN_AS_NODE".into(), "1".into())],
            });
        }
    }
    None
}

pub fn find_lody_cli_command(daemon: Option<&DaemonRunInfo>) -> Option<LodyCliCommand> {
    if let Ok(out) = Command::new("which").arg("lody").output() {
        if out.status.success() {
            let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            if p.exists() {
                return Some(LodyCliCommand {
                    program: p,
                    prefix_args: vec![],
                    extra_env: vec![],
                });
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for cand in [
            home.join(".local/bin/lody"),
            home.join(".lody/daemon-managed/service"),
            PathBuf::from("/usr/local/bin/lody"),
            PathBuf::from("/opt/homebrew/bin/lody"),
        ] {
            if cand.exists() {
                return Some(LodyCliCommand {
                    program: cand,
                    prefix_args: vec![],
                    extra_env: vec![],
                });
            }
        }
    }
    if let Some(pid) = daemon.and_then(|d| d.pid) {
        if let Some(bundled) = discover_bundled_cli_from_pid(pid) {
            return Some(bundled);
        }
    }
    None
}

pub fn run_lody_cli_json_cmd(cli: &LodyCliCommand, args: &[String]) -> Result<Value, String> {
    let mut cmd = Command::new(&cli.program);
    for arg in &cli.prefix_args {
        cmd.arg(arg);
    }
    for arg in args {
        cmd.arg(arg);
    }
    for (k, v) in &cli.extra_env {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("启动 Lody CLI 失败 ({}): {e}", cli.program.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(format!(
            "Lody CLI 执行失败 (exit {:?}): {}",
            out.status.code(),
            detail.chars().take(500).collect::<String>()
        ));
    }
    let start = stdout
        .find('{')
        .ok_or_else(|| format!("Lody CLI 未返回 JSON 输出: {}", stdout.chars().take(300).collect::<String>()))?;
    serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter::<Value>()
        .next()
        .ok_or_else(|| "解析 Lody CLI JSON 输出为空".to_string())?
        .map_err(|e| format!("解析 Lody CLI JSON 失败: {e}"))
}

fn run_lody_cli_json(cli: &LodyCliCommand, args: &[&str]) -> Option<Value> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_lody_cli_json_cmd(cli, &owned).ok()
}

pub fn discover_live_lody_catalog() -> Result<LodyCatalog, String> {
    let daemon = find_running_daemon()
        .ok_or_else(|| "未发现运行中的 Lody Daemon (~/.lody/run/daemon.json)".to_string())?;

    let health = unix_http_json(
        &daemon.socket_path,
        "GET",
        "/healthz",
        daemon.token.as_deref(),
        None,
    )?;
    let machine_id = health
        .get("machineId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Lody /healthz 响应缺少 machineId".to_string())?
        .to_string();
    let cli_version = health
        .get("cliVersion")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(daemon.version.clone())
        .unwrap_or_else(|| "unknown".to_string());

    let state = unix_http_json(
        &daemon.socket_path,
        "GET",
        "/state",
        daemon.token.as_deref(),
        None,
    )
    .unwrap_or(Value::Null);

    let mut workspace_id = state
        .pointer("/connectedWorkspaces/0/id")
        .and_then(|v| v.as_str())
        .unwrap_or("local-workspace")
        .to_string();

    let proj_resp = unix_http_json(
        &daemon.control_socket_path,
        "POST",
        "/project-control",
        daemon.token.as_deref(),
        Some(&json!({
            "type": "local-project/list",
            "machineId": machine_id
        })),
    )?;

    let mut projects = Vec::new();
    let mut workspace_names = Vec::new();
    if let Some(workspaces) = proj_resp
        .pointer("/result/workspaces")
        .and_then(|v| v.as_array())
    {
        for ws in workspaces {
            if let Some(wid) = ws.get("workspaceId").and_then(|v| v.as_str()) {
                if workspace_id == "local-workspace" {
                    workspace_id = wid.to_string();
                }
            }
            if let Some(wn) = ws.get("workspaceName").and_then(|v| v.as_str()) {
                workspace_names.push(wn.to_string());
            }
            if let Some(plist) = ws.get("projects").and_then(|v| v.as_array()) {
                for p in plist {
                    let Some(pid) = p.get("localProjectId").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let name = p
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(pid)
                        .to_string();
                    let root_path = p
                        .get("rootPath")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    projects.push(LodyProject {
                        id: pid.to_string(),
                        name,
                        kind: "local".to_string(),
                        machine_id: Some(machine_id.clone()),
                        root_path,
                        repo_full_name: None,
                        available: true,
                    });
                }
            }
        }
    }

    let mut machines = vec![LodyMachine {
        id: machine_id.clone(),
        name: local_hostname(),
        online_status: "online".to_string(),
    }];
    let mut agent_configs = detect_local_agent_configs(&daemon.data_dir, &machine_id);
    let mut source = "lody-daemon-ipc".to_string();

    // Optional enrichment from `lody` CLI or running Lody Desktop's bundled CLI (adds GitHub repos, other machines, exact agentConfigIds)
    if let Some(cli_cmd) = find_lody_cli_command(Some(&daemon)) {
        let mut enriched = false;
        if let Some(m_json) = run_lody_cli_json(&cli_cmd, &["machine", "list", "--json", "--all-pages"]) {
            if let Some(items) = m_json.get("items").and_then(|v| v.as_array()) {
                let mut cli_machines = Vec::new();
                for m in items {
                    if let (Some(id), Some(name)) = (
                        m.get("id").and_then(|v| v.as_str()),
                        m.get("name").and_then(|v| v.as_str()),
                    ) {
                        cli_machines.push(LodyMachine {
                            id: id.to_string(),
                            name: name.to_string(),
                            online_status: m
                                .get("onlineStatus")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string(),
                        });
                    }
                }
                if !cli_machines.is_empty() {
                    machines = cli_machines;
                    enriched = true;
                }
            }
        }
        if let Some(p_json) =
            run_lody_cli_json(&cli_cmd, &["project", "list", "--catalog", "--json", "--all-pages"])
        {
            if let Some(items) = p_json.get("items").and_then(|v| v.as_array()) {
                let mut existing_ids: HashSet<String> = projects.iter().map(|p| p.id.clone()).collect();
                for p in items {
                    let Some(id) = p.get("id").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if existing_ids.contains(id) {
                        continue;
                    }
                    existing_ids.insert(id.to_string());
                    projects.push(LodyProject {
                        id: id.to_string(),
                        name: p.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string(),
                        kind: p.get("kind").and_then(|v| v.as_str()).unwrap_or("local").to_string(),
                        machine_id: p.get("machineId").and_then(|v| v.as_str()).map(String::from),
                        root_path: p.get("rootPath").and_then(|v| v.as_str()).map(String::from),
                        repo_full_name: p.get("repoFullName").and_then(|v| v.as_str()).map(String::from),
                        available: p
                            .pointer("/availability/state")
                            .and_then(|v| v.as_str())
                            .map(|s| s == "available")
                            .unwrap_or(true),
                    });
                }
                enriched = true;
            }
        }
        if let Some(a_json) =
            run_lody_cli_json(&cli_cmd, &["agent-config", "list", "--json", "--all-pages"])
        {
            if let Some(items) = a_json.get("items").and_then(|v| v.as_array()) {
                let mut cli_agents = Vec::new();
                for a in items {
                    let (Some(id), Some(name), Some(mid)) = (
                        a.get("id").and_then(|v| v.as_str()),
                        a.get("name").and_then(|v| v.as_str()),
                        a.get("machineId").and_then(|v| v.as_str()),
                    ) else {
                        continue;
                    };
                    let modes = a
                        .pointer("/runConfig/modes")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m.get("id").and_then(|s| s.as_str()).map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let models = a
                        .pointer("/runConfig/models")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m.get("id").and_then(|s| s.as_str()).map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    cli_agents.push(LodyAgentConfig {
                        id: id.to_string(),
                        name: name.to_string(),
                        machine_id: mid.to_string(),
                        agent_type: a
                            .get("agentType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        available: a
                            .pointer("/availability/state")
                            .and_then(|v| v.as_str())
                            .map(|s| s == "available")
                            .unwrap_or(true),
                        modes,
                        models,
                        plan_mode: a
                            .pointer("/runConfig/planMode")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        fast_mode: a
                            .pointer("/runConfig/fastMode")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    });
                }
                if !cli_agents.is_empty() {
                    agent_configs = cli_agents;
                    enriched = true;
                }
            }
        }
        if enriched {
            source = "lody-daemon+cli".to_string();
        }
    }

    let local_count = projects
        .iter()
        .filter(|p| p.kind == "local" && p.machine_id.as_deref() == Some(machine_id.as_str()))
        .count();
    let ws_label = workspace_names
        .first()
        .cloned()
        .unwrap_or_else(|| workspace_id.clone());

    Ok(LodyCatalog {
        workspace_id,
        default_machine_id: machine_id,
        machines,
        projects,
        agent_configs,
        source: Some(source),
        source_detail: Some(format!(
            "已实时连接本机 Lody Daemon (v{cli_version}) · 工作区「{ws_label}」· 发现 {local_count} 个本地项目"
        )),
        daemon_connected: true,
    })
}

pub fn merge_catalogs(mut live: LodyCatalog, file_cat: LodyCatalog) -> LodyCatalog {
    // Keep live machine name if file catalog knows a nicer name for the same machineId
    let file_machine_names: HashMap<String, String> = file_cat
        .machines
        .iter()
        .map(|m| (m.id.clone(), m.name.clone()))
        .collect();
    for m in &mut live.machines {
        if let Some(name) = file_machine_names.get(&m.id) {
            m.name = name.clone();
        }
    }
    let mut existing_machines: HashSet<String> = live.machines.iter().map(|m| m.id.clone()).collect();
    for m in file_cat.machines {
        if existing_machines.insert(m.id.clone()) {
            live.machines.push(m);
        }
    }

    let mut existing_projects: HashSet<String> = live.projects.iter().map(|p| p.id.clone()).collect();
    for p in file_cat.projects {
        if existing_projects.insert(p.id.clone()) {
            live.projects.push(p);
        }
    }

    // Prefer real UUID agent configs from file catalog for the live machine if we only had synthetic local-* ids
    let has_file_agents_for_default = file_cat
        .agent_configs
        .iter()
        .any(|a| a.machine_id == live.default_machine_id);
    if has_file_agents_for_default
        && live
            .agent_configs
            .iter()
            .all(|a| a.id.starts_with("local-"))
    {
        live.agent_configs = file_cat.agent_configs;
    } else {
        let mut existing_agents: HashSet<String> =
            live.agent_configs.iter().map(|a| a.id.clone()).collect();
        for a in file_cat.agent_configs {
            if existing_agents.insert(a.id.clone()) {
                live.agent_configs.push(a);
            }
        }
    }

    live
}

pub fn register_local_project(
    root_path: &str,
    workspace_id: Option<&str>,
) -> Result<LodyProject, String> {
    let daemon = find_running_daemon()
        .ok_or_else(|| "未检测到本机运行中的 Lody Desktop / Daemon，无法自动注册项目".to_string())?;
    let health = unix_http_json(
        &daemon.socket_path,
        "GET",
        "/healthz",
        daemon.token.as_deref(),
        None,
    )?;
    let machine_id = health
        .get("machineId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "无法从 Lody Daemon 获取 machineId".to_string())?
        .to_string();

    let expanded = expand_tilde(root_path);
    let resolved_path = fs::canonicalize(&expanded)
        .unwrap_or(expanded)
        .display()
        .to_string();

    let mut req = json!({
        "type": "local-project/add",
        "machineId": machine_id,
        "rootPath": resolved_path,
    });
    if let Some(ws) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        req["workspace"] = json!(ws);
    }

    let resp = unix_http_json(
        &daemon.control_socket_path,
        "POST",
        "/project-control",
        daemon.token.as_deref(),
        Some(&req),
    )?;

    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let msg = resp
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| resp.get("error").and_then(|v| v.as_str()))
            .unwrap_or("Lody 注册本地项目失败");
        return Err(msg.to_string());
    }

    let result = resp.get("result").cloned().unwrap_or(Value::Null);
    let pid = result
        .get("localProjectId")
        .and_then(|v| v.as_str())
        .unwrap_or("local-project-added")
        .to_string();
    let name = result
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&resolved_path)
        .to_string();
    let final_root = result
        .get("rootPath")
        .and_then(|v| v.as_str())
        .unwrap_or(&resolved_path)
        .to_string();

    Ok(LodyProject {
        id: pid,
        name,
        kind: "local".to_string(),
        machine_id: Some(machine_id),
        root_path: Some(final_root),
        repo_full_name: None,
        available: true,
    })
}
