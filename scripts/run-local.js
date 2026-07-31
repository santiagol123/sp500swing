const { resolveWorkspace, DEFAULT_WORKSPACE } = require("../lib/workspaces");
const { runStrategy } = require("../lib/runtime");

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

async function main() {
  const workspace = resolveWorkspace(arg("workspace", DEFAULT_WORKSPACE));
  const maxSymbols = Number(arg("maxSymbols", 0));
  const concurrency = Number(arg("concurrency", 24));

  const result = await runStrategy(workspace, { maxSymbols, concurrency });

  // Las series de precios pesan megas y no aportan nada por consola.
  const { charts, cache, ...printable } = result;
  console.log(JSON.stringify(printable, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
