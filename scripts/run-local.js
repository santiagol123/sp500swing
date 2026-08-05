const { resolveWorkspace, DEFAULT_WORKSPACE } = require("../lib/workspaces");
const { runStrategy } = require("../lib/runtime");
const { readJson } = require("../lib/store");

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`) || arg(name, "false") === "true";
}

async function main() {
  const workspace = resolveWorkspace(arg("workspace", DEFAULT_WORKSPACE));
  const maxSymbols = Number(arg("maxSymbols", 0));
  const concurrency = Number(arg("concurrency", 24));
  const filingsCache = workspace.id === "insider" ? readJson(workspace.id, "filings", {}) || {} : {};

  const result = await runStrategy(workspace, {
    maxSymbols,
    concurrency,
    cache: filingsCache,
    cacheOnly: workspace.id === "insider" && flag("cacheOnly"),
    bootstrapSignals: workspace.id === "insider" && flag("bootstrapSignals"),
  });

  // Las series de precios pesan megas y no aportan nada por consola.
  const { charts, cache, ...printable } = result;
  console.log(JSON.stringify(printable, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
