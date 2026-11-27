import React, { useState } from 'react';
import { CheckCircle2, Download, FolderOutput, Play, Terminal } from 'lucide-react';
import { exportMigrationBundle } from '../api';
import type {
  AgentMappingOverride,
  ExportResult,
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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  const selectedThreads = scan.threads.filter((t) => selectedIds.has(t.id));
  const readyCount = selectedThreads.filter((t) => {
    const pm = projectMappings.find((p) => p.project.id === t.projectId);
    return pm && pm.status !== 'action_required' && pm.status !== 'skipped';
  }).length;

  const handleExport = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await exportMigrationBundle({
        dbPath,
        outputDir,
        targetMachineId,
        selectedThreadIds: Array.from(selectedIds),
        includeArchived,
        projectOverrides,
        agentOverrides,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <FolderOutput size={16} color="#34d399" />
            导出标准化迁移包（IR + Lody 批量执行清单）
          </h2>
          <span className="pill pill-green">幂等可重跑</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              导出目标目录
            </label>
            <input
              className="input mono"
              style={{ width: '100%' }}
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={running || selectedIds.size === 0}
            onClick={handleExport}
            style={{ height: 34 }}
          >
            <Download size={14} />
            {running ? '正在打包导出…' : `导出已选 ${selectedIds.size} 条会话`}
          </button>
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            同时包含已归档会话
          </label>
          <span style={{ color: 'var(--muted)' }}>
            预计生成可立即迁入 Lody 的会话：<strong style={{ color: '#34d399' }}>{readyCount}</strong> 条 · 需先注册项目的会话：
            <strong style={{ color: '#fb7185' }}>{selectedThreads.length - readyCount}</strong> 条
          </span>
        </div>

        {error && <div className="err-box">{error}</div>}
      </div>

      {result && (
        <div className="card" style={{ borderColor: 'rgba(16, 185, 129, 0.35)' }}>
          <div className="card-header">
            <h3 className="card-title" style={{ color: '#34d399' }}>
              <CheckCircle2 size={16} /> 迁移包导出成功！
            </h3>
            <span className="pill pill-green">{result.exportedThreads} 条会话已落盘</span>
          </div>

          <div className="grid-4" style={{ marginBottom: 14 }}>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">可直接导入 Lody</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#34d399' }}>
                {result.readyForLody}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">需先注册项目</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#fb7185' }}>
                {result.actionRequiredCount}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">保存未提交补丁</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#fbbf24' }}>
                {result.patchesSaved}
              </div>
            </div>
            <div style={{ background: '#0d121d', padding: 12, borderRadius: 9 }}>
              <div className="stat-label">复制原始附件</div>
              <div className="stat-value" style={{ fontSize: 22, color: '#60a5fa' }}>
                {result.attachmentsCopied}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              <strong>Lody MCP 批量指令清单：</strong>
              <code className="mono">{result.lodyBatchPath}</code>
            </div>
            <div>
              <strong>幂等状态跟踪表（断点续传）：</strong>
              <code className="mono">{result.statePath}</code>
            </div>
          </div>

          <div className="warn-box" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <Play size={13} /> 下一步：一键导入 Lody
            </div>
            <div style={{ marginTop: 4 }}>
              在 Lody 对话中直接告诉我“按 <code>{result.lodyBatchPath}</code> 挑 1 条或全部导入到 Lody”，我会按确定性{' '}
              <code>operationId</code> 调用 <code>lody_session_create</code> + <code>lody_session_manage(rename)</code> 完成建会话并回写{' '}
              <code>migration-state.json</code>。
            </div>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
              查看已生成的 {result.filesWritten.length} 个文件清单
            </summary>
            <pre className="pre-box" style={{ marginTop: 8, maxHeight: 220 }}>
              {result.filesWritten.join('\n')}
            </pre>
          </details>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Terminal size={15} color="#93c5fd" />
            编译为独立 Tauri v2 桌面应用
          </h3>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.7 }}>
          本仓库已内置完整的 Rust Tauri v2 后端（<code>src-tauri/src/t3_reader.rs</code>、<code>planner.rs</code>、
          <code>exporter.rs</code>，直连 <code>rusqlite</code> 只读解析）。在安装 Rust 与系统 WebView 依赖后即可一键编译原生客户端：
        </div>
        <pre className="pre-box" style={{ marginTop: 10, maxHeight: 150 }}>
{`# Ubuntu / Debian 依赖与 Rust 安装
sudo apt install -y build-essential libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 启动原生 Tauri 桌面窗口 / 打包 AppImage 或 DMG
npm run tauri dev
npm run tauri build`}
        </pre>
      </div>
    </div>
  );
};
