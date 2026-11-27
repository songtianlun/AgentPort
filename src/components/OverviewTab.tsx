import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  FolderGit2,
  GitBranch,
  Layers,
  MessageSquareText,
  ShieldAlert,
} from 'lucide-react';
import type { AgentProfileGroup, ResolvedProjectMapping, T3ScanResult } from '../types';

interface Props {
  scan: T3ScanResult;
  projectMappings: ResolvedProjectMapping[];
  agentGroups: AgentProfileGroup[];
  selectedCount: number;
  onNavigate: (tab: 'projects' | 'agents' | 'threads' | 'export') => void;
}

export const OverviewTab: React.FC<Props> = ({
  scan,
  projectMappings,
  agentGroups,
  selectedCount,
  onNavigate,
}) => {
  const exactProj = projectMappings.filter((p) => p.status === 'exact').length;
  const fallbackProj = projectMappings.filter((p) => p.status === 'fallback').length;
  const actionProj = projectMappings.filter((p) => p.status === 'action_required').length;
  const dirtyRepos = scan.projects.filter((p) => p.git.dirtyFiles.length > 0).length;
  const prThreads = scan.threads.filter((t) => t.pullRequests.length > 0).length;

  const readyThreads = scan.threads.filter((t) => {
    const pm = projectMappings.find((p) => p.project.id === t.projectId);
    return pm && pm.status !== 'action_required' && pm.status !== 'skipped';
  }).length;

  const readinessPct = scan.threads.length
    ? Math.round((readyThreads / scan.threads.length) * 100)
    : 100;

  return (
    <>
      <div className="grid-4">
        <div className="card">
          <div className="stat-label">已扫描活跃项目</div>
          <div className="stat-value">{scan.projects.length}</div>
          <div className="stat-sub">
            精确匹配 {exactProj} · GitHub 降级 {fallbackProj} · 待处理 {actionProj}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">可迁移会话（Threads）</div>
          <div className="stat-value">{scan.threads.length}</div>
          <div className="stat-sub">
            当前已勾选 {selectedCount} 条 · 含关联 PR {prThreads} 条
          </div>
        </div>
        <div className="card">
          <div className="stat-label">上下文与执行轨迹</div>
          <div className="stat-value">{scan.totalMessages}</div>
          <div className="stat-sub">
            Turn Items {scan.totalTurnItems.toLocaleString()} · 附件 {scan.totalAttachments} 个
          </div>
        </div>
        <div className="card">
          <div className="stat-label">直接迁入就绪度</div>
          <div className="stat-value" style={{ color: readinessPct >= 80 ? '#34d399' : '#fbbf24' }}>
            {readinessPct}%
          </div>
          <div className="stat-sub">
            {readyThreads}/{scan.threads.length} 会话可直接生成 Lody 创建任务
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <ShieldAlert size={16} color="#fbbf24" />
              不一致性诊断清单
            </h2>
            <span className="pill pill-amber">自动预检</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {projectMappings
              .filter((p) => p.status !== 'exact')
              .map((pm) => (
                <div
                  key={pm.project.id}
                  className={pm.status === 'action_required' ? 'err-box' : 'warn-box'}
                  style={{ marginTop: 0 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong>
                      项目「{pm.project.title}」（{pm.project.threadCount} 条会话）
                    </strong>
                    <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={() => onNavigate('projects')}>
                      去配置映射 <ArrowRight size={12} />
                    </button>
                  </div>
                  <div style={{ marginTop: 4 }}>{pm.warnings[0]}</div>
                </div>
              ))}

            {agentGroups
              .filter((g) => g.warnings.length > 0)
              .map((g) => (
                <div key={g.key} className="warn-box" style={{ marginTop: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong>
                      智能体 {g.provider} / {g.model}（{g.threadCount} 条会话）
                    </strong>
                    <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={() => onNavigate('agents')}>
                      调整映射 <ArrowRight size={12} />
                    </button>
                  </div>
                  {g.warnings.map((w, i) => (
                    <div key={i} style={{ marginTop: 4 }}>
                      {w}
                    </div>
                  ))}
                </div>
              ))}

            {dirtyRepos > 0 && (
              <div className="warn-box" style={{ marginTop: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <GitBranch size={14} />
                  <strong>检测到 {dirtyRepos} 个项目存在本地未提交代码改动</strong>
                </div>
                <div style={{ marginTop: 4 }}>
                  Lody 新建 Worktree 不会复制未提交文件，本工具导出时会自动保存 <code>dirty.patch</code> 防止丢改。
                </div>
              </div>
            )}

            {actionProj === 0 && agentGroups.every((g) => g.warnings.length === 0) && (
              <div style={{ color: '#34d399', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={16} /> 所有项目与智能体均已完成无冲突映射！
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Layers size={16} color="#60a5fa" />
              完整性保障策略（三层保真）
            </h2>
            <span className="pill pill-blue">只读安全</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11, color: '#cbd5e1', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <Database size={16} color="#60a5fa" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>零侵入只读读取</strong>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  仅以 <code>SQLITE_OPEN_READ_ONLY</code> 访问 <code>statev2.sqlite</code>（{(scan.dbSizeBytes / 1024 / 1024).toFixed(1)} MB），绝不锁写或改动运行中的 T3 Code。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <MessageSquareText size={16} color="#34d399" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>L1 全量归档 + L2 结构化交接 + L3 元数据还原</strong>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  每个会话同步导出 <code>raw.json</code>、完整 <code>transcript.md</code>、真实图片附件与提炼后的 <code>handoff.md</code>，再通过确定性 <code>operationId</code> 幂等生成 Lody 会话并锁定原标题。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <FolderGit2 size={16} color="#c084fc" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>标准中间层（IR），不锁死目标端</strong>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  导出的 <code>migration-bundle/</code> 同时包含标准 IR <code>manifest.json</code> 与 Lody 专属 <code>lody-mcp-batch.json</code>、<code>migration-state.json</code>，支持断点续传和未来扩展其他目标平台。
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => onNavigate('projects')}>
              1. 核对项目映射
            </button>
            <button className="btn" onClick={() => onNavigate('threads')}>
              2. 预览会话与 Handoff
            </button>
            <button className="btn" onClick={() => onNavigate('export')}>
              3. 导出迁移包
            </button>
          </div>
        </div>
      </div>

      {actionProj > 0 && (
        <div className="card" style={{ borderColor: 'rgba(245, 158, 11, 0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fbbf24', fontWeight: 600 }}>
            <AlertTriangle size={15} />
            关于未注册本地项目的说明
          </div>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 12.5 }}>
            Lody MCP 的项目目录接口为只读设计，无法代为向 Lody 注册新的本地磁盘路径。对于标注为「待处理」的项目，你可以先在 Lody 客户端添加对应目录，或在「项目映射」页直接改选为 GitHub 仓库 / 独立 Chat / 暂不迁移。
          </p>
        </div>
      )}
    </>
  );
};
