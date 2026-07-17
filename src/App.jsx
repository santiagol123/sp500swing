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
  LineChart,
  PieChart,
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import {
  backtest,
  buyToday,
  closedTrades,
  commissionPerSide,
  dailyHistory,
  equityCurve,
  portfolio,
  portfolioCash,
  strategies,
  ticketSize,
  watchlist,
} from "./mockData.js";
import { actionTone, makeSeries, mapApiRow, mergeApiData, money, number, pct, positionMetrics, usd } from "./utils.js";

const mockData = {
  buyToday,
  portfolio,
  watchlist,
  closedTrades,
  dailyHistory,
  equityCurve,
  strategies,
  backtest,
  meta: {
    mode: "mock",
    generatedAt: new Date().toISOString(),
    latestMarketDate: "2026-07-17",
    universeCount: 503,
    downloadedCount: 503,
    failedCount: 0,
  },
};

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "portfolio", label: "Cartera", icon: Briefcase },
  { id: "history", label: "Historico", icon: History },
  { id: "strategies", label: "Estrategias", icon: SlidersHorizontal },
  { id: "backtest", label: "Backtest", icon: BarChart3 },
  { id: "watchlist", label: "Watchlist", icon: Eye },
  { id: "settings", label: "Configuracion", icon: Settings },
];

function App() {
  const [view, setView] = useState("dashboard");
  const [data, setData] = useState(mockData);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Mockup listo");

  async function refreshSignals() {
    setLoading(true);
    try {
      const response = await fetch("/api/signals", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const payload = await response.json();
      setData(mergeApiData(mockData, payload));
      setStatusMessage("Datos API cargados");
    } catch (error) {
      setData(mockData);
      setStatusMessage("Mockup demo activo");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshSignals();
  }, []);

  const portfolioSummary = useMemo(() => getPortfolioSummary(data.portfolio), [data.portfolio]);
  const pageTitle = navItems.find((item) => item.id === view)?.label || "Dashboard";

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
          <strong>{money(ticketSize)}</strong>
          <span>{money(commissionPerSide)} compra + {money(commissionPerSide)} venta</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <p>
              Ultima actualizacion: {formatDateTime(data.meta.generatedAt)} · Mercado: {data.meta.latestMarketDate || "demo"}
            </p>
          </div>
          <div className="topbar-actions">
            <StatusPill tone={data.meta.mode === "api" ? "good" : "wait"} label={statusMessage} />
            <StatusPill tone="good" label="Bot online" />
            <button className="icon-button" onClick={refreshSignals} aria-label="Refrescar senales">
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        {view === "dashboard" && <Dashboard data={data} portfolioSummary={portfolioSummary} onSelect={setSelected} />}
        {view === "portfolio" && <PortfolioView data={data} summary={portfolioSummary} onSelect={setSelected} />}
        {view === "history" && <HistoryView data={data} />}
        {view === "strategies" && <StrategiesView data={data} />}
        {view === "backtest" && <BacktestView data={data} />}
        {view === "watchlist" && <WatchlistView data={data} onSelect={setSelected} />}
        {view === "settings" && <SettingsView data={data} />}
      </main>

      {selected && <DetailDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Dashboard({ data, portfolioSummary, onSelect }) {
  const executable = data.buyToday.filter((item) => item.action.includes("COMPRAR")).length;
  const blocked = data.buyToday.filter((item) => !item.action.includes("COMPRAR")).length;
  const avgRr = data.buyToday.reduce((acc, item) => acc + (item.rr || 0), 0) / Math.max(1, data.buyToday.length);

  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={Target} label="Compras ejecutables" value={executable} detail={`${blocked} en espera`} tone="good" />
        <MetricCard icon={ShieldCheck} label="Riesgo medio" value={number(avgRr, 2)} detail="Beneficio/riesgo scanner" />
        <MetricCard icon={Briefcase} label="P&L abierto" value={money(portfolioSummary.pnl)} detail={pct(portfolioSummary.pnlPct)} tone={portfolioSummary.pnl >= 0 ? "good" : "bad"} />
        <MetricCard icon={Activity} label="Universo" value={data.meta.downloadedCount || 503} detail={`${data.meta.failedCount || 0} fallos descarga`} />
      </div>

      <Panel
        title="Comprar hoy"
        right={<span className="panel-note">Orden limitada, no perseguir gaps</span>}
      >
        <SignalTable rows={data.buyToday} onSelect={onSelect} />
      </Panel>
    </section>
  );
}

function PortfolioView({ data, summary, onSelect }) {
  const sectorRows = groupBySector(data.portfolio);
  const pnlRows = data.portfolio.map((position) => ({ ...position, ...positionMetrics(position) }));

  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={Briefcase} label="Valor cartera" value={money(summary.marketValue + portfolioCash)} detail={`${summary.positions} posiciones`} />
        <MetricCard icon={TrendingUp} label="P&L abierto" value={money(summary.pnl)} detail={pct(summary.pnlPct)} tone={summary.pnl >= 0 ? "good" : "bad"} />
        <MetricCard icon={CalendarDays} label="Holding medio" value={`${number(summary.avgDays, 1)} dias`} detail="Maximo operativo 10/20 sesiones" />
        <MetricCard icon={AlertTriangle} label="Riesgo a stops" value={money(summary.stopRisk)} detail="Perdida si saltan todos" tone="wait" />
      </div>

      <div className="dashboard-grid">
        <Panel title="Curva de capital" className="wide">
          <LineSvg data={data.equityCurve.map((row) => row.value)} labels={data.equityCurve.map((row) => row.date)} />
        </Panel>
        <Panel title="Exposicion sectorial">
          <Donut rows={sectorRows} />
        </Panel>
      </div>

      <div className="dashboard-grid">
        <Panel title="P&L por posicion">
          <BarList rows={pnlRows.map((row) => ({ label: row.ticker, value: row.pnl, tone: row.pnl >= 0 ? "good" : "bad" }))} />
        </Panel>
        <Panel title="Progreso a salida">
          <ProgressList rows={pnlRows.map((row) => ({ label: row.ticker, value: progressToTarget(row), detail: `${pct(row.toTarget)} hasta TP` }))} />
        </Panel>
      </div>

      <Panel title="Posiciones abiertas">
        <PortfolioTable rows={data.portfolio} onSelect={onSelect} />
      </Panel>
    </section>
  );
}

function HistoryView({ data }) {
  const closed = data.closedTrades.map((trade) => {
    const gross = (trade.exit - trade.entry) * trade.shares;
    const pnl = gross - commissionPerSide * 2;
    return { ...trade, pnl, pnlPct: (pnl / (trade.entry * trade.shares)) * 100 };
  });
  const total = closed.reduce((acc, row) => acc + row.pnl, 0);
  const wins = closed.filter((row) => row.pnl > 0).length;

  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={ClipboardList} label="Operaciones cerradas" value={closed.length} detail={`${wins} ganadoras`} />
        <MetricCard icon={TrendingUp} label="P&L cerrado" value={money(total)} detail={pct((wins / Math.max(1, closed.length)) * 100, 0) + " win rate"} tone={total >= 0 ? "good" : "bad"} />
        <MetricCard icon={Activity} label="Dias monitorizados" value={data.dailyHistory.length} detail="Desde 22/06/2026" />
        <MetricCard icon={ShieldCheck} label="Stops evitables" value="3" detail="Casos para revisar filtro" tone="wait" />
      </div>

      <div className="dashboard-grid">
        <Panel title="Fluctuacion diaria" className="wide">
          <DailyHistory rows={data.dailyHistory} />
        </Panel>
        <Panel title="Resultado cerrado">
          <BarList rows={closed.map((row) => ({ label: row.ticker, value: row.pnl, tone: row.pnl >= 0 ? "good" : "bad" }))} />
        </Panel>
      </div>

      <Panel title="Historico de operaciones">
        <ClosedTradesTable rows={closed} />
      </Panel>
    </section>
  );
}

function StrategiesView({ data }) {
  return (
    <section className="page-stack">
      <Panel title="Comparativa de estrategias">
        <div className="strategy-grid">
          {data.strategies.map((strategy) => (
            <article className="strategy-card" key={strategy.name}>
              <div className="strategy-head">
                <strong>{strategy.name}</strong>
                <StatusPill tone={strategy.status === "Activo" ? "good" : "wait"} label={strategy.status} />
              </div>
              <div className="strategy-metrics">
                <span>Win rate <b>{number(strategy.winRate, 1)}%</b></span>
                <span>Expectancy <b>{number(strategy.expectancy, 2)}</b></span>
                <span>Max DD <b>{pct(strategy.maxDrawdown)}</b></span>
              </div>
              <MiniBars win={strategy.avgWin} loss={strategy.avgLoss} />
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Reglas operativas activas">
        <RulesGrid />
      </Panel>
    </section>
  );
}

function BacktestView({ data }) {
  const b = data.backtest;
  return (
    <section className="page-stack">
      <div className="kpi-grid">
        <MetricCard icon={LineChart} label="Retorno sistema" value={pct(b.systemReturn)} detail={b.range} tone="good" />
        <MetricCard icon={Activity} label="Retorno SPY" value={pct(b.spyReturn)} detail="Benchmark" />
        <MetricCard icon={ShieldCheck} label="Sharpe" value={number(b.sharpe, 2)} detail={`Max DD ${pct(b.maxDrawdown)}`} />
        <MetricCard icon={Target} label="Profit factor" value={number(b.profitFactor, 2)} detail={`${b.trades} operaciones`} />
      </div>

      <div className="dashboard-grid">
        <Panel title="Equity simulada" className="wide">
          <LineSvg data={[100, 104, 108, 105, 114, 121, 119, 132, 140, 147.8]} labels={["Ene", "Mar", "May", "Jul", "Sep", "Nov", "Ene", "Mar", "May", "Jul"]} />
        </Panel>
        <Panel title="Drawdown">
          <BarList rows={[
            { label: "2024", value: -4.1, tone: "bad" },
            { label: "2025", value: -8.7, tone: "bad" },
            { label: "2026", value: -5.9, tone: "bad" },
          ]} suffix="%" />
        </Panel>
      </div>

      <Panel title="Resumen backtest">
        <div className="backtest-table">
          <InfoRow label="Rentabilidad mensual aprox." value={pct(b.monthly)} />
          <InfoRow label="Win rate" value={pct(b.winRate)} />
          <InfoRow label="Holding medio" value={`${number(b.avgHold, 1)} sesiones`} />
          <InfoRow label="Comisiones incluidas" value={`${money(commissionPerSide)} por compra y venta`} />
        </div>
      </Panel>
    </section>
  );
}

function WatchlistView({ data, onSelect }) {
  return (
    <section className="page-stack">
      <Panel title="Radar de seguimiento" right={<span className="panel-note">No son compras automaticas</span>}>
        <SignalTable rows={data.watchlist} onSelect={onSelect} />
      </Panel>
    </section>
  );
}

function SettingsView({ data }) {
  return (
    <section className="page-stack">
      <Panel title="Parametros del bot">
        <div className="settings-grid">
          <Setting label="Capital por operacion" value={money(ticketSize)} />
          <Setting label="Comision compra" value={money(commissionPerSide)} />
          <Setting label="Comision venta" value={money(commissionPerSide)} />
          <Setting label="Max compras por dia" value={data.meta.rules?.max_new_buys_per_day || 3} />
          <Setting label="Max compras por sector" value={data.meta.rules?.max_buys_per_sector_per_day || 2} />
          <Setting label="Fuente actual" value={data.meta.mode === "api" ? "API Vercel" : "Mockup"} />
        </div>
      </Panel>
    </section>
  );
}

function SignalTable({ rows, onSelect }) {
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
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Entrada</th>
            <th>Acciones</th>
            <th>Precio actual</th>
            <th>P&L neto</th>
            <th>Stop</th>
            <th>TP</th>
            <th>Dias</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((position) => {
            const metrics = positionMetrics(position);
            return (
              <tr key={position.ticker}>
                <td><strong>{position.ticker}</strong><span className="muted-cell">{position.name}</span></td>
                <td>{usd(position.entry)}</td>
                <td>{position.shares}</td>
                <td>{usd(position.current)}</td>
                <td className={metrics.pnl >= 0 ? "positive" : "negative"}>{money(metrics.pnl)} · {pct(metrics.pnlPct)}</td>
                <td>{usd(position.stop)}</td>
                <td>{usd(position.target)}</td>
                <td>{position.daysHeld}/{position.maxDays}</td>
                <td>
                  <button className="row-action" onClick={() => onSelect(mapPositionToSignal(position))} aria-label={`Abrir ${position.ticker}`}>
                    <ChevronRight size={18} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClosedTradesTable({ rows }) {
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
            <th>P&L neto</th>
            <th>Estrategia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ticker}-${row.exitDate}`}>
              <td><strong>{row.ticker}</strong><span className="muted-cell">{row.name}</span></td>
              <td>{row.entryDate} · {usd(row.entry)}</td>
              <td>{row.exitDate} · {usd(row.exit)}</td>
              <td>{row.shares}</td>
              <td><Badge tone={row.result === "TP" ? "buy" : "bad"}>{row.result}</Badge></td>
              <td className={row.pnl >= 0 ? "positive" : "negative"}>{money(row.pnl)} · {pct(row.pnlPct)}</td>
              <td>{row.strategy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailDrawer({ item, onClose }) {
  const series = makeSeries(item.rank || item.price || 3, 36, item.price || 100);
  const shares = item.allocation ? Math.floor(item.allocation / Math.max(1, item.entryHigh || item.price)) : 0;
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <span className="eyebrow">{item.sector}</span>
          <h2>{item.ticker} · {item.name}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Cerrar detalle">
          <X size={18} />
        </button>
      </div>

      <div className="drawer-price">
        <strong>{usd(item.price)}</strong>
        <Badge tone={actionTone(item.action)}>{item.action}</Badge>
      </div>

      <LineSvg data={series} compact />

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

function LineSvg({ data, labels = [], compact = false }) {
  const width = compact ? 420 : 760;
  const height = compact ? 128 : 240;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(1, max - min);
  const points = data.map((value, index) => {
    const x = (index / Math.max(1, data.length - 1)) * (width - 24) + 12;
    const y = height - 18 - ((value - min) / span) * (height - 36);
    return `${x},${y}`;
  });
  const area = `12,${height - 18} ${points.join(" ")} ${width - 12},${height - 18}`;
  return (
    <div className={`chart-box ${compact ? "compact" : ""}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Grafico de linea">
        <polyline points={`12,${height - 18} ${width - 12},${height - 18}`} className="axis" />
        <polygon points={area} className="line-area" />
        <polyline points={points.join(" ")} className="line-main" />
        {!compact && labels.map((label, index) => (
          index % 2 === 0 ? <text key={label} x={(index / Math.max(1, labels.length - 1)) * (width - 24) + 12} y={height - 3}>{label}</text> : null
        ))}
      </svg>
    </div>
  );
}

function Donut({ rows }) {
  const total = rows.reduce((acc, row) => acc + row.value, 0) || 1;
  let offset = 25;
  return (
    <div className="donut-layout">
      <svg viewBox="0 0 160 160" className="donut">
        <circle cx="80" cy="80" r="54" className="donut-base" pathLength="100" />
        {rows.map((row, index) => {
          const part = (row.value / total) * 100;
          const stroke = ["#19734a", "#2f6fa3", "#bf7b21", "#6c5ce7", "#a12626"][index % 5];
          const circle = <circle key={row.label} cx="80" cy="80" r="54" className="donut-segment" pathLength="100" stroke={stroke} strokeDasharray={`${part} ${100 - part}`} strokeDashoffset={offset} />;
          offset -= part;
          return circle;
        })}
        <text x="80" y="78" textAnchor="middle" className="donut-value">{rows.length}</text>
        <text x="80" y="96" textAnchor="middle" className="donut-label">sectores</text>
      </svg>
      <div className="legend-list">
        {rows.map((row) => <InfoRow key={row.label} label={row.label} value={money(row.value)} />)}
      </div>
    </div>
  );
}

function BarList({ rows, suffix = "" }) {
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  return (
    <div className="bar-list">
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span>{row.label}</span>
          <div className="bar-track">
            <i className={row.tone} style={{ width: `${Math.max(6, (Math.abs(row.value) / max) * 100)}%` }} />
          </div>
          <strong className={row.value >= 0 ? "positive" : "negative"}>{suffix ? `${number(row.value, 1)}${suffix}` : money(row.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function ProgressList({ rows }) {
  return (
    <div className="progress-list">
      {rows.map((row) => (
        <div className="progress-row" key={row.label}>
          <div><strong>{row.label}</strong><span>{row.detail}</span></div>
          <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function DailyHistory({ rows }) {
  return (
    <div className="daily-history">
      {rows.map((row) => (
        <div className="daily-row" key={row.date}>
          <span>{row.date}</span>
          <strong>{money(row.value)}</strong>
          <b className={row.pnl >= 0 ? "positive" : "negative"}>{money(row.pnl)}</b>
          <em>{row.note}</em>
        </div>
      ))}
    </div>
  );
}

function MiniBars({ win, loss }) {
  const max = Math.max(Math.abs(win), Math.abs(loss), 1);
  return (
    <div className="mini-bars">
      <div><span>Win medio</span><i className="good" style={{ width: `${(Math.abs(win) / max) * 100}%` }} /><b>{pct(win)}</b></div>
      <div><span>Loss medio</span><i className="bad" style={{ width: `${(Math.abs(loss) / max) * 100}%` }} /><b>{pct(loss)}</b></div>
    </div>
  );
}

function RulesGrid() {
  const rules = [
    ["Entrada", "Solo limitada dentro de zona"],
    ["Tamano", "Acciones enteras sobre ticket de 2.000 EUR"],
    ["Comisiones", "2 EUR compra + 2 EUR venta"],
    ["Stop", "No ampliar stop tras entrar"],
    ["Salida", "TP, stop o tiempo maximo"],
    ["Filtro", "Evitar RSI extremo y MACD deteriorado"],
  ];
  return <div className="rules-grid">{rules.map(([label, value]) => <Setting key={label} label={label} value={value} />)}</div>;
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

function getPortfolioSummary(rows) {
  const enriched = rows.map(positionMetrics);
  const pnl = enriched.reduce((acc, row) => acc + row.pnl, 0);
  const invested = enriched.reduce((acc, row) => acc + row.invested, 0);
  const marketValue = rows.reduce((acc, row) => acc + row.current * row.shares, 0);
  const stopRisk = rows.reduce((acc, row) => acc + Math.max(0, (row.current - row.stop) * row.shares), 0);
  const avgDays = rows.reduce((acc, row) => acc + row.daysHeld, 0) / Math.max(1, rows.length);
  return { pnl, pnlPct: invested ? (pnl / invested) * 100 : 0, invested, marketValue, stopRisk, avgDays, positions: rows.length };
}

function groupBySector(rows) {
  const map = new Map();
  rows.forEach((row) => map.set(row.sector, (map.get(row.sector) || 0) + row.current * row.shares));
  return Array.from(map, ([label, value]) => ({ label, value }));
}

function progressToTarget(row) {
  const span = row.target - row.stop;
  if (span <= 0) return 0;
  return ((row.current - row.stop) / span) * 100;
}

function mapPositionToSignal(position) {
  const metrics = positionMetrics(position);
  return mapApiRow({
    ticker: position.ticker,
    name: position.name,
    gics_sector: position.sector,
    Accion_Ejecucion: "MANTENER_POSICION",
    strategy_family: position.strategy,
    rank_today: position.daysHeld,
    last_close: position.current,
    entry_zone_low: position.entry,
    entry_zone_high: position.entry,
    invalid_below_price: position.stop,
    target_price: position.target,
    risk_reward_ratio: Math.abs(metrics.toTarget / Math.min(-0.1, metrics.toStop)),
    rsi14: 56,
    macd_hist: metrics.pnl >= 0 ? 0.18 : -0.12,
    Motivo_Ejecucion: `Posicion abierta desde ${position.entryDate}. P&L neto ${money(metrics.pnl)}.`,
    Plan_Orden: "Mantener mientras no toque stop, take profit o tiempo maximo.",
  });
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

export default App;
