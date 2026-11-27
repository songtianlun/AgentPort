import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  FolderPlus,
  GitBranch,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import type { LodyCatalog, ProjectMappingOverride, ResolvedProjectMapping } from '../types';

interface Props {
  mappings: ResolvedProjectMapping[];
  catalog: LodyCatalog;
  targetMachineId: string;
  overrides: Record<string, ProjectMappingOverride>;
  onRegisterProject?: (projectId: string, rootPath: string) => Promise<void>;
  onOverrideChange: (projectId: string, override: ProjectMappingOverride | null) => void;
}

export const ProjectsTab: React.FC<Props> = ({
  mappings,
  catalog,
  targetMachineId,
  overrides,
  onRegisterProject,
  onOverrideChange,
}) => {
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [regError, setRegError] = useState<Record<string, string>>({});

  const localProjects = catalog.projects.filter(
    (p) => p.kind === 'local' && p.machineId === targetMachineId
  );
  const githubProjects = catalog.projects.filter((p) => p.kind === 'github');

  const handleRegister = async (projectId: string, rootPath: string) => {
    if (!onRegisterProject) return;
    setRegisteringId(projectId);
    setRegError((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    try {
      await onRegisterProject(projectId, rootPath);
    } catch (e) {
      setRegError((prev) => ({
        ...prev,
        [projectId]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setRegisteringId(null);
    }
  };

  const encodeValue = (m: ResolvedProjectMapping) => {
    const ov = overrides[m.project.id];
    if (!ov) return 'auto';
    if (ov.targetKind === 'local') return `local::${ov.targetProjectId}`;
    if (ov.targetKind === 'github') return `github::${ov.targetRepo}`;
    return ov.targetKind;
  };

  const handleSelect = (projectId: string, val: string) => {
    if (val === 'auto') {
      onOverrideChange(projectId, null);
    } else if (val.startsWith('local::')) {
      onOverrideChange(projectId, { targetKind: 'local', targetProjectId: val.slice(7) });
    } else if (val.startsWith('github::')) {
      onOverrideChange(projectId, { targetKind: 'github', targetRepo: val.slice(8) });
    } else if (val === 'chat' || val === 'skip') {
      onOverrideChange(projectId, { targetKind: val });
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <FolderGit2 size={16} color="#60a5fa" />
            项目对齐与映射（T3 Code → Lody）
          </h2>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            优先按本地路径精确匹配目标机器项目，其次通过 Git Remote 自动匹配已启用的 GitHub 仓库；所有映射均支持手动覆盖。
          </div>
        </div>
        {Object.keys(overrides).length > 0 && (
          <button
            className="btn"
            onClick={() => Object.keys(overrides).forEach((k) => onOverrideChange(k, null))}
          >
            <RotateCcw size={13} /> 重置手动覆盖
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>T3 Code 项目 & 路径</th>
              <th>Git / 工作区状态</th>
              <th>会话数</th>
              <th>匹配状态</th>
              <th>Lody 目标工作区（可手动覆盖）</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.project.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{m.project.title}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                    {m.project.workspaceRoot}
                  </div>
                </td>
                <td>
                  {m.project.isScratch ? (
                    <span className="pill pill-muted">Scratch / 无项目</span>
                  ) : m.project.git.isGitRepo ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="pill pill-blue">
                          <GitBranch size={11} /> {m.project.git.currentBranch || 'detached'}
                        </span>
                        {m.project.git.dirtyFiles.length > 0 ? (
                          <span className="pill pill-amber">
                            未提交 {m.project.git.dirtyFiles.length} 项
                          </span>
                        ) : (
                          <span className="pill pill-green">工作区干净</span>
                        )}
                      </div>
                      {m.project.git.githubRepo && (
                        <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                          github: {m.project.git.githubRepo}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="pill pill-muted">
                      {m.project.git.exists ? '非 Git 目录' : '目录不存在'}
                    </span>
                  )}
                </td>
                <td>
                  <span className="pill pill-muted">{m.project.threadCount}</span>
                </td>
                <td>
                  {m.status === 'exact' && (
                    <span className="pill pill-green">
                      <CheckCircle2 size={11} /> 精确匹配
                    </span>
                  )}
                  {m.status === 'fallback' && (
                    <span className="pill pill-amber">
                      <AlertTriangle size={11} /> 降级匹配
                    </span>
                  )}
                  {m.status === 'action_required' && (
                    <span className="pill pill-red">
                      <XCircle size={11} /> 需先注册
                    </span>
                  )}
                  {m.status === 'skipped' && <span className="pill pill-muted">已跳过</span>}
                </td>
                <td style={{ minWidth: 280 }}>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={encodeValue(m)}
                    onChange={(e) => handleSelect(m.project.id, e.target.value)}
                  >
                    <option value="auto">自动推断：{m.targetLabel}</option>
                    <optgroup label="目标机器已注册本地项目">
                      {localProjects.map((lp) => (
                        <option key={lp.id} value={`local::${lp.id}`}>
                          [Local] {lp.name} ({lp.rootPath})
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Lody 已启用 GitHub 仓库">
                      {githubProjects.map((gp) => (
                        <option key={gp.id} value={`github::${gp.repoFullName}`}>
                          [GitHub] {gp.repoFullName}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="其他目标策略">
                      <option value="chat">[Chat] 独立聊天工作区 (无代码目录)</option>
                      <option value="skip">[Skip] 暂不迁入 Lody（仅本地归档）</option>
                    </optgroup>
                  </select>
                  {m.warnings.map((w, idx) => (
                    <div
                      key={idx}
                      className={m.status === 'action_required' ? 'err-box' : 'warn-box'}
                    >
                      <div>{w}</div>
                      {m.status === 'action_required' &&
                        catalog.daemonConnected &&
                        targetMachineId === catalog.defaultMachineId &&
                        m.project.git.exists &&
                        onRegisterProject && (
                          <div style={{ marginTop: 8 }}>
                            <button
                              className="btn btn-primary"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              disabled={registeringId === m.project.id}
                              onClick={() => handleRegister(m.project.id, m.project.workspaceRoot)}
                            >
                              <FolderPlus size={13} />
                              {registeringId === m.project.id
                                ? '正在向 Lody 注册…'
                                : '一键添加到本机 Lody'}
                            </button>
                          </div>
                        )}
                      {regError[m.project.id] && (
                        <div style={{ marginTop: 6, color: '#fda4af' }}>
                          注册失败：{regError[m.project.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
