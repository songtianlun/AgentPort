export interface GitInfo {
  exists: boolean;
  isGitRepo: boolean;
  remoteOrigin: string | null;
  githubRepo: string | null;
  currentBranch: string | null;
  dirtyFiles: string[];
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  isScratch: boolean;
  deletedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  threadCount: number;
  git: GitInfo;
}

export interface T3PullRequest {
  host: string | null;
  repository: string | null;
  number: number | null;
  url: string;
  state: string | null;
  title: string | null;
  headBranch: string | null;
  baseBranch: string | null;
}

export interface T3Attachment {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  localPath: string | null;
  exists: boolean;
}

export interface T3Message {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  attachments: T3Attachment[];
}

export interface T3ThreadSummary {
  id: string;
  projectId: string;
  projectTitle: string;
  title: string;
  provider: string;
  providerInstanceId: string;
  model: string | null;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  worktreeDirtyCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  messageCount: number;
  turnItemCount: number;
  attachmentCount: number;
  pullRequests: T3PullRequest[];
  turnItemBreakdown: Record<string, number>;
}

export interface T3ThreadDetail {
  summary: T3ThreadSummary;
  messages: T3Message[];
  handoffMarkdown: string;
  transcriptMarkdown: string;
  uncommittedDiff: string | null;
}

export interface T3ScanResult {
  dbPath: string;
  dbSizeBytes: number;
  schemaVersion: string;
  scannedAt: string;
  projects: T3Project[];
  threads: T3ThreadSummary[];
  totalMessages: number;
  totalTurnItems: number;
  totalAttachments: number;
}

export interface LodyMachine {
  id: string;
  name: string;
  onlineStatus: string;
}

export interface LodyProject {
  id: string;
  name: string;
  kind: 'local' | 'github' | string;
  machineId: string | null;
  rootPath: string | null;
  repoFullName: string | null;
  available: boolean;
}

export interface LodyAgentConfig {
  id: string;
  name: string;
  machineId: string;
  agentType: string;
  available: boolean;
  modes: string[];
  models: string[];
  planMode: boolean;
  fastMode: boolean;
}

export interface LodyCatalog {
  workspaceId: string;
  defaultMachineId: string;
  machines: LodyMachine[];
  projects: LodyProject[];
  agentConfigs: LodyAgentConfig[];
  source?: string;
  sourceDetail?: string;
  daemonConnected?: boolean;
}

export interface ProjectMappingOverride {
  targetKind: 'local' | 'github' | 'chat' | 'skip';
  targetProjectId?: string;
  targetRepo?: string;
}

export interface AgentMappingOverride {
  agentConfigId: string;
  modelId?: string;
  modeId?: string;
}

export interface ResolvedProjectMapping {
  project: T3Project;
  status: 'exact' | 'fallback' | 'action_required' | 'skipped';
  targetKind: 'local' | 'github' | 'chat' | 'unregistered' | 'skip';
  targetLabel: string;
  targetProjectId?: string;
  targetRepo?: string;
  warnings: string[];
}

export interface AgentProfileGroup {
  key: string;
  provider: string;
  model: string;
  runtimeMode: string;
  threadCount: number;
  status: 'exact' | 'degraded' | 'missing';
  resolvedAgentConfigId?: string;
  resolvedAgentName?: string;
  resolvedModelId?: string;
  resolvedModeId?: string;
  warnings: string[];
}

export interface ExportRequest {
  dbPath?: string;
  outputDir: string;
  targetMachineId: string;
  selectedThreadIds: string[];
  includeArchived: boolean;
  projectOverrides: Record<string, ProjectMappingOverride>;
  agentOverrides: Record<string, AgentMappingOverride>;
}

export interface ExportResult {
  outputDir: string;
  exportedThreads: number;
  readyForLody: number;
  actionRequiredCount: number;
  warningCount: number;
  patchesSaved: number;
  attachmentsCopied: number;
  filesWritten: string[];
  lodyBatchPath: string;
  statePath: string;
}

export interface MigrationStateRecord {
  sourceThreadId: string;
  sourceProjectId: string;
  title?: string | null;
  operationId: string;
  status: 'planned_ready' | 'action_required' | 'imported' | 'failed' | string;
  warnings: string[];
  lodySessionId: string | null;
  lastError?: string | null;
  exportedAt: string;
  importedAt?: string | null;
}

export interface ImportToLodyRequest {
  exportRequest: ExportRequest;
  maxCount?: number | null;
  forceReimport?: boolean;
}

export interface ImportItemOutcome {
  sourceThreadId: string;
  title: string;
  operationId: string;
  status: 'imported' | 'skipped_imported' | 'skipped_not_ready' | 'failed' | string;
  lodySessionId: string | null;
  message?: string | null;
}

export interface ImportProgressEvent {
  phase: 'exporting' | 'importing' | 'done' | 'cancelled' | string;
  total: number;
  processed: number;
  importedNow: number;
  skippedAlreadyImported: number;
  failed: number;
  currentThreadId?: string | null;
  currentTitle?: string | null;
  lastOutcome?: ImportItemOutcome | null;
}

export interface ImportToLodyResult {
  outputDir: string;
  statePath: string;
  totalConsidered: number;
  importedNow: number;
  skippedAlreadyImported: number;
  skippedNotReady: number;
  failed: number;
  cancelled?: boolean;
  items: ImportItemOutcome[];
  stateRecords: MigrationStateRecord[];
}

export interface CloudServerConfig {
  serverUrl: string;
  apiToken: string;
  deviceName: string;
  autoBackupEnabled: boolean;
  autoBackupIntervalMinutes: number;
  lastSyncAt?: string | null;
}

export interface CloudConnectionStatus {
  ok: boolean;
  serverUrl: string;
  username?: string | null;
  serverVersion?: string | null;
  error?: string | null;
}

export interface CloudBackupRequest {
  dbPath?: string;
  selectedThreadIds: string[];
  includeArchived: boolean;
}

export interface CloudBackupProgress {
  phase: string;
  total: number;
  processed: number;
  uploaded: number;
  unchanged: number;
  blobsUploaded: number;
  failed: number;
  currentTitle?: string | null;
}

export interface CloudBackupResult {
  totalConsidered: number;
  uploaded: number;
  unchanged: number;
  blobsUploaded: number;
  failed: number;
  errors: string[];
  syncedAt: string;
}

export interface CloudShareRequest {
  dbPath?: string;
  threadId: string;
  title?: string;
  password?: string;
  expiresInHours?: number;
  redactSecrets: boolean;
  hidePaths: boolean;
  includePatch: boolean;
}

export interface CloudShareResult {
  slug: string;
  shareUrl: string;
  sessionId: string;
  hasPassword: boolean;
  redactionCount: number;
  expiresAt?: string | null;
}

// --- Server Mode & Public Share Types ---
export interface ServerUser {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

export interface ServerCapabilities {
  ok: boolean;
  mode: 'server';
  version: string;
  initialized: boolean;
  authenticated: boolean;
  user?: ServerUser | null;
  publicUrl?: string;
}

export interface ServerAPIToken {
  id: string;
  userId: string;
  name: string;
  deviceName: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface RemoteSessionAttachment {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  blobSha256?: string;
}

export interface RemoteSessionMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  attachments?: RemoteSessionAttachment[];
}

export interface RemoteSession {
  id: string;
  sourceTool: string;
  machineId: string;
  machineName: string;
  sourceThreadId: string;
  projectTitle: string;
  workspaceRoot: string;
  title: string;
  provider: string;
  model: string;
  branch: string;
  contentHash: string;
  messageCount: number;
  turnItemCount: number;
  attachmentCount: number;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  syncedAt: string;
  messages?: RemoteSessionMessage[];
  handoffMarkdown?: string;
  transcriptMarkdown?: string;
  dirtyPatch?: string;
  pullRequests?: Array<{
    url: string;
    repository?: string;
    number?: number;
    state?: string;
    title?: string;
    headBranch?: string;
    baseBranch?: string;
  }>;
}

export interface RemoteShareItem {
  slug: string;
  sessionId: string;
  title: string;
  hasPassword: boolean;
  expiresAt?: string | null;
  redactSecrets: boolean;
  hidePaths: boolean;
  includePatch: boolean;
  redactionCount: number;
  viewCount: number;
  createdAt: string;
  revokedAt?: string | null;
  shareUrl: string;
}

export interface PublicShareResponse {
  ok: boolean;
  locked: boolean;
  slug: string;
  title?: string;
  hasPassword: boolean;
  redactSecrets?: boolean;
  hidePaths?: boolean;
  redactionCount?: number;
  viewCount?: number;
  expiresAt?: string | null;
  createdAt: string;
  snapshot?: {
    title: string;
    sourceTool: string;
    projectTitle: string;
    workspaceRoot?: string;
    provider: string;
    model: string;
    branch?: string;
    sourceUpdatedAt: string;
    messages: RemoteSessionMessage[];
    handoffMarkdown?: string;
    dirtyPatch?: string;
    pullRequests?: Array<{
      url: string;
      state?: string;
      headBranch?: string;
      baseBranch?: string;
    }>;
    redactionReport?: {
      totalReplacements: number;
      byCategory?: Record<string, number>;
    };
  };
}
