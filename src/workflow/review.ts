import type { Correction, Episode } from "../core/types.ts";
import type { ClaimCandidate } from "../memory/claims.ts";
import { isHumanCorrection } from "../memory/consolidate.ts";
import type { Store } from "../storage/index.ts";

export const WORKFLOW_REVIEW_NOTE = "paradigm.workflow.review.v1";
export const WORKFLOW_REVIEW_SCHEMA = "paradigm.workflow.review.v1";

const MAX_REVIEW_BYTES = 64 * 1024;
const MAX_REVIEW_STEPS = 200;

export type WorkflowActor = "person" | "agent" | "system" | "unknown";

export interface WorkflowReviewStep {
  id: string;
  title: string;
  detail?: string;
  actor: WorkflowActor;
}

export interface WorkflowReviewPayload {
  schema: typeof WORKFLOW_REVIEW_SCHEMA;
  title: string;
  intent?: string;
  steps: WorkflowReviewStep[];
}

export interface ResolvedWorkflowReview {
  reviewed: boolean;
  correction?: Correction;
  review?: WorkflowReviewPayload;
  candidate?: ClaimCandidate;
}

function normalizedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** Parse the renderer's versioned, human-reviewed workflow envelope. */
export function parseWorkflowReview(value: unknown): WorkflowReviewPayload | undefined {
  let source = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_REVIEW_BYTES) return undefined;
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const raw = source as Record<string, unknown>;
  const title = normalizedText(raw.title, 240);
  if (
    raw.schema !== WORKFLOW_REVIEW_SCHEMA ||
    !title ||
    !Array.isArray(raw.steps) ||
    raw.steps.length < 1 ||
    raw.steps.length > MAX_REVIEW_STEPS
  ) return undefined;

  const steps: WorkflowReviewStep[] = [];
  const ids = new Set<string>();
  for (const candidate of raw.steps) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const step = candidate as Record<string, unknown>;
    const id = normalizedText(step.id, 160);
    const stepTitle = normalizedText(step.title, 240);
    if (
      !id ||
      !stepTitle ||
      ids.has(id) ||
      (step.actor !== "person" && step.actor !== "agent" && step.actor !== "system" && step.actor !== "unknown")
    ) return undefined;
    ids.add(id);
    const detail = normalizedText(step.detail, 2_000);
    steps.push({ id, title: stepTitle, ...(detail ? { detail } : {}), actor: step.actor });
  }

  const intent = normalizedText(raw.intent, 1_000);
  return {
    schema: WORKFLOW_REVIEW_SCHEMA,
    title,
    ...(intent ? { intent } : {}),
    steps,
  };
}

export function latestWorkflowCorrection(
  store: Store,
  episodeId: string,
): Correction | undefined {
  return store.corrections
    .byTarget(episodeId)
    .filter(
      (item) =>
        item.targetKind === "episode"
        && item.note === WORKFLOW_REVIEW_NOTE
        && isHumanCorrection(item),
    )
    .at(-1);
}

function claimStepTitle(value: string): string {
  return value.replace(/\s*(?:→|->)\s*/g, " then ").replace(/\s+/g, " ").trim();
}

/**
 * Resolve the latest human verdict for an episode. A valid confirmation/edit
 * replaces the heuristic workflow candidate; rejection suppresses it.
 */
export function resolveWorkflowReview(store: Store, episode: Episode): ResolvedWorkflowReview {
  return resolveWorkflowReviewCorrection(
    episode,
    latestWorkflowCorrection(store, episode.id),
  );
}

/** Resolve a workflow review from an already-loaded correction snapshot. */
export function resolveWorkflowReviewCorrection(
  episode: Episode,
  correction: Correction | undefined,
): ResolvedWorkflowReview {
  if (!correction || !isHumanCorrection(correction)) return { reviewed: false };
  if (correction.verdict === "rejected") return { reviewed: true, correction };
  const review = parseWorkflowReview(correction.correctedText);
  if (!review) return { reviewed: false };
  const text = `Workflow: ${review.steps.map((step) => claimStepTitle(step.title)).join(" → ")}`;
  return {
    reviewed: true,
    correction,
    review,
    candidate: {
      kind: "workflow_pattern",
      text,
      confidence: correction.verdict === "edited" ? 0.99 : 0.97,
      episodeId: episode.id,
      day: episode.startTs.slice(0, 10),
      provenance: "human_reviewed",
    },
  };
}

/** Most recently reviewed, non-rejected workflow; used as the playbook override. */
export function latestAcceptedWorkflowReview(store: Store): ResolvedWorkflowReview | undefined {
  let latest: ResolvedWorkflowReview | undefined;
  for (const episode of store.episodes.all()) {
    const resolved = resolveWorkflowReview(store, episode);
    if (!resolved.review || !resolved.correction) continue;
    const left = resolved.correction;
    const right = latest?.correction;
    if (
      !right ||
      left.createdTs > right.createdTs ||
      (left.createdTs === right.createdTs && left.id > right.id)
    ) latest = resolved;
  }
  return latest;
}
