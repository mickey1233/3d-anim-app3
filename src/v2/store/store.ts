import { create } from 'zustand';
import type { Anchor } from '../three/anchors/types';

export type Part = {
  id: string;
  name: string;
  color?: string;
};

export type AssemblyGroup = {
  id: string;
  name: string;
  partIds: string[];
};

/**
 * Records a directed assembly relation: source entity was mounted onto targetPartId.
 * Used instead of adding the target into the source group membership.
 * A group's partIds always represent only the movable subassembly — never the structural target.
 */
export type MountedRelation = {
  /** The source group ID (if source was a group) or source part ID. */
  sourceId: string;
  /** 'group' when source was an assembly group; 'part' when standalone. */
  sourceKind: 'group' | 'part';
  /** The target part ID that was assembled onto. */
  targetPartId: string;
  /** The target group ID if the target was part of a group. */
  targetGroupId?: string;
  /** The historyId from the mate commit, for cross-referencing. */
  historyId?: string;
  /** Unix timestamp (ms) of the mount event. */
  timestamp: number;
};

export type PartTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
};

export type FaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
export type MateMode = 'translate' | 'twist' | 'both';
export type InteractionMode = 'select' | 'move' | 'rotate' | 'mate';
export type AnchorMethodId =
  | 'auto'
  | 'planar_cluster'
  | 'face_projection'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'extreme_vertices'
  | 'obb_pca'
  | 'picked';
export type TwistAxisSpace = 'world' | 'source_face' | 'target_face';
export type TwistAxis = 'x' | 'y' | 'z' | 'normal' | 'tangent' | 'bitangent';
export type TwistSpec = { axisSpace: TwistAxisSpace; axis: TwistAxis; angleDeg: number };

export type Step = {
  id: string;
  label: string;
  snapshotOverridesById?: Record<string, PartTransform>;
  /** manualTransformById captured at addStep time — the part positions before this step's animation */
  baseManualTransforms?: Record<string, PartTransform>;
};

export type VlmImage = {
  id: string;
  name: string;
  url: string;
  file: File;
};

export type MateCaptureOverlayImage = {
  id: string;
  name: string;
  label: string;
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  mime: string;
};

export type MateCaptureOverlayState = {
  visible: boolean;
  nonce: number;
  expiresAt: number;
  images: MateCaptureOverlayImage[];
};

export type VlmResult = {
  steps: { from_image: string; to_image: string; inferred_action: string; changes: string[] }[];
  objects: { label: string; description?: string; confidence?: number }[];
  mapping_candidates: { label: string; scene_part_names: string[]; chosen: string; confidence: number }[];
  assembly_command?: {
    source_label: string;
    target_label: string;
    source_face: string;
    target_face: string;
    mcp_text_command: string;
  };
};

export type ServerStatus = {
  ts: number;
  router: { providerEnv: string; providerResolved: 'agent' | 'mock' | 'codex' | 'openai' | 'smart'; llmEnabled: boolean };
  codex: {
    loggedIn: boolean;
    authMode: string;
    apiKeyPresent: boolean;
    model: string;
    cliAvailable: boolean;
    authFile: string;
    smartCodexEnabled: boolean;
  };
  llm: {
    providerEnv: string;
    providerResolved: 'gemini' | 'ollama' | 'mock' | 'none';
    model: string;
    geminiKeyPresent: boolean;
    ollamaBaseUrl: string;
    ollamaReachable: boolean;
    ollamaModelsCount: number;
    ollamaModelRequested: string;
    ollamaModelAvailable: boolean;
  };
  vlm: {
    providerEnv: string;
    providerResolved: 'gemini' | 'ollama' | 'mock' | 'none';
    model: string;
    ollamaModelRequested: string;
    ollamaModelAvailable: boolean;
  };
  web: { enabled: boolean };
};

type Snapshot = {
  steps: {
    list: Step[];
    currentStepId: string | null;
  };
  ui: {
    leftOpen: boolean;
    rightOpen: boolean;
    workspaceSection: string;
    gizmoSpace: 'world' | 'local';
  };
  markers: {
    start?: Anchor;
    end?: Anchor;
  };
  vlm: {
    result?: VlmResult;
    analyzing: boolean;
  };
  parts: {
    overridesById: Record<string, PartTransform>;
  };
  assemblyGroups: {
    byId: Record<string, AssemblyGroup>;
    order: string[];
  };
  mountedRelations: MountedRelation[];
};

export type V2State = {
  cadUrl: string | null;
  cadFileName: string | null;
  parts: {
    byId: Record<string, Part>;
    order: string[];
    initialTransformById: Record<string, PartTransform>;
    overridesById: Record<string, PartTransform>;
    manualTransformById: Record<string, PartTransform>;
  };
  assemblyGroups: {
    byId: Record<string, AssemblyGroup>;
    order: string[];
  };
  /**
   * Directed assembly relations: source (group or part) mounted_to target.
   * Does NOT affect group membership — groups remain pure movable subassemblies.
   */
  mountedRelations: MountedRelation[];
  /**
   * Recent entity referents for deictic pronoun resolution ("它", "this", "them").
   * Updated after every successful mate operation.
   * Sent to the router in RouterContext.recentReferents.
   */
  recentReferents: {
    lastSource: { entityId: string; entityType: 'part' | 'group'; displayName: string; memberPartIds: string[]; role: 'source'; timestamp: number } | null;
    lastTarget: { entityId: string; entityType: 'part' | 'group'; displayName: string; memberPartIds: string[]; role: 'target'; timestamp: number } | null;
  };
  selection: { partId: string | null; groupId?: string; source: 'dropdown' | 'canvas' | 'list' | 'command' | 'system' };
  multiSelectIds: string[];
  steps: Snapshot['steps'];
  playback: { running: boolean; currentIndex: number; order: string[]; durationMs: number; targetStepId: string | null; resetToStepId: string | null };
  ui: Snapshot['ui'];
  interaction: { mode: InteractionMode; isTransformDragging: boolean; pickFaceMode: 'idle' | 'source' | 'target' };
  markers: Snapshot['markers'];
  vlm: { images: VlmImage[]; result?: VlmResult; analyzing: boolean };
  chat: { messages: { id: string; role: 'user' | 'assistant'; text: string }[] };
  view: {
    environment: string;
    showGrid: boolean;
    showAnchors: boolean;
    lighting: {
      exposure: number;        // tone mapping exposure (0.1–2.0)
      ambientIntensity: number; // 0–2
      mainIntensity: number;   // 0–3
      azimuth: number;         // degrees 0–360 (horizontal)
      elevation: number;       // degrees 0–90 (vertical)
    };
  };
  connection: { wsConnected: boolean; wsError?: string; serverStatus?: ServerStatus };
  mateCaptureOverlay: MateCaptureOverlayState;
  mateRequest?: {
    sourceId: string;
    targetId: string;
    sourceGroupId?: string;
    targetGroupId?: string;
    sourceFace: FaceId;
    targetFace: FaceId;
    mode: MateMode;
    twistSpec?: TwistSpec;
    sourceMethod?: AnchorMethodId;
    targetMethod?: AnchorMethodId;
    sourceOffset?: [number, number, number];
    targetOffset?: [number, number, number];
  };
  mateDraft: {
    sourceId: string;
    targetId: string;
    sourceGroupId?: string;
    targetGroupId?: string;
    sourceFace: FaceId;
    targetFace: FaceId;
    mode: MateMode;
    sourceMethod: AnchorMethodId;
    targetMethod: AnchorMethodId;
    twistAxisSpace: TwistAxisSpace;
    twistAxis: TwistAxis;
    twistAngleDeg: number;
    sourceOffset: [number, number, number];
    targetOffset: [number, number, number];
  };
  matePreview: {
    source?: {
      partId: string;
      faceId: string;
      positionWorld: [number, number, number];
      normalWorld: [number, number, number];
      methodUsed?: AnchorMethodId;
      methodRequested?: AnchorMethodId;
      fallbackUsed?: boolean;
    };
    target?: {
      partId: string;
      faceId: string;
      positionWorld: [number, number, number];
      normalWorld: [number, number, number];
      methodUsed?: AnchorMethodId;
      methodRequested?: AnchorMethodId;
      fallbackUsed?: boolean;
    };
  };
  mateTrace?: {
    ts: number;
    mode: MateMode;
    sourceId: string;
    targetId: string;
    sourceFace: string;
    targetFace: string;
    pivotWorld: [number, number, number];
    translationWorld: [number, number, number];
    rotationQuat: [number, number, number, number];
    normal?: { axisWorld: [number, number, number]; angleDeg: number };
    twist?: { axisWorld: [number, number, number]; angleDeg: number; source: 'spec' | 'tangent' };
    sourceBeforeWorld: { position: [number, number, number]; quaternion: [number, number, number, number] };
    sourceAfterWorld: { position: [number, number, number]; quaternion: [number, number, number, number] };
  };
  matePick: {
    source?: Anchor;
    target?: Anchor;
  };
  history: {
    past: Snapshot[];
    future: Snapshot[];
    lastCommand?: string;
  };

  setCadUrl: (url: string, fileName: string) => void;
  setParts: (parts: Part[], initialTransformById: Record<string, PartTransform>) => void;
  setSelection: (partId: string | null, source?: 'dropdown' | 'canvas' | 'list' | 'command' | 'system', groupId?: string) => void;
  addToMultiSelect: (partId: string) => void;
  removeFromMultiSelect: (partId: string) => void;
  clearMultiSelect: () => void;
  addStep: (label: string) => void;
  insertStep: (afterId: string | null, label: string) => void;
  selectStep: (id: string | null) => void;
  deleteStep: (id: string) => void;
  moveStep: (sourceId: string, targetId: string) => void;
  updateStepSnapshot: (id?: string | null) => void;
  startPlayback: (durationMs?: number) => void;
  startPlaybackAt: (targetStepId: string, durationMs?: number, fromStepId?: string) => void;
  stopPlayback: () => void;
  setPlaybackIndex: (index: number) => void;
  setPanels: (leftOpen: boolean, rightOpen: boolean) => void;
  setWorkspaceSection: (section: string) => void;
  setGizmoSpace: (space: 'world' | 'local') => void;
  setInteractionMode: (mode: InteractionMode) => void;
  setTransformDragging: (dragging: boolean) => void;
  setPickFaceMode: (mode: 'idle' | 'source' | 'target') => void;
  setEnvironment: (env: string) => void;
  setGridVisible: (visible: boolean) => void;
  setAnchorsVisible: (visible: boolean) => void;
  setLighting: (patch: Partial<V2State['view']['lighting']>) => void;
  setWsStatus: (connected: boolean, error?: string) => void;
  setServerStatus: (status?: ServerStatus) => void;
  setMarker: (type: 'start' | 'end', anchor?: Anchor) => void;
  clearMarkers: () => void;
  requestMate: (req: V2State['mateRequest']) => void;
  clearMateRequest: () => void;
  setMateDraft: (draft: Partial<V2State['mateDraft']>, clearPickFor?: 'source' | 'target') => void;
  setMatePick: (type: 'source' | 'target', anchor?: Anchor) => void;
  clearMatePick: () => void;
  clearMatePickFor: (type: 'source' | 'target') => void;
  setMatePreview: (preview: V2State['matePreview']) => void;
  setMateTrace: (trace?: V2State['mateTrace']) => void;
  setPartOverride: (partId: string, transform: PartTransform) => void;
  setPartOverrideSilent: (partId: string, transform: PartTransform) => void;
  clearPartOverride: (partId: string) => void;
  clearAllPartOverrides: () => void;
  clearAllPartOverridesSilent: () => void;
  resetToManualTransforms: () => void;
  getPartTransform: (partId: string) => PartTransform | null;
  setManualTransform: (partId: string, transform: PartTransform) => void;
  resetPartToInitial: (partId: string) => void;
  resetPartToManual: (partId: string) => void;
  createAssemblyGroup: (partIds: string[]) => string;
  mergeAssemblyGroups: (groupIdA: string, groupIdB: string) => string;
  addPartToGroup: (groupId: string, partId: string) => void;
  removePartFromGroup: (partId: string) => void;
  getGroupForPart: (partId: string) => string | null;
  getGroupParts: (groupId: string) => string[];
  /** Record a directed mounted_to relation without mutating group membership. */
  recordMountedRelation: (relation: MountedRelation) => void;
  /** Update the recent referent for source or target after a successful mate. */
  setRecentReferent: (
    role: 'source' | 'target',
    entity: { entityId: string; entityType: 'part' | 'group'; displayName: string; memberPartIds: string[] },
  ) => void;
  /** Return all relations involving a given source ID (group or part). */
  getMountedRelationsForSource: (sourceId: string) => MountedRelation[];
  /** Rename an assembly group. */
  renameAssemblyGroup: (groupId: string, name: string) => void;
  addVlmImages: (files: File[]) => void;
  moveVlmImage: (id: string, dir: -1 | 1) => void;
  removeVlmImage: (id: string) => void;
  setVlmResult: (result?: VlmResult) => void;
  setVlmAnalyzing: (active: boolean) => void;
  appendChatMessage: (message: { role: 'user' | 'assistant'; text: string }) => void;
  showMateCaptureOverlay: (images: MateCaptureOverlayImage[], durationMs?: number) => void;
  hideMateCaptureOverlay: () => void;

  dispatch: (label: string, updater: (state: V2State) => Partial<V2State>) => void;
  undo: () => void;
  redo: () => void;
};

const takeSnapshot = (state: V2State): Snapshot => ({
  steps: { list: [...state.steps.list], currentStepId: state.steps.currentStepId },
  ui: { ...state.ui },
  markers: { ...state.markers },
  vlm: { result: state.vlm.result, analyzing: state.vlm.analyzing },
  parts: { overridesById: { ...state.parts.overridesById } },
  assemblyGroups: {
    byId: Object.fromEntries(
      Object.entries(state.assemblyGroups.byId).map(([id, g]) => [id, { ...g, partIds: [...g.partIds] }])
    ),
    order: [...state.assemblyGroups.order],
  },
  mountedRelations: [...state.mountedRelations],
});

const applySnapshot = (state: V2State, snap: Snapshot): Partial<V2State> => ({
  steps: snap.steps,
  ui: snap.ui,
  markers: snap.markers,
  vlm: { ...state.vlm, result: snap.vlm.result, analyzing: snap.vlm.analyzing },
  parts: { ...state.parts, overridesById: { ...snap.parts.overridesById } },
  assemblyGroups: snap.assemblyGroups,
  mountedRelations: snap.mountedRelations,
});

const cloneTransform = (t: PartTransform): PartTransform => ({
  position: [t.position[0], t.position[1], t.position[2]],
  quaternion: [t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]],
  scale: [t.scale[0], t.scale[1], t.scale[2]],
});

const cloneOverrides = (overrides: Record<string, PartTransform>) =>
  Object.fromEntries(Object.entries(overrides).map(([id, t]) => [id, cloneTransform(t)]));

const eqTuple3 = (left?: [number, number, number], right?: [number, number, number]) =>
  !!left &&
  !!right &&
  Math.abs(left[0] - right[0]) < 1e-6 &&
  Math.abs(left[1] - right[1]) < 1e-6 &&
  Math.abs(left[2] - right[2]) < 1e-6;

const eqPreviewEntry = (
  left?: {
    partId: string;
    faceId: string;
    positionWorld: [number, number, number];
    normalWorld: [number, number, number];
    methodUsed?: AnchorMethodId;
    methodRequested?: AnchorMethodId;
    fallbackUsed?: boolean;
  },
  right?: {
    partId: string;
    faceId: string;
    positionWorld: [number, number, number];
    normalWorld: [number, number, number];
    methodUsed?: AnchorMethodId;
    methodRequested?: AnchorMethodId;
    fallbackUsed?: boolean;
  }
) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.partId === right.partId &&
    left.faceId === right.faceId &&
    eqTuple3(left.positionWorld, right.positionWorld) &&
    eqTuple3(left.normalWorld, right.normalWorld) &&
    left.methodUsed === right.methodUsed &&
    left.methodRequested === right.methodRequested &&
    Boolean(left.fallbackUsed) === Boolean(right.fallbackUsed)
  );
};

const eqMatePreview = (left: V2State['matePreview'], right: V2State['matePreview']) =>
  eqPreviewEntry(left.source, right.source) && eqPreviewEntry(left.target, right.target);

const DROPDOWN_CANVAS_LOCK_MS = 250;
let dropdownSelectionLockUntil = 0;

export const useV2Store = create<V2State>((set, get) => ({
  cadUrl: '',
  cadFileName: '',
  parts: { byId: {}, order: [], initialTransformById: {}, overridesById: {}, manualTransformById: {} },
  assemblyGroups: { byId: {}, order: [] },
  mountedRelations: [],
  recentReferents: { lastSource: null, lastTarget: null },
  selection: { partId: null, source: 'system' },
  multiSelectIds: [],
  steps: { list: [], currentStepId: null },
  playback: { running: false, currentIndex: 0, order: [], durationMs: 900, targetStepId: null, resetToStepId: null },
  ui: { leftOpen: true, rightOpen: true, workspaceSection: 'selection', gizmoSpace: 'world' as const },
  interaction: { mode: 'move', isTransformDragging: false, pickFaceMode: 'idle' },
  markers: {},
  vlm: { images: [], result: undefined, analyzing: false },
  chat: {
    messages: [
      {
        id: 'intro',
        role: 'assistant',
        text: '你好！我可以幫你選取、對齊、微調、重置或切換背景。輸入 /help 看範例。',
      },
    ],
  },
  view: {
    environment: 'studio',
    showGrid: true,
    showAnchors: false,
    lighting: {
      exposure: 0.65,
      ambientIntensity: 0.3,
      mainIntensity: 0.9,
      azimuth: 50,
      elevation: 60,
    },
  },
  connection: { wsConnected: false, wsError: undefined, serverStatus: undefined },
  mateCaptureOverlay: { visible: false, nonce: 0, expiresAt: 0, images: [] },
  matePick: {},
  mateDraft: {
    sourceId: '',
    targetId: '',
    sourceGroupId: undefined,
    targetGroupId: undefined,
    sourceFace: 'bottom',
    targetFace: 'top',
    mode: 'translate',
    sourceMethod: 'planar_cluster',
    targetMethod: 'planar_cluster',
    twistAxisSpace: 'target_face',
    twistAxis: 'normal',
    twistAngleDeg: 0,
    sourceOffset: [0, 0, 0],
    targetOffset: [0, 0, 0],
  },
  matePreview: {},
  mateTrace: undefined,
  history: { past: [], future: [], lastCommand: undefined },

  dispatch: (label, updater) =>
    set((state) => {
      const before = takeSnapshot(state);
      const patch = updater(state);
      const nextState: V2State = {
        ...state,
        ...patch,
        parts: patch.parts ? { ...state.parts, ...patch.parts } : state.parts,
        assemblyGroups: patch.assemblyGroups ? { ...state.assemblyGroups, ...patch.assemblyGroups } : state.assemblyGroups,
        selection: patch.selection ? { ...state.selection, ...patch.selection } : state.selection,
        steps: patch.steps ? { ...state.steps, ...patch.steps } : state.steps,
        ui: patch.ui ? { ...state.ui, ...patch.ui } : state.ui,
        interaction: patch.interaction ? { ...state.interaction, ...patch.interaction } : state.interaction,
        markers: patch.markers ? { ...state.markers, ...patch.markers } : state.markers,
        vlm: patch.vlm ? { ...state.vlm, ...patch.vlm } : state.vlm,
      };
      return {
        ...nextState,
        history: {
          past: [...state.history.past, before],
          future: [],
          lastCommand: label,
        },
      };
    }),

  setParts: (parts, initialTransformById) =>
    set((state) => ({
      ...state,
      parts: {
        byId: Object.fromEntries(parts.map((p) => [p.id, p])),
        order: parts.map((p) => p.id),
        initialTransformById,
        overridesById: {},
        manualTransformById: {},
      },
      assemblyGroups: { byId: {}, order: [] },
      mountedRelations: [],
      recentReferents: { lastSource: null, lastTarget: null },
      history: { past: [], future: [], lastCommand: undefined },
    })),

  setCadUrl: (url, fileName) =>
    set((state) => ({
      ...state,
      cadUrl: url,
      cadFileName: fileName,
      selection: { partId: null, source: 'system' },
      parts: { byId: {}, order: [], initialTransformById: {}, overridesById: {}, manualTransformById: {} },
      assemblyGroups: { byId: {}, order: [] },
      mountedRelations: [],
      recentReferents: { lastSource: null, lastTarget: null },
      markers: {},
      steps: { list: [], currentStepId: null },
      vlm: { images: [], result: undefined, analyzing: false },
      matePick: {},
      playback: { running: false, currentIndex: 0, order: [], durationMs: state.playback.durationMs, targetStepId: null, resetToStepId: null },
      interaction: { ...state.interaction, mode: 'move', pickFaceMode: 'idle' },
      history: { past: [], future: [], lastCommand: undefined },
    })),

  setSelection: (partId, source = 'system', groupId?) =>
    set((state) => {
      const now = Date.now();
      const nextSource =
        source === 'dropdown' && !partId ? 'system' : source;
      if (nextSource === 'canvas' && now < dropdownSelectionLockUntil) {
        return state;
      }
      if (nextSource === 'dropdown') {
        dropdownSelectionLockUntil = now + DROPDOWN_CANVAS_LOCK_MS;
      }
      if (state.selection.partId === partId && state.selection.source === nextSource && state.selection.groupId === groupId) {
        return state;
      }
      return {
        selection: { partId, source: nextSource, groupId },
      };
    }),

  addToMultiSelect: (partId) =>
    set((state) => {
      if (state.multiSelectIds.includes(partId)) return state;
      return { multiSelectIds: [...state.multiSelectIds, partId] };
    }),

  removeFromMultiSelect: (partId) =>
    set((state) => ({
      multiSelectIds: state.multiSelectIds.filter((id) => id !== partId),
    })),

  clearMultiSelect: () => set({ multiSelectIds: [] }),

  addStep: (label) =>
    get().dispatch('add_step', (state) => ({
      steps: {
        list: [
          ...state.steps.list,
          {
            id: crypto.randomUUID(),
            label,
            snapshotOverridesById: cloneOverrides(state.parts.overridesById),
            baseManualTransforms: cloneOverrides(state.parts.manualTransformById),
          },
        ],
        currentStepId: state.steps.currentStepId,
      },
    })),

  insertStep: (afterId, label) =>
    get().dispatch('insert_step', (state) => {
      const newStep = {
        id: crypto.randomUUID(),
        label,
        snapshotOverridesById: cloneOverrides(state.parts.overridesById),
        baseManualTransforms: cloneOverrides(state.parts.manualTransformById),
      };
      const list = [...state.steps.list];
      if (afterId === null) {
        list.unshift(newStep);
      } else {
        const idx = list.findIndex((s) => s.id === afterId);
        list.splice(idx < 0 ? list.length : idx + 1, 0, newStep);
      }
      return { steps: { ...state.steps, list } };
    }),

  selectStep: (id) =>
    get().dispatch('select_step', (state) => ({
      steps: { ...state.steps, currentStepId: id },
    })),
  deleteStep: (id) =>
    get().dispatch('delete_step', (state) => {
      const next = state.steps.list.filter((s) => s.id !== id);
      const currentStepId =
        state.steps.currentStepId === id
          ? next[next.length - 1]?.id || null
          : state.steps.currentStepId;
      return {
        steps: { list: next, currentStepId },
      };
    }),
  moveStep: (sourceId, targetId) =>
    get().dispatch('move_step', (state) => {
      const list = [...state.steps.list];
      const fromIndex = list.findIndex((s) => s.id === sourceId);
      const toIndex = list.findIndex((s) => s.id === targetId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return { steps: state.steps };
      }
      const [item] = list.splice(fromIndex, 1);
      list.splice(toIndex, 0, item);
      return { steps: { ...state.steps, list } };
    }),
  updateStepSnapshot: (id) =>
    get().dispatch('update_step_snapshot', (state) => {
      const targetId = id ?? state.steps.currentStepId;
      if (!targetId) return { steps: state.steps };
      const list = state.steps.list.map((step) =>
        step.id === targetId
          ? { ...step, snapshotOverridesById: cloneOverrides(state.parts.overridesById) }
          : step
      );
      return { steps: { ...state.steps, list } };
    }),
  startPlayback: (durationMs = 900) =>
    set((state) => ({
      ...state,
      playback: {
        running: true,
        currentIndex: 0,
        order: state.steps.list.map((s) => s.id),
        durationMs,
        targetStepId: null,
        resetToStepId: null,
      },
    })),
  startPlaybackAt: (targetStepId, durationMs, fromStepId) =>
    set((state) => {
      const steps = state.steps.list;
      const targetIndex = steps.findIndex((s) => s.id === targetStepId);
      const fromIndex = fromStepId != null ? steps.findIndex((s) => s.id === fromStepId) : -1;

      let order: string[];
      let resetToStepId: string | null;

      if (fromIndex >= 0 && targetIndex > fromIndex) {
        // Forward: include intermediate steps (played instantly) then target step (animated)
        order = steps.slice(fromIndex + 1, targetIndex + 1).map((s) => s.id);
        resetToStepId = fromStepId ?? null;
      } else {
        // Backward or same: just animate the target from its start state
        order = [targetStepId];
        resetToStepId = targetIndex > 0 ? steps[targetIndex - 1].id : null;
      }

      return {
        playback: {
          ...state.playback,
          running: true,
          currentIndex: 0,
          order,
          durationMs: durationMs ?? state.playback.durationMs,
          targetStepId,
          resetToStepId,
        },
      };
    }),
  stopPlayback: () =>
    set((state) => ({
      ...state,
      playback: { ...state.playback, running: false },
    })),
  setPlaybackIndex: (index) =>
    set((state) => ({
      ...state,
      playback: { ...state.playback, currentIndex: index },
    })),

  setPanels: (leftOpen, rightOpen) =>
    get().dispatch('set_panels', (state) => ({ ui: { ...state.ui, leftOpen, rightOpen } })),

  setWorkspaceSection: (section) =>
    set((state) => ({
      ...state,
      ui: { ...state.ui, workspaceSection: section },
    })),

  setGizmoSpace: (space) =>
    set((state) => ({ ...state, ui: { ...state.ui, gizmoSpace: space } })),

  setInteractionMode: (mode) =>
    set((state) => {
      if (state.interaction.mode === mode) return state;
      return {
        interaction: { ...state.interaction, mode },
      };
    }),

  setTransformDragging: (dragging) =>
    set((state) => {
      if (import.meta.env.DEV) {
        (window as any).__V2_ORBIT_ENABLED__ = !dragging;
      }
      if (state.interaction.isTransformDragging === dragging) return state;
      return {
        interaction: { ...state.interaction, isTransformDragging: dragging },
      };
    }),

  setPickFaceMode: (mode) =>
    set((state) => {
      if (state.interaction.pickFaceMode === mode) return state;
      return {
        interaction: { ...state.interaction, pickFaceMode: mode },
      };
    }),

  setEnvironment: (env) =>
    set((state) => ({
      ...state,
      view: { ...state.view, environment: env },
    })),

  setGridVisible: (visible) =>
    set((state) => ({
      ...state,
      view: { ...state.view, showGrid: visible },
    })),

  setAnchorsVisible: (visible) =>
    set((state) => ({
      ...state,
      view: { ...state.view, showAnchors: visible },
    })),

  setLighting: (patch) =>
    set((state) => ({
      ...state,
      view: { ...state.view, lighting: { ...state.view.lighting, ...patch } },
    })),

  setWsStatus: (connected, error) =>
    set((state) => ({
      ...state,
      connection: {
        ...state.connection,
        wsConnected: connected,
        wsError: error,
        ...(connected ? {} : { serverStatus: undefined }),
      },
    })),

  setServerStatus: (status) =>
    set((state) => ({
      ...state,
      connection: { ...state.connection, serverStatus: status },
    })),

  setMarker: (type, anchor) =>
    get().dispatch('set_marker', (state) => ({
      markers: { ...state.markers, [type]: anchor },
    })),

  clearMarkers: () =>
    get().dispatch('clear_markers', () => ({
      markers: {},
    })),

  requestMate: (req) =>
    set((state) => ({
      ...state,
      mateRequest: req,
    })),
  clearMateRequest: () =>
    set((state) => ({
      ...state,
      mateRequest: undefined,
    })),

  setMateDraft: (draft, clearPickFor) =>
    set((state) => {
      let draftChanged = false;
      for (const [key, value] of Object.entries(draft)) {
        if (!Object.is((state.mateDraft as any)[key], value)) {
          draftChanged = true;
          break;
        }
      }

      const pickChanged = Boolean(clearPickFor && state.matePick[clearPickFor]);
      if (!draftChanged && !pickChanged) return state;

      const next: Partial<V2State> = {};
      if (draftChanged) {
        next.mateDraft = { ...state.mateDraft, ...draft };
      }
      if (clearPickFor) {
        next.matePick = { ...state.matePick, [clearPickFor]: undefined };
      }
      return next;
    }),

  setMatePick: (type, anchor) =>
    set((state) => {
      if (state.matePick[type] === anchor) return state;
      return {
        matePick: { ...state.matePick, [type]: anchor },
      };
    }),

  clearMatePick: () =>
    set((state) => {
      if (!state.matePick.source && !state.matePick.target) return state;
      return {
        matePick: {},
      };
    }),
  clearMatePickFor: (type) =>
    set((state) => {
      if (!state.matePick[type]) return state;
      return {
        matePick: { ...state.matePick, [type]: undefined },
      };
    }),
  setMatePreview: (preview) =>
    set((state) => {
      if (eqMatePreview(state.matePreview, preview)) return state;
      return {
        matePreview: preview,
      };
    }),
  setMateTrace: (trace) =>
    set((state) => ({
      ...state,
      mateTrace: trace,
    })),

  setPartOverride: (partId, transform) =>
    get().dispatch('set_part_override', (state) => ({
      parts: { ...state.parts, overridesById: { ...state.parts.overridesById, [partId]: transform } },
    })),

  setPartOverrideSilent: (partId, transform) =>
    set((state) => ({
      ...state,
      parts: { ...state.parts, overridesById: { ...state.parts.overridesById, [partId]: transform } },
    })),

  clearPartOverride: (partId) =>
    get().dispatch('clear_part_override', (state) => {
      const next = { ...state.parts.overridesById };
      delete next[partId];
      return { parts: { ...state.parts, overridesById: next } };
    }),

  clearAllPartOverrides: () =>
    get().dispatch('clear_all_part_overrides', (state) => ({
      parts: { ...state.parts, overridesById: {} },
    })),
  clearAllPartOverridesSilent: () =>
    set((state) => ({
      ...state,
      parts: { ...state.parts, overridesById: {} },
    })),

  resetToManualTransforms: () =>
    set((state) => {
      const nextOverrides: Record<string, PartTransform> = {};
      for (const id of state.parts.order) {
        const manual = state.parts.manualTransformById[id];
        if (manual) nextOverrides[id] = manual;
      }
      return { ...state, parts: { ...state.parts, overridesById: nextOverrides } };
    }),

  getPartTransform: (partId) => {
    const state = get();
    return state.parts.overridesById[partId] || state.parts.initialTransformById[partId] || null;
  },

  setManualTransform: (partId, transform) =>
    set((state) => ({
      ...state,
      parts: { ...state.parts, manualTransformById: { ...state.parts.manualTransformById, [partId]: transform } },
    })),

  resetPartToInitial: (partId) =>
    get().dispatch('reset_part_to_initial', (state) => {
      const next = { ...state.parts.overridesById };
      delete next[partId];
      return { parts: { ...state.parts, overridesById: next } };
    }),

  resetPartToManual: (partId) =>
    get().dispatch('reset_part_to_manual', (state) => {
      const manual = state.parts.manualTransformById[partId];
      if (!manual) return { parts: state.parts };
      return { parts: { ...state.parts, overridesById: { ...state.parts.overridesById, [partId]: manual } } };
    }),

  createAssemblyGroup: (partIds) => {
    const groupId = crypto.randomUUID();
    const existingGroups = get().assemblyGroups;
    const groupCount = existingGroups.order.length + 1;
    const group: AssemblyGroup = { id: groupId, name: `Group ${groupCount}`, partIds: [...partIds] };
    get().dispatch('create_assembly_group', (state) => ({
      assemblyGroups: {
        byId: { ...state.assemblyGroups.byId, [groupId]: group },
        order: [...state.assemblyGroups.order, groupId],
      },
    }));
    return groupId;
  },

  mergeAssemblyGroups: (groupIdA, groupIdB) => {
    const state = get();
    const groupA = state.assemblyGroups.byId[groupIdA];
    const groupB = state.assemblyGroups.byId[groupIdB];
    if (!groupA || !groupB) return groupIdA;
    const mergedPartIds = [...new Set([...groupA.partIds, ...groupB.partIds])];
    const survivingId = groupIdA;
    get().dispatch('merge_assembly_groups', (s) => {
      const nextById = { ...s.assemblyGroups.byId };
      nextById[survivingId] = { ...groupA, partIds: mergedPartIds };
      delete nextById[groupIdB];
      return {
        assemblyGroups: {
          byId: nextById,
          order: s.assemblyGroups.order.filter((id) => id !== groupIdB),
        },
      };
    });
    return survivingId;
  },

  addPartToGroup: (groupId, partId) =>
    get().dispatch('add_part_to_group', (state) => {
      const group = state.assemblyGroups.byId[groupId];
      if (!group || group.partIds.includes(partId)) return { assemblyGroups: state.assemblyGroups };
      return {
        assemblyGroups: {
          ...state.assemblyGroups,
          byId: {
            ...state.assemblyGroups.byId,
            [groupId]: { ...group, partIds: [...group.partIds, partId] },
          },
        },
      };
    }),

  removePartFromGroup: (partId) =>
    get().dispatch('remove_part_from_group', (state) => {
      let changed = false;
      const nextById: Record<string, AssemblyGroup> = {};
      for (const [id, group] of Object.entries(state.assemblyGroups.byId)) {
        if (group.partIds.includes(partId)) {
          changed = true;
          nextById[id] = { ...group, partIds: group.partIds.filter((pid) => pid !== partId) };
        } else {
          nextById[id] = group;
        }
      }
      if (!changed) return { assemblyGroups: state.assemblyGroups };
      return { assemblyGroups: { ...state.assemblyGroups, byId: nextById } };
    }),

  getGroupForPart: (partId) => {
    const state = get();
    for (const [groupId, group] of Object.entries(state.assemblyGroups.byId)) {
      if (group.partIds.includes(partId)) return groupId;
    }
    return null;
  },

  getGroupParts: (groupId) => {
    const state = get();
    return state.assemblyGroups.byId[groupId]?.partIds ?? [];
  },

  recordMountedRelation: (relation) =>
    set((state) => ({ mountedRelations: [...state.mountedRelations, relation] })),

  getMountedRelationsForSource: (sourceId) => {
    return get().mountedRelations.filter((r) => r.sourceId === sourceId);
  },

  setRecentReferent: (role, entity) =>
    set((state) => ({
      recentReferents: {
        ...state.recentReferents,
        [role === 'source' ? 'lastSource' : 'lastTarget']: {
          ...entity,
          role,
          timestamp: Date.now(),
        },
      },
    })),

  renameAssemblyGroup: (groupId, name) =>
    set((state) => {
      const group = state.assemblyGroups.byId[groupId];
      if (!group) return {};
      return {
        assemblyGroups: {
          ...state.assemblyGroups,
          byId: { ...state.assemblyGroups.byId, [groupId]: { ...group, name } },
        },
      };
    }),

  addVlmImages: (files) =>
    set((state) => ({
      ...state,
      vlm: {
        ...state.vlm,
        images: [
          ...state.vlm.images,
          ...files.map((file) => ({
            id: crypto.randomUUID(),
            name: file.name,
            url: URL.createObjectURL(file),
            file,
          })),
        ],
      },
    })),

  moveVlmImage: (id, dir) =>
    set((state) => {
      const idx = state.vlm.images.findIndex((i) => i.id === id);
      if (idx < 0) return state;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= state.vlm.images.length) return state;
      const copy = [...state.vlm.images];
      const [item] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, item);
      return { ...state, vlm: { ...state.vlm, images: copy } };
    }),

  removeVlmImage: (id) =>
    set((state) => ({
      ...state,
      vlm: { ...state.vlm, images: state.vlm.images.filter((i) => i.id !== id) },
    })),

  setVlmResult: (result) =>
    set((state) => ({
      ...state,
      vlm: { ...state.vlm, result },
    })),

  setVlmAnalyzing: (active) =>
    set((state) => ({
      ...state,
      vlm: { ...state.vlm, analyzing: active },
    })),
  appendChatMessage: (message) =>
    set((state) => ({
      ...state,
      chat: {
        ...state.chat,
        messages: [...state.chat.messages, { id: crypto.randomUUID(), ...message }],
      },
    })),
  showMateCaptureOverlay: (images, durationMs = 5000) =>
    set((state) => {
      const now = Date.now();
      const validDurationMs = Number.isFinite(durationMs) ? Math.max(250, Math.floor(durationMs)) : 5000;
      return {
        ...state,
        mateCaptureOverlay: {
          visible: images.length > 0,
          nonce: state.mateCaptureOverlay.nonce + 1,
          expiresAt: now + validDurationMs,
          images,
        },
      };
    }),
  hideMateCaptureOverlay: () =>
    set((state) => {
      if (!state.mateCaptureOverlay.visible && state.mateCaptureOverlay.images.length === 0) return state;
      return {
        ...state,
        mateCaptureOverlay: {
          ...state.mateCaptureOverlay,
          visible: false,
          images: [],
          expiresAt: 0,
        },
      };
    }),

  undo: () =>
    set((state) => {
      if (state.history.past.length === 0) return state;
      const previous = state.history.past[state.history.past.length - 1];
      const current = takeSnapshot(state);
      return {
        ...state,
        ...applySnapshot(state, previous),
        history: {
          past: state.history.past.slice(0, -1),
          future: [current, ...state.history.future],
          lastCommand: state.history.lastCommand,
        },
      };
    }),

  redo: () =>
    set((state) => {
      if (state.history.future.length === 0) return state;
      const next = state.history.future[0];
      const current = takeSnapshot(state);
      return {
        ...state,
        ...applySnapshot(state, next),
        history: {
          past: [...state.history.past, current],
          future: state.history.future.slice(1),
          lastCommand: state.history.lastCommand,
        },
      };
    }),
}));

if (import.meta.env.DEV) {
  (window as any).__V2_STORE__ = useV2Store;
}
