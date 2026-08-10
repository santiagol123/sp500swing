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

function usesInsiderFilingsCache(workspace) {
  return workspace.strategy === "insider" || workspace.strategy === "insider_total" || workspace.strategy === "chatgpt_sp500";
}

async function main() {
  const workspace = resolveWorkspace(arg("workspace", DEFAULT_WORKSPACE));
  const maxSymbols = Number(arg("maxSymbols", 0));
  const concurrency = Number(arg("concurrency", 24));
  const filingsCache = usesInsiderFilingsCache(workspace) ? readJson("insider", "filings", {}) || {} : {};

  const result = await runStrategy(workspace, {
    maxSymbols,
    concurrency,
    cache: filingsCache,
    cacheOnly: usesInsiderFilingsCache(workspace) && flag("cacheOnly"),
    bootstrapSignals: usesInsiderFilingsCache(workspace) && flag("bootstrapSignals"),
  });

  // Las series de precios pesan megas y no aportan nada por consola.
  const { charts, cache, ...printable } = result;
  console.log(JSON.stringify(printable, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
