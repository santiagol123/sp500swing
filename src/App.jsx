import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Eye,
  Gauge,
  History,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { commissionPerSide, signalsEndpoint, ticketSize } from "./config.js";
import { actionTone, mapApiRow, mergeApiData, money, number, pct, usd } from "./utils.js";

const initialData = {
  buyToday: [],
  technicalEntries: [],
  watchlist: [],
  topRanked: [],
  portfolio: [],
  closedTrades: [],
  movements: [],
  portfolioSummary: {
    open_positions: 0,
    market_value: 0,
    invested: 0,
    open_pnl: 0,
    open_pnl_pct: 0,
    stop_risk: 0,
    target_upside: 0,
    closed_trades: 0,
    closed_pnl: 0,
    win_rate: 0,
    total_pnl: 0,
  },
  portfolioSource: {},
  failed: [],
  paperPortfolio: null,
  meta: {
    mode: "loading",
    generatedAt: null,
    workspace: null,
    workspaces: [],
    warning: null,
    latestMarketDate: null,
    universeSource: null,
    universeCount: 0,
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: 0,
    dashboard: {},
    rules: {},
    marketRegime: {},
  },
};

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "portfolio", label: "Cartera", icon: Briefcase },
  { id: "history", label: "Historico", icon: History },
  { id: "radar", label: "Radar", icon: Eye },
  { id: "ranking", label: "Ranking", icon: BarChart3 },
  { id: "strategies", label: "Estrategias", icon: Trophy },
  { id: "run", label: "Ejecucion", icon: ClipboardList },
  { id: "settings", label: "Configuracion", icon: Settings },
];

function App() {
  const [view, setView] = useState("dashboard");
  const [data, setData] = useState(initialData);
  const [selected, setSelected] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Cargando datos reales");
  const [workspace, setWorkspace] = useState("momentum");

  async function refreshSignals(workspaceId = workspace) {
    setStatusMessage("Cargando datos reales");
    try {
      const separator = signalsEndpoint.includes("?") ? "&" : "?";
      const response = await fetch(`${signalsEndpoint}${separator}workspace=${encodeURIComponent(workspaceId)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const payload = await response.json();
      const liveData = mergeApiData(initialData, payload);
      setData(liveData);
      setStatusMessage(liveData.meta.failedCount ? "Datos reales con avisos" : "Datos reales");
    } catch (error) {
      setData({
        ...initialData,
        meta: {
          ...initialData.meta,
          mode: "error",
          generatedAt: new Date().toISOString(),
          error: error.message,
        },
      });
      setStatusMessage("API real no disponible");
    }
  }

  useEffect(() => {
    refreshSignals();
  }, []);

  const pageTitle = navItems.find((item) => item.id === view)?.label || "Dashboard";
  const statusTone = data.meta.mode === "api" ? "good" : data.meta.mode === "error" ? "bad" : "wait";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MR</div>
          <div>
            <strong>Market Radar</strong>
            <span>Quant Bot</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-button ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-image">
          <img src="/elissir.jpg" alt="Elissir" />
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <p>
              Ultima actualizacion: {formatDateTime(data.meta.generatedAt)} - Mercado: {data.meta.latestMarketDate || "sin dato"}
            </p>
          </div>
          <div className="topbar-actions">
            <WorkspaceSwitcher
              workspaces={data.meta.workspaces}
              current={data.meta.workspace?.id || workspace}
              onChange={(id) => {
                setWorkspace(id);
                refreshSignals(id);
              }}
            />
            <StatusPill tone={statusTone} label={statusMessage} />
          </div>
        </header>

        {data.meta.workspace && (
          <p className="workspace-note">
            {data.meta.workspace.description}
            {" "}
            <em>
              ({data.meta.workspace.source === "live"
                ? "calculado en vivo"
                : `snapshot del Action${data.meta.workspace.computed_at ? ` del ${formatDateTime(data.meta.workspace.computed_at)}` : ""}`})
            </em>
          </p>
        )}

        {data.meta.warning && <EmptyState icon={AlertTriangle} title="Sin snapshot todavia" detail={data.meta.warning} />}

        {view === "dashboard" && <Dashboard data={data} onSelect={setSelected} />}
        {view === "portfolio" && <PortfolioView data={data} onSelect={setSelected} />}
        {view === "history" && <HistoryView data={data} />}
        {view === "radar" && <RadarView data={data} onSelect={setSelected} />}
        {view === "ranking" && <RankingView data={data} />}
        {view === "strategies" && <StrategiesView />}
        {view === "run" && <RunView data={data} />}
        {view === "settings" && <SettingsView data={data} />}
      </main>

      {selected && <DetailDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function WorkspaceSwitcher({ workspaces, current, onChange }) {
  if (!workspaces?.length) return null;
  return (
    <div className="workspace-switcher">
      {workspaces.map((w) => (
        <button
          key={w.id}
          className={`workspace-tab ${w.id === current ? "active" : ""}`}
          onClick={() => onChange(w.id)}
          title={w.description}
        >
          {w.short || w.label}
        </button>
      ))}
    </div>
  );
}

function usesPaperPortfolio(data) {
  return Boolean(data.paperPortfolio && data.meta.workspace?.id && data.meta.workspace.id !== "momentum");
}

function workspaceShortLabel(data, fallback = "Paper") {
  return data.meta.workspace?.short || data.meta.workspace?.label || fallback;
}

function paperPortfolioStats(paper = {}) {
  const positions = paper.open_positions || [];
  const marketValue = positions.reduce((sum, row) => sum + Number(row.qty || 0) * Number(row.last_price || row.entry_price || 0), 0);
  const invested = positions.reduce((sum, row) => sum + Number(row.cost_basis || 0), 0);
  const openPnl = marketValue - invested;
  return {
    openPositions: positions.length,
    marketValue,
    invested,
    openPnl,
    openPnlPct: invested > 0 ? openPnl / invested : 0,
  };
}

// Ranking entre estrategias. Se alimenta del historial de paper trading que
// commitea el Action, no del scanner, asi que se pide aparte.
function StrategiesView() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/leaderboard", { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error || "Respuesta invalida");
        setBoard(payload);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <EmptyState icon={AlertTriangle} title="No se pudo cargar el ranking" detail={error} />;
  if (!board) return <EmptyState icon={Activity} title="Cargando ranking" detail="Leyendo historial de paper trading" />;

  const empty = !board.total_closed_trades;

  return (
    <div className="page-stack">
      <Panel title="Veredicto">
        <p className={`verdict ${empty ? "verdict-empty" : ""}`}>{board.verdict}</p>
        <p className="panel-note">
          {board.method.note} {board.method.shared_rules}
        </p>
      </Panel>

      <section className="kpi-grid">
        <MetricCard icon={CalendarDays} label="Dias registrados" value={board.tracked_days} detail="Sesiones del tracker" />
        <MetricCard icon={ClipboardList} label="Operaciones cerradas" value={board.total_closed_trades} detail="Suma de estrategias" />
        <MetricCard
          icon={Trophy}
          label="Lider"
          value={board.leader ? board.ranking.find((m) => m.workspace === board.leader)?.short || board.leader : "-"}
          detail={empty ? "Sin datos suficientes" : "Por rentabilidad"}
          tone={empty ? "wait" : "good"}
        />
      </section>

      <Panel title="Comparativa">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Estrategia</th>
                <th>Rentabilidad</th>
                <th>Capital</th>
                <th>Ops</th>
                <th>Acierto</th>
                <th>R medio</th>
                <th>Profit factor</th>
                <th>Max DD</th>
                <th>Fiabilidad</th>
              </tr>
            </thead>
            <tbody>
              {board.ranking.map((m) => (
                <tr key={m.workspace}>
                  <td>{m.rank}</td>
                  <td><strong>{m.label}</strong></td>
                  <td className={m.total_return_pct >= 0 ? "positive" : "negative"}>{pct((m.total_return_pct || 0) * 100, 2)}</td>
                  <td>{usd(m.equity)}</td>
                  <td>{m.closed_trades}</td>
                  <td>{m.win_rate == null ? "-" : pct(m.win_rate * 100, 0)}</td>
                  <td>{m.avg_r == null ? "-" : number(m.avg_r)}</td>
                  <td>{m.profit_factor == null ? "-" : number(m.profit_factor)}</td>
                  <td className="negative">{pct((m.max_drawdown_pct || 0) * 100, 2)}</td>
                  <td><Badge tone={m.confidence === "alta" ? "buy" : m.confidence === "insuficiente" ? "bad" : "wait"}>{m.confidence}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Ultimas operaciones cerradas">
        {board.recent_trades.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Estrategia</th>
                  <th>Ticker</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Motivo</th>
                  <th>P/L</th>
                  <th>R</th>
                  <th>Dias</th>
                </tr>
              </thead>
              <tbody>
                {board.recent_trades.map((t, i) => (
                  <tr key={`${t.workspace}-${t.ticker}-${t.exit_date}-${i}`}>
                    <td>{t.workspace_label}</td>
                    <td><strong>{t.ticker}</strong></td>
                    <td>{formatDate(t.entry_date)}</td>
                    <td>{formatDate(t.exit_date)}</td>
                    <td>{t.exit_reason}</td>
                    <td className={t.pnl >= 0 ? "positive" : "negative"}>{usd(t.pnl)}</td>
                    <td className={t.r_multiple >= 0 ? "positive" : "negative"}>{t.r_multiple == null ? "-" : number(t.r_multiple)}</td>
                    <td>{t.hold_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Users}
            title="Todavia no se ha cerrado ninguna operacion"
            detail="El ranking se llena solo cuando el tracker diario acumula historial. No hay backtest: todo es hacia delante."
          />
        )}
      </Panel>
    </div>
  );
}

function Dashboard({ data, onSelect }) {
  const dashboard = data.meta.dashboard || {};
  const summary = data.portfolioSummary || initialData.portfolioSummary;
  const paper = data.paperPortfolio ? paperPortfolioStats(data.paperPortfolio) : null;
  const showPaper = usesPaperPortfolio(data);
  const paperLabel = workspaceShortLabel(data, "Paper");
  const executable = dashboard.portfolio_entry_count ?? data.buyToday.filter((item) => item.action.includes("COMPRAR")).length;
  const technical = dashboard.technical_entry_count ?? data.technicalEntries.length;
  const candidates = dashboard.candidates_total ?? data.buyToday.length + data.watchlist.length;
  const avgRr = data.buyToday.reduce((acc, item) => acc + (item.rr || 0), 0) / Math.max(1, data.buyToday.length);
  const secondaryRows = useMemo(() => {
    const selected = new Set(data.buyToday.map((row) => row.ticker));
    return data.technicalEntries.filter((row) => !selected.has(row.ticker)).slice(0, 8);
  }, [data.buyToday, data.technicalEntries]);

  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard
          icon={Briefcase}
          label={showPaper ? `Cartera ${paperLabel}` : "Cartera abierta"}
          value={showPaper ? paper.openPositions : summary.open_positions || 0}
          detail={showPaper ? `${usd(paper.marketValue)} valor actual` : `${money(summary.market_value || 0)} valor actual`}
        />
        <MetricCard
          icon={TrendingUp}
          label="P&L abierto"
          value={showPaper ? usd(paper.openPnl) : money(summary.open_pnl || 0)}
          detail={showPaper ? pct(paper.openPnlPct * 100) : pct(summary.open_pnl_pct || 0)}
          tone={(showPaper ? paper.openPnl : summary.open_pnl || 0) >= 0 ? "good" : "bad"}
        />
        <MetricCard icon={Target} label="Compras nuevas" value={executable} detail={`${technical} entradas tecnicas`} tone={executable ? "good" : "wait"} />
        <MetricCard icon={Activity} label="Candidatos" value={candidates} detail={`${dashboard.buys_today_count || 0} compras ya ejecutadas hoy`} />
      </div>

      {data.meta.mode === "error" && (
        <Panel title="Estado API">
          <EmptyState
            icon={AlertTriangle}
            title="No se pudo cargar la API real"
            detail={data.meta.error || "Revisa el endpoint desplegado o VITE_SIGNALS_API_URL."}
          />
        </Panel>
      )}

      <Panel title="Comprar hoy" right={<span className="panel-note">Orden limitada, no perseguir gaps</span>}>
        <SignalTable rows={data.buyToday} onSelect={onSelect} emptyTitle="Sin compras autorizadas en la ultima ejecucion real" />
      </Panel>

      <Panel title="Entradas tecnicas">
        <SignalTable rows={secondaryRows} onSelect={onSelect} emptyTitle="Sin entradas tecnicas adicionales" />
      </Panel>
    </section>
  );
}

function PortfolioView({ data, onSelect }) {
  if (usesPaperPortfolio(data)) {
    const paper = paperPortfolioStats(data.paperPortfolio);
    const paperLabel = workspaceShortLabel(data, "Paper");
    return (
      <section className="page-stack">
        <div className="kpi-grid">
          <MetricCard icon={Briefcase} label="Equity paper" value={usd(data.paperPortfolio.equity || 0)} detail={`${paper.openPositions} posiciones abiertas`} />
          <MetricCard icon={TrendingUp} label="P&L abierto" value={usd(paper.openPnl)} detail={pct(paper.openPnlPct * 100)} tone={paper.openPnl >= 0 ? "good" : "bad"} />
          <MetricCard icon={Activity} label="Efectivo" value={usd(data.paperPortfolio.cash || 0)} detail={`${usd(paper.marketValue)} invertido`} />
          <MetricCard icon={CalendarDays} label="Ultimo tracking" value={data.paperPortfolio.last_tracked_date || "-"} detail={`${data.paperPortfolio.tracked_days || 0} dias registrados`} />
        </div>

        <Panel title={`Cartera ${paperLabel} abierta`} right={<span className="panel-note">Paper trading del workspace</span>}>
          <PaperPortfolioTable rows={data.paperPortfolio.open_positions || []} label={paperLabel} />
        </Panel>
      </section>
    );
  }

  const summary = data.portfolioSummary || initialData.portfolioSummary;
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={Briefcase} label="Valor cartera" value={money(summary.market_value || 0)} detail={`${summary.open_positions || 0} posiciones abiertas`} />
        <MetricCard icon={TrendingUp} label="P&L abierto" value={money(summary.open_pnl || 0)} detail={pct(summary.open_pnl_pct || 0)} tone={(summary.open_pnl || 0) >= 0 ? "good" : "bad"} />
        <MetricCard icon={AlertTriangle} label="Riesgo a stops" value={money(summary.stop_risk || 0)} detail="Si saltan todos los stops" tone="wait" />
        <MetricCard icon={Target} label="Potencial a TP" value={money(summary.target_upside || 0)} detail="Hasta objetivos actuales" tone="good" />
      </div>

      <Panel title="Posiciones abiertas" right={<span className="panel-note">Fuente: documento + precios Yahoo</span>}>
        <PortfolioTable rows={data.portfolio} onSelect={onSelect} />
      </Panel>
    </section>
  );
}

function HistoryView({ data }) {
  if (usesPaperPortfolio(data)) {
    const paper = paperPortfolioStats(data.paperPortfolio);
    const paperLabel = workspaceShortLabel(data, "Paper");
    return (
      <section className="page-stack">
        <div className="kpi-grid">
          <MetricCard icon={History} label="Operaciones cerradas" value={data.paperPortfolio.closed_trades || 0} detail={`Paper trading ${paperLabel}`} />
          <MetricCard icon={TrendingUp} label="P&L abierto" value={usd(paper.openPnl)} detail={pct(paper.openPnlPct * 100)} tone={paper.openPnl >= 0 ? "good" : "bad"} />
          <MetricCard icon={Activity} label="Equity" value={usd(data.paperPortfolio.equity || 0)} detail={`Inicial ${usd(data.paperPortfolio.initial_equity || 0)}`} />
          <MetricCard icon={CalendarDays} label="Ultimo tracking" value={data.paperPortfolio.last_tracked_date || "-"} detail={`${data.paperPortfolio.tracked_days || 0} dias`} />
        </div>

        <Panel title={`Historico ${paperLabel}`}>
          <PaperClosedTradesTable rows={data.paperPortfolio.closed_trade_rows || []} label={paperLabel} />
        </Panel>
      </section>
    );
  }

  const summary = data.portfolioSummary || initialData.portfolioSummary;
  const autoClosed = data.portfolioSource.automation?.auto_closed_count || 0;
  const autoOpened = data.portfolioSource.automation?.auto_opened_count || 0;
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={History} label="Operaciones cerradas" value={summary.closed_trades || 0} detail={`${number(summary.win_rate || 0, 1)}% win rate`} />
        <MetricCard icon={TrendingUp} label="P&L cerrado" value={money(summary.closed_pnl || 0)} detail="Con comisiones" tone={(summary.closed_pnl || 0) >= 0 ? "good" : "bad"} />
        <MetricCard icon={Activity} label="P&L total" value={money(summary.total_pnl || 0)} detail="Abierto + cerrado" tone={(summary.total_pnl || 0) >= 0 ? "good" : "bad"} />
        <MetricCard icon={ShieldCheck} label="Auto altas/bajas" value={`${autoOpened}/${autoClosed}`} detail={data.portfolioSource.asOf || "Fecha de cartera"} />
      </div>

      <Panel title="Movimientos de cartera">
        <MovementsTable rows={data.movements} />
      </Panel>

      <Panel title="Historico de operaciones">
        <ClosedTradesTable rows={data.closedTrades} />
      </Panel>
    </section>
  );
}

function RadarView({ data, onSelect }) {
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={Eye} label="Radar" value={data.watchlist.length} detail="Senales no autorizadas" />
        <MetricCard icon={TrendingUp} label="Hot momentum" value={data.meta.dashboard?.hot_momentum_count || 0} detail="Ranking real actual" />
        <MetricCard icon={SlidersHorizontal} label="Pullback" value={data.meta.dashboard?.pullback_count || 0} detail="Setups detectados" />
        <MetricCard icon={CheckCircle2} label="Near breakout" value={data.meta.dashboard?.near_breakout_count || 0} detail="Setups detectados" />
      </div>

      <Panel title="Radar de seguimiento" right={<span className="panel-note">No son compras automaticas</span>}>
        <SignalTable rows={data.watchlist} onSelect={onSelect} emptyTitle="Sin valores en radar" />
      </Panel>
    </section>
  );
}

function RankingView({ data }) {
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={BarChart3} label="Top ranking" value={data.topRanked.length} detail="Primeros valores por score" />
        <MetricCard icon={Activity} label="Descargados" value={data.meta.downloadedCount || 0} detail={`${data.meta.universeCount || 0} en universo`} />
        <MetricCard icon={AlertTriangle} label="Fallos" value={data.meta.failedCount || 0} detail="Yahoo/Wikipedia" tone={data.meta.failedCount ? "wait" : "good"} />
        <MetricCard icon={CalendarDays} label="Latencia" value={formatMs(data.meta.elapsedMs)} detail="Tiempo de scanner" />
      </div>

      <Panel title="Ranking tecnico real">
        <RankedTable rows={data.topRanked} />
      </Panel>
    </section>
  );
}

function RunView({ data }) {
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={ClipboardList} label="Generado" value={formatTime(data.meta.generatedAt)} detail={formatDate(data.meta.generatedAt)} />
        <MetricCard icon={CalendarDays} label="Mercado" value={data.meta.latestMarketDate || "-"} detail="Ultima vela usada" />
        <MetricCard icon={Activity} label="Fuente universo" value={shortSource(data.meta.universeSource)} detail={data.meta.universeSource || "sin fuente"} />
        <MetricCard icon={ShieldCheck} label="Estado" value={data.meta.mode === "api" ? "OK" : "Aviso"} detail={data.meta.error || "Scanner operativo"} tone={data.meta.mode === "api" ? "good" : "wait"} />
      </div>

      <Panel title="Resumen de ejecucion">
        <div className="settings-grid">
          <Setting label="Endpoint" value={signalsEndpoint} />
          <Setting label="Universo" value={number(data.meta.universeCount || 0, 0)} />
          <Setting label="Descargados" value={number(data.meta.downloadedCount || 0, 0)} />
          <Setting label="Fallos" value={number(data.meta.failedCount || 0, 0)} />
          <Setting label="Duracion" value={formatMs(data.meta.elapsedMs)} />
          <Setting label="Regimen mercado" value={data.meta.marketRegime?.state || "-"} />
          <Setting label="Modo" value={data.meta.mode} />
        </div>
      </Panel>

      <Panel title="Fallos de descarga">
        <FailedList rows={data.failed} />
      </Panel>
    </section>
  );
}

function SettingsView({ data }) {
  const rules = data.meta.rules || {};
  const automation = data.portfolioSource.automation || {};
  const marketRegime = data.meta.marketRegime || {};
  return (
    <section className="page-stack">
      <Panel title="Parametros del bot">
        <div className="settings-grid">
          <Setting label="Capital por operacion" value={money(data.portfolioSource.ticketSize || ticketSize)} />
          <Setting label="Comision compra" value={money(data.portfolioSource.commissionPerSide || commissionPerSide)} />
          <Setting label="Comision venta" value={money(data.portfolioSource.commissionPerSide || commissionPerSide)} />
          <Setting label="Max compras por dia" value={rules.max_new_buys_per_day || 3} />
          <Setting label="Max compras por sector" value={rules.max_buys_per_sector_per_day || 2} />
          <Setting label="Max posiciones abiertas" value={rules.max_open_positions || "-"} />
          <Setting label="Max posiciones por sector" value={rules.max_open_positions_per_sector || "-"} />
          <Setting label="Max momentum abierto" value={rules.max_open_momentum_positions || "-"} />
          <Setting label="Riesgo auto por trade" value={usd(automation.auto_risk_budget_per_trade || 0)} />
          <Setting label="Fuente cartera" value={data.portfolioSource.asOf || "Sin cartera"} />
          <Setting label="Auto cartera" value={automation.mode || "Sin automatizacion"} />
        </div>
      </Panel>

      <Panel title="Reglas operativas activas">
        <div className="rules-grid">
          <Setting label="Entrada" value="Solo limitada dentro de zona" />
          <Setting label="Tamano" value="Ticket maximo y presupuesto de riesgo automatico" />
          <Setting label="Stop" value="No ampliar stop tras entrar" />
          <Setting label="Salida" value="TP, stop o tiempo maximo" />
          <Setting label="Filtro mercado" value={marketRegime.reason || "SPY/QQQ controlan compras nuevas"} />
          <Setting label="Filtro senal" value={`RR core ${number(rules.min_core_rr || 0, 2)} / momentum ${number(rules.min_momentum_rr || 0, 2)}`} />
        </div>
      </Panel>
    </section>
  );
}

function SignalTable({ rows, onSelect, emptyTitle = "Sin datos reales" }) {
  if (!rows.length) {
    return <EmptyState icon={Activity} title={emptyTitle} detail="La tabla se llenara cuando /api/signals devuelva filas reales." />;
  }

  const showInsiderTiming = rows.some((row) => row.insiderPublicationDate || row.insiderTransactionDate || row.signalDetectedAt);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Empresa</th>
            <th>Accion</th>
            <th>Estrategia</th>
            {showInsiderTiming && <th>Comprar desde</th>}
            <th>Precio</th>
            <th>Zona</th>
            <th>Stop</th>
            <th>TP</th>
            <th>RSI</th>
            <th>R/R</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.ticker}-${index}`}>
              <td><strong>{row.ticker}</strong></td>
              <td>{row.name}</td>
              <td><Badge tone={actionTone(row.action)}>{row.action}</Badge></td>
              <td>{row.strategy}</td>
              {showInsiderTiming && <td><SignalTiming row={row} /></td>}
              <td>{usd(row.price)}</td>
              <td>{usd(row.entryLow)} / {usd(row.entryHigh)}</td>
              <td>{usd(row.stop)}</td>
              <td>{usd(row.target)}</td>
              <td>{number(row.rsi, 1)}</td>
              <td>{number(row.rr, 2)}</td>
              <td>
                <button className="row-action" onClick={() => onSelect(row)} aria-label={`Abrir ${row.ticker}`}>
                  <ChevronRight size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignalTiming({ row }) {
  if (!row.insiderPublicationDate && !row.insiderTransactionDate && !row.signalDetectedAt) return <span className="muted-cell">-</span>;
  return (
    <div className="timing-cell">
      <strong>{formatFilingDateTime(row.insiderPublicationDateTime || row.insiderPublicationDate || row.signalDetectedAt)}</strong>
      <span>Operacion: {formatDateOnly(row.insiderTransactionDate)}</span>
      <span>Bot: {formatDateTime(row.signalDetectedAt)}</span>
    </div>
  );
}

function PortfolioTable({ rows, onSelect }) {
  if (!rows.length) {
    return <EmptyState icon={Briefcase} title="Sin posiciones abiertas" detail="La cartera real no tiene posiciones abiertas cargadas." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Entrada</th>
            <th>Acciones</th>
            <th>Actual</th>
            <th>P&L</th>
            <th>Stop</th>
            <th>TP</th>
            <th>Sesiones</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ticker}>
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.auto_opened ? "Auto - " : ""}{row.name}</span></td>
              <td>{row.entry_date} - {usd(row.entry)}</td>
              <td>{row.shares}</td>
              <td>{usd(row.current)}</td>
              <td className={row.pnl >= 0 ? "positive" : "negative"}>{money(row.pnl)} - {pct(row.pnl_pct)}</td>
              <td>{usd(row.stop)}</td>
              <td>{usd(row.target)}</td>
              <td>{row.sessions_held}/{row.max_sessions}</td>
              <td>
                <button className="row-action" onClick={() => onSelect(positionToSignal(row))} aria-label={`Abrir ${row.ticker}`}>
                  <ChevronRight size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaperPortfolioTable({ rows, label = "insider" }) {
  if (!rows.length) {
    return <EmptyState icon={Briefcase} title={`Sin posiciones ${label}`} detail={`La cartera ${label} no tiene posiciones abiertas.`} />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Entrada</th>
            <th>Cantidad</th>
            <th>Actual</th>
            <th>P&L</th>
            <th>Stop</th>
            <th>TP</th>
            <th>Tesis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const lastPrice = Number(row.last_price || row.entry_price || 0);
            const marketValue = Number(row.qty || 0) * lastPrice;
            const pnl = marketValue - Number(row.cost_basis || 0);
            const pnlPct = row.cost_basis > 0 ? (pnl / row.cost_basis) * 100 : 0;
            return (
              <tr key={`${row.ticker}-${row.entry_date}`}>
                <td><strong>{row.ticker}</strong><span className="muted-cell">{row.name}</span></td>
                <td>{row.entry_date} - {usd(row.entry_price)}</td>
                <td>{number(row.qty || 0, 3)}</td>
                <td>{usd(lastPrice)}</td>
                <td className={pnl >= 0 ? "positive" : "negative"}>
                  {usd(pnl)} - {pct(pnlPct)}
                </td>
                <td>{usd(row.stop_price)}</td>
                <td>{usd(row.target_price)}</td>
                <td>
                  {row.signal_meta?.insider_count || "-"} insiders
                  <span className="muted-cell">Publicado: {formatFilingDateTime(row.signal_meta?.last_filing_datetime || row.signal_meta?.last_filing)}</span>
                  <span className="muted-cell">Operacion: {formatDateOnly(row.signal_meta?.first_buy)} / {formatDateOnly(row.signal_meta?.last_buy)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaperClosedTradesTable({ rows, label = "insider" }) {
  if (!rows.length) {
    return <EmptyState icon={History} title="Sin operaciones cerradas" detail={`La cartera ${label} todavia no ha cerrado operaciones.`} />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Entrada</th>
            <th>Salida</th>
            <th>Cantidad</th>
            <th>Motivo</th>
            <th>P&L</th>
            <th>R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ticker}-${row.entry_date}-${row.exit_date}`}>
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.name}</span></td>
              <td>{row.entry_date} - {usd(row.entry_price)}</td>
              <td>{row.exit_date} - {usd(row.exit_price)}</td>
              <td>{number(row.qty || 0, 3)}</td>
              <td><Badge tone={row.exit_reason === "OBJETIVO" ? "buy" : "bad"}>{row.exit_reason}</Badge></td>
              <td className={(row.pnl || 0) >= 0 ? "positive" : "negative"}>{usd(row.pnl || 0)} - {pct((row.pnl_pct || 0) * 100)}</td>
              <td>{number(row.r_multiple || 0, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClosedTradesTable({ rows }) {
  if (!rows.length) {
    return <EmptyState icon={History} title="Sin operaciones cerradas" detail="No hay historico cerrado cargado en la cartera real." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Entrada</th>
            <th>Salida</th>
            <th>Acciones</th>
            <th>Resultado</th>
            <th>P&L</th>
            <th>Estrategia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ticker}-${row.exit_date}`}>
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.name}</span></td>
              <td>{row.entry_date} - {usd(row.entry)}</td>
              <td>{row.exit_date} - {usd(row.exit)}</td>
              <td>{row.shares}</td>
              <td><Badge tone={row.result === "TP" ? "buy" : "bad"}>{row.result}</Badge></td>
              <td className={row.pnl >= 0 ? "positive" : "negative"}>{money(row.pnl)} - {pct(row.pnl_pct)}</td>
              <td>{row.strategy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MovementsTable({ rows }) {
  if (!rows.length) {
    return <EmptyState icon={ClipboardList} title="Sin movimientos" detail="Todavia no hay movimientos de cartera cargados." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Ticker</th>
            <th>Precio</th>
            <th>Acciones</th>
            <th>P&L</th>
            <th>Nota</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.date}-${row.type}-${row.ticker}-${index}`}>
              <td>{row.date}</td>
              <td><Badge tone={movementTone(row.type)}>{row.type}</Badge></td>
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.name}</span></td>
              <td>{usd(row.price)}</td>
              <td>{row.shares}</td>
              <td className={(row.pnl || 0) >= 0 ? "positive" : "negative"}>{row.pnl == null ? "-" : money(row.pnl)}</td>
              <td>{row.note || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RankedTable({ rows }) {
  if (!rows.length) {
    return <EmptyState icon={BarChart3} title="Sin ranking real" detail="La API todavia no devolvio top_ranked." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Ticker</th>
            <th>Empresa</th>
            <th>Sector</th>
            <th>Setup</th>
            <th>Score</th>
            <th>Precio</th>
            <th>1W</th>
            <th>1M</th>
            <th>SMA50</th>
            <th>52W High</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.ticker}-${index}`}>
              <td>{row.rank_today || index + 1}</td>
              <td><strong>{row.ticker}</strong></td>
              <td>{row.name || row.ticker}</td>
              <td>{row.sector || row.gics_sector || "Sin sector"}</td>
              <td><Badge tone="neutral">{row.setup_type || "SCANNER"}</Badge></td>
              <td>{number((row.score || 0) * 100, 1)}</td>
              <td>{usd(row.price)}</td>
              <td>{pct((row.ret_1w || 0) * 100)}</td>
              <td>{pct((row.ret_1m || 0) * 100)}</td>
              <td>{pct((row.dist_sma50 || 0) * 100)}</td>
              <td>{pct((row.pct_from_52w_high || 0) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailedList({ rows }) {
  if (!rows.length) {
    return <EmptyState icon={CheckCircle2} title="Sin fallos reportados" detail="La ultima ejecucion no devolvio errores de descarga." />;
  }

  return (
    <div className="daily-history">
      {rows.map((row) => (
        <div className="daily-row" key={row.symbol}>
          <span>{row.symbol}</span>
          <strong>Error</strong>
          <b className="negative">Yahoo</b>
          <em>{row.error}</em>
        </div>
      ))}
    </div>
  );
}

function DetailDrawer({ item, onClose }) {
  const shares = item.shares || (item.allocation ? Math.floor(item.allocation / Math.max(1, item.entryHigh || item.price)) : 0);
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <span className="eyebrow">{item.sector}</span>
          <h2>{item.ticker} - {item.name}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Cerrar detalle">
          <X size={18} />
        </button>
      </div>

      <div className="drawer-price">
        <strong>{usd(item.price)}</strong>
        <Badge tone={actionTone(item.action)}>{item.action}</Badge>
      </div>

      <div className="detail-grid">
        <InfoRow label="Entrada baja" value={usd(item.entryLow)} />
        <InfoRow label="Entrada maxima" value={usd(item.entryHigh)} />
        <InfoRow label="Stop" value={usd(item.stop)} />
        <InfoRow label="Take profit" value={usd(item.target)} />
        {item.insiderPublicationDate || item.signalDetectedAt ? (
          <InfoRow label="Comprar desde" value={formatFilingDateTime(item.insiderPublicationDateTime || item.insiderPublicationDate || item.signalDetectedAt)} />
        ) : null}
        {item.insiderTransactionDate ? <InfoRow label="Operacion insider" value={formatDateOnly(item.insiderTransactionDate)} /> : null}
        {item.signalDetectedAt ? <InfoRow label="Detectado bot" value={formatDateTime(item.signalDetectedAt)} /> : null}
        <InfoRow label="RSI" value={number(item.rsi, 1)} />
        <InfoRow label="MACD hist" value={number(item.macdHist, 3)} />
        <InfoRow label="R/R" value={number(item.rr, 2)} />
        <InfoRow label="Acciones aprox." value={shares || "-"} />
      </div>

      <div className="drawer-copy">
        <h3>Motivo</h3>
        <p>{item.reason}</p>
        <h3>Riesgo</h3>
        <p>{item.risk}</p>
      </div>
    </aside>
  );
}

function positionToSignal(position) {
  return mapApiRow({
    ticker: position.ticker,
    name: position.name,
    gics_sector: position.sector,
    Accion_Ejecucion: "MANTENER_POSICION",
    strategy_family: position.strategy,
    rank_today: position.sessions_held,
    last_close: position.current,
    entry_zone_low: position.entry,
    entry_zone_high: position.entry,
    invalid_below_price: position.stop,
    target_price: position.target,
    risk_reward_ratio: position.stop < position.current ? (position.target - position.current) / Math.max(0.01, position.current - position.stop) : 0,
    rsi14: 0,
    macd_hist: 0,
    portfolio_allowed: false,
    Motivo_Ejecucion: `Posicion abierta desde ${position.entry_date}. P&L ${money(position.pnl)} (${pct(position.pnl_pct)}).`,
    Plan_Orden: position.note || "Gestionar segun stop, take profit y tiempo maximo.",
  });
}

function movementTone(type = "") {
  if (type.includes("BUY")) return "buy";
  if (type.includes("STOP")) return "bad";
  if (type.includes("TP")) return "buy";
  if (type.includes("TIME")) return "wait";
  return "neutral";
}

function MetricCard({ icon: Icon, label, value, detail, tone = "neutral" }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon"><Icon size={19} /></div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Panel({ title, right, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ tone = "neutral", label }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function Badge({ tone, children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function EmptyState({ icon: Icon = Activity, title, detail }) {
  return (
    <div className="empty-state">
      <Icon size={22} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function Setting({ label, value }) {
  return (
    <div className="setting">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return "sin fecha";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateOnly(value) {
  if (!value) return "-";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return formatDate(value);
}

function formatFilingDateTime(value) {
  if (!value) return "-";
  const text = String(value);
  const secMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?\s*(ET)?$/i);
  if (secMatch) return `${secMatch[3]}/${secMatch[2]}/${secMatch[1]} ${secMatch[4]}:${secMatch[5]}${secMatch[6] ? " ET" : ""}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatDateOnly(text);
  return formatDateTime(text);
}

function formatDate(value) {
  if (!value) return "sin fecha";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMs(value) {
  const ms = Number(value || 0);
  if (!ms) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${number(ms / 1000, 1)} s`;
}

function shortSource(value) {
  if (!value) return "-";
  if (value.startsWith("fallback")) return "fallback";
  return value;
}

export default App;
