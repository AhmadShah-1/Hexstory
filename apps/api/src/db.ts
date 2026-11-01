import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A connection or a transaction; service functions accept either. */
export type Db = postgres.Sql | postgres.TransactionSql;

/**
 * One pool per process. On Vercel each function instance has its own small pool in front of
 * Neon's PgBouncer (transaction mode, which supports the protocol-level prepared statements
 * postgres.js uses); idle connections are closed quickly so suspended instances don't hold them.
 */
export function createDb(url: string, options: { max?: number; serverless?: boolean } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.serverless ? 20 : undefined,
    connect_timeout: 15,
    // snake_case columns come back as camelCase properties
    transform: postgres.toCamel,
    onnotice: () => {},
  });
}

/** Host and database name, for logs. Never includes credentials. */
export function describeDatabase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}
