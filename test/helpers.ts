import { openStore, type Store } from "../src/storage/index.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { replay } from "../src/capture/sources/synthetic.ts";
import { codexSessionEvents } from "../src/fixtures/codexSession.ts";
import { followupSessionEvents } from "../src/fixtures/followupSession.ts";
import { reconstruct } from "../src/reconstructor/reconstructor.ts";
import { fuse } from "../src/fuser/fuser.ts";
import { buildGraph, type GraphResult } from "../src/memory/graph.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { ActionEvent, Episode } from "../src/core/types.ts";

export function freshStore(): Store {
  return openStore({ memory: true });
}

export async function ingestFixtures(store: Store, followup = true): Promise<void> {
  const ingest = makeIngest(store);
  await replay(codexSessionEvents(), ingest.ingest);
  if (followup) await replay(followupSessionEvents(), ingest.ingest);
}

export interface Pipeline {
  store: Store;
  newId: (p: string) => string;
  actions: ActionEvent[];
  episodes: Episode[];
  graph: GraphResult;
}

export async function fullPipeline(followup = true): Promise<Pipeline> {
  const store = freshStore();
  const newId = makeSeededIdGen();
  await ingestFixtures(store, followup);
  const actions = reconstruct(store, { newId });
  const episodes = fuse(store, { newId });
  const graph = buildGraph(store, { newId, now: "2026-06-09T10:00:00.000Z" });
  return { store, newId, actions, episodes, graph };
}

/** Build a synthetic action for unit tests. */
export function action(partial: Partial<ActionEvent> & { action: string; startTs: string }): ActionEvent {
  return {
    id: partial.id ?? `act_${partial.startTs}`,
    type: "user_action",
    action: partial.action,
    app: partial.app ?? "App",
    startTs: partial.startTs,
    endTs: partial.endTs ?? partial.startTs,
    text: partial.text,
    confidence: partial.confidence ?? 0.9,
    evidence: partial.evidence ?? ["ev"],
    uncertainty: partial.uncertainty,
    payload: partial.payload,
  };
}
