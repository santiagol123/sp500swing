const signalsHandler = require("./api/signals");
const healthHandler = require("./api/health");
const leaderboardHandler = require("./api/leaderboard");

function vercelApiPlugin() {
  return {
    name: "local-vercel-api",
    configureServer(server) {
      server.middlewares.use("/api/signals", (req, res) => signalsHandler(req, res));
      server.middlewares.use("/api/health", (req, res) => healthHandler(req, res));
      server.middlewares.use("/api/leaderboard", (req, res) => leaderboardHandler(req, res));
    },
  };
}

module.exports = {
  plugins: [vercelApiPlugin()],
};
