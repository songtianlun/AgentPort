mod cloud_sync;
mod exporter;
mod lody_discovery;
mod models;
mod planner;
mod t3_reader;

use models::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

struct ImportCancelState(Arc<AtomicBool>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    runtime: String,
    default_db_path: String,
    default_output_dir: String,
}

#[tauri::command]
fn get_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        runtime: "tauri-native".to_string(),
        default_db_path: t3_reader::default_db_path().display().to_string(),
        default_output_dir: t3_reader::default_output_dir().display().to_string(),
    }
}

#[tauri::command]
async fn scan_t3_database(db_path: Option<String>) -> Result<T3ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = t3_reader::resolve_db_path(db_path.as_deref());
        t3_reader::scan_database(&path)
    })
    .await
    .map_err(|e| format!("后台扫描任务失败: {e}"))?
}

#[tauri::command]
async fn get_thread_detail(
    db_path: Option<String>,
    thread_id: String,
) -> Result<T3ThreadDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = t3_reader::resolve_db_path(db_path.as_deref());
        t3_reader::load_thread_detail(&path, &thread_id)
    })
    .await
    .map_err(|e| format!("读取会话详情任务失败: {e}"))?
}

#[tauri::command]
async fn get_lody_catalog(catalog_path: Option<String>) -> Result<LodyCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        planner::load_catalog_with_fallback(catalog_path.as_deref())
    })
    .await
    .map_err(|e| format!("读取 Lody 目录任务失败: {e}"))?
}

#[tauri::command]
async fn register_lody_local_project(
    root_path: String,
    workspace_id: Option<String>,
) -> Result<LodyProject, String> {
    tauri::async_runtime::spawn_blocking(move || {
        lody_discovery::register_local_project(&root_path, workspace_id.as_deref())
    })
    .await
    .map_err(|e| format!("注册本地项目任务失败: {e}"))?
}

#[tauri::command]
async fn export_migration_bundle(
    request: ExportRequest,
    catalog_path: Option<String>,
) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = t3_reader::resolve_db_path(request.db_path.as_deref());
        let catalog = planner::load_catalog_with_fallback(catalog_path.as_deref())?;
        exporter::export_bundle(&db, &catalog, &request)
    })
    .await
    .map_err(|e| format!("导出迁移包任务失败: {e}"))?
}

#[tauri::command]
async fn read_migration_state(output_dir: String) -> Result<Vec<MigrationStateRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || exporter::load_migration_state(&output_dir))
        .await
        .map_err(|e| format!("读取迁移状态任务失败: {e}"))
}

#[tauri::command]
fn cancel_lody_import(cancel_state: State<'_, ImportCancelState>) -> bool {
    cancel_state.0.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
async fn import_to_lody(
    app: AppHandle,
    cancel_state: State<'_, ImportCancelState>,
    request: ImportToLodyRequest,
    catalog_path: Option<String>,
) -> Result<ImportToLodyResult, String> {
    let cancel_flag = cancel_state.0.clone();
    cancel_flag.store(false, Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        let db = t3_reader::resolve_db_path(request.export_request.db_path.as_deref());
        let catalog = planner::load_catalog_with_fallback(catalog_path.as_deref())?;
        exporter::import_to_lody_with_progress(&db, &catalog, &request, &cancel_flag, |progress| {
            let _ = app.emit("lody-import-progress", &progress);
        })
    })
    .await
    .map_err(|e| format!("后台导入任务异常: {e}"))?
}

#[tauri::command]
async fn get_cloud_config() -> Result<CloudServerConfig, String> {
    tauri::async_runtime::spawn_blocking(cloud_sync::load_cloud_config)
        .await
        .map_err(|e| format!("读取云配置失败: {e}"))
}

#[tauri::command]
async fn save_cloud_config(config: CloudServerConfig) -> Result<CloudServerConfig, String> {
    tauri::async_runtime::spawn_blocking(move || cloud_sync::save_cloud_config(config))
        .await
        .map_err(|e| format!("保存云配置失败: {e}"))?
}

#[tauri::command]
async fn test_cloud_connection(
    server_url: String,
    api_token: String,
) -> Result<CloudConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cloud_sync::test_connection(&server_url, &api_token)
    })
    .await
    .map_err(|e| format!("测试服务器连接失败: {e}"))
}

#[tauri::command]
async fn backup_to_cloud(
    app: AppHandle,
    request: CloudBackupRequest,
) -> Result<CloudBackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = t3_reader::resolve_db_path(request.db_path.as_deref());
        cloud_sync::backup_to_cloud_with_progress(&db, &request, |progress| {
            let _ = app.emit("cloud-backup-progress", &progress);
        })
    })
    .await
    .map_err(|e| format!("云端备份任务异常: {e}"))?
}

#[tauri::command]
async fn create_cloud_share(request: CloudShareRequest) -> Result<CloudShareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = t3_reader::resolve_db_path(request.db_path.as_deref());
        cloud_sync::create_cloud_share(&db, &request)
    })
    .await
    .map_err(|e| format!("创建云分享失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ImportCancelState(Arc::new(AtomicBool::new(false))))
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            scan_t3_database,
            get_thread_detail,
            get_lody_catalog,
            register_lody_local_project,
            export_migration_bundle,
            read_migration_state,
            cancel_lody_import,
            import_to_lody,
            get_cloud_config,
            save_cloud_config,
            test_cloud_connection,
            backup_to_cloud,
            create_cloud_share
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
