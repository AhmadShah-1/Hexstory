import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Sql } from '../db.js';
import type { Storage } from '../storage/index.js';

/** Everything route plugins need, passed explicitly instead of hanging off globals. */
export interface Deps {
  config: Config;
  sql: Sql;
  storage: Storage;
  coordinator: Coordinator;
}
