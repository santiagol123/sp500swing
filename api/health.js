module.exports = function handler(_req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, service: "market-radar-vercel", ts: new Date().toISOString() }));
};
