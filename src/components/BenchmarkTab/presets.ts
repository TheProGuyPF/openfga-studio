// Depth-ladder presets derived from the mx-authorization stable model.
//
// Each rung is strictly deeper than the last, so a "slow-when-deep in EVERY env"
// signal implicates the model, while "slow-in-one-env" implicates the deployment.
// The referenced IDs/user come from the shared seed definition in seedData.ts.
import type { BenchScenario } from './types';
import { PROBE_USER, SEED_IDS } from './seedData';

export { PROBE_USER, SEED_IDS };

/** A user with NO seeded grants — used for negative (denied) rungs. */
export const ABSENT_USER = 'user:__bench_absent';

/**
 * The near-zero-cost baseline probe: a check against IDs that don't exist, so
 * OpenFGA resolves quickly with minimal datastore work. Its p50 is the per-env
 * network+auth floor we subtract from real scenarios.
 */
export const BASELINE_PROBE: BenchScenario = {
  id: 'baseline',
  label: 'baseline (network floor)',
  depth: -1,
  user: 'user:__bench_absent',
  relation: 'admin',
  object: 'institution:__bench_absent',
  note: 'Nonexistent IDs — measures network + auth + minimal server work.',
};

export const DEPTH_LADDER: BenchScenario[] = [
  {
    id: 'institution-admin',
    label: 'institution.admin',
    depth: 0,
    user: PROBE_USER,
    relation: 'admin',
    object: SEED_IDS.institution,
    note: 'Direct assignment — shallowest.',
  },
  {
    id: 'team-can_read',
    label: 'team.can_read',
    depth: 1,
    user: PROBE_USER,
    relation: 'can_read',
    object: SEED_IDS.team,
    note: 'team_reader via 1 TTU hop from parent_institution.',
  },
  {
    id: 'task-can_read',
    label: 'task.can_read',
    depth: 2,
    user: PROBE_USER,
    relation: 'can_read',
    object: SEED_IDS.task,
    note: 'task_reader from institution + task_type link.',
  },
  {
    id: 'assessment-can_read',
    label: 'assessment.can_read',
    depth: 3,
    user: PROBE_USER,
    relation: 'can_read',
    object: SEED_IDS.assessment,
    note: 'assessment → template → template_group (multi-hop TTU).',
  },
  {
    id: 'document-can_read',
    label: 'document.can_read',
    depth: 4,
    user: PROBE_USER,
    relation: 'can_read',
    object: SEED_IDS.document,
    note: 'Intersection: parent_note.can_read AND institution.document_reader.',
  },
  {
    id: 'recyclebin-can_read',
    label: 'recycle_bin_entry.can_read',
    depth: 5,
    user: PROBE_USER,
    relation: 'can_read',
    object: SEED_IDS.recycleBin,
    note: 'Deepest: recycle_bin → document → note → assessment → institution, nested intersections.',
  },
  // Institution-level "blanket" check — a very common production shape.
  {
    id: 'institution-document_reader',
    label: 'institution.document_reader (blanket)',
    depth: 6,
    user: PROBE_USER,
    relation: 'document_reader',
    object: SEED_IDS.institution,
    note: 'Blanket institution-level permission check (union over [user, role#assignee]).',
  },
  // Negative rungs — resolve DENIED. No positive short-circuit, so the resolver
  // must exhaust the union/role usersets before concluding false. At higher
  // cardinality this is where scanning cost shows up.
  {
    id: 'institution-recycle_bin_reader-neg',
    label: 'institution.recycle_bin_reader (negative)',
    depth: 6,
    user: ABSENT_USER,
    relation: 'recycle_bin_reader',
    object: SEED_IDS.institution,
    expectDenied: true,
    note: 'Denied blanket check — scans all role#assignee grants + editor/deleter branches.',
  },
  {
    id: 'recyclebin-can_read-neg',
    label: 'recycle_bin_entry.can_read (negative)',
    depth: 5,
    user: ABSENT_USER,
    relation: 'can_read',
    object: SEED_IDS.recycleBin,
    expectDenied: true,
    note: 'Denied user→resource check down the deepest chain.',
  },
  // list-objects — "what can this user reach?" Enumerates objects, so its cost
  // scales with object cardinality (the sibling objects seeded at medium/large).
  {
    id: 'list-documents',
    label: 'list documents (can_read)',
    depth: 4,
    op: 'list-objects',
    user: PROBE_USER,
    relation: 'can_read',
    object: '',
    listType: 'document',
    note: 'list-objects over the document type — cost grows with object count.',
  },
  {
    id: 'list-assessments',
    label: 'list assessments (can_read)',
    depth: 3,
    op: 'list-objects',
    user: PROBE_USER,
    relation: 'can_read',
    object: '',
    listType: 'assessment',
    note: 'list-objects over the assessment type.',
  },
];
