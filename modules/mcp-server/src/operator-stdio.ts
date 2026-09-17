// This file has NO static imports — that's load-bearing, not incidental.
// stdout is reserved for the MCP JSON-RPC stream over this transport, so
// any stray console.log (ours or a dependency's) would corrupt the
// protocol. Under ESM, every module a file statically imports is fully
// evaluated — including its own top-level side effects — before that
// file's own top-level code runs, regardless of where the `import`
// appears textually. A `console.log = console.error` written "first" in a
// file that also statically imports the MCP SDK, zod, jsdom, etc. would
// still run AFTER all of those modules' own top-level code, because
// static imports are hoisted. Only a genuine runtime operation — a
// dynamic import() — is evaluated in the order it's actually reached, so
// the redirect goes here, in a file with nothing else to hoist above it,
// before operator-stdio-main.ts (and everything it imports) is loaded.
console.log = console.error;

await import('./operator-stdio-main.js');
