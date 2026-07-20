# Market Radar Quant Bot para Vercel

Bot autonomo para escoger acciones del S&P 500 sin ChatGPT y sin tokens de API.

## Que hace

- Descarga universo S&P 500 desde Wikipedia.
- Usa Yahoo Finance public chart API, sin token.
- Calcula momentum, setups, RSI, MACD, stops, take profit y beneficio/riesgo.
- Aplica las reglas actuales del optimizador:
  - `CORE_PULLBACK`
  - `BREAKOUT_CONTINUATION`
  - maximo 3 compras nuevas al dia
  - maximo 2 compras por sector
- Expone `/api/signals` en JSON.
- Incluye una app Vite/React en `/` para ver dashboard, cartera, historico, radar, ranking tecnico, ejecucion y configuracion con datos reales de `/api/signals`.
- Lee la cartera real desde `data/portfolio.json`, extraida del documento `Script bolsa sp500 codex.docx`, y la valora con los ultimos precios descargados de Yahoo Finance.
- Vercel Cron llama `/api/signals` en dias laborables para calentar cache.

## Importante sobre Vercel sin tokens

Sin base de datos ni storage no hay historico persistente en Vercel. La funcion calcula y devuelve la senal actual; Vercel puede cachear la respuesta, pero si quieres guardar historico real dia a dia hace falta almacenamiento externo, por ejemplo Vercel KV/Postgres/Blob o GitHub, y eso normalmente requiere credenciales.

## Probar local

Instala dependencias la primera vez:

```bash
cd vercel_bot
npm install
```

Arranca el front Vite:

```bash
cd vercel_bot
npm run dev
```

La app intenta leer `/api/signals`. Si quieres apuntar el front local a un despliegue de Vercel, define `VITE_SIGNALS_API_URL` con la URL completa de `/api/signals`.

No hay datos demo en el front: si la API real no responde, la interfaz muestra estado vacio y el error de carga.

## Cartera actual

La cartera operativa se guarda en `data/portfolio.json`.

- Posiciones abiertas a 17/07/2026: `MNST`, `CPAY`, `V`, `CTVA`, `EG`, `CFG`.
- Operaciones cerradas cargadas: `MAR`, `NTRS`, `HWM`, `SPG`, `MS`.
- El scanner cuenta las compras ya ejecutadas hoy y no recomienda duplicar tickers abiertos.

## Actualizacion automatica de cartera en Vercel Free

Vercel Free no ofrece disco persistente para que `/api/signals` edite archivos en produccion. Para mantenerlo gratis, la cartera se actualiza de forma derivada en cada ejecucion:

- `data/portfolio.json` es el ledger base versionado.
- Cada llamada a `/api/signals` descarga historico Yahoo y reconstruye el ledger desde `data/portfolio.json.as_of` hasta la ultima vela disponible.
- Las recomendaciones autorizadas de cada dia reproducido (`COMPRAR_LIMITADA` / `COMPRAR_1_2_PULLBACK`) se agregan a la cartera de la respuesta como compras automaticas.
- Si una vela posterior al dia de entrada toca `stop`, la posicion se mueve a cerradas en la respuesta como `STOP`.
- Si una vela posterior al dia de entrada toca `target`, se mueve a cerradas como `TP`.
- Si supera `max_sessions`, se mueve a cerradas como `TIME_EXIT`.
- La API devuelve `portfolio.movements` con altas y bajas de cartera (`BUY_AUTO`, `SELL_AUTO_STOP`, `SELL_AUTO_TP`, etc.).
- La API devuelve `portfolio.automation.auto_opened_count` y `portfolio.automation.auto_closed_count` para indicar cuantos movimientos detecto automaticamente.

La funcion no escribe en disco en Vercel; recalcula el estado actual cada vez usando datos reales de mercado. Esto permite que una compra automatica de ayer siga apareciendo manana aunque ya no salga como recomendacion nueva.

Ejecuta el scanner por consola:

```bash
cd vercel_bot
npm run scan
```

Prueba rapida con menos simbolos:

```bash
npm run scan:fast
```

## Desplegar

```bash
cd vercel_bot
npm run build
npx vercel deploy --prod
```

No hacen falta variables de entorno. Opcionales:

- `SCANNER_CONCURRENCY`: concurrencia de descargas Yahoo. Por defecto `24`.
- `MAX_SYMBOLS`: limite de simbolos para depurar. En produccion no lo uses.

## Cron

`vercel.json` programa dos llamadas de lunes a viernes:

- `14:35 UTC`, poco despues de la apertura USA.
- `18:00 UTC`, revision intradia.

La ruta programada es `/api/signals`.

## Limites

En Vercel Hobby conviene mantener la funcion por debajo de 60 segundos. Este scanner usa Node puro y llamadas Yahoo paralelas, normalmente mucho mas rapido que el script Python con `yfinance`, pero Yahoo puede rate-limitar. Si ocurre, baja `SCANNER_CONCURRENCY` a `12` o `8`.

## Uso operativo

La tabla que manda el bot es `recommendations`, y el front la muestra en Dashboard cuando `/api/signals` esta disponible.

- Comprar solo si `Accion_Ejecucion = COMPRAR_LIMITADA`.
- No comprar a mercado.
- Usar `entry_zone_high` como precio maximo.
- Usar `invalid_below_price` como stop.
- Usar `target_price` como take profit.
