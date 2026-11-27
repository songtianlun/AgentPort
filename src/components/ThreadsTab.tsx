import React, { useEffect, useState } from 'react';
import {
  FileCode2,
  GitBranch,
  GitPullRequest,
  Image as ImageIcon,
  MessageSquareText,
  Search,
} from 'lucide-react';
import { getThreadDetail } from '../api';
import { buildLodyCreatePayload } from '../planner';
import type {
  AgentProfileGroup,
  ResolvedProjectMapping,
  T3ScanResult,
  T3ThreadDetail,
} from '../types';

interface Props {
  scan: T3ScanResult;
  dbPath?: string;
  targetMachineId: string;
  projectMappings: ResolvedProjectMapping[];
  agentGroups: AgentProfileGroup[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onBulkSelect: (ids: string[]) => void;
}

export const ThreadsTab: React.FC<Props> = ({
  scan,
  dbPath,
  targetMachineId,
  projectMappings,
  agentGroups,
  selectedIds,
  onToggleSelect,
  onBulkSelect,
}) => {
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [activeThreadId, setActiveThreadId] = useState<string>(scan.threads[0]?.id || '');
  const [detail, setDetail] = useState<T3ThreadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [previewTab, setPreviewTab] = useState<'handoff' | 'messages' | 'payload' | 'transcript'>(
    'handoff'
  );

  const filtered = scan.threads.filter((t) => {
    if (projectFilter !== 'all' && t.projectId !== projectFilter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        t.projectTitle.toLowerCase().includes(q) ||
        (t.branch || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  useEffect(() => {
    if (!activeThreadId) return;
    let cancelled = false;
    setLoadingDetail(true);
    getThreadDetail(activeThreadId, dbPath)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, dbPath]);

  const activeThread = scan.threads.find((t) => t.id === activeThreadId);
  const activeProjMap = activeThread
    ? projectMappings.find((p) => p.project.id === activeThread.projectId)
    : undefined;
  const activeAgent = activeThread
    ? agentGroups.find((g) => g.key === `${activeThread.provider}::${activeThread.model || 'default'}`)
    : undefined;

  const readyFilteredIds = filtered
    .filter((t) => {
      const pm = projectMappings.find((p) => p.project.id === t.projectId);
      return pm && pm.status !== 'action_required' && pm.status !== 'skipped';
    })
    .map((t) => t.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card" style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <Search
              size={14}
              style={{ position: 'absolute', left: 10, top: 9, color: 'var(--muted)' }}
            />
            <input
              className="input"
              style={{ width: '100%', paddingLeft: 30 }}
              placeholder="搜索会话标题、项目名或分支..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="select"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="all">全部项目（{scan.threads.length}）</option>
            {scan.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}（{p.threadCount}）
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => onBulkSelect(readyFilteredIds)}>
            勾选全部就绪项（{readyFilteredIds.length}）
          </button>
          <button className="btn" onClick={() => onBulkSelect(filtered.map((t) => t.id))}>
            全选当前筛选
          </button>
          <button className="btn" onClick={() => onBulkSelect([])}>
            清空勾选
          </button>
        </div>
      </div>

      <div className="split-threads">
        <div className="thread-list">
          {filtered.map((t) => {
            const pm = projectMappings.find((p) => p.project.id === t.projectId);
            const checked = selectedIds.has(t.id);
            const isSelected = t.id === activeThreadId;
            return (
              <div
                key={t.id}
                className={`thread-row ${isSelected ? 'selected' : ''}`}
                onClick={() => setActiveThreadId(t.id)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggleSelect(t.id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, wordBreak: 'break-word' }}>
                    {t.title}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="pill pill-muted">{t.projectTitle}</span>
                    <span className="pill pill-purple">{t.model || t.provider}</span>
                    {pm?.status === 'exact' && <span className="pill pill-green">就绪</span>}
                    {pm?.status === 'fallback' && <span className="pill pill-amber">GitHub降级</span>}
                    {pm?.status === 'action_required' && <span className="pill pill-red">待注册项目</span>}
                    {t.branch && (
                      <span className="pill pill-blue">
                        <GitBranch size={10} /> {t.branch}
                      </span>
                    )}
                    {t.pullRequests.length > 0 && (
                      <span className="pill pill-green">
                        <GitPullRequest size={10} /> PR ×{t.pullRequests.length}
                      </span>
                    )}
                    {t.attachmentCount > 0 && (
                      <span className="pill pill-amber">
                        <ImageIcon size={10} /> {t.attachmentCount}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
                    消息 {t.messageCount} · 执行节点 {t.turnItemCount} · 更新于{' '}
                    {t.updatedAt.slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ minHeight: 520 }}>
          {!activeThread ? (
            <div style={{ color: 'var(--muted)' }}>请从左侧选择一条会话进行预览。</div>
          ) : (
            <>
              <div className="card-header" style={{ marginBottom: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="card-title" style={{ wordBreak: 'break-word' }}>
                    <MessageSquareText size={16} color="#60a5fa" />
                    {activeThread.title}
                  </h3>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                    thread: {activeThread.id} · 目标: {activeProjMap?.targetLabel}
                  </div>
                </div>
              </div>

              <div className="tab-strip">
                <button
                  className={`tab-btn ${previewTab === 'handoff' ? 'active' : ''}`}
                  onClick={() => setPreviewTab('handoff')}
                >
                  L2 交接摘要 (Handoff)
                </button>
                <button
                  className={`tab-btn ${previewTab === 'messages' ? 'active' : ''}`}
                  onClick={() => setPreviewTab('messages')}
                >
                  原始对话 ({activeThread.messageCount})
                </button>
                <button
                  className={`tab-btn ${previewTab === 'payload' ? 'active' : ''}`}
                  onClick={() => setPreviewTab('payload')}
                >
                  <FileCode2 size={12} style={{ verticalAlign: -2 }} /> Lody Payload
                </button>
                <button
                  className={`tab-btn ${previewTab === 'transcript' ? 'active' : ''}`}
                  onClick={() => setPreviewTab('transcript')}
                >
                  L1 归档 / Patch
                </button>
              </div>

              {loadingDetail && <div style={{ color: 'var(--muted)' }}>正在只读加载会话详情…</div>}

              {!loadingDetail && detail && previewTab === 'handoff' && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                    以下内容将作为新 Lody 会话的首条启动 Prompt，并自动附带完整 <code>transcript.md</code> 归档：
                  </div>
                  <pre className="pre-box">{detail.handoffMarkdown}</pre>
                </>
              )}

              {!loadingDetail && detail && previewTab === 'messages' && (
                <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    {Object.entries(activeThread.turnItemBreakdown).map(([k, v]) => (
                      <span key={k} className="pill pill-muted">
                        {k}: {v}
                      </span>
                    ))}
                  </div>
                  {detail.messages.map((m) => (
                    <div key={m.id} className={`msg-card ${m.role}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                        <strong>{m.role === 'user' ? 'User' : 'Assistant'}</strong>
                        <span>{m.createdAt}</span>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5 }}>
                        {m.text.length > 1200 ? m.text.slice(0, 1200) + '\n…（已折叠，完整版见 L1 归档）' : m.text}
                      </div>
                      {m.attachments.length > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {m.attachments.map((a) => (
                            <span key={a.id} className={`pill ${a.exists ? 'pill-green' : 'pill-red'}`}>
                              附件: {a.name} ({a.exists ? '本地文件已定位' : '缺失'})
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!loadingDetail && activeProjMap && previewTab === 'payload' && (
                <pre className="pre-box">
                  {JSON.stringify(
                    buildLodyCreatePayload(
                      activeThread,
                      activeProjMap,
                      activeAgent,
                      targetMachineId,
                      detail?.handoffMarkdown
                    ),
                    null,
                    2
                  )}
                </pre>
              )}

              {!loadingDetail && detail && previewTab === 'transcript' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {detail.uncommittedDiff && (
                    <div>
                      <div className="pill pill-amber" style={{ marginBottom: 6 }}>
                        检测到未提交代码改动（将导出为 dirty.patch）
                      </div>
                      <pre className="pre-box" style={{ maxHeight: 180 }}>
                        {detail.uncommittedDiff.slice(0, 3000)}
                      </pre>
                    </div>
                  )}
                  <pre className="pre-box">{detail.transcriptMarkdown}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
