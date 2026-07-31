// Persistencia en ficheros JSON dentro del repo.
//
// No hay base de datos a proposito: el GitHub Action escribe estos ficheros y
// los commitea, y la app desplegada solo los lee. Asi el despliegue en Vercel
// sigue sin necesitar ninguna variable de entorno ni token.

const fs = require("fs");
const path = require("path");

const HISTORY_DIR = path.join(__dirname, "..", "data", "history");

function workspaceDir(workspaceId) {
  return path.join(HISTORY_DIR, workspaceId);
}

function filePath(workspaceId, name) {
  return path.join(workspaceDir(workspaceId), `${name}.json`);
}

function readJson(workspaceId, name, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath(workspaceId, name), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`No se pudo leer ${workspaceId}/${name}.json: ${error.message}`);
  }
}

function writeJson(workspaceId, name, data) {
  const dir = workspaceDir(workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(workspaceId, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function emptyState(workspace) {
  return {
    workspace: workspace.id,
    created_at: new Date().toISOString(),
    updated_at: null,
    initial_equity: workspace.portfolio.initial_equity,
    cash: workspace.portfolio.initial_equity,
    positions: [],
    trades: [],
    equity_curve: [],
    tracked_days: 0,
    last_market_date: null,
  };
}

function readState(workspace) {
  return readJson(workspace.id, "state", null) || emptyState(workspace);
}

function writeState(workspace, state) {
  writeJson(workspace.id, "state", state);
}

module.exports = {
  HISTORY_DIR,
  workspaceDir,
  filePath,
  readJson,
  writeJson,
  emptyState,
  readState,
  writeState,
};
