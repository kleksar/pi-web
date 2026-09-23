"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentOrchestration } from "@/lib/subagents";
import {
  MAIN_NODE_ID,
  MAP_MIN_SCALE,
  MAP_NODE_HEIGHT,
  MAP_NODE_WIDTH,
  buildOrchestrationGraph,
  changeChildLink,
  changeDependencyLink,
  effectiveMapProfiles,
  findMapProfile,
  fitOrchestrationMap,
  mapPathFromMain,
  orchestrationForOwner,
  type MapEdge,
  type MapProfile,
  type OrchestrationMapLayer,
} from "@/lib/orchestration-map";
import "./OrchestrationMap.css";

interface MainMapNode {
  /** null/undefined is the older unrestricted Main policy. */
  orchestration?: SubagentOrchestration | null;
  selectedSkills?: readonly string[];
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
  canEdit?: boolean;
  onSelectOwner: (ownerId: string | null) => void;
  onOpenProfile?: (profileName: string) => void;
  onToggleChild?: (ownerId: string, childName: string, enabled: boolean, next: SubagentOrchestration) => void;
  onToggleDependency?: (ownerId: string, producerName: string, consumerName: string, enabled: boolean, next: SubagentOrchestration) => void;
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

function layoutStorageKey(cwd: string, ownerId: string | null, layer: OrchestrationMapLayer): string {
  return `pi-web:orchestration-map-layout:${cwd}:${ownerId ?? "overview"}:${layer}`;
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

function edgePath(source: Point, target: Point, offset = 0): string {
  const x1 = source.x + MAP_NODE_WIDTH;
  const y1 = source.y + MAP_NODE_HEIGHT / 2;
  const x2 = target.x;
  const y2 = target.y + MAP_NODE_HEIGHT / 2;
  if (x2 <= x1 + 36) {
    const bendY = Math.max(y1, y2) + 96 + offset;
    return `M ${x1} ${y1} C ${x1 + 65} ${bendY}, ${x2 - 65} ${bendY}, ${x2} ${y2}`;
  }
  const half = Math.max(60, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + half} ${y1 + offset}, ${x2 - half} ${y2 + offset}, ${x2} ${y2}`;
}

export function OrchestrationMap({
  cwd, profiles: sources, main, ownerId, draftOrchestration, canEdit = false,
  onSelectOwner, onOpenProfile, onToggleChild, onToggleDependency,
}: OrchestrationMapProps) {
  const { t } = useI18n();
  const [layer, setLayer] = useState<OrchestrationMapLayer>("delegation");
  const [query, setQuery] = useState("");
  const [selectedNode, setSelectedNode] = useState<string>(MAIN_NODE_ID);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  const [producer, setProducer] = useState("");
  const [consumer, setConsumer] = useState("");
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEW);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const profiles = useMemo(() => effectiveMapProfiles(sources), [sources]);
  const policy = ownerId === null ? null : orchestrationForOwner(ownerId, profiles, main.orchestration ?? null, ownerId, draftOrchestration);
  const graph = useMemo(() => buildOrchestrationGraph({ profiles, main: main.orchestration ?? null, ownerId, draft: draftOrchestration, layer, query }),
    [profiles, main.orchestration, ownerId, draftOrchestration, layer, query]);
  const storageKey = layoutStorageKey(cwd, ownerId, layer);
  const nodes = useMemo(() => graph.nodes.map((node) => ({ ...node, ...(positions[node.id] ?? {}) })), [graph.nodes, positions]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const path = useMemo(() => ownerId === null ? [] : mapPathFromMain(ownerId, profiles, main.orchestration ?? null), [ownerId, profiles, main.orchestration]);
  const selected = selectedNode === MAIN_NODE_ID ? null : findMapProfile(profiles, selectedNode);
  const visibleSkills = selectedNode === MAIN_NODE_ID ? main.selectedSkills : selected?.selectedSkills;
  const visibleTools = selectedNode === MAIN_NODE_ID ? main.selectedExtensionTools : selected?.selectedExtensionTools;
  const legacySkills = selectedNode === MAIN_NODE_ID ? main.loadSkills ?? true : selected?.loadSkills;
  const legacyExtensions = selectedNode === MAIN_NODE_ID ? main.loadExtensions ?? true : selected?.loadExtensions;
  const selectedLink = graph.edges.find((edge) => edgeId(edge) === selectedEdge);
  const relatedOverviewEdges = ownerId === null
    ? graph.edges.filter((edge) => edge.source === selectedNode || edge.target === selectedNode)
    : [];
  const overlapOffsets = useMemo(() => {
    const groups = new Map<string, MapEdge[]>();
    for (const edge of graph.edges) {
      const pair = `${edge.source}\u0000${edge.target}`;
      const group = groups.get(pair) ?? [];
      group.push(edge);
      groups.set(pair, group);
    }
    const offsets = new Map<string, number>();
    for (const group of groups.values()) {
      group.forEach((edge, index) => offsets.set(edgeId(edge), Math.max(-120, Math.min(120, (index - (group.length - 1) / 2) * 40))));
    }
    return offsets;
  }, [graph.edges]);
  const canChange = canEdit && ownerId !== null && policy !== null
    && (layer === "delegation" ? Boolean(onToggleChild) : Boolean(onToggleDependency));
  const candidates = profiles.filter((profile) => profile.enabled && !profile.configurationError
    && profile.name.toLowerCase() !== ownerId?.toLowerCase()
    && !policy?.allowedChildren.some((name) => name.toLowerCase() === profile.name.toLowerCase()));

  const fit = useCallback((currentNodes = graph.nodes) => {
    const element = stage.current;
    if (!element || !currentNodes.length) return;
    const { width, height } = element.getBoundingClientRect();
    const next = fitOrchestrationMap(currentNodes, width, height, ownerId ?? MAIN_NODE_ID);
    if (next) setViewport(next);
  }, [graph.nodes, ownerId]);

  useEffect(() => {
    const restored = readLayout(storageKey);
    setPositions(restored);
    fit(graph.nodes.map((node) => ({ ...node, ...(restored[node.id] ?? {}) })));
    setSelectedEdge(null);
    setConnectionSource(null);
    setError(null);
  }, [storageKey, fit, graph.nodes]);

  useEffect(() => { setSelectedNode(ownerId ?? MAIN_NODE_ID); }, [ownerId]);

  useEffect(() => {
    if (!nodeById.has(selectedNode)) setSelectedNode(ownerId ?? MAIN_NODE_ID);
  }, [nodeById, ownerId, selectedNode]);

  const savePositions = (next: Record<string, Point>) => {
    setPositions(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Layout is optional. */ }
  };

  const zoom = (factor: number) => {
    const element = stage.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setViewport((previous) => {
      const scale = Math.max(MAP_MIN_SCALE, Math.min(MAX_SCALE, previous.scale * factor));
      const ratio = scale / previous.scale;
      return { x: width / 2 - (width / 2 - previous.x) * ratio,
        y: height / 2 - (height / 2 - previous.y) * ratio, scale };
    });
  };

  const wheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08);
  };

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
    savePositions({ ...positions, [id]: { x: node.x + dx, y: node.y + dy } });
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
    if (!canChange || !policy || ownerId === null) return;
    const result = changeChildLink(ownerId, policy, child, enabled, profiles);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    onToggleChild?.(ownerId, child, enabled, result.next);
  };

  const updateDependency = (from: string, to: string, enabled: boolean) => {
    if (!canChange || !policy || ownerId === null) return;
    const result = changeDependencyLink(policy, from, to, enabled);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    onToggleDependency?.(ownerId, from, to, enabled, result.next);
  };

  const chooseConnector = (id: string) => {
    if (!canChange || layer !== "dependencies" || id === ownerId) return;
    if (!connectionSource) { setConnectionSource(id); setSelectedNode(id); return; }
    if (connectionSource === id) { setConnectionSource(null); return; }
    updateDependency(connectionSource, id, true);
    setConnectionSource(null);
  };

  const removeSelectedLink = (edge: MapEdge) => {
    if (edge.ownerId !== ownerId) return;
    if (edge.kind === "delegation") updateChild(edge.target, false);
    else updateDependency(edge.source, edge.target, false);
    setSelectedEdge(null);
  };

  return (
    <section className="orchestration-map" aria-label={t("map.title")}>
      <div className="orchestration-map-toolbar">
        <div className="orchestration-map-breadcrumbs" aria-label={t("map.path")}>
          <button type="button" aria-current={ownerId === null ? "page" : undefined} onClick={() => onSelectOwner(null)}>{t("map.allAgents")}</button>
          {path.map((id) => <span key={id} className="orchestration-map-crumb"><span aria-hidden="true">›</span>
            <button type="button" aria-current={ownerId === id ? "page" : undefined} onClick={() => onSelectOwner(id)}>
              {id === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, id)?.displayName ?? id}
            </button>
          </span>)}
        </div>
        <div className="orchestration-map-controls">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("map.search")} placeholder={t("map.searchPlaceholder")} />
          <button type="button" onClick={() => zoom(1.2)} aria-label={t("map.zoomIn")}>＋</button>
          <button type="button" onClick={() => zoom(1 / 1.2)} aria-label={t("map.zoomOut")}>−</button>
          <button type="button" onClick={() => fit(nodes)} aria-label={t("map.fit")}>{t("map.fitShort")}</button>
          <button type="button" onClick={() => { savePositions({}); fit(graph.nodes); }} title={t("map.arrange")}>{t("map.arrangeShort")}</button>
        </div>
      </div>
      <div className="orchestration-map-layers" role="group" aria-label={t("map.layers")}>
        <button type="button" aria-pressed={layer === "delegation"} onClick={() => setLayer("delegation")}>{t("map.delegation")}</button>
        <button type="button" aria-pressed={layer === "dependencies"} onClick={() => setLayer("dependencies")}>{t("map.dependencies")}</button>
        <span>{ownerId === null ? t("map.fullRoster") : t("map.directAgents", { count: policy?.allowedChildren.length ?? 0 })}</span>
      </div>
      <div className="orchestration-map-body">
        <div className="orchestration-map-stage" ref={stage} onWheel={wheelZoom} onPointerDown={panStart}
          onPointerMove={panMove} onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }} aria-label={t("map.graph")}>
          <div className="orchestration-map-canvas" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
            <svg className="orchestration-map-edges" width="100%" height="100%" aria-hidden="true">
              <defs><marker id="orchestration-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" /></marker></defs>
              {graph.edges.map((edge) => {
                const source = nodeById.get(edge.source);
                const target = nodeById.get(edge.target);
                if (!source || !target) return null;
                const d = edgePath(source, target, overlapOffsets.get(edgeId(edge)) ?? 0);
                return <g key={edgeId(edge)}>
                  <path className={`orchestration-map-edge${selectedEdge === edgeId(edge) ? " is-selected" : ""}`} d={d} markerEnd="url(#orchestration-map-arrow)" />
                  <path className="orchestration-map-edge-target" d={d} onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); }} />
                </g>;
              })}
            </svg>
            {nodes.map((node) => <div key={node.id}
              className={`orchestration-map-node is-${node.kind}${node.enabled ? "" : " is-disabled"}${selectedNode === node.id ? " is-selected" : ""}`}
              style={{ left: node.x, top: node.y }}>
              <button type="button" className="orchestration-map-node-face" aria-label={t("map.inspect", { name: node.id === MAIN_NODE_ID ? t("common.main") : node.label })}
                aria-pressed={selectedNode === node.id} onClick={() => { setSelectedNode(node.id); setSelectedEdge(null); }}>
                <span className="orchestration-map-node-kind">{t(node.kind === "main" ? "map.kindMain" : node.kind === "orchestrator" ? "map.kindOrchestrator" : node.kind === "missing" ? "map.kindMissing" : "map.kindAgent")}</span>
                <strong title={node.id === MAIN_NODE_ID ? t("common.main") : node.label}>{node.id === MAIN_NODE_ID ? t("common.main") : node.label}</strong>
                <small title={node.id}>{node.scope ? `${t(`agents.scope.${node.scope}`)} · ` : ""}{node.id === MAIN_NODE_ID ? t("common.main") : node.id}</small>
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
                  drag.current.last = next;
                  setPositions((previous) => ({ ...previous, [node.id]: next }));
                }}
                onPointerUp={() => {
                  if (drag.current?.type !== "node" || drag.current.id !== node.id) return;
                  savePositions({ ...positions, [node.id]: drag.current.last });
                  drag.current = null;
                }} onPointerCancel={() => { drag.current = null; }}>⠿</button>
              {node.kind === "orchestrator" || node.kind === "main" ? <button type="button" className="orchestration-map-node-open"
                aria-label={t("map.openNamedBranch", { name: node.id === MAIN_NODE_ID ? t("common.main") : node.label })} title={t("map.openBranch")} onClick={() => onSelectOwner(node.id)}>↗</button> : null}
              {layer === "dependencies" && ownerId !== null && node.id !== ownerId && canChange ?
                <button type="button" className={`orchestration-map-node-port${connectionSource === node.id ? " is-active" : ""}`}
                  aria-label={connectionSource ? t("map.consumerPort", { name: node.label, source: connectionSource }) : t("map.prerequisitePort", { name: node.label })}
                  title={t("map.dependencyHint")} onClick={() => chooseConnector(node.id)}>●</button> : null}
            </div>)}
          </div>
          {query.trim() && graph.matchCount === 0 ? <div className="orchestration-map-empty" role="status">{t("map.noMatches")}</div> : null}
        </div>
        <aside className="orchestration-map-inspector" aria-label={t("map.details")}>
          <h3>{selectedNode === MAIN_NODE_ID ? t("common.main") : selected?.displayName ?? selectedNode}</h3>
          {selectedNode !== MAIN_NODE_ID && selected && <>
            <div className="orchestration-map-meta">{t(`agents.scope.${selected.scope}`)} · {t(selected.enabled ? "map.statusEnabled" : "map.statusDisabled")}{selected.orchestration ? ` · ${t("map.kindOrchestrator")}` : ""}</div>
            <p>{selected.description || t("map.noDescription")}</p>
            <button type="button" onClick={() => onOpenProfile?.(selected.name)} disabled={!onOpenProfile}>{t("map.openProfile")}</button>
            {selected.orchestration && <button type="button" onClick={() => onSelectOwner(selected.name)}>{t("map.openBranch")}</button>}
          </>}
          {selectedNode !== MAIN_NODE_ID && !selected && <p>{t("map.missingProfile")}</p>}
          {selectedNode === MAIN_NODE_ID && <p>{main.orchestration == null ? t("map.rootLegacy") : t("map.rootConfigured", { count: main.orchestration.allowedChildren.length })}</p>}
          <div className="orchestration-map-inspector-resources">
            <strong>{t("map.skills")}</strong><span>{visibleSkills === undefined ? t(legacySkills ? "map.allAvailableLegacy" : "map.noneAssigned") : visibleSkills.join(", ") || t("map.noneAssigned")}</span>
            <strong>{t("map.extensionTools")}</strong><span>{visibleTools === undefined ? t(legacyExtensions ? "map.allAvailableLegacy" : "map.noneAssigned")
              : visibleTools.map((tool) => `${tool.toolName} · ${tool.extensionPath}`).join(", ") || t("map.noneAssigned")}</span>
          </div>
          <h4>{t(layer === "delegation" ? "map.directDelegates" : "map.requiredResults")}</h4>
          {ownerId === null ? <>
            {relatedOverviewEdges.length > 0 && <div className="orchestration-map-overview-links" role="group" aria-label={t(layer === "delegation" ? "map.directDelegates" : "map.requiredResults")}>
              {relatedOverviewEdges.map((edge) => {
                const ownerName = edge.ownerId === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.ownerId)?.displayName ?? edge.ownerId;
                const sourceName = edge.source === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.source)?.displayName ?? edge.source;
                const targetName = findMapProfile(profiles, edge.target)?.displayName ?? edge.target;
                return <button key={edgeId(edge)} type="button" aria-pressed={selectedEdge === edgeId(edge)}
                  onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); }}>
                  <span>{t("map.overviewOwner", { name: ownerName })}</span>
                  <strong>{sourceName} → {targetName}</strong>
                </button>;
              })}
            </div>}
            {selectedLink && <div className="orchestration-map-overview-link">
              <p>{t("map.overviewOwner", { name: selectedLink.ownerId === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, selectedLink.ownerId)?.displayName ?? selectedLink.ownerId })}</p>
              <button type="button" onClick={() => onSelectOwner(selectedLink.ownerId)}>{t("map.openItsBranch")}</button>
            </div>}
            <p>{t("map.selectToEdit")}</p>
          </> : <>
            <p className="orchestration-map-hint">{t(layer === "delegation" ? "map.delegateHint" : "map.dependencyHint")}</p>
            {ownerId === MAIN_NODE_ID && main.orchestration == null && <p className="orchestration-map-legacy-note">
              {t("map.legacyWarning")}
            </p>}
            {graph.edges.filter((edge) => edge.ownerId === ownerId).map((edge) => <div key={edgeId(edge)}
              className={`orchestration-map-link${selectedEdge === edgeId(edge) ? " is-selected" : ""}`}>
              <button type="button" onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedNode(edge.target); }}>
                {edge.source === MAIN_NODE_ID ? t("common.main") : findMapProfile(profiles, edge.source)?.displayName ?? edge.source}
                <span aria-hidden="true"> → </span>{findMapProfile(profiles, edge.target)?.displayName ?? edge.target}
              </button>
              {canChange && <button type="button" aria-label={t("map.removeLink", { source: edge.source === MAIN_NODE_ID ? t("common.main") : edge.source, target: edge.target })}
                title={t("map.removeLink", { source: edge.source === MAIN_NODE_ID ? t("common.main") : edge.source, target: edge.target })} onClick={() => removeSelectedLink(edge)}>×</button>}
            </div>)}
            {selectedLink && selectedLink.ownerId !== ownerId && <div className="orchestration-map-meta">{t("map.otherOwner", { name: selectedLink.ownerId === MAIN_NODE_ID ? t("common.main") : selectedLink.ownerId })}</div>}
            {canChange && layer === "delegation" && <form className="orchestration-map-add" onSubmit={(event) => { event.preventDefault(); if (candidate) { updateChild(candidate, true); setCandidate(""); } }}>
              <label htmlFor="orchestration-map-candidate">{t("map.addDirectAgent")}</label>
              <select id="orchestration-map-candidate" value={candidate} onChange={(event) => setCandidate(event.target.value)}>
                <option value="">{t("map.chooseAgent")}</option>{candidates.map((profile) => <option key={profile.name} value={profile.name}>{profile.displayName} ({profile.name})</option>)}
              </select><button type="submit" disabled={!candidate}>{t("map.addLink")}</button>
            </form>}
            {canChange && layer === "dependencies" && <form className="orchestration-map-add" onSubmit={(event) => {
              event.preventDefault(); if (producer && consumer) updateDependency(producer, consumer, true);
            }}>
              <label htmlFor="orchestration-map-producer">{t("map.producer")}</label>
              <select id="orchestration-map-producer" value={producer} onChange={(event) => setProducer(event.target.value)}>
                <option value="">{t("map.chooseProducer")}</option>{policy?.allowedChildren.map((name) => <option key={name} value={name}>{findMapProfile(profiles, name)?.displayName ?? name}</option>)}
              </select>
              <label htmlFor="orchestration-map-consumer">{t("map.consumer")}</label>
              <select id="orchestration-map-consumer" value={consumer} onChange={(event) => setConsumer(event.target.value)}>
                <option value="">{t("map.chooseConsumer")}</option>{policy?.allowedChildren.map((name) => <option key={name} value={name}>{findMapProfile(profiles, name)?.displayName ?? name}</option>)}
              </select><button type="submit" disabled={!producer || !consumer}>{t("map.addRequirement")}</button>
            </form>}
            {!canEdit && <p className="orchestration-map-hint">{t("map.readOnly")}</p>}
            {canEdit && !policy && <p className="orchestration-map-hint">{t("map.enableOrchestration")}</p>}
          </>}
          {error && <p role="alert" className="orchestration-map-error">{ERROR_KEYS[error] ? t(ERROR_KEYS[error]) : error}</p>}
          <p className="orchestration-map-note">{t("map.layoutNote")}</p>
        </aside>
      </div>
    </section>
  );
}
