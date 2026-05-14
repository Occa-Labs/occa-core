"use client";

// React Flow-based org chart. Renders one box per agent, edges from
// child → parent via deployment.parent_agent_index. Auto-layouts the
// tree top-down via dagre. Built-in pan, zoom, mini-map.
//
// Drag-drop reparent is intentionally NOT wired here — Phase 2 keeps
// reassignment in the per-agent Settings tab. Adding it later is a
// matter of handling `onNodesChange` + position swaps; the canvas
// itself is already drag-capable.

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
} from "@xyflow/react";
import dagre from "dagre";
import { Pause } from "lucide-react";
import { formatRoleLabel } from "@/lib/format-role";
import type { AgentDTO } from "@occa/shared/types";
import { getTier } from "@occa/shared/role-catalog";

import "@xyflow/react/dist/style.css";

// Node box geometry — fed to dagre for layout and to React Flow for
// hit-testing. Keep in sync with the actual rendered CSS.
const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;

// Spacing between siblings (horizontal) and tiers (vertical). Tuned so
// 3-tier chart fits a 720px window without zoom-out.
const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 64;

interface AgentNodeData extends Record<string, unknown> {
  agent: AgentDTO;
  isSelected: boolean;
}

type AgentNodeType = Node<AgentNodeData>;

function AgentBoxNode({ data }: NodeProps<AgentNodeType>) {
  const { agent, isSelected } = data;
  const tier = getTier(agent.role) ?? "specialist";
  const isHead = tier === "ceo" || tier === "head";
  const isPaused = agent.status === "paused";

  const tierColor = (() => {
    if (tier === "ceo") return "from-emerald-500/22 to-emerald-500/8 ring-emerald-400/40";
    if (tier === "head") return "from-emerald-500/15 to-emerald-500/4 ring-emerald-400/26";
    if (tier === "direct_report")
      return "from-sky-500/14 to-sky-500/4 ring-sky-400/22";
    return "from-white/10 to-white/4 ring-white/14";
  })();

  return (
    <div
      className={`relative bg-linear-to-br ${tierColor} ring-1 ring-inset rounded-xl px-3.5 py-2.5 transition-all ${
        isSelected ? "shadow-[0_0_0_2px_rgba(255,255,255,0.5)]" : ""
      } ${isPaused ? "opacity-55" : ""}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "transparent", border: 0, top: -1 }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className={`text-[13px] font-semibold truncate ${
              isHead ? "text-emerald-100/95" : "text-white/90"
            }`}
          >
            {agent.name}
          </div>
          <div className="text-[10.5px] text-white/55 truncate">
            {formatRoleLabel(agent.role)}
          </div>
        </div>
        {isPaused && (
          <span className="shrink-0 flex items-center gap-1 rounded-full bg-amber-500/18 px-1.5 py-0.5 text-[9px] font-medium text-amber-200/90 ring-1 ring-inset ring-amber-500/30">
            <Pause className="size-2.5" />
            paused
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${
            agent.connectionState === "connected"
              ? "bg-emerald-400"
              : agent.connectionState === "disconnected"
                ? "bg-red-400"
                : "bg-white/25"
          }`}
        />
        <span className="text-[10px] text-white/45 truncate">
          {agent.connectionState}
          {agent.activityState && agent.activityState !== "idle"
            ? ` · ${agent.activityState}`
            : ""}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "transparent", border: 0, bottom: -1 }}
      />
    </div>
  );
}

const nodeTypes = { agentBox: AgentBoxNode };

// Translate the flat agent list into a positioned node graph via dagre.
// Edges are child → parent (semantically) but dagre treats parent →
// child for layout direction, so we flip when feeding the graph.
function layoutAgents(args: {
  agents: AgentDTO[];
  selectedId: string | null;
}): { nodes: AgentNodeType[]; edges: Edge[] } {
  const { agents, selectedId } = args;
  if (agents.length === 0) return { nodes: [], edges: [] };

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    nodesep: HORIZONTAL_GAP,
    ranksep: VERTICAL_GAP,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const a of agents) {
    g.setNode(a.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const a of agents) {
    if (a.parentAgentId && agents.find((x) => x.id === a.parentAgentId)) {
      g.setEdge(a.parentAgentId, a.id);
    }
  }
  dagre.layout(g);

  const nodes: AgentNodeType[] = agents.map((a) => {
    const pos = g.node(a.id);
    return {
      id: a.id,
      type: "agentBox",
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { agent: a, isSelected: a.id === selectedId },
      draggable: false,
    };
  });

  const edges: Edge[] = agents
    .filter(
      (a) => a.parentAgentId && agents.find((x) => x.id === a.parentAgentId),
    )
    .map((a) => ({
      id: `${a.parentAgentId}->${a.id}`,
      source: a.parentAgentId as string,
      target: a.id,
      type: "smoothstep",
      animated: false,
      style: { stroke: "rgba(255,255,255,0.25)", strokeWidth: 1.5 },
    }));

  return { nodes, edges };
}

function OrgChartCanvasInner({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const initial = useMemo(
    () => layoutAgents({ agents, selectedId }),
    [agents, selectedId],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const hasInitiallyFit = useRef(false);

  // Re-layout when the underlying data changes (deploy/retire/reparent
  // triggers a refetch upstream). Without this the canvas freezes at
  // first render.
  useEffect(() => {
    const next = layoutAgents({ agents, selectedId });
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [agents, selectedId, setNodes, setEdges]);

  // Imperatively fit-to-view once React Flow has actually measured the
  // nodes' DOM dimensions. The `fitView` prop only fires on initial
  // render — when our useEffect-driven nodes haven't been measured
  // yet — so the camera lands wherever the first paint puts it
  // (often jammed to the top-left when nodes were absent at mount).
  //
  // `useNodesInitialized` flips to true after the internal ResizeObserver
  // reports widths/heights for every node, which is the exact moment
  // fitView can compute bounds correctly.
  //
  // Re-fit when the agent id set changes (deploy/retire/reparent) but
  // NOT on selection-only updates, which only mutate node data.
  const agentIdKey = useMemo(
    () => agents.map((a) => a.id).sort().join("|"),
    [agents],
  );
  useEffect(() => {
    if (!nodesInitialized || agents.length === 0) return;
    reactFlow.fitView({
      // Generous padding + capped maxZoom so a small graph (2-3 nodes)
      // doesn't blow each box up to fill the window. Without maxZoom
      // here React Flow zooms in past 1.0 to fit the bounding box,
      // making the tree feel cramped against the window edges.
      padding: 0.35,
      maxZoom: 0.85,
      duration: hasInitiallyFit.current ? 300 : 0,
    });
    hasInitiallyFit.current = true;
  }, [nodesInitialized, agentIdKey, agents.length, reactFlow]);

  const handleNodeClick = useCallback(
    (_: unknown, node: AgentNodeType) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
      fitView
      fitViewOptions={{ padding: 0.35, minZoom: 0.4, maxZoom: 0.85 }}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.05)" />
      <Controls
        position="bottom-right"
        showInteractive={false}
        className="bg-white/8! border! border-white/12! rounded-lg! overflow-hidden [&_button]:bg-transparent! [&_button]:border-white/12! [&_button:hover]:bg-white/10! [&_button_svg]:fill-white/70!"
      />
      <MiniMap
        position="bottom-left"
        pannable
        zoomable
        maskColor="rgba(0,0,0,0.4)"
        nodeColor="rgba(255,255,255,0.35)"
        style={{ background: "rgba(20,20,22,0.75)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}
      />
    </ReactFlow>
  );
}

export function OrgChartCanvas(props: {
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <OrgChartCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
