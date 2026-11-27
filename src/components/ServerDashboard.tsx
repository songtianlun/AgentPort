import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Lock,
  LogOut,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  serverCreateShare,
  serverCreateToken,
  serverDeleteSession,
  serverGetSession,
  serverListSessions,
  serverListShares,
  serverListTokens,
  serverLogin,
  serverLogout,
  serverRevokeShare,
  serverRevokeToken,
  serverSetup,
} from '../api';
import type {
  RemoteSession,
  RemoteShareItem,
  ServerAPIToken,
  ServerCapabilities,
} from '../types';

interface Props {
  initialCaps: ServerCapabilities;
}

export const ServerDashboard: React.FC<Props> = ({ initialCaps }) => {
  const [caps, setCaps] = useState<ServerCapabilities>(initialCaps);
  const [authUser, setAuthUser] = useState('admin');
  const [authPass, setAuthPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [tab, setTab] = useState<'sessions' | 'shares' | 'tokens'>('sessions');
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeDetail, setActiveDetail] = useState<RemoteSession | null>(null);
  const [shares, setShares] = useState<RemoteShareItem[]>([]);
  const [tokens, setTokens] = useState<ServerAPIToken[]>([]);

  // Share form inside session viewer
  const [showShareBox, setShowShareBox] = useState(false);
  const [sharePw, setSharePw] = useState('');
  const [shareExp, setShareExp] = useState(168);
  const [shareRedact, setShareRedact] = useState(true);
  const [shareHidePaths, setShareHidePaths] = useState(true);
  const [createdShareUrl, setCreatedShareUrl] = useState<string | null>(null);

  // Token creation form
  const [newTokenName, setNewTokenName] = useState('My Desktop');
  const [newTokenDevice, setNewTokenDevice] = useState('');
  const [createdPlainToken, setCreatedPlainToken] = useState<string | null>(null);

  const loadSessions = async (q = searchQ) => {
    const list = await serverListSessions({ q });
    setSessions(list);
    if (list.length > 0 && !activeSessionId) {
      setActiveSessionId(list[0].id);
    }
  };

  const loadShares = async () => setShares(await serverListShares());
  const loadTokens = async () => setTokens(await serverListTokens());

  useEffect(() => {
    if (!caps.authenticated) return;
    loadSessions('');
    loadShares();
    loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.authenticated]);

  useEffect(() => {
    if (!caps.authenticated || !activeSessionId) return;
    serverGetSession(activeSessionId)
      .then((s) => setActiveDetail(s))
      .catch(() => setActiveDetail(null));
  }, [caps.authenticated, activeSessionId]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = caps.initialized
        ? await serverLogin(authUser, authPass)
        : await serverSetup(authUser, authPass);
      setCaps({ ...caps, initialized: true, authenticated: true, user: res.user });
      setAuthPass('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    await serverLogout();
    setCaps({ ...caps, authenticated: false, user: null });
  };

  const handleCreateShare = async () => {
    if (!activeDetail) return;
    const res = await serverCreateShare({
      sessionId: activeDetail.id,
      title: activeDetail.title,
      password: sharePw || undefined,
      expiresInHours: shareExp || undefined,
      redactSecrets: shareRedact,
      hidePaths: shareHidePaths,
      includePatch: false,
    });
    setCreatedShareUrl(res.shareUrl);
    setSharePw('');
    await loadShares();
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await serverCreateToken(newTokenName, newTokenDevice);
    setCreatedPlainToken(res.plain);
    await loadTokens();
  };

  if (!caps.authenticated) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
        <div className="card" style={{ width: '100%', maxWidth: 420 }}>
          <div className="brand" style={{ padding: 0, marginBottom: 14 }}>
            <div className="brand-icon">
              <ArrowRightLeft size={17} />
            </div>
            <div>
              <h1>AgentPort Server</h1>
              <p>{caps.initialized ? '登录云端会话管理台' : '首次启动：初始化管理员账号'}</p>
            </div>
          </div>
          <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="input"
              placeholder="用户名（如 admin）"
              value={authUser}
              onChange={(e) => setAuthUser(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="密码（至少 6 位）"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={authBusy}>
              {authBusy ? '提交中…' : caps.initialized ? '登录' : '创建管理员并进入'}
            </button>
            {authError && <div className="err-box">{authError}</div>}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ArrowRightLeft size={17} />
          </div>
          <div>
            <h1>AgentPort Server</h1>
            <p>云备份与会话分享中心</p>
          </div>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-item ${tab === 'sessions' ? 'active' : ''}`}
            onClick={() => setTab('sessions')}
          >
            <span className="nav-left">
              <MessageSquareText size={15} /> 云端会话库
            </span>
            <span className="pill pill-blue">{sessions.length}</span>
          </button>
          <button
            className={`nav-item ${tab === 'shares' ? 'active' : ''}`}
            onClick={() => setTab('shares')}
          >
            <span className="nav-left">
              <Link2 size={15} /> 分享管理
            </span>
            <span className="pill pill-purple">
              {shares.filter((s) => !s.revokedAt).length}
            </span>
          </button>
          <button
            className={`nav-item ${tab === 'tokens' ? 'active' : ''}`}
            onClick={() => setTab('tokens')}
          >
            <span className="nav-left">
              <KeyRound size={15} /> 设备与 Token
            </span>
            <span className="pill pill-muted">
              {tokens.filter((t) => !t.revokedAt).length}
            </span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>账号：{caps.user?.username}</span>
            <span className="pill pill-green">{caps.version}</span>
          </div>
          <button className="btn" style={{ justifyContent: 'center' }} onClick={handleLogout}>
            <LogOut size={13} /> 退出登录
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div style={{ fontWeight: 600 }}>
            {tab === 'sessions' && '云端会话库（FTS5 全文搜索）'}
            {tab === 'shares' && '公开分享链接管理'}
            {tab === 'tokens' && '桌面端同步 Token 管理'}
          </div>
          <button
            className="btn"
            onClick={() => {
              loadSessions();
              loadShares();
              loadTokens();
            }}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </header>

        <main className="content">
          {tab === 'sessions' && (
            <>
              <div className="card" style={{ padding: '12px 16px' }}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    loadSessions(searchQ);
                  }}
                  style={{ display: 'flex', gap: 10 }}
                >
                  <div style={{ position: 'relative', flex: 1 }}>
                    <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--muted)' }} />
                    <input
                      className="input"
                      style={{ width: '100%', paddingLeft: 30 }}
                      placeholder="全文搜索会话标题、项目或历史对话内容..."
                      value={searchQ}
                      onChange={(e) => setSearchQ(e.target.value)}
                    />
                  </div>
                  <button className="btn btn-primary" type="submit">
                    搜索
                  </button>
                </form>
              </div>

              <div className="split-threads">
                <div className="thread-list">
                  {sessions.length === 0 && (
                    <div className="card" style={{ color: 'var(--muted)' }}>
                      云端暂无已备份会话。请先在「设备与 Token」生成 API Token，然后在 AgentPort 桌面客户端中配置本服务地址并点击备份。
                    </div>
                  )}
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`thread-row ${s.id === activeSessionId ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveSessionId(s.id);
                        setShowShareBox(false);
                        setCreatedShareUrl(null);
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{s.title}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                          <span className="pill pill-blue">{s.sourceTool}</span>
                          <span className="pill pill-muted">{s.projectTitle || 'No project'}</span>
                          <span className="pill pill-purple">{s.model || s.provider}</span>
                          <span className="pill pill-muted">{s.machineName}</span>
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
                          消息 {s.messageCount} · 同步于 {s.syncedAt.slice(0, 16).replace('T', ' ')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="card" style={{ minHeight: 520 }}>
                  {!activeDetail ? (
                    <div style={{ color: 'var(--muted)' }}>选择左侧会话即可查看完整历史记录或创建分享链接。</div>
                  ) : (
                    <>
                      <div className="card-header">
                        <div style={{ minWidth: 0 }}>
                          <h3 className="card-title">{activeDetail.title}</h3>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                            {activeDetail.sourceTool} · {activeDetail.machineName} · {activeDetail.workspaceRoot}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="btn btn-primary"
                            onClick={() => {
                              setShowShareBox((v) => !v);
                              setCreatedShareUrl(null);
                            }}
                          >
                            <Link2 size={13} /> 分享链接
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={async () => {
                              await serverDeleteSession(activeDetail.id);
                              setActiveDetail(null);
                              setActiveSessionId('');
                              await loadSessions();
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {showShareBox && (
                        <div
                          style={{
                            marginBottom: 14,
                            padding: 12,
                            borderRadius: 10,
                            background: '#0d121d',
                            border: '1px solid var(--border)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                          }}
                        >
                          <div className="grid-2">
                            <input
                              type="password"
                              className="input"
                              placeholder="可选访问密码（留空公开）"
                              value={sharePw}
                              onChange={(e) => setSharePw(e.target.value)}
                            />
                            <select
                              className="select"
                              value={shareExp}
                              onChange={(e) => setShareExp(Number(e.target.value))}
                            >
                              <option value={24}>24 小时后过期</option>
                              <option value={168}>7 天后过期</option>
                              <option value={720}>30 天后过期</option>
                              <option value={0}>永久有效</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={shareRedact}
                                onChange={(e) => setShareRedact(e.target.checked)}
                              />
                              自动脱敏 API Key / Token
                            </label>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={shareHidePaths}
                                onChange={(e) => setShareHidePaths(e.target.checked)}
                              />
                              隐藏本机用户路径
                            </label>
                            <button className="btn btn-primary" onClick={handleCreateShare}>
                              生成公开快照链接
                            </button>
                          </div>
                          {createdShareUrl && (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <input className="input mono" style={{ flex: 1 }} readOnly value={createdShareUrl} />
                              <button className="btn" onClick={() => navigator.clipboard?.writeText(createdShareUrl)}>
                                <Copy size={13} /> 复制
                              </button>
                              <a className="btn" href={createdShareUrl} target="_blank" rel="noreferrer">
                                <ExternalLink size={13} /> 打开
                              </a>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                        {(activeDetail.messages || []).map((m) => (
                          <div key={m.id} className={`msg-card ${m.role}`}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 5 }}>
                              <strong>{m.role === 'user' ? 'User' : 'Assistant'}</strong>
                              <span>{m.createdAt}</span>
                            </div>
                            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
                              {m.text}
                            </div>
                            {m.attachments && m.attachments.length > 0 && (
                              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {m.attachments.map((a) =>
                                  a.blobSha256 && a.mimeType?.startsWith('image/') ? (
                                    <img
                                      key={a.id}
                                      src={`/api/v1/blobs/${a.blobSha256}`}
                                      alt={a.name}
                                      style={{ maxWidth: '100%', maxHeight: 340, borderRadius: 8 }}
                                    />
                                  ) : (
                                    <span key={a.id} className="pill pill-muted">
                                      {a.name}
                                    </span>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === 'shares' && (
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>分享标题 & 链接</th>
                      <th>保护与脱敏</th>
                      <th>查看次数</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.map((sh) => (
                      <tr key={sh.slug}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{sh.title}</div>
                          <div className="mono" style={{ fontSize: 11.5, color: '#93c5fd' }}>
                            {sh.shareUrl}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {sh.hasPassword ? (
                              <span className="pill pill-amber">
                                <Lock size={10} /> 密码保护
                              </span>
                            ) : (
                              <span className="pill pill-muted">公开</span>
                            )}
                            {sh.redactSecrets && (
                              <span className="pill pill-green">
                                <ShieldCheck size={10} /> 脱敏 {sh.redactionCount} 处
                              </span>
                            )}
                          </div>
                        </td>
                        <td>{sh.viewCount}</td>
                        <td>
                          {sh.revokedAt ? (
                            <span className="pill pill-red">已撤销</span>
                          ) : (
                            <span className="pill pill-green">生效中</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn"
                              style={{ padding: '4px 8px' }}
                              onClick={() => navigator.clipboard?.writeText(sh.shareUrl)}
                            >
                              <Copy size={12} /> 复制
                            </button>
                            <a
                              className="btn"
                              style={{ padding: '4px 8px', textDecoration: 'none' }}
                              href={sh.shareUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink size={12} />
                            </a>
                            {!sh.revokedAt && (
                              <button
                                className="btn btn-danger"
                                style={{ padding: '4px 8px' }}
                                onClick={async () => {
                                  await serverRevokeShare(sh.slug);
                                  await loadShares();
                                }}
                              >
                                撤销
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'tokens' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">签发桌面客户端同步 Token</h3>
                </div>
                <form onSubmit={handleCreateToken} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    placeholder="Token 名称（如 Arch 笔记本）"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                  />
                  <input
                    className="input"
                    placeholder="设备标识（可选）"
                    value={newTokenDevice}
                    onChange={(e) => setNewTokenDevice(e.target.value)}
                  />
                  <button className="btn btn-primary" type="submit">
                    <Plus size={14} /> 生成新 Token
                  </button>
                </form>
                {createdPlainToken && (
                  <div className="warn-box" style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      请立即复制以下 API Token（仅展示一次），填入 AgentPort 桌面端「云备份与分享」页：
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="input mono" style={{ flex: 1 }} readOnly value={createdPlainToken} />
                      <button
                        className="btn"
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(createdPlainToken)}
                      >
                        <Copy size={13} /> 复制 Token
                      </button>
                    </div>
                    <div className="mono" style={{ fontSize: 11.5, marginTop: 6 }}>
                      当前服务器地址：{window.location.origin}
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>名称 / 设备</th>
                        <th>前缀</th>
                        <th>最近同步</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokens.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{t.name}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.deviceName || '-'}</div>
                          </td>
                          <td className="mono">{t.prefix}…</td>
                          <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                            {t.lastUsedAt ? t.lastUsedAt.slice(0, 19).replace('T', ' ') : '未使用'}
                          </td>
                          <td>
                            {t.revokedAt ? (
                              <span className="pill pill-red">已吊销</span>
                            ) : (
                              <span className="pill pill-green">有效</span>
                            )}
                          </td>
                          <td>
                            {!t.revokedAt && (
                              <button
                                className="btn btn-danger"
                                style={{ padding: '4px 8px' }}
                                onClick={async () => {
                                  await serverRevokeToken(t.id);
                                  await loadTokens();
                                }}
                              >
                                吊销
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
