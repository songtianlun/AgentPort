mod exporter;
mod models;
mod planner;
mod t3_reader;

use models::*;
use serde::Serialize;

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
fn scan_t3_database(db_path: Option<String>) -> Result<T3ScanResult, String> {
    let path = t3_reader::resolve_db_path(db_path.as_deref());
    t3_reader::scan_database(&path)
}

#[tauri::command]
fn get_thread_detail(db_path: Option<String>, thread_id: String) -> Result<T3ThreadDetail, String> {
    let path = t3_reader::resolve_db_path(db_path.as_deref());
    t3_reader::load_thread_detail(&path, &thread_id)
}

#[tauri::command]
fn get_lody_catalog(catalog_path: Option<String>) -> Result<LodyCatalog, String> {
    planner::load_catalog_with_fallback(catalog_path.as_deref())
}

#[tauri::command]
fn export_migration_bundle(
    request: ExportRequest,
    catalog_path: Option<String>,
) -> Result<ExportResult, String> {
    let db = t3_reader::resolve_db_path(request.db_path.as_deref());
    let catalog = planner::load_catalog_with_fallback(catalog_path.as_deref())?;
    exporter::export_bundle(&db, &catalog, &request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            scan_t3_database,
            get_thread_detail,
            get_lody_catalog,
            export_migration_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
