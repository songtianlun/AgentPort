import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FlaskConical,
  FolderOutput,
  History,
  RefreshCw,
  Rocket,
  XCircle,
} from 'lucide-react';
import { exportMigrationBundle, importToLody, readMigrationState } from '../api';
import type {
  AgentMappingOverride,
  ExportResult,
  ImportToLodyResult,
  MigrationStateRecord,
  ProjectMappingOverride,
  ResolvedProjectMapping,
  T3ScanResult,
} from '../types';

interface Props {
  scan: T3ScanResult;
  dbPath?: string;
  defaultOutputDir: string;
  targetMachineId: string;
  selectedIds: Set<string>;
  projectMappings: ResolvedProjectMapping[];
  projectOverrides: Record<string, ProjectMappingOverride>;
  agentOverrides: Record<string, AgentMappingOverride>;
}

export const ExportTab: React.FC<Props> = ({
  scan,
  dbPath,
  defaultOutputDir,
  targetMachineId,
  selectedIds,
  projectMappings,
  projectOverrides,
  agentOverrides,
}) => {
  const [outputDir, setOutputDir] = useState(defaultOutputDir);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busyMode, setBusyMode] = useState<null | 'export' | 'import_one' | 'import_all'>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [importResult, setImportResult] = useState<ImportToLodyResult | null>(null);
  const [stateRecords, setStateRecords] = useState<MigrationStateRecord[]>([]);

  const loadState = async (dir = outputDir) => {
    try {
      const records = await readMigrationState(dir);
      setStateRecords(records);
    } catch {
      setStateRecords([]);
    }
  };

  useEffect(() => {
    loadState(outputDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDir]);

  const selectedThreads = scan.threads.filter((t) => selectedIds.has(t.id));
  const readyCount = selectedThreads.filter((t) => {
    const pm = projectMappings.find((p) => p.project.id === t.projectId);
    return pm && pm.status !== 'action_required' && pm.status !== 'skipped';
  }).length;

  const importedIdSet = new Set(
    stateRecords
      .filter((r) => r.status === 'imported' && r.lodySessionId)
      .map((r) => r.sourceThreadId)
  );
  const alreadyImportedSelected = selectedThreads.filter((t) => importedIdSet.has(t.id)).length;
  const remainingToImport = Math.max(0, readyCount - alreadyImportedSelected);

  const buildExportReq = () => ({
    dbPath,
    outputDir,
    targetMachineId,
    selectedThreadIds: Array.from(selectedIds),
    includeArchived,
    projectOverrides,
    agentOverrides,
  });

  const handleExportOnly = async () => {
    setBusyMode('export');
    setError(null);
    try {
      const res = await exportMigrationBundle(buildExportReq());
      setExportResult(res);
      await loadState(res.outputDir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyMode(null);
    }
  };

  const handleImport = async (maxCount: number | null) => {
    setBusyMode(maxCount === 1 ? 'import_one' : 'import_all');
    setError(null);
    try {
      const res = await importToLody({
        exportRequest: buildExportReq(),
        maxCount,
        forceReimport: false,
      });
      setImportResult(res);
      setStateRecords(res.stateRecords);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyMode(null);
    }
  };

  const totalImportedCount = stateRecords.filter((r) => r.status === 'imported').length;
  const totalFailedCount = stateRecords.filter((r) => r.status === 'failed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <FolderOutput size={16} color="#34d399" />
              一键幂等导入到 Lody
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
              自动同步导出完整归档（<code>transcript.md</code>、<code>dirty.patch</code>、原始附件）并逐条导入本机 Lody；已导入会话基于{' '}
              <code>migration-state.json</code> 自动跳过，支持随时中断续跑。
            </div>
          </div>
          <span className="pill pill-green">幂等防重复</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              迁移归档与状态目录
            </label>
            <input
              className="input mono"
              style={{ width: '100%' }}
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              同时包含已归档会话
            </label>
            <span style={{ color: 'var(--muted)' }}>
              已选 <strong>{selectedIds.size}</strong> 条 · 就绪{' '}
              <strong style={{ color: '#34d399' }}>{readyCount}</strong> 条 · 已导入跳过{' '}
              <strong style={{ color: '#60a5fa' }}>{alreadyImportedSelected}</strong> 条 · 本次待新建{' '}
              <strong style={{ color: '#fbbf24' }}>{remainingToImport}</strong> 条
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
            <button
              className="btn btn-primary"
              disabled={busyMode !== null || readyCount === 0}
              onClick={() => handleImport(null)}
            >
              <Rocket size={14} />
              {busyMode === 'import_all'
                ? '正在一键幂等导入到 Lody…'
                : `一键幂等导入 Lody（待新建 ${remainingToImport} 条）`}
            </button>

            <button
              className="btn"
              disabled={busyMode !== null || remainingToImport === 0}
              onClick={() => handleImport(1)}
            >
              <FlaskConical size={14} />
              {busyMode === 'import_one' ? '正在试迁 1 条…' : '试迁 1 条验证'}
            </button>

            <button
              className="btn"
              disabled={busyMode !== null || selectedIds.size === 0}
              onClick={handleExportOnly}
            >
              <Download size={14} />
              {busyMode === 'export' ? '正在导出归档…' : '仅导出迁移包'}
            </button>
          </div>
        </div>

        {busyMode && busyMode !== 'export' && (
          <div className="warn-box" style={{ marginTop: 12 }}>
            正在通过本机 Lody CLI 逐条创建会话、挂载归档附件并写入 <code>migration-state.json</code>
            ，每完成一条即实时落盘，请耐心等待本批结束…
          </div>
        )}

        {error && <div className="err-box">{error}</div>}
      </div>

      {importResult && (
        <div
          className="card"
          style={{
            borderColor:
              importResult.failed === 0
                ? 'rgba(16, 185, 129, 0.35)'
                : 'rgba(245, 158, 11, 0.35)',
          }}
        >
          <div className="card-header">
            <h3 className="card-title" style={{ color: importResult.failed === 0 ? '#34d399' : '#fbbf24' }}>
              <CheckCircle2 size={16} /> 本次 Lody 幂等导入执行完成
            </h3>
            <span className="pill pill-blue">状态已持久化</span>
          </div>

          <div className="grid-4" style={{ marginBottom: 14 }}>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">本次新导入</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#34d399' }}>
                {importResult.importedNow}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">已存在幂等跳过</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#60a5fa' }}>
                {importResult.skippedAlreadyImported}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">需先注册跳过</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#fbbf24' }}>
                {importResult.skippedNotReady}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">失败（可重试）</div>
              <div
                className="stat-value"
                style={{ fontSize: 22, color: importResult.failed > 0 ? '#fb7185' : 'var(--muted)' }}
              >
                {importResult.failed}
              </div>
            </div>
          </div>

          {importResult.items.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>会话标题</th>
                    <th>执行结果</th>
                    <th>Lody Session ID</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {importResult.items.map((it) => (
                    <tr key={it.sourceThreadId}>
                      <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>{it.title}</td>
                      <td>
                        {it.status === 'imported' && <span className="pill pill-green">已导入</span>}
                        {it.status === 'skipped_imported' && (
                          <span className="pill pill-blue">幂等跳过</span>
                        )}
                        {it.status === 'failed' && (
                          <span className="pill pill-red">
                            <XCircle size={11} /> 失败
                          </span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {it.lodySessionId || '-'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{it.message || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {exportResult && !importResult && (
        <div className="card" style={{ borderColor: 'rgba(16, 185, 129, 0.35)' }}>
          <div className="card-header">
            <h3 className="card-title" style={{ color: '#34d399' }}>
              <CheckCircle2 size={16} /> 迁移包导出成功
            </h3>
            <span className="pill pill-green">{exportResult.exportedThreads} 条会话已落盘</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>可导入 Lody：{exportResult.readyForLody}</span>
            <span>未提交补丁：{exportResult.patchesSaved}</span>
            <span>复制附件：{exportResult.attachmentsCopied}</span>
            <span className="mono">状态文件：{exportResult.statePath}</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              <History size={15} color="#93c5fd" />
              幂等迁移状态表（migration-state.json）
            </h3>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
              已累计导入 <strong style={{ color: '#34d399' }}>{totalImportedCount}</strong> 条
              {totalFailedCount > 0 ? ` · 失败 ${totalFailedCount} 条（可再次点击一键导入重试）` : ''}
            </div>
          </div>
          <button className="btn" onClick={() => loadState(outputDir)}>
            <RefreshCw size={12} /> 刷新状态
          </button>
        </div>

        {stateRecords.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
            当前目录尚无迁移记录。点击上方「试迁 1 条验证」或「一键幂等导入 Lody」后，每条会话的导入状态与 Lody Session ID 都会持久化记录在这里。
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>原会话标题</th>
                  <th>状态</th>
                  <th>Lody Session ID</th>
                  <th>导入 / 导出时间</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {stateRecords.map((r) => (
                  <tr key={r.sourceThreadId}>
                    <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>
                      <div>{r.title || r.sourceThreadId}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        op: {r.operationId}
                      </div>
                    </td>
                    <td>
                      {r.status === 'imported' && <span className="pill pill-green">已导入</span>}
                      {r.status === 'planned_ready' && <span className="pill pill-blue">待导入</span>}
                      {r.status === 'action_required' && (
                        <span className="pill pill-amber">需先注册项目</span>
                      )}
                      {r.status === 'failed' && <span className="pill pill-red">失败</span>}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {r.lodySessionId || '-'}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {(r.importedAt || r.exportedAt || '').slice(0, 19).replace('T', ' ')}
                    </td>
                    <td style={{ fontSize: 12, color: r.lastError ? '#fda4af' : 'var(--muted)' }}>
                      {r.lastError || (r.warnings.length > 0 ? r.warnings[0] : '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
