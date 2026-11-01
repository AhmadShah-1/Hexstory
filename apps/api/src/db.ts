import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A connection or a transaction; service functions accept either. */
export type Db = postgres.Sql | postgres.TransactionSql;

export function createDb(url: string): Sql {
  return postgres(url, {
    max: 10,
    // snake_case columns come back as camelCase properties
    transform: postgres.toCamel,
    onnotice: () => {},
  });
}
