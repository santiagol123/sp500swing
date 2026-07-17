const { runScanner } = require("../lib/scanner");

async function main() {
  const maxSymbols = Number(process.argv.find((arg) => arg.startsWith("--maxSymbols="))?.split("=")[1] || 0);
  const concurrency = Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1] || 24);
  const payload = await runScanner({ maxSymbols, concurrency });
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
