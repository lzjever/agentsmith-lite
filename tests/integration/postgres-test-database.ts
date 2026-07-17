export function readPostgresTestUrl(): string | undefined {
  const postgresUrl = process.env.POSTGRES_TEST_URL;
  if (!postgresUrl) {
    return undefined;
  }

  const databaseName = decodeURIComponent(new URL(postgresUrl).pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error("POSTGRES_TEST_URL must select a database whose name ends with _test");
  }
  return postgresUrl;
}
