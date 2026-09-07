import type { Workflow, WorkflowNodeType } from "../domain/entities.js";

const kinds: WorkflowNodeType[] = ["agent", "tool", "condition", "approval", "parallel", "trigger", "webhook", "telegram"];

/** Validate the entire graph, including unreachable components, before any side effect. */
export function validateWorkflowGraph(workflow: Workflow): void {
  if (!Array.isArray(workflow.nodes) || !workflow.nodes.length || workflow.nodes.length > 256) throw new Error("Workflow needs 1–256 nodes");
  if (!Array.isArray(workflow.edges) || workflow.edges.length > 2048) throw new Error("Workflow may have at most 2048 edges");
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim() || ["__proto__", "constructor", "prototype"].includes(node.id) || ids.has(node.id)) throw new Error(`Invalid or duplicate workflow node id: ${node?.id}`);
    if (!kinds.includes(node.type)) throw new Error(`Unknown workflow node type: ${node.type}`);
    if (!node.config || typeof node.config !== "object" || Array.isArray(node.config)) throw new Error(`Invalid config for workflow node ${node.id}`);
    ids.add(node.id);
  }
  const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]));
  const edges = new Set<string>();
  for (const edge of workflow.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) throw new Error("Workflow edge references a missing node");
    const key = JSON.stringify([edge.from, edge.to, edge.condition ?? ""]);
    if (edges.has(key)) throw new Error("Duplicate workflow edge");
    if (edge.condition !== undefined && typeof edge.condition !== "string") throw new Error("Invalid workflow edge condition");
    edges.add(key);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    visited += 1;
    for (const next of outgoing.get(id)!) {
      incoming.set(next, incoming.get(next)! - 1);
      if (!incoming.get(next)) ready.push(next);
    }
  }
  if (visited !== ids.size) throw new Error("Workflow must be a DAG; a cycle was detected");
}
