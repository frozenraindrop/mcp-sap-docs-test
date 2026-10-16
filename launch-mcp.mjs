// Launcher: Claude Code spawns stdio MCP servers with the directory it was launched
// from as cwd (verified for user-scoped servers), not the server's own directory, and
// has no documented `cwd` field for them. The server reads config/ and dist/ paths
// relative to process.cwd(), so fix cwd to this file's own directory before importing
// the real entrypoint.
process.chdir(import.meta.dirname);
await import("./dist/src/server.js");
