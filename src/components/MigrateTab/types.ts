// Shared types for the Migrate tab.
import type { MigrationTemplate } from '../../utils/migrationTransform';

/** A named mapping template cached in localStorage (configs are meant to live in git). */
export interface SavedTemplate {
  name: string;
  /** The template, stored as-is for round-tripping through the editor. */
  config: MigrationTemplate;
}
