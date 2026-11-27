mod exporter;
mod models;
mod planner;
mod t3_reader;

use models::*;
use std::path::PathBuf;

#[tauri::command]
fn scan_t3_database(db_path: Option<String>) -> Result<T3ScanResult, String> {
    let path = db_path
        .map(PathBuf::from)
        .unwrap_or_else(t3_reader::default_db_path);
    t3_reader::scan_database(&path)
}

#[tauri::command]
fn get_thread_detail(db_path: Option<String>, thread_id: String) -> Result<T3ThreadDetail, String> {
    let path = db_path
        .map(PathBuf::from)
        .unwrap_or_else(t3_reader::default_db_path);
    t3_reader::load_thread_detail(&path, &thread_id)
}

#[tauri::command]
fn get_lody_catalog(catalog_path: Option<String>) -> Result<LodyCatalog, String> {
    let explicit = catalog_path.map(PathBuf::from);
    planner::load_catalog_with_fallback(explicit.as_deref())
}

#[tauri::command]
fn export_migration_bundle(
    request: ExportRequest,
    catalog_path: Option<String>,
) -> Result<ExportResult, String> {
    let db = request
        .db_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(t3_reader::default_db_path);
    let explicit = catalog_path.map(PathBuf::from);
    let catalog = planner::load_catalog_with_fallback(explicit.as_deref())?;
    exporter::export_bundle(&db, &catalog, &request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_t3_database,
            get_thread_detail,
            get_lody_catalog,
            export_migration_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
