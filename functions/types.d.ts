interface D1Result { meta: { changes: number } }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
}
interface D1Database { prepare(query: string): D1PreparedStatement }
type PagesFunction<Environment = unknown> = (context: {
  request: Request;
  env: Environment;
  params: Record<string, string>;
}) => Response | Promise<Response>;
