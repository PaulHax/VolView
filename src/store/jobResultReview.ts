// Live-session review state for auto-shown job results (contract Seam 2; D6;
// Chunk 22).
//
// A validated result is BORN-PERSISTENT (decisions.md D6 "Review UX", 2026-07-04
// in-flight call): it is applied as a NORMAL, deletable segment group governed by
// the EXISTING visibility/delete UI — there is NO confirm/reject state machine and
// NO promotion field on the group. Deletability alone answers "no undo". The only
// review cue is a COSMETIC, LIVE-SESSION-ONLY badge ("new job result") on the
// freshly-attached group; this store holds exactly that badge set and nothing
// else.
//
// Deliberately NOT serialized — it never enters the `.volview.zip` (the badge is
// live-only, per the chunk). A page reload starts with an empty set. A
// re-discovered (tier-2) group is badged only when it is FRESHLY re-attached; a
// session-restored group is skipped by the scene-state idempotency guard in the
// applier, so it is never re-badged.
//
// House rules: functional style; `type`, not `interface`.

import { defineStore } from 'pinia';
import { reactive } from 'vue';

export const useJobResultReviewStore = defineStore('jobResultReview', () => {
  // Segment-group ids freshly auto-shown from a job result THIS session. A
  // reactive Set so the badge in SegmentGroupControls reacts to mark/dismiss.
  const newResultGroupIds = reactive(new Set<string>());

  // Badge a freshly auto-shown result group as new (the provisional review cue).
  const markNew = (id: string) => {
    newResultGroupIds.add(id);
  };

  // Drop the badge — e.g. the group was deleted, or the user acknowledged the
  // cue. Dismissing the badge NEVER deletes the group; the group is a normal
  // object and outlives its badge.
  const dismiss = (id: string) => {
    newResultGroupIds.delete(id);
  };

  const isNew = (id: string) => newResultGroupIds.has(id);

  const clear = () => {
    newResultGroupIds.clear();
  };

  return { newResultGroupIds, markNew, dismiss, isNew, clear };
});
