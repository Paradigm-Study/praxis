import type { DatabaseSync } from "node:sqlite";
import type { GraphEdge, GraphNode } from "../core/types.ts";
import { fromJsonObject, sensitiveText, strOrUndef, toJson } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface GraphStore {
  putNode(n: GraphNode): void;
  putEdge(e: GraphEdge): void;
  getNode(id: string): GraphNode | undefined;
  findNode(kind: string, label: string): GraphNode | undefined;
  nodes(): GraphNode[];
  edges(): GraphEdge[];
  /** Edges incident on a node (either direction). */
  incident(nodeId: string): GraphEdge[];
  hasEdge(from: string, to: string, kind: string): boolean;
  counts(): { nodes: number; edges: number };
}

function rowToNode(row: Record<string, unknown>, cipher?: StorageCipher): GraphNode {
  return {
    id: row.id as string,
    kind: row.kind as string,
    label: cipher?.decryptText(row.label, "graph_nodes.label") ?? (row.label as string),
    confidence: Number(row.confidence),
    claimId: strOrUndef(row.claim_id),
    data: fromJsonObject(row.data_json, cipher, "graph_nodes.data_json"),
    createdTs: row.created_ts as string,
    updatedTs: row.updated_ts as string,
  };
}

function rowToEdge(row: Record<string, unknown>, cipher?: StorageCipher): GraphEdge {
  return {
    id: row.id as string,
    from: row.from_id as string,
    to: row.to_id as string,
    kind: row.kind as string,
    data: fromJsonObject(row.data_json, cipher, "graph_edges.data_json"),
    createdTs: row.created_ts as string,
  };
}

export function makeGraphStore(db: DatabaseSync, cipher?: StorageCipher): GraphStore {
  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO graph_nodes
       (id, kind, label, confidence, claim_id, data_json, created_ts, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT OR REPLACE INTO graph_edges
       (id, from_id, to_id, kind, data_json, created_ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const nodeById = db.prepare(`SELECT * FROM graph_nodes WHERE id = ?`);
  const nodeByLabel = db.prepare(
    `SELECT * FROM graph_nodes WHERE kind = ? AND label = ? LIMIT 1`,
  );
  const edgeDup = db.prepare(
    `SELECT 1 FROM graph_edges WHERE from_id = ? AND to_id = ? AND kind = ? LIMIT 1`,
  );

  return {
    putNode(n) {
      insertNode.run(
        n.id,
        n.kind,
        sensitiveText(n.label, cipher, "graph_nodes.label"),
        n.confidence,
        n.claimId ?? null,
        n.data ? toJson(n.data, cipher, "graph_nodes.data_json") : null,
        n.createdTs,
        n.updatedTs,
      );
    },
    putEdge(e) {
      insertEdge.run(
        e.id,
        e.from,
        e.to,
        e.kind,
        e.data ? toJson(e.data, cipher, "graph_edges.data_json") : null,
        e.createdTs,
      );
    },
    getNode(id) {
      const row = nodeById.get(id) as Record<string, unknown> | undefined;
      return row ? rowToNode(row, cipher) : undefined;
    },
    findNode(kind, label) {
      const row = nodeByLabel.get(kind, sensitiveText(label, cipher, "graph_nodes.label")) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToNode(row, cipher) : undefined;
    },
    nodes() {
      const rows = db
        .prepare(`SELECT * FROM graph_nodes ORDER BY confidence DESC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToNode(row, cipher));
    },
    edges() {
      const rows = db
        .prepare(`SELECT * FROM graph_edges`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToEdge(row, cipher));
    },
    incident(nodeId) {
      const rows = db
        .prepare(`SELECT * FROM graph_edges WHERE from_id = ? OR to_id = ?`)
        .all(nodeId, nodeId) as Record<string, unknown>[];
      return rows.map((row) => rowToEdge(row, cipher));
    },
    hasEdge(from, to, kind) {
      return edgeDup.get(from, to, kind) !== undefined;
    },
    counts() {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM graph_nodes`).get() as {
        n: number;
      };
      const e = db.prepare(`SELECT COUNT(*) AS n FROM graph_edges`).get() as {
        n: number;
      };
      return { nodes: n.n, edges: e.n };
    },
  };
}
