// Match SQLite BINARY and PostgreSQL C collation, including mixed-case nanoids.
export function compareMessages(a, b) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}
