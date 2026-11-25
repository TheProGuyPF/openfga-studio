// "Copy AI prompt" builder — kept out of the component file so Fast Refresh stays
// happy. Assembles the JSON Schema + detected CSV headers + sample rows + a rules
// cheatsheet so the user can round-trip config generation through their own AI tool.
import { MIGRATION_TEMPLATE_SCHEMA } from '../../utils/migrationSchema';

const RULES_CHEATSHEET = `Rules cheatsheet:
- rowFilters: include/exclude a row based on a column value being in truthyValues.
- requiredColumns: any empty ⇒ skip the whole row.
- rules[].whenColumnsPresent: all listed columns must be non-empty for the rule to emit.
- Segment (user/object): { type, column, usersetRelation?, caseFold? } → "type:{column}[#userset]".
  Or { column, enum:{ column, caseInsensitive, map:{ VALUE:{type, usersetRelation?} } } } (unmatched ⇒ skip tuple).
- relation: { constant } OR { enum:{ column, caseInsensitive, map:{VALUE:relation}, default? } }.
- dedupe: drop duplicate user|relation|object tuples. validationMode: drop-tuple | drop-row.`;

/** Build the "Copy AI prompt" text: schema + detected headers + sample rows + cheatsheet. */
export function buildAiPrompt(headers: string[], sampleRows: Record<string, string>[]): string {
  const samples = sampleRows
    .slice(0, 5)
    .map((r) => JSON.stringify(r))
    .join('\n');
  return [
    'You are generating a MigrationTemplate (JSON) for OpenFGA Studio that maps CSV rows to structural OpenFGA tuples {user, relation, object}.',
    'Return ONLY a JSON object that validates against this JSON Schema:',
    '```json',
    JSON.stringify(MIGRATION_TEMPLATE_SCHEMA, null, 2),
    '```',
    RULES_CHEATSHEET,
    '',
    `Detected CSV columns: ${headers.join(', ') || '(none — paste a CSV first)'}`,
    'Sample rows:',
    samples || '(no rows)',
    '',
    'Produce the MigrationTemplate JSON now.',
  ].join('\n');
}
