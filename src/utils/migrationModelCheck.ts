// Model validation for produced tuples, folded into the dry-run step. Reuses
// extractRelationshipMetadata and mirrors TuplesTab's acceptance check
// (`userTypes.some(t => t.startsWith(type))`): for each tuple, the object type
// must exist, the relation must exist on it, and the user's type must be an
// allowed directly-related user type for that relation.
import { extractRelationshipMetadata, parseTupleObject } from './tupleHelper';
import type { Tuple } from './migrationTransform';

export interface TupleWarning {
  tuple: Tuple;
  message: string;
}

const MAX_WARNINGS = 500;

/** The user's "type signature": `user`, `team#member`, or `user:*` (wildcard). */
function userTypeSignature(user: string): string {
  const [head, userset] = user.split('#');
  const type = head.split(':')[0];
  if (userset) return `${type}#${userset}`;
  if (head.endsWith(':*')) return `${type}:*`;
  return type;
}

/**
 * Returns model-validation warnings for the produced tuples (empty ⇒ all valid).
 * Best-effort: an unparseable/empty model yields no warnings (the caller shows a
 * "model unavailable" note instead of blocking).
 */
export function validateAgainstModel(tuples: Tuple[], model: string): TupleWarning[] {
  if (!model || !model.trim()) return [];
  let meta;
  try {
    meta = extractRelationshipMetadata(model);
  } catch {
    return [];
  }

  const warnings: TupleWarning[] = [];
  for (const tuple of tuples) {
    if (warnings.length >= MAX_WARNINGS) break;
    const { type: objectType } = parseTupleObject(tuple.object);
    const typeMeta = meta.types.get(objectType);
    if (!typeMeta) {
      warnings.push({ tuple, message: `unknown object type "${objectType}"` });
      continue;
    }
    if (!typeMeta.relations.includes(tuple.relation)) {
      warnings.push({ tuple, message: `relation "${tuple.relation}" not defined on type "${objectType}"` });
      continue;
    }
    const allowed = typeMeta.userTypes.get(tuple.relation) ?? [];
    const sig = userTypeSignature(tuple.user);
    const typePart = sig.split('#')[0].split(':')[0];
    const ok = allowed.some((a) => a === sig || a === `${typePart}:*` || a.startsWith(sig));
    if (!ok) {
      warnings.push({
        tuple,
        message: `user type "${sig}" is not an allowed type for "${objectType}#${tuple.relation}"`,
      });
    }
  }
  return warnings;
}
