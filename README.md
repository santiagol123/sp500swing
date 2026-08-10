# Market Radar Quant Bot para Vercel

Bot autonomo para escoger acciones del S&P 500 sin tokens de API.

Tres estrategias independientes, cada una con su cartera de paper trading, y una
pantalla que las compara.

## Que hace

- Descarga universo S&P 500 desde Wikipedia.
- Usa Yahoo Finance public chart API, sin token.
- Calcula momentum, setups, RSI, MACD, stops, take profit y beneficio/riesgo.
- Detecta compras agrupadas de directivos en SEC EDGAR (formulario 4), sin token.
- Expone `/api/signals` y `/api/leaderboard` en JSON.
- Incluye una app Vite/React en `/` para ver dashboard, cartera, historico, radar, ranking tecnico, ejecucion y configuracion con datos reales de `/api/signals`.
- Lee la cartera real desde `data/portfolio.json` y la valora con los ultimos precios descargados de Yahoo Finance.
- Vercel Cron llama `/api/signals` en dias laborables para calentar cache.

## Workspaces

Un workspace es una estrategia + su cartera simulada aislada. Se cambia con el
selector de la app o con `?workspace=<id>` en la API.

| Workspace  | Que busca | Fuente | Se calcula |
|------------|-----------|--------|------------|
| `momentum` | Pullbacks en tendencia (`CORE_PULLBACK`) y continuaciones de ruptura (`BREAKOUT_CONTINUATION`), con filtro de regimen de mercado e integracion con la cartera real. | Yahoo Finance chart API | En vivo, en cada peticion |
| `insider`  | Clusters de compras de directivos: 2 o mas insiders distintos comprando la misma empresa en mercado abierto dentro de 30 dias. | SEC EDGAR, formulario 4 | Por el GitHub Action (ver abajo) |
| `insider_total` | ChatGPT SP500: compras fuertes de insiders del S&P 500, filtrando Form 4 codigo P/Dataroma por clusters, seniority, importe material y filing reciente; salida a 5 sesiones. | SEC EDGAR + Dataroma + Yahoo Finance | Por el GitHub Action (ver abajo) |

Anadir una tercera estrategia es crear `lib/strategies/<id>.js` con la misma
interfaz (`{ id, label, run }`), registrarla en `lib/strategies/index.js` y
anadir su entrada en `lib/workspaces.js`. La API traduce sola la forma comun de
senal al contrato que consume el frontend, asi que no hay que tocar la UI.

### Ojo con los dos "portfolio"

Son cosas distintas y conviven a proposito:

- `lib/portfolio.js` + `data/portfolio.json`: la cartera **real**, con precios de
  compra reales. Es la que sale en `payload.portfolio` y en la vista Cartera.
- `lib/papertrading.js` + `data/history/`: el **simulador** que alimenta el
  ranking. Sale en `payload.paper_portfolio`. No es dinero real.

## La estrategia de insiders

Solo cuenta el **codigo P** del formulario 4, que es una compra voluntaria en
mercado abierto. Se ignoran las concesiones de acciones (A), los ejercicios de
opciones (M) y las retenciones fiscales (F): no expresan conviccion.

Ademas exige que compren **varios insiders distintos**. Una compra suelta es
ruido; la senal que mejor aguanta el escrutinio academico es la compra agrupada.
Filtros actuales (en `lib/strategies/insider.js`):

- 2+ directivos o consejeros distintos
- dentro de una ventana de 30 dias
- importe conjunto minimo 50.000 USD
- la compra mas reciente, como mucho de hace 15 dias (la ventaja decae rapido)

**Estas senales son escasas.** Medido sobre 60 empresas y 180 dias: 2.680
formularios 4 leidos, 41 compras de insider, y solo 3 empresas con cluster.
Extrapolado al indice completo son del orden de 2 a 4 senales accionables al mes.
Es lo normal en esta estrategia, pero significa que su cartera acumulara
operaciones despacio.

`insider_total` se reutiliza como la pestaña `ChatGPT SP500`. Automatiza el chat
de conviccion insider: no compra cualquier insider buying, sino solo senales con
Form 4 codigo P/Dataroma, varios insiders o una compra individual muy material
de CEO/fundador/C-level, importe material, filing reciente y sin plan 10b5-1
cuando ese dato aparece en el Form 4. La tesis es de evento corto: si no toca
stop ni take profit antes, se cierra a 5 sesiones. En esta pestaña, las senales
que pasan filtro no se sustituyen por otras con mejor puntuacion: se mantienen
en cartera hasta su salida temporal, stop u objetivo, mientras quepa en el
limite global de posiciones.

## El ranking

`/leaderboard.html` compara las estrategias. Es importante entender que mide:

- Es **paper trading hacia delante, no un backtest**. No reproduce el pasado:
  registra lo que pasa a partir del dia que lo despliegas.
- **Empieza vacio.** Hasta que el tracker no acumule dias y operaciones cerradas,
  la pantalla lo dice en vez de coronar a un ganador inventado.
- Cada estrategia lleva una etiqueta de fiabilidad segun operaciones cerradas
  (`insuficiente` <10, `baja` <30, `media` <100, `alta` >=100).
- Ambos workspaces usan **el mismo capital inicial, los mismos limites de
  posiciones y sector, y los mismos costes**. Lo unico que cambia es que acciones
  elige cada estrategia, que es justo lo que se quiere comparar.

Reglas del simulador (`lib/papertrading.js`): entrada al cierre del dia de la
senal, salida por stop, objetivo o limite de dias. Si una vela toca stop y
objetivo el mismo dia se asume el stop, porque con velas diarias no se sabe cual
llego antes y suponer lo contrario infla los resultados. Coste de 0,05% por lado.

## Cartera real

La cartera operativa se guarda en `data/portfolio.json` y el scanner la
reconstruye en cada ejecucion desde `as_of` hasta la ultima vela disponible:

- Las recomendaciones autorizadas de cada dia reproducido se agregan como compras automaticas.
- Si una vela posterior toca `stop` o `target`, la posicion pasa a cerradas (`STOP` / `TP`).
- Si supera `max_sessions`, se cierra como `TIME_EXIT`.
- `portfolio.movements` lista altas y bajas; `portfolio.automation` cuenta cuantas detecto.

La funcion no escribe en disco en Vercel: recalcula el estado actual cada vez con
datos reales de mercado.

## Endpoints

- `GET /api/signals?workspace=momentum` - senales del workspace, cartera real y cartera simulada
- `GET /api/leaderboard` - ranking, metricas y curvas de capital
- `GET /api/health`
- `/` - app Vite/React
- `/leaderboard.html` - pantalla de ranking

## Probar local

Instala dependencias la primera vez:

```bash
npm install
```

Arranca el front Vite (sirve tambien `/api/signals` y `/api/leaderboard`):

```bash
npm run dev
```

Para apuntar el front local a un despliegue de Vercel, define `VITE_SIGNALS_API_URL`
con la URL completa de `/api/signals`.

Ejecutar el scanner por consola:

```bash
npm run scan
```

Escanear insiders (tarda: la SEC limita a 10 peticiones por segundo):

```bash
npm run scan:insider
```

Escanear la estrategia ChatGPT SP500:

```bash
npm run scan:chatgpt-sp500
```

Registrar un dia de paper trading en ambos workspaces:

```bash
npm run track
```

## El tracker y el historial

El ranking sale de `data/history/<workspace>/state.json`, que escribe
`scripts/track.js` y commitea el workflow `.github/workflows/track.yml` de lunes
a viernes a las 21:30 UTC, despues del cierre USA.

Se hace asi, y no con base de datos, para que la app desplegada siga sin
necesitar ninguna variable de entorno ni token: el Action escribe, Vercel solo
lee. El precio es un commit diario en el historial de git.

El tracker es idempotente por dia de mercado: si corre dos veces el mismo dia, la
segunda no duplica operaciones.

**Para activarlo hace falta dar permiso de escritura al Action**: en GitHub,
Settings > Actions > General > Workflow permissions > Read and write permissions.
Sin eso el `git push` del ultimo paso falla.

### Coste de la primera ejecucion

La primera vez, el escaneo de insiders descarga unos 11.000 formularios 4 a 8
peticiones por segundo: unos 25 minutos. Despues, la cache de accessions
(`data/history/insider/filings.json`) hace que solo se descarguen los nuevos, y
baja a 2-3 minutos por dia. Un formulario ya presentado no cambia nunca, asi que
la cache es permanente.

ChatGPT SP500 reutiliza la cache SEC de `insider` y anade Dataroma/Yahoo para
puntuar conviccion. Como toca SEC EDGAR, tambien se calcula en el Action y la
app sirve el ultimo snapshot, sin base de datos ni servicios extra.

## SEC EDGAR

Es gratis y sin token, pero la SEC exige un User-Agent identificable con un
contacto real y limita a 10 peticiones por segundo. Ambas cosas estan en
`lib/edgar.js`. Para cambiar el contacto, define `SEC_USER_AGENT` (en local, o
como repository variable para el Action).

## Desplegar

```bash
npm run build
npx vercel deploy --prod
```

No hacen falta variables de entorno. Opcionales:

- `SCANNER_CONCURRENCY`: concurrencia de descargas Yahoo. Por defecto `24`.
- `MAX_SYMBOLS`: limite de simbolos para depurar. En produccion no lo uses.
- `SEC_USER_AGENT`: contacto que se envia a la SEC.
- `SEC_RPS`: peticiones por segundo a la SEC. Por defecto `8`, no subir de `10`.
- `CHATGPT_SP500_MIN_VALUE_USD`: importe minimo agregado para la pestaña ChatGPT SP500. Por defecto `250000`.
- `CHATGPT_SP500_MIN_INSIDERS`: minimo de insiders distintos. Por defecto `2`.
- `CHATGPT_SP500_MIN_SINGLE_SENIOR_VALUE_USD`: compra individual minima para aceptar un CEO/fundador/C-level aunque no haya cluster. Por defecto `500000`.
- `CHATGPT_SP500_MAX_AUTHORIZED_BUYS`: maximo de senales ChatGPT SP500 autorizadas por snapshot. Por defecto `12`.
- `CHATGPT_SP500_MAX_NEW_POSITIONS_PER_DAY`: maximo de aperturas diarias para ChatGPT SP500. Por defecto igual al maximo global de posiciones abiertas.
- `CHATGPT_SP500_MAX_POSITIONS_PER_SECTOR`: maximo de posiciones por sector para ChatGPT SP500. Por defecto igual al maximo global de posiciones abiertas.
- `CHATGPT_SP500_SIGNAL_FILING_FRESH_DAYS`: antiguedad maxima normal del filing. Por defecto `20`.
- `CHATGPT_SP500_MAX_HOLD_DAYS`: sesiones maximas antes de cierre temporal. Por defecto `5`.

## Cron

`vercel.json` programa dos llamadas de lunes a viernes:

- `14:35 UTC`, poco despues de la apertura USA.
- `18:00 UTC`, revision intradia.

La ruta programada es `/api/signals`.

## Limites

En Vercel Hobby la funcion debe quedar por debajo de 60 segundos. El escaner de
momentum entra de sobra. El de insiders **no cabe**: recorrer el S&P 500 contra
la SEC son mas de 500 peticiones a 10/s. Por eso `insider` se calcula en el
Action y la API sirve el ultimo snapshot; la app indica siempre si lo que ves es
calculo en vivo o snapshot, y de cuando.

Si Yahoo empieza a limitar, baja `SCANNER_CONCURRENCY` a `12` o `8`.

## Uso operativo

La tabla que manda el bot es `recommendations`, y el front la muestra en
Dashboard cuando `/api/signals` esta disponible.

- Comprar solo si `Accion_Ejecucion = COMPRAR_LIMITADA`.
- No comprar a mercado.
- Usar `entry_zone_high` como precio maximo.
- Usar `invalid_below_price` como stop.
- Usar `target_price` como take profit.

El paper trading es una simulacion para comparar estrategias, no un registro de
tus operaciones reales.
