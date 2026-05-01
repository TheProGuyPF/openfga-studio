import type { RelationshipTuple } from '../../utils/tupleHelper';

export type LookupMode = 'effective' | 'direct';

export interface ConditionState {
  name: string;
  context: Record<string, string | number | boolean>;
}

export interface EffectiveFormValues {
  userType: string;
  userName: string;
  relation: string;
  objectType: string;
  conditionState: ConditionState | null;
}

export interface DirectFormValues {
  userType: string;
  userName: string;
  isUserset: boolean;
  usersetRelation: string;
  filterRelation: string;
  objectType: string;
  objectId: string;
}

export interface EffectiveResult {
  query: { user: string; relation: string; objectType: string };
  objects: string[];
}

export interface DirectResult {
  query: { user?: string; relation?: string; object?: string };
  tuples: RelationshipTuple[];
  continuationToken?: string;
  totalLoaded: number;
}

export interface PendingQueryPrefill {
  user: string;
  relation: string;
  object: string;
}

export interface CrossModeActions {
  showDirectTuplesForObject: (object: string) => void;
  showEffectiveAccessForUser: (user: string) => void;
  checkTuple: (user: string, relation: string, object: string) => void;
}

export const DEFAULT_PAGE_SIZE = 25;
export const LOAD_ALL_CAP = 10000;
