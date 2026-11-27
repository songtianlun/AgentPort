import React from 'react';
import { Bot, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';
import type { AgentMappingOverride, AgentProfileGroup, LodyCatalog } from '../types';

interface Props {
  groups: AgentProfileGroup[];
  catalog: LodyCatalog;
  targetMachineId: string;
  overrides: Record<string, AgentMappingOverride>;
  onOverrideChange: (key: string, override: AgentMappingOverride | null) => void;
}

export const AgentsTab: React.FC<Props> = ({
  groups,
  catalog,
  targetMachineId,
  overrides,
  onOverrideChange,
}) => {
  const configs = catalog.agentConfigs.filter((c) => c.machineId === targetMachineId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Bot size={16} color="#c084fc" />
              智能体 / 模型 / 权限模式对齐
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
              基于目标机器实时拉取的 Lody <code>agent_configs</code> 能力矩阵进行映射，自动标出权限模式与模型差异。
            </div>
          </div>
          {Object.keys(overrides).length > 0 && (
            <button
              className="btn"
              onClick={() => Object.keys(overrides).forEach((k) => onOverrideChange(k, null))}
            >
              <RotateCcw size={13} /> 恢复自动映射
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>T3 Code 配置 (Provider / Model / Mode)</th>
                <th>涉及会话</th>
                <th>Lody 目标 Agent</th>
                <th>Lody 目标 Model</th>
                <th>Lody 目标权限 Mode</th>
                <th>一致性</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const selectedCfg =
                  configs.find((c) => c.id === g.resolvedAgentConfigId) || configs[0];

                const updateField = (patch: Partial<AgentMappingOverride>) => {
                  const nextAgentId = patch.agentConfigId || g.resolvedAgentConfigId || configs[0]?.id || '';
                  const nextCfg = configs.find((c) => c.id === nextAgentId);
                  const nextModel =
                    patch.modelId !== undefined
                      ? patch.modelId
                      : nextCfg?.models.includes(g.resolvedModelId || '')
                        ? g.resolvedModelId
                        : nextCfg?.models[0];
                  const nextMode =
                    patch.modeId !== undefined
                      ? patch.modeId
                      : nextCfg?.modes.includes(g.resolvedModeId || '')
                        ? g.resolvedModeId
                        : nextCfg?.modes[0];

                  onOverrideChange(g.key, {
                    agentConfigId: nextAgentId,
                    modelId: nextModel,
                    modeId: nextMode,
                  });
                };

                return (
                  <tr key={g.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{g.provider}</div>
                      <div className="mono" style={{ fontSize: 11.5, color: '#93c5fd' }}>
                        {g.model}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <span className="pill pill-muted">runtime: {g.runtimeMode}</span>
                      </div>
                    </td>
                    <td>
                      <span className="pill pill-blue">{g.threadCount} 条</span>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={g.resolvedAgentConfigId || ''}
                        onChange={(e) => updateField({ agentConfigId: e.target.value })}
                      >
                        {configs.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.agentType})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="select mono"
                        value={g.resolvedModelId || ''}
                        onChange={(e) => updateField({ modelId: e.target.value })}
                      >
                        {(selectedCfg?.models || []).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="select mono"
                        value={g.resolvedModeId || ''}
                        onChange={(e) => updateField({ modeId: e.target.value })}
                      >
                        {(selectedCfg?.modes || []).map((md) => (
                          <option key={md} value={md}>
                            {md}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      {g.status === 'exact' ? (
                        <span className="pill pill-green">
                          <CheckCircle2 size={11} /> 完全一致
                        </span>
                      ) : (
                        <>
                          <span className="pill pill-amber">
                            <AlertTriangle size={11} /> 语义降级
                          </span>
                          {g.warnings.map((w, i) => (
                            <div key={i} className="warn-box">
                              {w}
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">目标机器可用 Lody Agent Config 能力一览</h3>
          <span className="pill pill-muted">{configs.length} 个已注册配置</span>
        </div>
        <div className="grid-2">
          {configs.map((c) => (
            <div key={c.id} style={{ background: '#0d121d', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{c.name}</strong>
                <span className={`pill ${c.available ? 'pill-green' : 'pill-red'}`}>
                  {c.available ? '可用' : '离线'}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 8px' }}>
                id: {c.id} · type: {c.agentType}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                <strong>权限模式：</strong>
                {c.modes.join(', ') || '无'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                <strong>支持模型（{c.models.length}）：</strong>
                <span className="mono" style={{ fontSize: 11 }}>
                  {c.models.slice(0, 8).join(', ')}
                  {c.models.length > 8 ? ` …(+${c.models.length - 8})` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
