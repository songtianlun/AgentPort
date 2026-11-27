import type {
  ExportRequest,
  ExportResult,
  ImportToLodyRequest,
  ImportToLodyResult,
  LodyCatalog,
  LodyProject,
  MigrationStateRecord,
  T3ScanResult,
  T3ThreadDetail,
} from './types';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export async function getRuntimeInfo(): Promise<{
  runtime: 'tauri-native' | 'web-bridge';
  defaultDbPath: string;
  defaultOutputDir: string;
}> {
  if (isTauriRuntime()) {
    return tauriInvoke<{
      runtime: 'tauri-native';
      defaultDbPath: string;
      defaultOutputDir: string;
    }>('get_runtime_info');
  }
  const h = await httpJson<{
    runtime: 'web-bridge';
    defaultDbPath: string;
    defaultOutputDir: string;
  }>('/api/health');
  return h;
}

export async function scanT3Database(dbPath?: string): Promise<T3ScanResult> {
  if (isTauriRuntime()) {
    return tauriInvoke<T3ScanResult>('scan_t3_database', { dbPath: dbPath || null });
  }
  const q = dbPath ? `?dbPath=${encodeURIComponent(dbPath)}` : '';
  return httpJson<T3ScanResult>(`/api/scan${q}`);
}

export async function getLodyCatalog(): Promise<LodyCatalog> {
  if (isTauriRuntime()) {
    return tauriInvoke<LodyCatalog>('get_lody_catalog', { catalogPath: null });
  }
  return httpJson<LodyCatalog>('/api/catalog');
}

export async function getThreadDetail(threadId: string, dbPath?: string): Promise<T3ThreadDetail> {
  if (isTauriRuntime()) {
    return tauriInvoke<T3ThreadDetail>('get_thread_detail', {
      dbPath: dbPath || null,
      threadId,
    });
  }
  const q = dbPath ? `?dbPath=${encodeURIComponent(dbPath)}` : '';
  return httpJson<T3ThreadDetail>(`/api/thread/${encodeURIComponent(threadId)}${q}`);
}

export async function registerLodyLocalProject(
  rootPath: string,
  workspaceId?: string
): Promise<LodyProject> {
  if (isTauriRuntime()) {
    return tauriInvoke<LodyProject>('register_lody_local_project', {
      rootPath,
      workspaceId: workspaceId || null,
    });
  }
  return httpJson<LodyProject>('/api/lody/register-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath, workspaceId }),
  });
}

export async function exportMigrationBundle(request: ExportRequest): Promise<ExportResult> {
  if (isTauriRuntime()) {
    return tauriInvoke<ExportResult>('export_migration_bundle', {
      request,
      catalogPath: null,
    });
  }
  return httpJson<ExportResult>('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function readMigrationState(outputDir: string): Promise<MigrationStateRecord[]> {
  if (isTauriRuntime()) {
    return tauriInvoke<MigrationStateRecord[]>('read_migration_state', { outputDir });
  }
  return httpJson<MigrationStateRecord[]>(
    `/api/state?outputDir=${encodeURIComponent(outputDir)}`
  );
}

export async function importToLody(request: ImportToLodyRequest): Promise<ImportToLodyResult> {
  if (isTauriRuntime()) {
    return tauriInvoke<ImportToLodyResult>('import_to_lody', {
      request,
      catalogPath: null,
    });
  }
  return httpJson<ImportToLodyResult>('/api/import-lody', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}
