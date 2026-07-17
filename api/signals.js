const { runScanner } = require("../lib/scanner");

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url || "/api/signals", `https://${req.headers.host || "localhost"}`);
    const maxSymbols = Number(url.searchParams.get("maxSymbols") || 0);
    const concurrency = Number(url.searchParams.get("concurrency") || process.env.SCANNER_CONCURRENCY || 24);
    const payload = await runScanner({ maxSymbols, concurrency });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.statusCode = 200;
    res.end(JSON.stringify(payload, null, 2));
  } catch (error) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 500;
    res.end(
      JSON.stringify(
        {
          ok: false,
          error: error.message,
          elapsed_ms: Date.now() - startedAt,
          generated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
};
