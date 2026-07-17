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
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  TrendingUp,
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
  meta: {
    mode: "loading",
    generatedAt: null,
    latestMarketDate: null,
    universeSource: null,
    universeCount: 0,
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: 0,
    dashboard: {},
    rules: {},
  },
};

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "portfolio", label: "Cartera", icon: Briefcase },
  { id: "history", label: "Historico", icon: History },
  { id: "radar", label: "Radar", icon: Eye },
  { id: "ranking", label: "Ranking", icon: BarChart3 },
  { id: "run", label: "Ejecucion", icon: ClipboardList },
  { id: "settings", label: "Configuracion", icon: Settings },
];

function App() {
  const [view, setView] = useState("dashboard");
  const [data, setData] = useState(initialData);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Cargando datos reales");

  async function refreshSignals() {
    setLoading(true);
    try {
      const response = await fetch(signalsEndpoint, {
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
    } finally {
      setLoading(false);
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

        <div className="sidebar-card">
          <span className="sidebar-label">Ticket base</span>
          <strong>{money(data.portfolioSource.ticketSize || ticketSize)}</strong>
          <span>{money(data.portfolioSource.commissionPerSide || commissionPerSide)} compra + venta</span>
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
            <StatusPill tone={statusTone} label={statusMessage} />
            <StatusPill tone="neutral" label={data.meta.universeSource || "scanner"} />
            <button className="icon-button" onClick={refreshSignals} aria-label="Refrescar senales">
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        {view === "dashboard" && <Dashboard data={data} onSelect={setSelected} />}
        {view === "portfolio" && <PortfolioView data={data} onSelect={setSelected} />}
        {view === "history" && <HistoryView data={data} />}
        {view === "radar" && <RadarView data={data} onSelect={setSelected} />}
        {view === "ranking" && <RankingView data={data} />}
        {view === "run" && <RunView data={data} />}
        {view === "settings" && <SettingsView data={data} />}
      </main>

      {selected && <DetailDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Dashboard({ data, onSelect }) {
  const dashboard = data.meta.dashboard || {};
  const summary = data.portfolioSummary || initialData.portfolioSummary;
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
        <MetricCard icon={Briefcase} label="Cartera abierta" value={summary.open_positions || 0} detail={`${money(summary.market_value || 0)} valor actual`} />
        <MetricCard icon={TrendingUp} label="P&L abierto" value={money(summary.open_pnl || 0)} detail={pct(summary.open_pnl_pct || 0)} tone={(summary.open_pnl || 0) >= 0 ? "good" : "bad"} />
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
  const summary = data.portfolioSummary || initialData.portfolioSummary;
  const autoClosed = data.portfolioSource.automation?.auto_closed_count || 0;
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={History} label="Operaciones cerradas" value={summary.closed_trades || 0} detail={`${number(summary.win_rate || 0, 1)}% win rate`} />
        <MetricCard icon={TrendingUp} label="P&L cerrado" value={money(summary.closed_pnl || 0)} detail="Con comisiones" tone={(summary.closed_pnl || 0) >= 0 ? "good" : "bad"} />
        <MetricCard icon={Activity} label="P&L total" value={money(summary.total_pnl || 0)} detail="Abierto + cerrado" tone={(summary.total_pnl || 0) >= 0 ? "good" : "bad"} />
        <MetricCard icon={ShieldCheck} label="Auto cierres" value={autoClosed} detail={data.portfolioSource.asOf || "Fecha de cartera"} />
      </div>

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
  return (
    <section className="page-stack">
      <Panel title="Parametros del bot">
        <div className="settings-grid">
          <Setting label="Capital por operacion" value={money(data.portfolioSource.ticketSize || ticketSize)} />
          <Setting label="Comision compra" value={money(data.portfolioSource.commissionPerSide || commissionPerSide)} />
          <Setting label="Comision venta" value={money(data.portfolioSource.commissionPerSide || commissionPerSide)} />
          <Setting label="Max compras por dia" value={rules.max_new_buys_per_day || 3} />
          <Setting label="Max compras por sector" value={rules.max_buys_per_sector_per_day || 2} />
          <Setting label="Fuente cartera" value={data.portfolioSource.asOf || "Sin cartera"} />
          <Setting label="Auto cartera" value={automation.mode || "Sin automatizacion"} />
        </div>
      </Panel>

      <Panel title="Reglas operativas activas">
        <div className="rules-grid">
          <Setting label="Entrada" value="Solo limitada dentro de zona" />
          <Setting label="Tamano" value={`Acciones enteras sobre ticket de ${money(data.portfolioSource.ticketSize || ticketSize)}`} />
          <Setting label="Stop" value="No ampliar stop tras entrar" />
          <Setting label="Salida" value="TP, stop o tiempo maximo" />
          <Setting label="Filtro" value="Evitar RSI extremo y MACD deteriorado" />
          <Setting label="Nota" value={rules.note || "No comprar a mercado"} />
        </div>
      </Panel>
    </section>
  );
}

function SignalTable({ rows, onSelect, emptyTitle = "Sin datos reales" }) {
  if (!rows.length) {
    return <EmptyState icon={Activity} title={emptyTitle} detail="La tabla se llenara cuando /api/signals devuelva filas reales." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Empresa</th>
            <th>Accion</th>
            <th>Estrategia</th>
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
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.auto_closed ? "Auto - " : ""}{row.name}</span></td>
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
