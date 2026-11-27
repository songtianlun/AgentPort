import type {
  AgentMappingOverride,
  AgentProfileGroup,
  LodyCatalog,
  ProjectMappingOverride,
  ResolvedProjectMapping,
  T3Project,
  T3ThreadSummary,
} from './types';

export function resolveProjectMapping(
  project: T3Project,
  catalog: LodyCatalog,
  targetMachineId: string,
  overrides: Record<string, ProjectMappingOverride>
): ResolvedProjectMapping {
  const ov = overrides[project.id];
  if (ov) {
    if (ov.targetKind === 'local') {
      const lp = catalog.projects.find((p) => p.id === ov.targetProjectId);
      return {
        project,
        status: 'exact',
        targetKind: 'local',
        targetLabel: lp ? `${lp.name} (${lp.rootPath})` : ov.targetProjectId || 'local',
        targetProjectId: ov.targetProjectId,
        warnings: [],
      };
    }
    if (ov.targetKind === 'github') {
      return {
        project,
        status: 'fallback',
        targetKind: 'github',
        targetLabel: `GitHub: ${ov.targetRepo}`,
        targetRepo: ov.targetRepo,
        warnings: ['已手动指定使用 GitHub 仓库 worktree（不包含本地未提交改动，已自动打包 dirty.patch）'],
      };
    }
    if (ov.targetKind === 'chat') {
      return {
        project,
        status: 'exact',
        targetKind: 'chat',
        targetLabel: '独立聊天工作区 (workContext: chat)',
        warnings: project.isScratch ? [] : ['原本地代码项目已降级映射到独立 Chat 会话'],
      };
    }
    return {
      project,
      status: 'skipped',
      targetKind: 'skip',
      targetLabel: '已跳过（仅保留原库，不迁入 Lody）',
      warnings: [],
    };
  }

  if (project.isScratch) {
    return {
      project,
      status: 'exact',
      targetKind: 'chat',
      targetLabel: '独立聊天工作区 (workContext: chat)',
      warnings: [],
    };
  }

  // 1. Exact local path match
  const localMatch = catalog.projects.find(
    (p) =>
      p.kind === 'local' &&
      p.machineId === targetMachineId &&
      p.rootPath === project.workspaceRoot
  );
  if (localMatch) {
    return {
      project,
      status: 'exact',
      targetKind: 'local',
      targetLabel: `本地项目: ${localMatch.name} (${localMatch.rootPath})`,
      targetProjectId: localMatch.id,
      warnings:
        project.git.dirtyFiles.length > 0
          ? [`当前本地目录有 ${project.git.dirtyFiles.length} 个未提交变更，导出时将自动生成 dirty.patch`]
          : [],
    };
  }

  // 2. GitHub repo fallback
  const gh = project.git.githubRepo;
  if (gh) {
    const ghMatch = catalog.projects.find(
      (p) => p.kind === 'github' && p.repoFullName?.toLowerCase() === gh.toLowerCase()
    );
    if (ghMatch && ghMatch.repoFullName) {
      return {
        project,
        status: 'fallback',
        targetKind: 'github',
        targetLabel: `GitHub 仓库: ${ghMatch.repoFullName}`,
        targetRepo: ghMatch.repoFullName,
        warnings: [
          `目录 ${project.workspaceRoot} 尚未在目标机器注册为 Lody 本地项目，已通过 Git remote 自动匹配到 GitHub 仓库 ${ghMatch.repoFullName}`,
        ],
      };
    }
  }

  return {
    project,
    status: 'action_required',
    targetKind: 'unregistered',
    targetLabel: '未在 Lody 注册（需处理）',
    warnings: [
      `目录 ${project.workspaceRoot} 未在目标机器的 Lody 本地项目中注册。建议先在 Lody 客户端添加该目录，或在此手动改选 GitHub / Chat / 跳过。`,
    ],
  };
}

export function resolveAgentGroups(
  threads: T3ThreadSummary[],
  catalog: LodyCatalog,
  targetMachineId: string,
  overrides: Record<string, AgentMappingOverride>
): AgentProfileGroup[] {
  const buckets = new Map<string, { provider: string; model: string; runtimeMode: string; count: number }>();
  for (const t of threads) {
    const model = t.model || 'default';
    const key = `${t.provider}::${model}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, {
        provider: t.provider,
        model,
        runtimeMode: t.runtimeMode,
        count: 1,
      });
    }
  }

  const machineConfigs = catalog.agentConfigs.filter((c) => c.machineId === targetMachineId);
  const groups: AgentProfileGroup[] = [];

  for (const [key, b] of buckets.entries()) {
    const ov = overrides[key];
    if (ov) {
      const cfg = machineConfigs.find((c) => c.id === ov.agentConfigId);
      groups.push({
        key,
        provider: b.provider,
        model: b.model,
        runtimeMode: b.runtimeMode,
        threadCount: b.count,
        status: cfg ? 'exact' : 'missing',
        resolvedAgentConfigId: ov.agentConfigId,
        resolvedAgentName: cfg?.name || ov.agentConfigId,
        resolvedModelId: ov.modelId,
        resolvedModeId: ov.modeId,
        warnings: [],
      });
      continue;
    }

    const norm = b.provider.startsWith('codex')
      ? 'codex'
      : b.provider.includes('claude')
        ? 'claude'
        : b.provider;
    const cfg =
      machineConfigs.find((c) => c.agentType.toLowerCase() === norm.toLowerCase()) ||
      machineConfigs[0];

    if (!cfg) {
      groups.push({
        key,
        provider: b.provider,
        model: b.model,
        runtimeMode: b.runtimeMode,
        threadCount: b.count,
        status: 'missing',
        warnings: ['目标机器没有任何可用的 Lody Agent Config'],
      });
      continue;
    }

    const warnings: string[] = [];
    if (cfg.agentType.toLowerCase() !== norm.toLowerCase()) {
      warnings.push(`原 Provider "${b.provider}" 不可用，自动降级为 ${cfg.name}`);
    }

    let resolvedModel = cfg.models[0];
    if (b.model !== 'default' && cfg.models.includes(b.model)) {
      resolvedModel = b.model;
    } else if (b.model !== 'default') {
      warnings.push(`模型 "${b.model}" 不在 ${cfg.name} 列表内，降级为 "${resolvedModel || 'default'}"`);
    }

    let resolvedMode = cfg.modes[0];
    if (b.runtimeMode === 'full-access') {
      if (cfg.modes.includes('agent-full-access')) {
        resolvedMode = 'agent-full-access';
      } else if (cfg.modes.includes('bypassPermissions')) {
        resolvedMode = 'bypassPermissions';
      } else if (cfg.modes.includes('accept-edits')) {
        resolvedMode = 'accept-edits';
        warnings.push(
          `权限语义差异：T3 的 full-access 在 Lody ${cfg.name} 中无完全对等项，已安全映射为 accept-edits`
        );
      }
    }

    groups.push({
      key,
      provider: b.provider,
      model: b.model,
      runtimeMode: b.runtimeMode,
      threadCount: b.count,
      status: warnings.length === 0 ? 'exact' : 'degraded',
      resolvedAgentConfigId: cfg.id,
      resolvedAgentName: cfg.name,
      resolvedModelId: resolvedModel,
      resolvedModeId: resolvedMode,
      warnings,
    });
  }

  return groups.sort((a, b) => b.threadCount - a.threadCount);
}

export function buildLodyCreatePayload(
  thread: T3ThreadSummary,
  projMap: ResolvedProjectMapping,
  agentGroup: AgentProfileGroup | undefined,
  targetMachineId: string,
  handoffMarkdown?: string
) {
  const workContext: Record<string, unknown> =
    projMap.targetKind === 'local'
      ? { kind: 'local', projectId: projMap.targetProjectId, ...(thread.branch ? { branch: thread.branch } : {}) }
      : projMap.targetKind === 'github'
        ? { kind: 'github', repo: projMap.targetRepo, ...(thread.branch ? { branch: thread.branch } : {}) }
        : projMap.targetKind === 'chat'
          ? { kind: 'chat' }
          : { kind: 'unregistered', localRootPath: projMap.project.workspaceRoot };

  return {
    tool: 'lody_session_create',
    arguments: {
      operationId: `t3mig-${thread.id.slice(0, 12)}`,
      machineId: targetMachineId,
      agentConfigId: agentGroup?.resolvedAgentConfigId,
      modelId: agentGroup?.resolvedModelId,
      modeId: agentGroup?.resolvedModeId,
      useCurrentSessionAsParent: false,
      workContext,
      prompt: handoffMarkdown || '(点击左侧会话加载完整 Handoff Prompt)',
      attachments: [`threads/${thread.id}/transcript.md`],
    },
    followUpRename: {
      tool: 'lody_session_manage',
      action: 'rename',
      title: thread.title.slice(0, 200),
    },
  };
}
