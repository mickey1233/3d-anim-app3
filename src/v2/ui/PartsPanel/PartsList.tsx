import React from 'react';
import { Search, RotateCcw, MapPin, ChevronDown, ChevronRight } from 'lucide-react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

export function PartsListV2() {
  const parts = useV2Store((s) => s.parts);
  const assemblyGroups = useV2Store((s) => s.assemblyGroups);
  const selectedPartId = useV2Store((s) => s.selection.partId);
  const selectedGroupId = useV2Store((s) => s.selection.groupId);
  const [query, setQuery] = React.useState('');
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Build a set of partIds that belong to any group
  const groupedPartIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const group of Object.values(assemblyGroups.byId)) {
      for (const id of group.partIds) set.add(id);
    }
    return set;
  }, [assemblyGroups]);

  const filteredPartIds = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>(parts.order);
    return new Set(
      parts.order.filter((id) => {
        const p = parts.byId[id];
        return p && p.name.toLowerCase().includes(q);
      })
    );
  }, [parts, query]);

  const selectPart = (partId: string) => {
    // Explicitly clear groupId so individual part is moved alone
    useV2Store.getState().setSelection(partId, 'list', undefined);
    void callMcpTool('selection.set', {
      selection: { kind: 'part', part: { partId } },
      replace: true,
      autoResolve: true,
    });
  };

  const selectGroup = (groupId: string) => {
    const group = assemblyGroups.byId[groupId];
    const firstPartId = group?.partIds[0];
    if (!firstPartId) return;
    // Select first part as gizmo target with groupId to enable group-move
    useV2Store.getState().setSelection(firstPartId, 'list', groupId);
  };

  const resetToInitial = (e: React.MouseEvent, partId: string) => {
    e.stopPropagation();
    void callMcpTool('action.reset_part_transform', { part: { partId }, mode: 'initial' });
  };

  const resetToManual = (e: React.MouseEvent, partId: string) => {
    e.stopPropagation();
    const hasManual = Boolean(parts.manualTransformById[partId]);
    if (!hasManual) return;
    void callMcpTool('action.reset_part_transform', { part: { partId }, mode: 'manual' });
  };

  const renderPartRow = (partId: string, indented = false, groupName?: string) => {
    const part = parts.byId[partId];
    if (!part || !filteredPartIds.has(partId)) return null;
    const active = part.id === selectedPartId && !selectedGroupId;
    const hasManual = Boolean(parts.manualTransformById[partId]);

    return (
      <div key={part.id} className={`flex items-center gap-1 ${indented ? 'pl-4' : ''}`}>
        <button
          type="button"
          onClick={() => selectPart(part.id)}
          data-testid="v2-part-item"
          className={`flex-1 flex items-center justify-between gap-2 px-2 py-2 rounded border text-xs ${
            active
              ? 'bg-[var(--accent-color)]/15 border-[var(--accent-color)]'
              : 'bg-black/30 border-white/5 hover:bg-white/5'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full border border-white/10 shrink-0"
              style={{ backgroundColor: part.color || '#ffffff' }}
            />
            {groupName ? (
              <span className="truncate">
                <span className="text-[var(--text-secondary)]">{groupName}/</span>
                {part.name}
              </span>
            ) : (
              <span className="truncate">{part.name}</span>
            )}
          </div>
          <span className="text-[10px] font-mono text-[var(--text-secondary)]">
            {part.id.slice(0, 6)}
          </span>
        </button>
        <button
          type="button"
          title="重置到初始位置"
          onClick={(e) => resetToInitial(e, part.id)}
          className="p-1 rounded hover:bg-white/10 text-[var(--text-secondary)] hover:text-white"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <button
          type="button"
          title={hasManual ? '重置到移動位置' : '尚未記錄手動位置'}
          onClick={(e) => resetToManual(e, part.id)}
          disabled={!hasManual}
          className={`p-1 rounded ${hasManual ? 'hover:bg-white/10 text-[var(--text-secondary)] hover:text-white' : 'opacity-30 cursor-not-allowed text-[var(--text-secondary)]'}`}
        >
          <MapPin className="w-3 h-3" />
        </button>
      </div>
    );
  };

  // Determine rendering order: groups first, then ungrouped parts
  const ungroupedPartIds = parts.order.filter((id) => !groupedPartIds.has(id));

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parts…"
          className="w-full bg-black/40 border border-white/10 rounded pl-7 pr-2 py-1.5 text-xs outline-none focus:border-[var(--accent-color)]"
        />
      </div>
      <div className="flex-1 min-h-0 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-1">
        {/* Assembly groups */}
        {assemblyGroups.order.map((groupId) => {
          const group = assemblyGroups.byId[groupId];
          if (!group) return null;
          const visibleMembers = group.partIds.filter((id) => filteredPartIds.has(id));
          if (visibleMembers.length === 0) return null;
          const collapsed = collapsedGroups.has(groupId);
          return (
            <div key={groupId} className="flex flex-col gap-0.5">
              <div
                className={`flex items-center rounded border text-xs ${
                  selectedGroupId === groupId
                    ? 'border-[var(--accent-color)] bg-[var(--accent-color)]/10'
                    : 'border-white/10 bg-white/5'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(groupId)}
                  className="p-1.5 hover:bg-white/10 rounded-l shrink-0"
                  title={collapsed ? 'Expand group' : 'Collapse group'}
                >
                  {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => selectGroup(groupId)}
                  className="flex-1 flex items-center gap-1.5 px-1 py-1 hover:bg-white/10 rounded-r text-left"
                  title="Select group (move all members)"
                >
                  <span className={`font-medium ${selectedGroupId === groupId ? 'text-[var(--accent-color)]' : 'text-white/70'}`}>
                    {group.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-secondary)]">({group.partIds.length})</span>
                </button>
              </div>
              {!collapsed && visibleMembers.map((partId) => renderPartRow(partId, true, group.name))}
            </div>
          );
        })}

        {/* Ungrouped parts */}
        {ungroupedPartIds.map((partId) => renderPartRow(partId, false))}
      </div>
    </div>
  );
}
