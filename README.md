# Market Radar Bot para Vercel

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
- Tiene una pagina simple en `/` para ver la decision.
- Vercel Cron llama `/api/signals` en dias laborables para calentar cache.

## Importante sobre Vercel sin tokens

Sin base de datos ni storage no hay historico persistente en Vercel. La funcion calcula y devuelve la senal actual; Vercel puede cachear la respuesta, pero si quieres guardar historico real dia a dia hace falta almacenamiento externo, por ejemplo Vercel KV/Postgres/Blob o GitHub, y eso normalmente requiere credenciales.

## Probar local

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

La tabla que manda es `recommendations`.

- Comprar solo si `Accion_Ejecucion = COMPRAR_LIMITADA`.
- No comprar a mercado.
- Usar `entry_zone_high` como precio maximo.
- Usar `invalid_below_price` como stop.
- Usar `target_price` como take profit.
