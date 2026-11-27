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
