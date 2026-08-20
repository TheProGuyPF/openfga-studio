// Shared benchmark seed definition — used by BOTH the in-app seeding flow
// (seedRunner.ts) and scripts/seed-benchmark-store.mjs. The .mjs script cannot
// import this TS module, so it duplicates the base chain + scale presets: KEEP
// THE TWO IN SYNC. This file is the source of truth.
//
// A known probe user resolves `allowed` through progressively deeper model paths:
//   institution.admin            (direct)
//   team.can_read                (1 TTU hop)
//   task.can_read                (TTU + task_type)
//   assessment.can_read          (assessment → template → template_group)
//   document.can_read            (intersection + parent_note chain)
//   recycle_bin_entry.can_read   (recycle_bin → document → note → assessment → institution)
//
// The BASE chain (Minimal) grants the probe directly, so the depth ladder always
// resolves and stays comparable across runs. Higher scales ADD cardinality on top
// (roles with many assignees, a team with many members, many sibling objects) so
// resolution and list-objects run over realistic data volume.

export const BENCHMARK_STORE_NAME = 'openfga-studio-benchmark';

/** Subject user seeded as allowed through every rung's intended (deep) path. */
export const PROBE_USER = 'user:__bench_probe';

/** Fixed seeded object IDs (the depth-ladder scenarios target these). */
export const SEED_IDS = {
  institution: 'institution:__bench',
  team: 'team:__bench_team',
  taskType: 'task_type:__bench_tt',
  task: 'task:__bench_task',
  group: 'assessment_template_group:__bench_g',
  template: 'assessment_template:__bench_t',
  assessment: 'assessment:__bench_a',
  note: 'note:__bench_note',
  document: 'document:__bench_doc',
  recycleBin: 'recycle_bin_entry:__bench_rb',
} as const;

export interface SeedTuple {
  user: string;
  relation: string;
  object: string;
}

/** Institution relations the probe needs granted directly. `admin` is `[user]` only. */
const INSTITUTION_GRANTS = [
  'admin',
  'team_reader',
  'task_reader',
  'note_reader',
  'document_reader',
  'recycle_bin_reader',
] as const;

/**
 * Relations grantable to a `role#assignee` userset — i.e. those whose model type
 * includes `role#assignee`. `admin` is excluded because `institution.admin` only
 * accepts `[user]`, so granting it to a userset is an invalid-type write (400).
 */
const ROLE_GRANTS = INSTITUTION_GRANTS.filter((r) => r !== 'admin');

/** The deterministic BASE deep-chain tuples (Minimal scale). */
export const BASE_SEED_TUPLES: SeedTuple[] = [
  // Institution-level direct grants for the probe (subject → relation → institution)
  ...INSTITUTION_GRANTS.map((relation) => ({
    user: PROBE_USER,
    relation,
    object: SEED_IDS.institution,
  })),

  // Structural parent_institution links (institution → parent_institution → child)
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.team },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.taskType },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.task },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.group },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.template },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.assessment },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.note },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.document },
  { user: SEED_IDS.institution, relation: 'parent_institution', object: SEED_IDS.recycleBin },

  // Structural chain links
  { user: SEED_IDS.taskType, relation: 'parent_task_type', object: SEED_IDS.task },
  { user: SEED_IDS.group, relation: 'parent_template_group', object: SEED_IDS.template },
  { user: SEED_IDS.template, relation: 'parent_template', object: SEED_IDS.assessment },
  { user: SEED_IDS.assessment, relation: 'parent_assessment', object: SEED_IDS.note },
  { user: SEED_IDS.note, relation: 'parent_note', object: SEED_IDS.document },
  { user: SEED_IDS.document, relation: 'parent_document', object: SEED_IDS.recycleBin },

  // Deep assessment grant: direct reader on the template GROUP forces
  // assessment.can_read to walk template → group (no institution shortcut).
  { user: PROBE_USER, relation: 'reader', object: SEED_IDS.group },
];

/** Back-compat alias — the base chain is the Minimal dataset. */
export const SEED_TUPLES = BASE_SEED_TUPLES;

export type ScaleName = 'minimal' | 'medium' | 'large';

export interface ScaleParams {
  /** Filler roles that also grant the institution relations via role#assignee. */
  roles: number;
  /** Filler user assignees per role (userset breadth). */
  assigneesPerRole: number;
  /** Members on the shared team (team#member userset breadth). */
  members: number;
  /** Sibling documents + assessments under the institution (breadth for list-objects). */
  objects: number;
}

export const SCALE_PRESETS: Record<ScaleName, { label: string; params: ScaleParams }> = {
  minimal: { label: 'Minimal — deep chain only', params: { roles: 0, assigneesPerRole: 0, members: 0, objects: 0 } },
  medium: { label: 'Medium — ~1k tuples', params: { roles: 15, assigneesPerRole: 25, members: 200, objects: 50 } },
  large: { label: 'Large — ~6k tuples', params: { roles: 60, assigneesPerRole: 50, members: 1500, objects: 300 } },
};

/** Estimate the tuple count for a scale (for UI display). */
export function estimateTupleCount(p: ScaleParams): number {
  return (
    BASE_SEED_TUPLES.length +
    p.roles * (1 + ROLE_GRANTS.length + 1 + 1 + p.assigneesPerRole) + // parent + grants + group + probe-assignee + fillers
    (p.members > 0 ? p.members + 2 : 0) + // members + probe-member + team-reader-on-assessment
    p.objects * 4 // 2 tuples each for a sibling document and a sibling assessment
  );
}

/**
 * Build the full seed tuple set for a scale: the base deep chain plus additive
 * cardinality (roles/assignees, team members, sibling objects).
 */
export function buildSeedTuples(p: ScaleParams): SeedTuple[] {
  const tuples: SeedTuple[] = [...BASE_SEED_TUPLES];

  // Filler roles: each grants the institution relations via its #assignee userset
  // (adds union operands the resolver may explore); probe is an assignee of each,
  // plus `assigneesPerRole` filler users to grow the userset.
  for (let r = 0; r < p.roles; r++) {
    const role = `role:__bench_role_${r}`;
    tuples.push({ user: SEED_IDS.institution, relation: 'parent_institution', object: role });
    for (const relation of ROLE_GRANTS) {
      tuples.push({ user: `${role}#assignee`, relation, object: SEED_IDS.institution });
    }
    tuples.push({ user: `${role}#assignee`, relation: 'reader', object: SEED_IDS.group });
    tuples.push({ user: PROBE_USER, relation: 'assignee', object: role });
    for (let a = 0; a < p.assigneesPerRole; a++) {
      tuples.push({ user: `user:__bench_ru${r}_${a}`, relation: 'assignee', object: role });
    }
  }

  // Team members: probe + fillers; team#member also granted reader on the assessment
  // (exercises the team#member userset on the deep assessment path).
  if (p.members > 0) {
    tuples.push({ user: `${SEED_IDS.team}#member`, relation: 'reader', object: SEED_IDS.assessment });
    tuples.push({ user: PROBE_USER, relation: 'member', object: SEED_IDS.team });
    for (let m = 0; m < p.members; m++) {
      tuples.push({ user: `user:__bench_m${m}`, relation: 'member', object: SEED_IDS.team });
    }
  }

  // Sibling objects under the institution (breadth — most impactful for list-objects).
  for (let j = 0; j < p.objects; j++) {
    const doc = `document:__bench_doc_${j}`;
    tuples.push({ user: SEED_IDS.institution, relation: 'parent_institution', object: doc });
    tuples.push({ user: SEED_IDS.note, relation: 'parent_note', object: doc });
    const asmt = `assessment:__bench_a_${j}`;
    tuples.push({ user: SEED_IDS.institution, relation: 'parent_institution', object: asmt });
    tuples.push({ user: SEED_IDS.template, relation: 'parent_template', object: asmt });
  }

  return tuples;
}
