"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentOrchestration } from "@/lib/subagents";
import {
  MAIN_NODE_ID,
  MAP_MIN_SCALE,
  autoLayoutGraph,
  buildOrchestrationGraph,
  centerOrchestrationMapNode,
  changeChildLink,
  changeContextProviderLink,
  changeDependencyLink,
  effectiveMapProfiles,
  filterOrchestrationEdges,
  findMapProfile,
  fitOrchestrationMap,
  mapOwnersForAgent,
  mapPathFromMain,
  mainPolicyForMap,
  navigationOrchestrationGraph,
  orchestrationLayoutFingerprint,
  orchestrationForOwner,
  readableOrchestrationMap,
  type MapEdge,
  type MapProfile,
  type OrchestrationMapEdgeKind,
  windowOrchestrationBranch,
} from "@/lib/orchestration-map";
import { applyManualMapPositions, canPlaceMapNode, routeOrchestrationEdges } from "@/lib/orchestration-map-routing";
import "./OrchestrationMap.css";

interface MainMapNode {
  /** null/undefined is the older unrestricted Main policy. */
  orchestration?: SubagentOrchestration | null;
  selectedSkills?: readonly string[];
  allowedBuiltInTools?: readonly string[];
  selectedExtensionTools?: readonly { extensionPath: string; toolName: string }[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
}

export interface OrchestrationMapProps {
  cwd: string;
  /** Source profiles are accepted; shadowed definitions are omitted from the canvas. */
  profiles: readonly MapProfile[];
  main: MainMapNode;
  /** null shows the entire roster. Main is a distinct editable root. */
  ownerId: string | null;
  /** Unsaved changes for the selected owner; never persisted by this component. */
  draftOrchestration?: SubagentOrchestration | null;
  /** A profile opened from the profile editor should remain selected in its coordinator's branch. */
  focusNodeId?: string | null;
  canEdit?: boolean;
  onSelectOwner: (ownerId: string | null) => boolean | void;
  onOpenProfile?: (profileName: string) => void;
  onRestrictMain?: () => void;
  onToggleChild?: (ownerId: string, childName: string, enabled: boolean, next: SubagentOrchestration) => void;
  onToggleDependency?: (ownerId: string, producerName: string, consumerName: string, enabled: boolean, next: SubagentOrchestration) => void;
  onToggleContextProvider?: (ownerId: string, providerName: string, consumerName: string, enabled: boolean, next: SubagentOrchestration) => void;
}

interface Point { x: number; y: number }
interface Viewport extends Point { scale: number }
type DragState = { type: "pan"; x: number; y: number; start: Viewport }
  | { type: "node"; id: string; x: number; y: number; start: Point; last: Point };

const DEFAULT_VIEW: Viewport = { x: 20, y: 20, scale: 1 };
const MAX_SCALE = 1.6;
const ERROR_KEYS: Record<string, string> = {
  "Choose an available agent profile.": "map.errorChooseProfile",
  "An orchestrator cannot delegate to itself.": "map.errorSelfChild",
  "Both agents must be direct children of this orchestrator.": "map.errorDirectChildren",
  "An agent cannot depend on itself.": "map.errorSelfDependency",
  "An agent may have at most 8 prerequisites.": "map.errorMaxPrerequisites",
  "This link creates a dependency cycle.": "map.errorCycle",
};

function layoutStorageKey(cwd: string, ownerId: string | null, layer: OrchestrationMapEdgeKind): string {
  // v3 ignores coordinates saved for the former column layout.
  return `pi-web:orchestration-map-layout:v3:${cwd}:${ownerId ?? "overview"}:${layer}`;
}

function readLayout(storageKey: string): Record<string, Point> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Point] => {
      const point = entry[1] as Point | null;
      return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }));
  } catch {
    return {};
  }
}

function edgeId(edge: MapEdge): string {
  return [edge.kind, edge.ownerId, edge.source, edge.target].join("\u0000");
}

function scaledViewport(previous: Viewport, factor: number, width: number, height: number): Viewport {
  // Fit all may be smaller than the interactive minimum; zoom in gradually from that overview.
  const scale = Math.max(Math.min(MAP_MIN_SCALE, previous.scale), Math.min(MAX_SCALE, previous.scale * factor));
  const ratio = scale / previous.scale;
  return { x: width / 2 - (width / 2 - previous.x) * ratio,
    y: height / 2 - (height / 2 - previous.y) * ratio, scale };
}

export function OrchestrationMap({
  cwd, profiles: sources, main, ownerId, draftOrchestration, focusNodeId, canEdit = false,
  onSelectOwner, onOpenProfile, onRestrictMain, onToggleChild, onToggleDependency, onToggleContextProvider,
}: OrchestrationMapProps) {
  const { t } = useI18n();
  const [layer, setLayer] = useState<OrchestrationMapEdgeKind>("delegation");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(24);
  const [query, setQuery] = useState("");
  const [exactQuery, setExactQuery] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string>(focusNodeId ?? MAIN_NODE_ID);
  const [userSelectedNode, setUserSelectedNode] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  const [connectionKind, setConnectionKind] = useState<"dependencies" | "contextProviders">("contextProviders");
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEW);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const pendingFocusNode = useRef<string | null>(null);
  const lastLayoutFingerprint = useRef("");
  const lastStorageKey = useRef<string | null>(null);
  const profiles = useMemo(() => effectiveMapProfiles(sources), [sources]);
  const policy = ownerId === null ? null : orchestrationForOwner(ownerId, profiles, main.orchestration ?? null, ownerId, draftOrchestration);
  const fullGraph = useMemo(() => buildOrchestrationGraph({ profiles, main: main.orchestration ?? null, ownerId, draft: draftOrchestration,
    layer: ownerId === null ? "delegation" : "all", query, exactQuery, connectedOnly: true }),
    [profiles, main.orchestration, ownerId, draftOrchestration, query, exactQuery]);
  const visibleLayer: OrchestrationMapEdgeKind = ownerId === null ? "delegation" : layer;
  const navigationGraph = useMemo(() => ownerId === null && !query.trim()
    ? navigationOrchestrationGraph(fullGraph, mainPolicyForMap(profiles, main.orchestration ?? null).allowedChildren)
    : null, [ownerId, query, fullGraph, profiles, main.orchestration]);
  const pinnedEdge = fullGraph.edges.find((edge) => edgeId(edge) === selectedEdge);
  const branchWindow = useMemo(() => ownerId !== null && !query.trim()
    ? windowOrchestrationBranch(fullGraph, ownerId, visibleLayer, visibleLimit, { edge: pinnedEdge, nodeId: selectedNode })
    : null, [ownerId, query, fullGraph, visibleLayer, visibleLimit, pinnedEdge, selectedNode]);
  const graph = navigationGraph ?? branchWindow ?? fullGraph;
  const hiddenDirectCount = (navigationGraph ?? branchWindow)?.hiddenDirectCount ?? 0;
  // Requirements and on-demand data belong to a particular coordinator. A roster-wide
  // overlay combines unrelated policies and implies a global dependency that does not exist.
  const visibleEdges = useMemo(() => filterOrchestrationEdges(graph.edges, visibleLayer), [graph.edges, visibleLayer]);
  const layoutNodes = useMemo(() => branchWindow ? graph.nodes : autoLayoutGraph(graph.nodes, visibleEdges, ownerId),
    [branchWindow, graph.nodes, visibleEdges, ownerId]);
  const storageKey = layoutStorageKey(cwd, ownerId, visibleLayer);
  const layoutFingerprint = orchestrationLayoutFingerprint(storageKey, layoutNodes, visibleEdges);
  const nodes = useMemo(() => applyManualMapPositions(layoutNodes, positions, visibleEdges), [layoutNodes, positions, visibleEdges]);
  const routes = useMemo(() => routeOrchestrationEdges(nodes, visibleEdges), [nodes, visibleEdges]);
  const workflowStages = ownerId !== null && visibleLayer === "dependencies" && visibleEdges.length > 0
    ? [...new Set(layoutNodes.filter((node) => node.id !== ownerId).map((node) => node.x))].sort((a, b) => a - b)
    : [];
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const path = useMemo(() => ownerId === null ? [] : mapPathFromMain(ownerId, profiles, main.orchestration ?? null), [ownerId, profiles, main.orchestration]);
  const selected = selectedNode === MAIN_NODE_ID ? null : findMapProfile(profiles, selectedNode);
  const selectedOwners = selectedNode === MAIN_NODE_ID ? [] : mapOwnersForAgent(selectedNode, profiles, main.orchestration ?? null, ownerId, draftOrchestration);
  const selectedIsDirectChild = ownerId !== null && ownerId !== selectedNode
    && Boolean(policy?.allowedChildren.some((name) => name.toLowerCase() === selectedNode.toLowerCase()));
  const selectedPrerequisites = selectedIsDirectChild
    ? Object.entries(policy?.dependencies ?? {}).find(([name]) => name.toLowerCase() === selectedNode.toLowerCase())?.[1] ?? []
    : [];
  const selectedProviders = selectedIsDirectChild
    ? Object.entries(policy?.contextProviders ?? {}).find(([name]) => name.toLowerCase() === selectedNode.toLowerCase())?.[1] ?? []
    : [];
  const mainNeedsRestriction = ownerId === MAIN_NODE_ID && main.orchestration == null && draftOrchestration == null;
  const visibleSkills = selectedNode === MAIN_NODE_ID ? main.selectedSkills : selected?.selectedSkills;
  const visibleBuiltInTools = selectedNode === MAIN_NODE_ID ? main.allowedBuiltInTools : selected?.tools;
  const visibleTools = selectedNode === MAIN_NODE_ID ? main.selectedExtensionTools : selected?.selectedExtensionTools;
  const legacySkills = selectedNode === MAIN_NODE_ID ? main.loadSkills ?? true : selected?.loadSkills;
  const legacyExtensions = selectedNode === MAIN_NODE_ID ? main.loadExtensions ?? true : selected?.loadExtensions;
  const selectedLink = visibleEdges.find((edge) => edgeId(edge) === selectedEdge);
  // During search the visible path and every matched card must remain readable.
  const focusRelations = !query.trim() && nodeById.has(selectedNode) && (ownerId === null || selectedNode !== ownerId);
  const highlightedEdges = useMemo(() => new Set(focusRelations
    ? visibleEdges.filter((edge) => edge.source === selectedNode || edge.target === selectedNode).map(edgeId)
    : visibleEdges.map(edgeId)), [focusRelations, visibleEdges, selectedNode]);
  const highlightedNodes = useMemo(() => new Set(focusRelations
    ? [selectedNode, ...visibleEdges.filter((edge) => highlightedEdges.has(edgeId(edge)))
      .flatMap((edge) => [edge.source, edge.target])]
    : nodes.map((node) => node.id)), [focusRelations, visibleEdges, highlightedEdges, selectedNode, nodes]);
  const relatedOverviewEdges = ownerId === null
    ? visibleEdges.filter((edge) => edge.source === selectedNode || edge.target === selectedNode)
    : [];
  const canChange = canEdit && ownerId !== null && policy !== null && !mainNeedsRestriction;
  const candidates = profiles.filter((profile) => profile.enabled && !profile.configurationError
    && profile.name.toLowerCase() !== ownerId?.toLowerCase()
    && !policy?.allowedChildren.some((name) => name.toLowerCase() === profile.name.toLowerCase()));

  useEffect(() => { setVisibleLimit(24); }, [ownerId]);

  const fit = useCallback((currentNodes = layoutNodes, readable = false) => {
    const element = stage.current;
    if (!element || !currentNodes.length) return;
    const { width, height } = element.getBoundingClientRect();
    const routePoints = routeOrchestrationEdges(currentNodes, visibleEdges).flatMap((route) => route.points);
    const next = (readable ? readableOrchestrationMap : fitOrchestrationMap)(currentNodes, width, height, ownerId ?? MAIN_NODE_ID, routePoints);
    if (next) setViewport(next);
  }, [layoutNodes, visibleEdges, ownerId]);

  useEffect(() => {
    if (lastLayoutFingerprint.current === layoutFingerprint) return;
    const storageChanged = lastStorageKey.current !== storageKey;
    lastLayoutFingerprint.current = layoutFingerprint;
    lastStorageKey.current = storageKey;
    const restored = storageChanged ? readLayout(storageKey) : positions;
    if (storageChanged) setPositions(restored);
    const currentNodes = applyManualMapPositions(layoutNodes, restored, visibleEdges);
    const focusNode = focusNodeId ? currentNodes.find((node) => node.id.toLowerCase() === focusNodeId.toLowerCase()) : undefined;
    const rectangle = stage.current?.getBoundingClientRect();
    if (focusNode && rectangle) {
      setViewport(centerOrchestrationMapNode(focusNode, rectangle.width, rectangle.height, 0.9));
    } else fit(currentNodes, true);
    setSelectedEdge((current) => current && visibleEdges.some((edge) => edgeId(edge) === current) ? current : null);
    setConnectionSource(null);
    setError(null);
  }, [storageKey, layoutFingerprint, fit, layoutNodes, positions, focusNodeId, visibleEdges]);

  useEffect(() => {
    if (focusNodeId) {
      setSelectedNode(focusNodeId);
      setUserSelectedNode(false);
    }
  }, [focusNodeId]);

  useEffect(() => {
    const id = pendingFocusNode.current;
    const element = stage.current;
    if (!id || !element) return;
    // Link navigation may change the layer and restore layer-specific manual positions.
    const current = applyManualMapPositions(layoutNodes, readLayout(storageKey), visibleEdges);
    const node = current.find((candidate) => candidate.id === id);
    if (!node) return;
    pendingFocusNode.current = null;
    const { width, height } = element.getBoundingClientRect();
    setViewport(centerOrchestrationMapNode(node, width, height, 0.9));
  }, [layoutNodes, storageKey, visibleEdges]);

  useEffect(() => {
    if (!userSelectedNode && focusNodeId && nodeById.has(focusNodeId) && selectedNode !== focusNodeId) {
      setSelectedNode(focusNodeId);
    } else if (!nodeById.has(selectedNode)) {
      setSelectedNode(focusNodeId && nodeById.has(focusNodeId) ? focusNodeId : ownerId ?? MAIN_NODE_ID);
    }
  }, [nodeById, ownerId, selectedNode, focusNodeId, userSelectedNode]);

  const savePositions = (next: Record<string, Point>) => {
    setPositions(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Layout is optional. */ }
  };

  const zoom = (factor: number) => {
    const element = stage.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setViewport((previous) => scaledViewport(previous, factor, width, height));
  };

  const centerSelected = () => {
    const element = stage.current;
    const node = nodeById.get(selectedNode);
    if (!element || !node) return;
    const { width, height } = element.getBoundingClientRect();
    setViewport(centerOrchestrationMapNode(node, width, height, Math.max(viewport.scale, 0.9)));
  };

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Browser wheel listeners can be passive by default; keep pan within the canvas.
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const { width, height } = element.getBoundingClientRect();
        const delta = Math.max(-100, Math.min(100, event.deltaY * multiplier));
        setViewport((previous) => scaledViewport(previous, Math.exp(-delta * 0.001), width, height));
        return;
      }
      setViewport((previous) => ({ ...previous,
        x: previous.x - Math.max(-80, Math.min(80, event.deltaX * multiplier)) * 0.65,
        y: previous.y - Math.max(-80, Math.min(80, event.deltaY * multiplier)) * 0.65 }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const panStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target as Element).classList.contains("orchestration-map-canvas")) return;
    if (event.button !== 0) return;
    drag.current = { type: "pan", x: event.clientX, y: event.clientY, start: viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const panMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.type !== "pan") return;
    const { x, y, start } = drag.current;
    setViewport({ ...start, x: start.x + event.clientX - x, y: start.y + event.clientY - y });
  };

  const moveNode = (id: string, dx: number, dy: number) => {
    const node = nodeById.get(id);
    if (!node) return;
    const next = { x: node.x + dx, y: node.y + dy };
    if (canPlaceMapNode(id, next, nodes, visibleEdges)) savePositions({ ...positions, [id]: next });
  };

  const moveKey = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const delta = event.shiftKey ? 40 : 10;
    const direction: Record<string, Point> = { ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta },
      ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 } };
    const movement = direction[event.key];
    if (!movement) return;
    event.preventDefault();
    moveNode(id, movement.x, movement.y);
  };

  const updateChild = (child: string, enabled: boolean) => {
    if (!canChange || !onToggleChild || !policy || ownerId === null) return;
    const result = changeChildLink(ownerId, policy, child, enabled, profiles);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    if (enabled) setLayer("delegation");
    onToggleChild?.(ownerId, child, enabled, result.next);
  };

  const updateDependency = (from: string, to: string, enabled: boolean) => {
    if (!canChange || !onToggleDependency || !policy || ownerId === null) return;
    const result = changeDependencyLink(policy, from, to, enabled);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    if (enabled) { setLayer("dependencies"); setConnectionKind("dependencies"); }
    onToggleDependency?.(ownerId, from, to, enabled, result.next);
  };

  const updateContextProvider = (from: string, to: string, enabled: boolean) => {
    if (!canChange || !onToggleContextProvider || !policy || ownerId === null) return;
    const result = changeContextProviderLink(policy, from, to, enabled);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    if (enabled) { setLayer("contextProviders"); setConnectionKind("contextProviders"); }
    onToggleContextProvider(ownerId, from, to, enabled, result.next);
  };

  const chooseConnector = (id: string) => {
    if (!canChange || !(connectionKind === "dependencies" ? onToggleDependency : onToggleContextProvider) || id === ownerId) return;
    if (!connectionSource) { setConnectionSource(id); setSelectedNode(id); setUserSelectedNode(true); return; }
    if (connectionSource === id) { setConnectionSource(null); return; }
    if (connectionKind === "dependencies") updateDependency(connectionSource, id, true);
    else updateContextProvider(connectionSource, id, true);
    setConnectionSource(null);
  };

  const removeSelectedLink = (edge: MapEdge) => {
    if (edge.ownerId !== ownerId) return;
    if (edge.kind === "delegation") updateChild(edge.target, false);
    else if (edge.kind === "dependencies") updateDependency(edge.source, edge.target, false);
    else updateContextProvider(edge.source, edge.target, false);
    setSelectedEdge(null);
  };

  const switchOwner = (nextOwner: string | null) => {
    // The parent can reject navigation when unsaved changes are present. Keep
    // search and selection intact in that case; otherwise show the full branch.
    if (onSelectOwner(nextOwner) === false) return;
    setQuery("");
    setExactQuery(false);
    setSelectedEdge(null);
    setConnectionSource(null);
  };

  return (
    <section className="orchestration-map" aria-label={t("map.title")}>
      <div className="orchestration-map-toolbar">
        <div className="orchestration-map-breadcrumbs" aria-label={t("map.path")}>
          <button type="button" aria-current={ownerId === null ? "page" : undefined} onClick={() => switchOwner(null)}>{t("map.allAgents")}</button>
          {path.map((id) => <span key={id} className="orchestration-map-crumb"><span aria-hidden="true">›</span>
            <button type="button" aria-current={ownerId === id ? "page" : undefined} onClick={() => switchOwner(id)}>
              {id === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, id)?.displayName ?? id}
            </button>
          </span>)}
        </div>
        <div className="orchestration-map-controls">
          <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setExactQuery(false); }} aria-label={t("map.search")} placeholder={t("map.searchPlaceholder")} />
          {query && <button type="button" onClick={() => { setQuery(""); setExactQuery(false); }}>{t("map.showAllDirectAgents")}</button>}
          <button type="button" onClick={() => zoom(1.15)} aria-label={t("map.zoomIn")}>＋</button>
          <button type="button" onClick={() => zoom(1 / 1.15)} aria-label={t("map.zoomOut")}>−</button>
          <button type="button" onClick={centerSelected} disabled={!nodeById.has(selectedNode)}>{t("map.focusSelection")}</button>
          <button type="button" onClick={() => fit(nodes)} title={t("map.fit")}>{t("map.fit")}</button>
          <button type="button" onClick={() => { savePositions({}); fit(layoutNodes, true); }} title={t("map.arrange")}>{t("map.arrangeShort")}</button>
          <button type="button" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>{t("map.details")}</button>
        </div>
      </div>
      <div className="orchestration-map-scope" role="status">
        <strong>{ownerId === null ? t("map.fullRoster")
          : ownerId === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, ownerId)?.displayName ?? ownerId}</strong>
        <span>{t(ownerId === null ? "map.overviewHint" : "map.branchHint")}</span>
      </div>
      <div className="orchestration-map-layers" role="group" aria-label={t("map.layers")}>
        {(["delegation", ...(ownerId === null ? [] : ["dependencies", "contextProviders"])] as OrchestrationMapEdgeKind[]).map((kind) => <button key={kind} type="button"
          className="orchestration-map-legend" aria-pressed={visibleLayer === kind}
          onClick={() => { setLayer(kind); if (kind === "dependencies" || kind === "contextProviders") setConnectionKind(kind); setConnectionSource(null); setSelectedEdge(null); }}>
          <i className={`is-${kind}`} aria-hidden="true" />{t(kind === "delegation" ? "map.delegationMeaning" : kind === "dependencies" ? "map.dependenciesMeaning" : "map.contextProvidersMeaning")}
        </button>)}
        <span className="orchestration-map-count">{query.trim() ? t("map.searchResults", { count: graph.matchCount })
          : ownerId === null ? t("map.directAgents", { count: mainPolicyForMap(profiles, main.orchestration ?? null).allowedChildren.length })
            : t("map.directAgents", { count: policy?.allowedChildren.length ?? 0 })}</span>
      </div>
      {ownerId === null && hiddenDirectCount > 0 && <div className="orchestration-map-collapsed">
        <span>{t("map.hiddenDirectAgents", { count: hiddenDirectCount })}</span>
        <button type="button" onClick={() => switchOwner(MAIN_NODE_ID)}>{t("map.openMainBranch")}</button>
      </div>}
      {ownerId !== null && hiddenDirectCount > 0 && <div className="orchestration-map-collapsed">
        <span>{t("map.hiddenBranchAgents", { count: hiddenDirectCount })}</span>
        <button type="button" onClick={() => setVisibleLimit((limit) => limit + 24)}>{t("map.showMoreAgents")}</button>
      </div>}
      <div className="orchestration-map-pan-hint">{t("map.panHint")}</div>
      <div className="orchestration-map-body">
        <div className="orchestration-map-stage" ref={stage} onPointerDown={panStart}
          onPointerMove={panMove} onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }} aria-label={t("map.graph")}>
          <div className="orchestration-map-canvas" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
            {workflowStages.map((x, index) => <div key={x} className="orchestration-map-stage-label" style={{ left: x, top: 9 }}>
              {t("map.workflowStage", { count: index + 1 })}
            </div>)}
            <svg className="orchestration-map-edges" width="100%" height="100%" aria-hidden="true">
              <defs>
                <marker id="orchestration-map-arrow-delegation" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" /></marker>
                <marker id="orchestration-map-arrow-dependencies" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" /></marker>
                <marker id="orchestration-map-arrow-contextProviders" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" /></marker>
              </defs>
              {routes.map(({ edge, path: d }) => {
                return <g key={edgeId(edge)}>
                  <path className={`orchestration-map-edge is-${edge.kind}${highlightedEdges.has(edgeId(edge)) ? "" : " is-muted"}${selectedEdge === edgeId(edge) ? " is-selected" : ""}`}
                    d={d} markerEnd={`url(#orchestration-map-arrow-${edge.kind})`} />
                  <path className="orchestration-map-edge-target" d={d} onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); setUserSelectedNode(true); }} />
                </g>;
              })}
            </svg>
            {nodes.map((node) => <div key={node.id}
              className={`orchestration-map-node is-${node.kind}${node.enabled ? "" : " is-disabled"}${highlightedNodes.has(node.id) ? "" : " is-muted"}${selectedNode === node.id ? " is-selected" : ""}`}
              style={{ left: node.x, top: node.y }}>
              <button type="button" className="orchestration-map-node-face" aria-label={t("map.inspect", { name: node.id === MAIN_NODE_ID ? t("common.main") : node.label })}
                aria-pressed={selectedNode === node.id} onClick={() => { setSelectedNode(node.id); setUserSelectedNode(true); setSelectedEdge(null); }}>
                <span className="orchestration-map-node-kind">{t(node.kind === "main" ? "map.kindMain" : node.kind === "orchestrator" ? "map.kindOrchestrator" : node.kind === "missing" ? "map.kindMissing" : "map.kindAgent")}</span>
                <strong title={node.id === MAIN_NODE_ID ? t("common.main") : node.label}>{node.id === MAIN_NODE_ID ? t("common.main") : node.label}</strong>
                <small title={node.id}>{node.id !== MAIN_NODE_ID && findMapProfile(profiles, node.id)?.orchestration
                  ? t("map.directAgents", { count: findMapProfile(profiles, node.id)!.orchestration!.allowedChildren.length })
                  : node.scope ? `${t(`agents.scope.${node.scope}`)} · ${node.id}` : node.id === MAIN_NODE_ID ? t("common.main") : node.id}</small>
              </button>
              <button type="button" className="orchestration-map-node-move" aria-label={t("map.move", { name: node.id === MAIN_NODE_ID ? t("common.main") : node.label })}
                title={t("map.moveHint")} onKeyDown={(event) => moveKey(event, node.id)}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const current = nodeById.get(node.id);
                  if (!current) return;
                  drag.current = { type: "node", id: node.id, x: event.clientX, y: event.clientY,
                    start: { x: current.x, y: current.y }, last: { x: current.x, y: current.y } };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (drag.current?.type !== "node" || drag.current.id !== node.id) return;
                  const { start, x, y } = drag.current;
                  const next = {
                    x: start.x + (event.clientX - x) / viewport.scale, y: start.y + (event.clientY - y) / viewport.scale,
                  };
                  if (!canPlaceMapNode(node.id, next, nodes, visibleEdges)) return;
                  drag.current.last = next;
                  setPositions((previous) => ({ ...previous, [node.id]: next }));
                }}
                onPointerUp={() => {
                  if (drag.current?.type !== "node" || drag.current.id !== node.id) return;
                  savePositions({ ...positions, [node.id]: drag.current.last });
                  drag.current = null;
                }} onPointerCancel={() => { drag.current = null; }}>⠿</button>
              {node.kind === "orchestrator" || node.kind === "main" ? <button type="button" className="orchestration-map-node-open"
                aria-label={t("map.openNamedBranch", { name: node.id === MAIN_NODE_ID ? t("common.main") : node.label })} title={t("map.openBranch")} onClick={() => switchOwner(node.id)}>↗</button> : null}
              {ownerId !== null && node.id !== ownerId && canChange && visibleLayer === connectionKind
                && (onToggleDependency || onToggleContextProvider) ?
                <button type="button" className={`orchestration-map-node-port is-${connectionKind}${connectionSource === node.id ? " is-active" : ""}`}
                  aria-label={connectionKind === "dependencies"
                    ? connectionSource ? t("map.consumerPort", { name: node.label, source: connectionSource }) : t("map.prerequisitePort", { name: node.label })
                    : connectionSource ? t("map.contextConsumerPort", { name: node.label, source: connectionSource }) : t("map.contextProviderPort", { name: node.label })}
                  title={t(connectionKind === "dependencies" ? "map.dependencyHint" : "map.contextProviderHint")}
                  onClick={() => chooseConnector(node.id)}>●</button> : null}
            </div>)}
          </div>
          {query.trim() && graph.matchCount === 0 ? <div className="orchestration-map-empty" role="status">{t("map.noMatches")}</div> : null}
          {ownerId !== null && !fullGraph.edges.some((edge) => edge.kind === visibleLayer) && !query.trim() ?
            <div className="orchestration-map-empty" role="status">{t("map.noRelations")}</div> : null}
        </div>
        <aside className="orchestration-map-inspector" aria-label={t("map.details")} hidden={!inspectorOpen}>
          <h3>{selectedNode === MAIN_NODE_ID ? t("common.main") : selected?.displayName ?? selectedNode}</h3>
          {error && <p role="alert" className="orchestration-map-error">{ERROR_KEYS[error] ? t(ERROR_KEYS[error]) : error}</p>}
          {selectedNode !== MAIN_NODE_ID && selected && <>
            <div className="orchestration-map-meta">{t(`agents.scope.${selected.scope}`)} · {t(selected.enabled ? "map.statusEnabled" : "map.statusDisabled")}{selected.orchestration ? ` · ${t("map.kindOrchestrator")}` : ""}{selected.fastMode ? ` · ${t("agents.fastMode")}` : ""}</div>
            <p>{selected.description || t("map.noDescription")}</p>
            <button type="button" onClick={() => onOpenProfile?.(selected.name)} disabled={!onOpenProfile}>{t("map.openProfile")}</button>
            {selected.orchestration && <button type="button" onClick={() => switchOwner(selected.name)}>{t("map.openBranch")}</button>}
          </>}
          {selectedNode !== MAIN_NODE_ID && !selected && <p>{t("map.missingProfile")}</p>}
          {selectedNode === MAIN_NODE_ID && <p>{main.orchestration == null ? t("map.rootLegacy") : t("map.rootConfigured", { count: main.orchestration.allowedChildren.length })}</p>}
          {ownerId !== null && selectedNode === ownerId && Boolean(policy?.allowedChildren.length) && <>
            <h4>{t("map.directDelegates")}</h4>
            <div className="orchestration-map-inspector-branch-list">
              {policy?.allowedChildren.map((name) => <button key={name} type="button"
                onClick={() => { pendingFocusNode.current = name; setQuery(""); setExactQuery(false); setSelectedNode(name); setUserSelectedNode(true); setSelectedEdge(null); }}>
                {findMapProfile(profiles, name)?.displayName ?? name}
              </button>)}
            </div>
          </>}
          {selectedNode !== MAIN_NODE_ID && <div className="orchestration-map-context">
            <h4>{t("map.coordinators")}</h4>
            {selectedOwners.length ? <>
              {selectedOwners.length > 1 && <p>{t("map.coordinatorHint")}</p>}
              <div role="group" aria-label={t("map.chooseCoordinator")} className="orchestration-map-owner-choices">
                {selectedOwners.map((id) => <button key={id} type="button" aria-pressed={id === ownerId} onClick={() => switchOwner(id)}>
                  {id === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, id)?.displayName ?? id}
                </button>)}
              </div>
              {selectedIsDirectChild && <div className="orchestration-map-prerequisites">
                {(["contextProviders", "dependencies"] as const).map((kind) => {
                  const linked = kind === "contextProviders" ? selectedProviders : selectedPrerequisites;
                  const update = kind === "contextProviders" ? updateContextProvider : updateDependency;
                  const title = t(kind === "contextProviders" ? "map.providersForSelected" : "map.requiredBySelected", { name: selected?.displayName ?? selectedNode });
                  const others = policy?.allowedChildren.filter((name) => name.toLowerCase() !== selectedNode.toLowerCase()) ?? [];
                  return <div key={kind} className={`orchestration-map-source-group is-${kind}`}>
                    <h4>{title}</h4>
                    <p>{t(kind === "contextProviders" ? "map.contextProviderHint" : "map.prerequisiteMeaning")}</p>
                    {linked.length > 0 && <div className="orchestration-map-active-sources">{linked.map((name) => <button key={name} type="button"
                      disabled={!canChange || !(kind === "contextProviders" ? onToggleContextProvider : onToggleDependency)}
                      aria-label={t("map.removeTypedLink", { kind: t(kind === "contextProviders" ? "map.contextProvidersMeaning" : "map.dependenciesMeaning"), source: name, target: selectedNode })}
                      onClick={() => update(name, selectedNode, false)}>
                      {findMapProfile(profiles, name)?.displayName ?? name}<span aria-hidden="true">×</span>
                    </button>)}</div>}
                    {canChange && (kind === "contextProviders" ? onToggleContextProvider : onToggleDependency) && others.length > 0 &&
                      <select aria-label={title} value="" onChange={(event) => { if (event.target.value) update(event.target.value, selectedNode, true); }}>
                        <option value="">{t("map.chooseProducer")}</option>
                        {others.filter((name) => !linked.some((source) => source.toLowerCase() === name.toLowerCase())).map((name) =>
                          <option key={name} value={name}>{findMapProfile(profiles, name)?.displayName ?? name}</option>)}
                      </select>}
                  </div>;
                })}
                {policy?.allowedChildren.length === 1 && <p>{t("map.addSiblingFirst")}</p>}
              </div>}
            </> : <>
              <p>{t("map.noCoordinators")}</p>
              <button type="button" onClick={() => switchOwner(MAIN_NODE_ID)}>{t("map.openMainBranch")}</button>
            </>}
          </div>}
          {ownerId !== null && <h4>{t("map.connections")}</h4>}
          {ownerId === null ? <>
            {relatedOverviewEdges.length > 0 && <details className="orchestration-map-link-group">
              <summary>{t("map.connections")}<span>{relatedOverviewEdges.length}</span></summary>
              <div className="orchestration-map-overview-links" role="group" aria-label={t("map.connections")}>
              {relatedOverviewEdges.map((edge) => {
                const ownerName = edge.ownerId === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.ownerId)?.displayName ?? edge.ownerId;
                const sourceName = edge.source === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.source)?.displayName ?? edge.source;
                const targetName = findMapProfile(profiles, edge.target)?.displayName ?? edge.target;
                return <button key={edgeId(edge)} type="button" aria-pressed={selectedEdge === edgeId(edge)}
                  onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); setUserSelectedNode(true); }}>
                  <span>{t(edge.kind === "delegation" ? "map.delegationMeaning" : edge.kind === "dependencies" ? "map.dependenciesMeaning" : "map.contextProvidersMeaning")} · {t("map.overviewOwner", { name: ownerName })}</span>
                  <strong>{sourceName} → {targetName}</strong>
                </button>;
              })}
              </div>
            </details>}
            {selectedLink && <div className="orchestration-map-overview-link">
              <p>{t("map.overviewOwner", { name: selectedLink.ownerId === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, selectedLink.ownerId)?.displayName ?? selectedLink.ownerId })}</p>
              <button type="button" onClick={() => switchOwner(selectedLink.ownerId)}>{t("map.openItsBranch")}</button>
            </div>}
            <p>{t("map.selectToEdit")}</p>
            {!query.trim() && graph.unreachableAgentIds.length > 0 && <details className="orchestration-map-unassigned">
              <summary>{t("map.unassignedAgents", { count: graph.unreachableAgentIds.length })}</summary>
              {graph.unreachableAgentIds.map((name) => <button key={name} type="button" title={t("map.openUnassigned")}
                onClick={() => { pendingFocusNode.current = name; setQuery(name); setExactQuery(true); setSelectedNode(name); setUserSelectedNode(true); setSelectedEdge(null); }}>
                {findMapProfile(profiles, name)?.displayName ?? name}
              </button>)}
            </details>}
          </> : <>
            {mainNeedsRestriction && <div className="orchestration-map-legacy-note">
              {t("map.legacyWarning")}
              {canEdit && onRestrictMain && <button type="button" onClick={onRestrictMain}>{t("map.restrictMain")}</button>}
            </div>}
            {canChange && onToggleChild && <form className="orchestration-map-add" onSubmit={(event) => { event.preventDefault(); if (candidate) { updateChild(candidate, true); setCandidate(""); } }}>
              <label htmlFor="orchestration-map-candidate">{t("map.addDirectAgent")}</label>
              <div className="orchestration-map-add-row"><select id="orchestration-map-candidate" value={candidate} onChange={(event) => setCandidate(event.target.value)}>
                <option value="">{t("map.chooseAgent")}</option>{candidates.map((profile) => <option key={profile.name} value={profile.name}>{profile.displayName} ({profile.name})</option>)}
              </select><button type="submit" disabled={!candidate}>{t("map.addLink")}</button></div>
            </form>}
            {canChange && (onToggleDependency || onToggleContextProvider) && <div className="orchestration-map-link-kind">
              <label htmlFor="orchestration-map-link-kind">{t("map.linkKind")}</label>
              <select id="orchestration-map-link-kind" value={connectionKind} onChange={(event) => {
                const kind = event.target.value as "dependencies" | "contextProviders";
                setConnectionKind(kind); setLayer(kind); setConnectionSource(null); setSelectedEdge(null);
              }}>
                <option value="contextProviders">{t("map.contextProvidersMeaning")}</option>
                <option value="dependencies">{t("map.dependenciesMeaning")}</option>
              </select>
              {!selectedIsDirectChild && <p>{t("map.connectHint")}</p>}
            </div>}
            {canChange && !selectedIsDirectChild && (connectionKind === "dependencies" ? onToggleDependency : onToggleContextProvider) &&
              <details className="orchestration-map-link-group"><summary>{t("map.addLink")}</summary>
                <form className="orchestration-map-add" onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const producer = String(data.get("producer") ?? "");
                  const consumer = String(data.get("consumer") ?? "");
                  if (!producer || !consumer) return;
                  if (connectionKind === "dependencies") updateDependency(producer, consumer, true);
                  else updateContextProvider(producer, consumer, true);
                }}>
                  <label htmlFor="orchestration-map-producer">{t("map.producer")}</label>
                  <select id="orchestration-map-producer" name="producer" defaultValue="">
                    <option value="">{t("map.chooseProducer")}</option>{policy?.allowedChildren.map((name) => <option key={name} value={name}>{findMapProfile(profiles, name)?.displayName ?? name}</option>)}
                  </select>
                  <label htmlFor="orchestration-map-consumer">{t("map.consumer")}</label>
                  <select id="orchestration-map-consumer" name="consumer" defaultValue="">
                    <option value="">{t("map.chooseConsumer")}</option>{policy?.allowedChildren.map((name) => <option key={name} value={name}>{findMapProfile(profiles, name)?.displayName ?? name}</option>)}
                  </select><button type="submit">{t("map.addLink")}</button>
                </form>
              </details>}
            {(["delegation", "contextProviders", "dependencies"] as const).map((kind) => <details key={`${ownerId}:${kind}`}
              className="orchestration-map-link-group">
              <summary>{t(kind === "delegation" ? "map.directDelegates" : kind === "dependencies" ? "map.requiredResults" : "map.availableProviders")}
                <span>{fullGraph.edges.filter((edge) => edge.ownerId === ownerId && edge.kind === kind).length}</span></summary>
              {fullGraph.edges.filter((edge) => edge.ownerId === ownerId && edge.kind === kind).map((edge) => <div key={edgeId(edge)}
                className={`orchestration-map-link is-${edge.kind}${selectedEdge === edgeId(edge) ? " is-selected" : ""}`}>
                <button type="button" onClick={() => {
                  pendingFocusNode.current = edge.target;
                  setLayer(edge.kind);
                  if (edge.kind === "dependencies" || edge.kind === "contextProviders") setConnectionKind(edge.kind);
                  setConnectionSource(null);
                  setQuery("");
                  setExactQuery(false);
                  setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); setUserSelectedNode(true);
                }}>
                  {edge.source === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.source)?.displayName ?? edge.source}
                  <span aria-hidden="true"> → </span>{findMapProfile(profiles, edge.target)?.displayName ?? edge.target}
                </button>
                {canChange && <button type="button" aria-label={t("map.removeTypedLink", {
                  kind: t(edge.kind === "delegation" ? "map.delegationMeaning" : edge.kind === "dependencies" ? "map.dependenciesMeaning" : "map.contextProvidersMeaning"),
                  source: edge.source === MAIN_NODE_ID ? t("common.main") : edge.source, target: edge.target,
                })}
                  title={t("map.removeTypedLink", {
                    kind: t(edge.kind === "delegation" ? "map.delegationMeaning" : edge.kind === "dependencies" ? "map.dependenciesMeaning" : "map.contextProvidersMeaning"),
                    source: edge.source === MAIN_NODE_ID ? t("common.main") : edge.source, target: edge.target,
                  })} onClick={() => removeSelectedLink(edge)}>×</button>}
              </div>)}
            </details>)}
            {selectedLink && selectedLink.ownerId !== ownerId && <div className="orchestration-map-meta">{t("map.otherOwner", { name: selectedLink.ownerId === MAIN_NODE_ID ? t("common.main") : selectedLink.ownerId })}</div>}
            {!canEdit && <p className="orchestration-map-hint">{t("map.readOnly")}</p>}
            {canEdit && !policy && <p className="orchestration-map-hint">{t("map.enableOrchestration")}</p>}
          </>}
          <details className="orchestration-map-resource-details">
            <summary>{t("main.builtInTools")} · {t("map.skills")} · {t("map.extensionTools")}</summary>
            <div className="orchestration-map-inspector-resources">
              <strong>{t("main.builtInTools")}</strong><span>{visibleBuiltInTools === undefined ? t("map.allAvailableLegacy")
                : visibleBuiltInTools.join(", ") || t("map.noneAssigned")}</span>
              <strong>{t("map.skills")}</strong><span>{visibleSkills === undefined ? t(legacySkills ? "map.allAvailableLegacy" : "map.noneAssigned") : visibleSkills.join(", ") || t("map.noneAssigned")}</span>
              <strong>{t("map.extensionTools")}</strong><span>{visibleTools === undefined ? t(legacyExtensions ? "map.allAvailableLegacy" : "map.noneAssigned")
                : visibleTools.map((tool) => `${tool.toolName} · ${tool.extensionPath}`).join(", ") || t("map.noneAssigned")}</span>
            </div>
          </details>
          <p className="orchestration-map-note">{t("map.layoutNote")}</p>
        </aside>
      </div>
    </section>
  );
}
