import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Cloud,
  FolderGit2,
  FolderOutput,
  LayoutDashboard,
  MessageSquareText,
  RefreshCw,
  Server,
} from 'lucide-react';
import {
  backupToCloud,
  detectServerCapabilities,
  getCloudConfig,
  getLodyCatalog,
  getRuntimeInfo,
  registerLodyLocalProject,
  scanT3Database,
} from './api';
import { AgentsTab } from './components/AgentsTab';
import { CloudSyncTab } from './components/CloudSyncTab';
import { ExportTab } from './components/ExportTab';
import { OverviewTab } from './components/OverviewTab';
import { ProjectsTab } from './components/ProjectsTab';
import { ServerDashboard } from './components/ServerDashboard';
import { SharePublicView } from './components/SharePublicView';
import { ThreadsTab } from './components/ThreadsTab';
import { resolveAgentGroups, resolveProjectMapping } from './planner';
import type {
  AgentMappingOverride,
  CloudServerConfig,
  LodyCatalog,
  ProjectMappingOverride,
  ServerCapabilities,
  T3ScanResult,
} from './types';

type TabKey = 'overview' | 'projects' | 'agents' | 'threads' | 'export' | 'cloud';

function extractPublicShareSlug(): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

export default function App() {
  const shareSlug = useMemo(() => extractPublicShareSlug(), []);
  const [serverCaps, setServerCaps] = useState<ServerCapabilities | null>(null);
  const [modeChecked, setModeChecked] = useState<boolean>(Boolean(shareSlug));

  const [tab, setTab] = useState<TabKey>('overview');
  const [runtime, setRuntime] = useState<'tauri-native' | 'web-bridge'>('web-bridge');
  const [dbPath, setDbPath] = useState('');
  const [defaultOutputDir, setDefaultOutputDir] = useState('./migration-bundle');
  const [scan, setScan] = useState<T3ScanResult | null>(null);
  const [catalog, setCatalog] = useState<LodyCatalog | null>(null);
  const [cloudCfg, setCloudCfg] = useState<CloudServerConfig | null>(null);
  const [targetMachineId, setTargetMachineId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [projectOverrides, setProjectOverrides] = useState<Record<string, ProjectMappingOverride>>({});
  const [agentOverrides, setAgentOverrides] = useState<Record<string, AgentMappingOverride>>({});
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  const loadAll = async (overrideDbPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const [info, cat] = await Promise.all([getRuntimeInfo(), getLodyCatalog()]);
      setRuntime(info.runtime);
      const effectiveDb = overrideDbPath !== undefined ? overrideDbPath : dbPath || info.defaultDbPath;
      setDbPath(effectiveDb);
      setDefaultOutputDir(info.defaultOutputDir);
      setCatalog(cat);
      setTargetMachineId((prev) => {
        if (prev && cat.machines.some((m) => m.id === prev)) return prev;
        return cat.defaultMachineId;
      });

      const scanRes = await scanT3Database(effectiveDb);
      setScan(scanRes);
      setSelectedThreadIds(new Set(scanRes.threads.map((t) => t.id)));
      getCloudConfig()
        .then((c) => setCloudCfg(c))
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (shareSlug) return;
    let cancelled = false;
    detectServerCapabilities().then((caps) => {
      if (cancelled) return;
      if (caps) {
        setServerCaps(caps);
        setModeChecked(true);
      } else {
        setModeChecked(true);
        loadAll();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareSlug]);

  // Background auto-backup timer when enabled in Desktop Cloud Config
  useEffect(() => {
    if (
      !cloudCfg?.autoBackupEnabled ||
      !cloudCfg.serverUrl ||
      !cloudCfg.apiToken ||
      !scan
    ) {
      return;
    }
    const mins = Math.max(5, cloudCfg.autoBackupIntervalMinutes || 30);
    const id = window.setInterval(() => {
      backupToCloud({
        dbPath,
        selectedThreadIds: [],
        includeArchived: false,
      }).catch(() => {});
    }, mins * 60 * 1000);
    return () => window.clearInterval(id);
  }, [cloudCfg, dbPath, scan]);

  const refreshCatalogOnly = async () => {
    setError(null);
    try {
      const cat = await getLodyCatalog();
      setCatalog(cat);
      setTargetMachineId((prev) =>
        prev && cat.machines.some((m) => m.id === prev) ? prev : cat.defaultMachineId
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRegisterProject = async (projectId: string, rootPath: string) => {
    await registerLodyLocalProject(rootPath, catalog?.workspaceId);
    setProjectOverrides((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    await refreshCatalogOnly();
  };

  const projectMappings = useMemo(() => {
    if (!scan || !catalog || !targetMachineId) return [];
    return scan.projects.map((p) =>
      resolveProjectMapping(p, catalog, targetMachineId, projectOverrides)
    );
  }, [scan, catalog, targetMachineId, projectOverrides]);

  const agentGroups = useMemo(() => {
    if (!scan || !catalog || !targetMachineId) return [];
    return resolveAgentGroups(scan.threads, catalog, targetMachineId, agentOverrides);
  }, [scan, catalog, targetMachineId, agentOverrides]);

  if (shareSlug) {
    return <SharePublicView slug={shareSlug} />;
  }

  if (!modeChecked) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
        正在检测运行环境…
      </div>
    );
  }

  if (serverCaps) {
    return <ServerDashboard initialCaps={serverCaps} />;
  }

  const actionProjCount = projectMappings.filter((p) => p.status === 'action_required').length;
  const degradedAgentCount = agentGroups.filter((g) => g.warnings.length > 0).length;

  const toggleThread = (id: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ArrowRightLeft size={17} />
          </div>
          <div>
            <h1>AgentPort</h1>
            <p>AI 编程工作区迁移与备份</p>
          </div>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-item ${tab === 'overview' ? 'active' : ''}`}
            onClick={() => setTab('overview')}
          >
            <span className="nav-left">
              <LayoutDashboard size={15} /> 迁移总览
            </span>
          </button>
          <button
            className={`nav-item ${tab === 'projects' ? 'active' : ''}`}
            onClick={() => setTab('projects')}
          >
            <span className="nav-left">
              <FolderGit2 size={15} /> 项目映射
            </span>
            {actionProjCount > 0 ? (
              <span className="pill pill-red">{actionProjCount}</span>
            ) : (
              <span className="pill pill-muted">{scan?.projects.length ?? 0}</span>
            )}
          </button>
          <button
            className={`nav-item ${tab === 'agents' ? 'active' : ''}`}
            onClick={() => setTab('agents')}
          >
            <span className="nav-left">
              <Bot size={15} /> 智能体对齐
            </span>
            {degradedAgentCount > 0 ? (
              <span className="pill pill-amber">{degradedAgentCount}</span>
            ) : (
              <span className="pill pill-muted">{agentGroups.length}</span>
            )}
          </button>
          <button
            className={`nav-item ${tab === 'threads' ? 'active' : ''}`}
            onClick={() => setTab('threads')}
          >
            <span className="nav-left">
              <MessageSquareText size={15} /> 会话与上下文
            </span>
            <span className="pill pill-blue">{selectedThreadIds.size}</span>
          </button>
          <button
            className={`nav-item ${tab === 'export' ? 'active' : ''}`}
            onClick={() => setTab('export')}
          >
            <span className="nav-left">
              <FolderOutput size={15} /> 迁移与本地备份
            </span>
          </button>
          <button
            className={`nav-item ${tab === 'cloud' ? 'active' : ''}`}
            onClick={() => setTab('cloud')}
          >
            <span className="nav-left">
              <Cloud size={15} /> 云备份与分享
            </span>
            {cloudCfg?.autoBackupEnabled && <span className="pill pill-green">自动</span>}
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>运行模式</span>
            <span className={`pill ${runtime === 'tauri-native' ? 'pill-green' : 'pill-purple'}`}>
              {runtime === 'tauri-native' ? 'Tauri 原生' : 'Web 预览桥接'}
            </span>
          </div>
          {catalog && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Lody 来源</span>
              <span
                className={`pill ${
                  catalog.daemonConnected
                    ? 'pill-green'
                    : catalog.source === 'example-fallback'
                      ? 'pill-amber'
                      : 'pill-blue'
                }`}
              >
                {catalog.daemonConnected
                  ? '本机实时连接'
                  : catalog.source === 'example-fallback'
                    ? '示例数据'
                    : '本地快照'}
              </span>
            </div>
          )}
          <div>源库格式：{scan?.schemaVersion || '检测中'}</div>
          <div className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
            {scan?.dbPath || dbPath}
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-meta" style={{ flex: 1 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>源数据库</span>
            <input
              className="input mono"
              style={{ flex: '1 1 280px', maxWidth: 440 }}
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
            />
            <button className="btn" onClick={() => loadAll(dbPath)} disabled={loading}>
              <RefreshCw size={13} /> 重新扫描
            </button>
          </div>

          {catalog && (
            <div className="topbar-meta">
              <Server size={14} color="#60a5fa" />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Lody 目标机器</span>
              <select
                className="select"
                value={targetMachineId}
                onChange={(e) => setTargetMachineId(e.target.value)}
              >
                {catalog.machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.onlineStatus === 'online' ? '在线' : '离线'})
                  </option>
                ))}
              </select>
            </div>
          )}
        </header>

        <main className="content">
          {error && (
            <div className="err-box" style={{ padding: 14 }}>
              <strong>加载失败：</strong> {error}
            </div>
          )}

          {catalog?.source === 'example-fallback' && (
            <div
              className="warn-box"
              style={{
                padding: '12px 14px',
                marginTop: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <strong>未连接到本机 Lody：</strong>{' '}
                {catalog.sourceDetail ||
                  '未检测到运行中的 Lody Desktop / Daemon，当前展示的是示例数据。请先启动 Lody 后重新探测。'}
              </div>
              <button className="btn" onClick={refreshCatalogOnly}>
                <RefreshCw size={13} /> 重新探测本机 Lody
              </button>
            </div>
          )}

          {catalog?.daemonConnected && catalog.sourceDetail && (
            <div
              style={{
                padding: '9px 14px',
                borderRadius: 10,
                background: 'var(--green-soft)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
                color: '#a7f3d0',
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>{catalog.sourceDetail}</span>
              <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={refreshCatalogOnly}>
                <RefreshCw size={12} /> 刷新 Lody 目录
              </button>
            </div>
          )}

          {loading && !scan && (
            <div className="card" style={{ color: 'var(--muted)' }}>
              正在以只读模式扫描本机 T3 Code 数据库与 Git 仓库状态…
            </div>
          )}

          {scan && catalog && (
            <>
              {tab === 'overview' && (
                <OverviewTab
                  scan={scan}
                  projectMappings={projectMappings}
                  agentGroups={agentGroups}
                  selectedCount={selectedThreadIds.size}
                  onNavigate={(next) => setTab(next)}
                />
              )}
              {tab === 'projects' && (
                <ProjectsTab
                  mappings={projectMappings}
                  catalog={catalog}
                  targetMachineId={targetMachineId}
                  overrides={projectOverrides}
                  onRegisterProject={handleRegisterProject}
                  onOverrideChange={(pid, ov) =>
                    setProjectOverrides((prev) => {
                      const next = { ...prev };
                      if (ov) next[pid] = ov;
                      else delete next[pid];
                      return next;
                    })
                  }
                />
              )}
              {tab === 'agents' && (
                <AgentsTab
                  groups={agentGroups}
                  catalog={catalog}
                  targetMachineId={targetMachineId}
                  overrides={agentOverrides}
                  onOverrideChange={(k, ov) =>
                    setAgentOverrides((prev) => {
                      const next = { ...prev };
                      if (ov) next[k] = ov;
                      else delete next[k];
                      return next;
                    })
                  }
                />
              )}
              {tab === 'threads' && (
                <ThreadsTab
                  scan={scan}
                  dbPath={dbPath}
                  targetMachineId={targetMachineId}
                  projectMappings={projectMappings}
                  agentGroups={agentGroups}
                  selectedIds={selectedThreadIds}
                  onToggleSelect={toggleThread}
                  onBulkSelect={(ids) => setSelectedThreadIds(new Set(ids))}
                />
              )}
              {tab === 'export' && (
                <ExportTab
                  scan={scan}
                  dbPath={dbPath}
                  defaultOutputDir={defaultOutputDir}
                  targetMachineId={targetMachineId}
                  selectedIds={selectedThreadIds}
                  projectMappings={projectMappings}
                  projectOverrides={projectOverrides}
                  agentOverrides={agentOverrides}
                />
              )}
              {tab === 'cloud' && (
                <CloudSyncTab
                  scan={scan}
                  dbPath={dbPath}
                  selectedIds={selectedThreadIds}
                  onConfigUpdated={(c) => setCloudCfg(c)}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
