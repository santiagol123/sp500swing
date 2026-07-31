# Market Radar Bot para Vercel

Bot autonomo para escoger acciones del S&P 500 sin ChatGPT y sin tokens de API.

Dos estrategias independientes, cada una con su cartera de paper trading, y una
pantalla que las compara.

## Workspaces

Un workspace es una estrategia + su cartera aislada. Se cambia con el selector
de la pagina o con `?workspace=<id>` en la API.

| Workspace  | Que busca | Fuente | Se calcula |
|------------|-----------|--------|------------|
| `momentum` | Pullbacks en tendencia (`CORE_PULLBACK`) y continuaciones de ruptura (`BREAKOUT_CONTINUATION`), por ranking transversal de momentum, fuerza relativa y volumen. | Yahoo Finance chart API | En vivo, en cada peticion |
| `insider`  | Clusters de compras de directivos: 2 o mas insiders distintos comprando la misma empresa en mercado abierto dentro de 30 dias. | SEC EDGAR, formulario 4 | Por el GitHub Action (ver abajo) |

Anadir una tercera estrategia es crear `lib/strategies/<id>.js` con la misma
interfaz (`{ id, label, run }`), registrarla en `lib/strategies/index.js` y
anadir su entrada en `lib/workspaces.js`.

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

## El ranking

`/leaderboard.html` compara las estrategias. Es importante entender que mide:

- Es **paper trading hacia delante, no un backtest**. No reproduce el pasado:
  registra lo que pasa a partir del dia que lo despliegas. Todo lo que aparece
  ahi es out-of-sample por construccion.
- **Empieza vacio.** Hasta que el tracker no acumule dias y operaciones cerradas,
  la pantalla lo dice en vez de coronar a un ganador inventado.
- Cada estrategia lleva una etiqueta de fiabilidad segun operaciones cerradas
  (`insuficiente` <10, `baja` <30, `media` <100, `alta` >=100). Con menos de 10
  operaciones el ranking no significa nada y la pantalla lo advierte.
- Ambos workspaces usan **el mismo capital inicial, los mismos limites de
  posiciones y sector, y los mismos costes**. Lo unico que cambia es que acciones
  elige cada estrategia, que es justo lo que se quiere comparar.

Reglas del motor de cartera (`lib/portfolio.js`): entrada al cierre del dia de la
senal, salida por stop, objetivo o limite de dias. Si una vela toca stop y
objetivo el mismo dia se asume el stop, porque con velas diarias no se sabe cual
llego antes y suponer lo contrario infla los resultados. Se aplica un coste de
0,05% por lado.

## Endpoints

- `GET /api/signals?workspace=momentum` - senales del workspace + posiciones abiertas
- `GET /api/leaderboard` - ranking, metricas y curvas de capital
- `GET /api/health`
- `/` - pantalla de senales con selector de workspace
- `/leaderboard.html` - pantalla de ranking

## Probar local

```bash
npm run scan
```

Menos simbolos para iterar rapido:

```bash
npm run scan:fast
```

Escanear insiders (tarda: la SEC limita a 10 peticiones por segundo):

```bash
npm run scan:insider
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

## SEC EDGAR

Es gratis y sin token, pero la SEC exige un User-Agent identificable con un
contacto real y limita a 10 peticiones por segundo. Ambas cosas estan en
`lib/edgar.js`. Para cambiar el contacto, define la variable `SEC_USER_AGENT`
(en local, o como repository variable para el Action).

## Desplegar

```bash
npx vercel deploy --prod
```

No hacen falta variables de entorno. Opcionales:

- `SCANNER_CONCURRENCY`: concurrencia de descargas Yahoo. Por defecto `24`.
- `MAX_SYMBOLS`: limite de simbolos para depurar. En produccion no lo uses.
- `SEC_USER_AGENT`: contacto que se envia a la SEC.
- `SEC_RPS`: peticiones por segundo a la SEC. Por defecto `8`, no subir de `10`.

## Limites

En Vercel Hobby la funcion debe quedar por debajo de 60 segundos. El escaner de
momentum entra de sobra (unos 3 segundos para 500 simbolos). El de insiders **no
cabe**: recorrer el S&P 500 contra la SEC son mas de 500 peticiones a 10/s. Por eso
`insider` se calcula en el Action y la API sirve el ultimo snapshot; la pagina
indica siempre si lo que ves es calculo en vivo o snapshot, y de cuando.

Si Yahoo empieza a limitar, baja `SCANNER_CONCURRENCY` a `12` o `8`.

## Uso operativo

La tabla que manda es `recommendations`.

- Comprar solo si `action = COMPRAR_LIMITADA`.
- No comprar a mercado.
- Usar `entry_zone_high` como precio maximo.
- Usar `invalid_below_price` como stop.
- Usar `target_price` como take profit.

El paper trading es una simulacion para comparar estrategias, no un registro de
tus operaciones reales.
