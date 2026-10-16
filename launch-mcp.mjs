// Launcher: Claude Code's .mcp.json does not honor a `cwd` field, so it spawns
// this server with the project root as the working directory. The server reads
// config/ and dist/ paths relative to process.cwd(), so fix cwd to this file's
// own directory before importing the real entrypoint.
process.chdir(import.meta.dirname);
await import("./dist/src/server.js");
