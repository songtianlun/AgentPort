import type {
  CloudBackupProgress,
  CloudBackupRequest,
  CloudBackupResult,
  CloudConnectionStatus,
  CloudServerConfig,
  CloudShareRequest,
  CloudShareResult,
  ExportRequest,
  ExportResult,
  ImportProgressEvent,
  ImportToLodyRequest,
  ImportToLodyResult,
  LodyCatalog,
  LodyProject,
  MigrationStateRecord,
  PublicShareResponse,
  RemoteSession,
  RemoteShareItem,
  ServerAPIToken,
  ServerCapabilities,
  ServerUser,
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

export async function cancelLodyImport(): Promise<boolean> {
  if (isTauriRuntime()) {
    return tauriInvoke<boolean>('cancel_lody_import');
  }
  return false;
}

export async function subscribeImportProgress(
  handler: (event: ImportProgressEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<ImportProgressEvent>('lody-import-progress', (ev) => {
    handler(ev.payload);
  });
  return unlisten;
}

// --- Desktop Cloud Backup & Share Commands ---
export async function getCloudConfig(): Promise<CloudServerConfig> {
  if (isTauriRuntime()) {
    return tauriInvoke<CloudServerConfig>('get_cloud_config');
  }
  return httpJson<CloudServerConfig>('/api/cloud/config');
}

export async function saveCloudConfig(config: CloudServerConfig): Promise<CloudServerConfig> {
  if (isTauriRuntime()) {
    return tauriInvoke<CloudServerConfig>('save_cloud_config', { config });
  }
  return httpJson<CloudServerConfig>('/api/cloud/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function testCloudConnection(
  serverUrl: string,
  apiToken: string
): Promise<CloudConnectionStatus> {
  if (isTauriRuntime()) {
    return tauriInvoke<CloudConnectionStatus>('test_cloud_connection', {
      serverUrl,
      apiToken,
    });
  }
  return httpJson<CloudConnectionStatus>('/api/cloud/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverUrl, apiToken }),
  });
}

export async function backupToCloud(request: CloudBackupRequest): Promise<CloudBackupResult> {
  if (isTauriRuntime()) {
    return tauriInvoke<CloudBackupResult>('backup_to_cloud', { request });
  }
  return httpJson<CloudBackupResult>('/api/cloud/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function subscribeCloudBackupProgress(
  handler: (event: CloudBackupProgress) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<CloudBackupProgress>('cloud-backup-progress', (ev) => {
    handler(ev.payload);
  });
  return unlisten;
}

export async function createCloudShare(request: CloudShareRequest): Promise<CloudShareResult> {
  if (isTauriRuntime()) {
    return tauriInvoke<CloudShareResult>('create_cloud_share', { request });
  }
  return httpJson<CloudShareResult>('/api/cloud/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

// --- Go Server Mode & Public Share APIs ---
export async function detectServerCapabilities(): Promise<ServerCapabilities | null> {
  if (isTauriRuntime()) return null;
  try {
    const res = await fetch('/api/v1/capabilities', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.mode === 'server') {
      return data as ServerCapabilities;
    }
    return null;
  } catch {
    return null;
  }
}

async function serverJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export async function serverSetup(username: string, password: string): Promise<{ user: ServerUser }> {
  return serverJson('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function serverLogin(username: string, password: string): Promise<{ user: ServerUser }> {
  return serverJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function serverLogout(): Promise<void> {
  await serverJson('/api/v1/auth/logout', { method: 'POST' });
}

export async function serverListSessions(params?: {
  q?: string;
  sourceTool?: string;
  project?: string;
}): Promise<RemoteSession[]> {
  const sp = new URLSearchParams();
  if (params?.q) sp.set('q', params.q);
  if (params?.sourceTool) sp.set('sourceTool', params.sourceTool);
  if (params?.project) sp.set('project', params.project);
  const qs = sp.toString();
  const data = await serverJson<{ items: RemoteSession[] }>(
    `/api/v1/sessions${qs ? `?${qs}` : ''}`
  );
  return data.items || [];
}

export async function serverGetSession(id: string): Promise<RemoteSession> {
  const data = await serverJson<{ session: RemoteSession }>(
    `/api/v1/sessions/${encodeURIComponent(id)}`
  );
  return data.session;
}

export async function serverDeleteSession(id: string): Promise<void> {
  await serverJson(`/api/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function serverListShares(): Promise<RemoteShareItem[]> {
  const data = await serverJson<{ items: RemoteShareItem[] }>('/api/v1/shares');
  return data.items || [];
}

export async function serverCreateShare(payload: {
  sessionId: string;
  title?: string;
  password?: string;
  expiresInHours?: number;
  redactSecrets: boolean;
  hidePaths: boolean;
  includePatch: boolean;
}): Promise<{ share: RemoteShareItem; shareUrl: string }> {
  return serverJson('/api/v1/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function serverRevokeShare(slug: string): Promise<void> {
  await serverJson(`/api/v1/shares/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}

export async function serverListTokens(): Promise<ServerAPIToken[]> {
  const data = await serverJson<{ items: ServerAPIToken[] }>('/api/v1/tokens');
  return data.items || [];
}

export async function serverCreateToken(
  name: string,
  deviceName: string
): Promise<{ token: ServerAPIToken; plain: string }> {
  return serverJson('/api/v1/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, deviceName }),
  });
}

export async function serverRevokeToken(id: string): Promise<void> {
  await serverJson(`/api/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function publicGetShare(slug: string): Promise<PublicShareResponse> {
  return serverJson<PublicShareResponse>(`/api/v1/public/shares/${encodeURIComponent(slug)}`);
}

export async function publicUnlockShare(
  slug: string,
  password: string
): Promise<PublicShareResponse> {
  return serverJson<PublicShareResponse>(
    `/api/v1/public/shares/${encodeURIComponent(slug)}/unlock`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }
  );
}
