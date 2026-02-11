import React from 'react';
import { CommandBar } from '../ui/CommandBar/CommandBar';
import { PanelDock } from '../ui/layout/PanelDock';
import { StatusPill } from '../ui/layout/StatusPill';
import { CanvasRoot } from '../three/CanvasRoot';
import { useV2Store } from '../store/store';
import { ModelPanelV2 } from '../ui/PartsPanel/ModelPanel';
import { PartsListV2 } from '../ui/PartsPanel/PartsList';
import { MatePanel } from '../ui/MatePanel/MatePanel';
import { StepsPanel } from '../ui/Steps/StepsPanel';
import { TimelineBar } from '../ui/Steps/TimelineBar';
import { VlmPanel } from '../ui/VLM/VlmPanel';
import { SelectionPanel } from '../ui/Selection/SelectionPanel';
import { ViewPanel } from '../ui/View/ViewPanel';
import { ChatPanel } from '../ui/Chat/ChatPanel';
import { WorkspaceTabs } from '../ui/layout/WorkspaceTabs';
import { InteractionModeToggle } from '../ui/layout/InteractionModeToggle';
import { connectV2Client, v2Client } from '../network/client';
import { registerToolProxyBridge } from '../network/toolProxyBridge';
import { callMcpTool } from '../network/mcpToolsClient';

export function AppShell() {
  const leftOpen = useV2Store((s) => s.ui.leftOpen);
  const rightOpen = useV2Store((s) => s.ui.rightOpen);
  const setPanels = useV2Store((s) => s.setPanels);
  const workspaceSection = useV2Store((s) => s.ui.workspaceSection);
  const setWorkspaceSection = useV2Store((s) => s.setWorkspaceSection);
  const canUndo = useV2Store((s) => s.history.past.length > 0);
  const canRedo = useV2Store((s) => s.history.future.length > 0);
  const wsConnected = useV2Store((s) => s.connection.wsConnected);
  const wsError = useV2Store((s) => s.connection.wsError);
  const setWsStatus = useV2Store((s) => s.setWsStatus);
  const workspaceItems = React.useMemo(
    () => [
      { id: 'selection', label: 'Selection', content: <SelectionPanel /> },
      { id: 'view', label: 'View', content: <ViewPanel /> },
      { id: 'mate', label: 'Mate', content: <MatePanel /> },
      { id: 'steps', label: 'Steps', content: <StepsPanel /> },
      { id: 'chat', label: 'AI Chat', content: <ChatPanel /> },
      { id: 'vlm', label: 'VLM', content: <VlmPanel /> },
    ],
    []
  );

  const activeWorkspaceSection =
    workspaceItems.find((item) => item.id === workspaceSection)?.id || workspaceItems[0].id;

  React.useEffect(() => {
    if (!workspaceItems.find((item) => item.id === workspaceSection)) {
      setWorkspaceSection(workspaceItems[0].id);
    }
  }, [workspaceItems, workspaceSection, setWorkspaceSection]);

  React.useEffect(() => {
    const unsubscribeStatus = v2Client.onStatus(({ connected, error }) => setWsStatus(connected, error));
    const unsubscribeProxyBridge = registerToolProxyBridge();
    connectV2Client();
    return () => {
      unsubscribeStatus();
      unsubscribeProxyBridge();
    };
  }, [setWsStatus]);

  return (
    <div className="w-full h-[100dvh] bg-[var(--bg-color)] text-white flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="h-12 shrink-0 px-3 sm:px-4 border-b border-white/10 flex items-center gap-3">
        <div className="font-bold text-xs tracking-wider text-[var(--accent-color)] uppercase">3D CAD Studio v2</div>
        <div className="flex-1 min-w-0">
          <CommandBar />
        </div>
        <div className="flex items-center gap-2">
          <InteractionModeToggle />
          <button
            type="button"
            onClick={() => {
              void callMcpTool('history.undo', {});
            }}
            disabled={!canUndo}
            className="px-2 py-1 text-[10px] uppercase font-bold border border-white/10 rounded disabled:opacity-40 hover:bg-white/10"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => {
              void callMcpTool('history.redo', {});
            }}
            disabled={!canRedo}
            className="px-2 py-1 text-[10px] uppercase font-bold border border-white/10 rounded disabled:opacity-40 hover:bg-white/10"
          >
            Redo
          </button>
          <StatusPill
            label={wsConnected ? 'Connected' : wsError ? 'WS Error' : 'Disconnected'}
            tone={wsConnected ? 'ok' : wsError ? 'error' : 'warning'}
          />
        </div>
      </div>

      {/* Main Layout */}
      <div className="flex-1 min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
        {/* Left Panel */}
        <PanelDock
          side="left"
          title="Model & Parts"
          isOpen={leftOpen}
          onToggle={() => setPanels(!leftOpen, rightOpen)}
        >
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-2">Model</div>
              <ModelPanelV2 />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-2">Parts</div>
              <PartsListV2 />
            </div>
          </div>
        </PanelDock>

        {/* Center Canvas */}
        <div className="min-h-0 h-full relative">
          <CanvasRoot />
        </div>

        {/* Right Panel */}
        <PanelDock
          side="right"
          title="Workspace"
          isOpen={rightOpen}
          onToggle={() => setPanels(leftOpen, !rightOpen)}
        >
          <WorkspaceTabs
            items={workspaceItems}
            activeId={activeWorkspaceSection}
            onChange={(id) => setWorkspaceSection(id)}
          />
        </PanelDock>
      </div>

      <div className="shrink-0">
        <TimelineBar />
      </div>
    </div>
  );
}
