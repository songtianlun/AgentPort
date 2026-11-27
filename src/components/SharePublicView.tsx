import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Eye,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { publicGetShare, publicUnlockShare } from '../api';
import type { PublicShareResponse } from '../types';

interface Props {
  slug: string;
}

export const SharePublicView: React.FC<Props> = ({ slug }) => {
  const [data, setData] = useState<PublicShareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    publicGetShare(slug)
      .then((res) => setData(res))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [slug]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError(null);
    try {
      const res = await publicUnlockShare(slug, password);
      setData(res);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '28px 18px 60px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            paddingBottom: 14,
            borderBottom: '1px solid var(--border-soft)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="brand-icon" style={{ width: 30, height: 30, borderRadius: 8 }}>
              <ArrowRightLeft size={15} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>AgentPort 公开会话分享</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>只读快照 · slug: {slug}</div>
            </div>
          </div>
          {data && !data.locked && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {data.redactSecrets && (
                <span className="pill pill-green">
                  <ShieldCheck size={11} /> 已脱敏 {data.redactionCount || 0} 处
                </span>
              )}
              <span className="pill pill-muted">
                <Eye size={11} /> {data.viewCount || 1} 次查看
              </span>
            </div>
          )}
        </header>

        {loading && <div className="card">正在加载分享会话…</div>}

        {error && (
          <div className="card" style={{ borderColor: 'rgba(244, 63, 94, 0.35)' }}>
            <strong style={{ color: '#fb7185' }}>无法打开分享</strong>
            <div style={{ marginTop: 6, color: 'var(--muted)' }}>{error}</div>
          </div>
        )}

        {!loading && data?.locked && (
          <div className="card" style={{ maxWidth: 440, margin: '48px auto', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Lock size={18} color="#fbbf24" />
              <h2 style={{ margin: 0, fontSize: 16 }}>此会话受密码保护</h2>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>
              标题：{data.title || '受保护会话'}
            </div>
            <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                type="password"
                className="input"
                placeholder="请输入访问密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <button className="btn btn-primary" type="submit" disabled={unlocking || !password}>
                <KeyRound size={14} /> {unlocking ? '正在验证…' : '解锁查看会话'}
              </button>
              {unlockError && <div className="err-box">{unlockError}</div>}
            </form>
          </div>
        )}

        {!loading && data && !data.locked && data.snapshot && (
          <>
            <div className="card">
              <h1 style={{ margin: '0 0 10px', fontSize: 19, lineHeight: 1.35 }}>
                {data.snapshot.title}
              </h1>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="pill pill-blue">{data.snapshot.sourceTool}</span>
                {data.snapshot.projectTitle && (
                  <span className="pill pill-muted">项目: {data.snapshot.projectTitle}</span>
                )}
                {data.snapshot.model && (
                  <span className="pill pill-purple">{data.snapshot.model}</span>
                )}
                {data.snapshot.branch && (
                  <span className="pill pill-blue">
                    <GitBranch size={11} /> {data.snapshot.branch}
                  </span>
                )}
                {data.snapshot.pullRequests?.map((pr, idx) => (
                  <a
                    key={idx}
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="pill pill-green"
                    style={{ textDecoration: 'none' }}
                  >
                    <GitPullRequest size={11} /> PR ({pr.state || 'linked'})
                  </a>
                ))}
              </div>
              {data.snapshot.workspaceRoot && (
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
                  工作区：{data.snapshot.workspaceRoot}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.snapshot.messages.map((m, idx) => (
                <div key={m.id || idx} className={`msg-card ${m.role}`} style={{ padding: '14px 16px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: 'var(--muted)',
                      marginBottom: 8,
                    }}
                  >
                    <strong style={{ color: m.role === 'user' ? '#93c5fd' : '#34d399' }}>
                      {m.role === 'user' ? 'User' : 'Assistant'}
                    </strong>
                    <span>{m.createdAt?.slice(0, 19).replace('T', ' ')}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13.5, lineHeight: 1.65 }}>
                    {m.text}
                  </div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {m.attachments.map((a) =>
                        a.blobSha256 && a.mimeType?.startsWith('image/') ? (
                          <div key={a.id}>
                            <img
                              src={`/api/v1/public/shares/${encodeURIComponent(slug)}/blobs/${a.blobSha256}`}
                              alt={a.name}
                              style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 8, border: '1px solid var(--border)' }}
                            />
                          </div>
                        ) : (
                          <span key={a.id} className="pill pill-muted">
                            附件：{a.name}
                          </span>
                        )
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {data.snapshot.dirtyPatch && (
              <details className="card">
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                  查看附带的未提交代码 Patch
                </summary>
                <pre className="pre-box" style={{ marginTop: 10 }}>
                  {data.snapshot.dirtyPatch}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
};
