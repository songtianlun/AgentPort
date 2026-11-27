import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  CloudUpload,
  Copy,
  KeyRound,
  Link2,
  PlugZap,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  backupToCloud,
  createCloudShare,
  getCloudConfig,
  saveCloudConfig,
  subscribeCloudBackupProgress,
  testCloudConnection,
} from '../api';
import type {
  CloudBackupProgress,
  CloudBackupResult,
  CloudConnectionStatus,
  CloudServerConfig,
  CloudShareResult,
  T3ScanResult,
} from '../types';

interface Props {
  scan: T3ScanResult;
  dbPath?: string;
  selectedIds: Set<string>;
  onConfigUpdated?: (cfg: CloudServerConfig) => void;
}

export const CloudSyncTab: React.FC<Props> = ({
  scan,
  dbPath,
  selectedIds,
  onConfigUpdated,
}) => {
  const [cfg, setCfg] = useState<CloudServerConfig>({
    serverUrl: '',
    apiToken: '',
    deviceName: '',
    autoBackupEnabled: false,
    autoBackupIntervalMinutes: 30,
    lastSyncAt: null,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connStatus, setConnStatus] = useState<CloudConnectionStatus | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const [includeArchived, setIncludeArchived] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupProgress, setBackupProgress] = useState<CloudBackupProgress | null>(null);
  const [backupResult, setBackupResult] = useState<CloudBackupResult | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [shareThreadId, setShareThreadId] = useState<string>(scan.threads[0]?.id || '');
  const [sharePassword, setSharePassword] = useState('');
  const [shareExpiryHours, setShareExpiryHours] = useState<number>(168);
  const [redactSecrets, setRedactSecrets] = useState(true);
  const [hidePaths, setHidePaths] = useState(true);
  const [includePatch, setIncludePatch] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<CloudShareResult | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    getCloudConfig()
      .then((c) => {
        setCfg(c);
        onConfigUpdated?.(c);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let disposed = false;
    subscribeCloudBackupProgress((ev) => {
      if (!disposed) setBackupProgress(ev);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveNote(null);
    try {
      const saved = await saveCloudConfig(cfg);
      setCfg(saved);
      onConfigUpdated?.(saved);
      setSaveNote('配置已保存至 ~/.agentport/cloud-config.json');
    } catch (e) {
      setSaveNote(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setConnStatus(null);
    try {
      const res = await testCloudConnection(cfg.serverUrl, cfg.apiToken);
      setConnStatus(res);
    } catch (e) {
      setConnStatus({
        ok: false,
        serverUrl: cfg.serverUrl,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    setBackupError(null);
    setBackupResult(null);
    setBackupProgress({
      phase: 'diff',
      total: selectedIds.size || scan.threads.length,
      processed: 0,
      uploaded: 0,
      unchanged: 0,
      blobsUploaded: 0,
      failed: 0,
      currentTitle: '正在连接服务端比对增量状态…',
    });
    try {
      await saveCloudConfig(cfg);
      const res = await backupToCloud({
        dbPath,
        selectedThreadIds: Array.from(selectedIds),
        includeArchived,
      });
      setBackupResult(res);
      const refreshed = await getCloudConfig();
      setCfg(refreshed);
      onConfigUpdated?.(refreshed);
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackingUp(false);
    }
  };

  const handleCreateShare = async () => {
    if (!shareThreadId) return;
    setSharing(true);
    setShareError(null);
    setShareResult(null);
    setCopiedUrl(false);
    try {
      await saveCloudConfig(cfg);
      const res = await createCloudShare({
        dbPath,
        threadId: shareThreadId,
        password: sharePassword || undefined,
        expiresInHours: shareExpiryHours || undefined,
        redactSecrets,
        hidePaths,
        includePatch,
      });
      setShareResult(res);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    });
  };

  const progressPct =
    backupProgress && backupProgress.total > 0
      ? Math.min(100, Math.round((backupProgress.processed / backupProgress.total) * 100))
      : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Cloud size={16} color="#60a5fa" />
              云端服务器配置（自建 Docker / 官方云同步）
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
              连接到 AgentPort Server 后，可将本机多工具会话增量备份到云端，并在任意浏览器查看、全文检索与生成加密分享链接。
            </div>
          </div>
          {cfg.lastSyncAt && (
            <span className="pill pill-green">
              上次同步：{cfg.lastSyncAt.slice(0, 19).replace('T', ' ')}
            </span>
          )}
        </div>

        <div className="grid-2" style={{ marginBottom: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 5 }}>
              服务器地址（Server URL）
            </label>
            <input
              className="input mono"
              style={{ width: '100%' }}
              placeholder="例如 https://agentport.example.com 或 http://127.0.0.1:8080"
              value={cfg.serverUrl}
              onChange={(e) => setCfg({ ...cfg, serverUrl: e.target.value })}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 5 }}>
              设备同步 Token（在服务端后台「设备与 Token」生成）
            </label>
            <input
              type="password"
              className="input mono"
              style={{ width: '100%' }}
              placeholder="ap_xxxxxxxxxxxxxxxxxxxxxxxx"
              value={cfg.apiToken}
              onChange={(e) => setCfg({ ...cfg, apiToken: e.target.value })}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>设备名称</span>
            <input
              className="input"
              style={{ width: 210 }}
              value={cfg.deviceName}
              onChange={(e) => setCfg({ ...cfg, deviceName: e.target.value })}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cfg.autoBackupEnabled}
              onChange={(e) => setCfg({ ...cfg, autoBackupEnabled: e.target.checked })}
            />
            启用定时自动增量备份
          </label>
          {cfg.autoBackupEnabled && (
            <select
              className="select"
              value={cfg.autoBackupIntervalMinutes}
              onChange={(e) =>
                setCfg({ ...cfg, autoBackupIntervalMinutes: Number(e.target.value) || 30 })
              }
            >
              <option value={10}>每 10 分钟</option>
              <option value={30}>每 30 分钟</option>
              <option value={60}>每 1 小时</option>
              <option value={180}>每 3 小时</option>
            </select>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            <Save size={14} /> {saving ? '保存中…' : '保存服务器配置'}
          </button>
          <button className="btn" disabled={testing || !cfg.serverUrl} onClick={handleTest}>
            <PlugZap size={14} /> {testing ? '正在测试连接…' : '测试连接'}
          </button>
        </div>

        {saveNote && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#93c5fd' }}>{saveNote}</div>
        )}
        {connStatus && (
          <div
            className={connStatus.ok ? '' : 'err-box'}
            style={
              connStatus.ok
                ? {
                    marginTop: 10,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'var(--green-soft)',
                    border: '1px solid rgba(16, 185, 129, 0.28)',
                    color: '#a7f3d0',
                    fontSize: 12.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }
                : undefined
            }
          >
            {connStatus.ok ? (
              <>
                <CheckCircle2 size={15} />
                连接成功！账号：{connStatus.username} · 服务端版本：{connStatus.serverVersion || 'unknown'}
              </>
            ) : (
              <>
                <XCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                连接失败：{connStatus.error}
              </>
            )}
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <CloudUpload size={16} color="#34d399" />
              增量云备份
            </h3>
            <span className="pill pill-green">SHA256 去重</span>
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)' }}>
            仅上传新增或有变更的会话，图片附件按 SHA256 内容寻址自动去重；已选{' '}
            <strong>{selectedIds.size}</strong> 条会话。
          </p>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              包含已归档会话
            </label>
            <button
              className="btn btn-primary"
              disabled={backingUp || !cfg.serverUrl || !cfg.apiToken}
              onClick={handleBackup}
            >
              <CloudUpload size={14} />
              {backingUp ? '正在增量备份…' : `立即备份 ${selectedIds.size} 条会话`}
            </button>
          </div>

          {backingUp && backupProgress && (
            <div style={{ padding: 12, borderRadius: 9, background: '#0d121d', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span>
                  {backupProgress.phase === 'diff'
                    ? '比对云端哈希…'
                    : `同步进度 ${backupProgress.processed}/${backupProgress.total} (${progressPct}%)`}
                </span>
                <span>
                  新上传 {backupProgress.uploaded} · 跳过 {backupProgress.unchanged}
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              {backupProgress.currentTitle && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  {backupProgress.currentTitle}
                </div>
              )}
            </div>
          )}

          {backupError && <div className="err-box">{backupError}</div>}

          {backupResult && !backingUp && (
            <div
              style={{
                marginTop: 10,
                padding: 12,
                borderRadius: 9,
                background: 'var(--green-soft)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
                fontSize: 12.5,
              }}
            >
              <div style={{ color: '#34d399', fontWeight: 600, marginBottom: 4 }}>
                云备份完成！
              </div>
              <div>
                新上传/更新 <strong>{backupResult.uploaded}</strong> 条 · 无变化跳过{' '}
                <strong>{backupResult.unchanged}</strong> 条 · 上传新附件{' '}
                <strong>{backupResult.blobsUploaded}</strong> 个
                {backupResult.failed > 0 ? ` · 失败 ${backupResult.failed} 条` : ''}
              </div>
              {backupResult.errors.length > 0 && (
                <pre className="pre-box" style={{ marginTop: 8, maxHeight: 120 }}>
                  {backupResult.errors.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <Link2 size={16} color="#c084fc" />
              一键云分享（可选密码 + 自动脱敏）
            </h3>
            <span className="pill pill-purple">
              <ShieldCheck size={11} /> 独立快照
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                选择要分享的会话
              </label>
              <select
                className="select"
                style={{ width: '100%' }}
                value={shareThreadId}
                onChange={(e) => setShareThreadId(e.target.value)}
              >
                {scan.threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    [{t.projectTitle}] {t.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid-2">
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                  <KeyRound size={11} style={{ verticalAlign: -1 }} /> 访问密码（留空则公开）
                </label>
                <input
                  type="password"
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="可选，访客需输入密码查看"
                  value={sharePassword}
                  onChange={(e) => setSharePassword(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                  链接有效期
                </label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={shareExpiryHours}
                  onChange={(e) => setShareExpiryHours(Number(e.target.value))}
                >
                  <option value={24}>24 小时</option>
                  <option value={168}>7 天</option>
                  <option value={720}>30 天</option>
                  <option value={0}>永久有效（可随时撤销）</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={redactSecrets}
                  onChange={(e) => setRedactSecrets(e.target.checked)}
                />
                自动脱敏 API Key / Token
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={hidePaths}
                  onChange={(e) => setHidePaths(e.target.checked)}
                />
                隐藏本机用户路径
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includePatch}
                  onChange={(e) => setIncludePatch(e.target.checked)}
                />
                包含未提交 Patch
              </label>
            </div>

            <div>
              <button
                className="btn btn-primary"
                disabled={sharing || !shareThreadId || !cfg.serverUrl || !cfg.apiToken}
                onClick={handleCreateShare}
              >
                <Link2 size={14} /> {sharing ? '正在同步并生成链接…' : '一键生成分享链接'}
              </button>
            </div>

            {shareError && <div className="err-box">{shareError}</div>}

            {shareResult && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 9,
                  background: 'var(--purple-soft)',
                  border: '1px solid rgba(168, 85, 247, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ color: '#e9d5ff' }}>分享链接已生成！</strong>
                  <span className="pill pill-green">
                    自动脱敏 {shareResult.redactionCount} 处
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input mono" style={{ flex: 1 }} readOnly value={shareResult.shareUrl} />
                  <button className="btn" onClick={() => copyText(shareResult.shareUrl)}>
                    <Copy size={13} /> {copiedUrl ? '已复制' : '复制'}
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {shareResult.hasPassword ? '已启用访问密码保护' : '公开只读链接（无需密码）'}
                  {shareResult.expiresAt ? ` · 过期时间：${shareResult.expiresAt.slice(0, 19).replace('T', ' ')}` : ' · 永久有效'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
