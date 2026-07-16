// Máquina de estados editorial (pura, testável). Adaptada de
// spa-sapienza/lib/content/state-machine.ts.
// draft → in_review → scheduled → published → archived; volta a draft em edição.

export type ContentStatus = "draft" | "in_review" | "scheduled" | "published" | "archived"

export const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["in_review", "published"],
  in_review: ["scheduled", "published", "draft"],
  scheduled: ["published", "draft"],
  published: ["archived", "draft"],
  archived: ["draft"],
}

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function allowedTransitions(from: ContentStatus): ContentStatus[] {
  return TRANSITIONS[from] ?? []
}

export class TransitionError extends Error {}
