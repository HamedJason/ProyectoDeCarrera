#!/usr/bin/env node
/*
 * Pruebas minimas de la prueba de concepto, listas para pegar en el reporte.
 * Ejecuta contra el servidor desplegado (sin hardware, sin dependencias, Node 18+):
 *
 *   node medir_tiempos.js --url https://sentinelhome.ddns.net --token hv_XXXX \
 *        --email tu@correo.com --clave "tu clave"
 *   (con el token global antiguo agrega: --vivienda casa-001)
 *
 *   Con el servidor en HTTP: --url http://sentinelhome.ddns.net:8080
 *
 * Que hace:
 *   1. Diez transmisiones consecutivas de un contacto (abre/cierra), con codigo
 *      HTTP, latencia de la respuesta e id asignado en la base de datos.
 *   2. Para cada una, el tiempo hasta que el dato esta disponible para el
 *      frontend (se consulta igual que lo hace la aplicacion). Es la medicion
 *      aproximada sensor-frontend SIN el tramo inalambrico del nodo al hub.
 *   3. Una peticion sin token (debe dar 401) y una con datos incorrectos (debe
 *      dar 400 y no registrar nada).
 * Los registros de prueba usan el sensor "prueba-medicion"; se pueden borrar desde la app.
 * Sin --email/--clave se omite la parte 2.
 */
const a = process.argv.slice(2);
const opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const URL_BASE = opt('url', 'http://localhost:8080').replace(/\/+$/, '');
const VIVIENDA = opt('vivienda', '');   // solo con el token global antiguo (casa-001); con un token hv_ no hace falta
const TOKEN = opt('token', ''), EMAIL = opt('email', ''), CLAVE = opt('clave', '');
if (!TOKEN) { console.log('Falta --token (el hv_... de la vivienda).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = (extra = {}) => ({ 'X-Device-Token': TOKEN, 'Content-Type': 'application/json', ...extra });
let cookie = '';

async function pedir(ruta, { metodo = 'GET', headers = {}, json } = {}) {
  const t0 = performance.now();
  const r = await fetch(URL_BASE + ruta, { method: metodo, headers, body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(15000) });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, datos: d, ms: performance.now() - t0, t0, r };
}

async function entrar() {
  if (!EMAIL) return false;
  const r = await pedir('/auth/entrar', { metodo: 'POST', headers: { 'Content-Type': 'application/json' }, json: { email: EMAIL, clave: CLAVE } });
  if (r.status !== 200) { console.log('No se pudo iniciar sesion:', r.status, JSON.stringify(r.datos)); return false; }
  const sc = r.r.headers.getSetCookie ? r.r.headers.getSetCookie() : [];
  cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return !!cookie;
}

(async () => {
  const fecha = new Date().toISOString();
  console.log(`Servidor: ${URL_BASE}   Fecha: ${fecha}\n`);
  const sesion = await entrar();
  let viviendaId = null;   // se toma de la respuesta de la primera medicion (la vivienda de ese token)

  // ---- 1 y 2. Diez transmisiones consecutivas ----
  const filas = [];
  for (let i = 1; i <= 10; i++) {
    const valor = i % 2 ? 1 : 0;
    const nr = Date.now() % 1000000000 + i;
    const r = await pedir('/mediciones', { metodo: 'POST', headers: dev(), json: { ...(VIVIENDA ? { vivienda_id: VIVIENDA } : {}), zona: 'prueba', nodo_id: 'prueba-nodo', sensor_id: 'prueba-medicion', variable: 'estado_puerta', valor, unidad: 'estado', numero_registro: nr } });
    const id = r.datos && (r.datos.medicion ? r.datos.medicion.id : r.datos.id);
    if (!viviendaId && r.datos && r.datos.medicion) viviendaId = r.datos.medicion.vivienda_id;
    let visible = null;
    if (sesion && r.status === 201) {
      for (let k = 0; k < 100; k++) {                       // hasta 10 s, cada 100 ms
        const c = await pedir('/mediciones/ultima' + (viviendaId ? `?vivienda_id=${encodeURIComponent(viviendaId)}` : ''), { headers: { Cookie: cookie } });
        const m = c.datos && (c.datos.medicion || c.datos);
        if (m && Number(m.numero_registro) === nr) { visible = performance.now() - r.t0; break; }
        await sleep(100);
      }
    }
    filas.push({ i, evento: valor ? 'Apertura' : 'Cierre', valor, codigo: r.status, ms: Math.round(r.ms), id: id ?? '-', visible: visible === null ? '-' : Math.round(visible) });
    await sleep(300);
  }
  console.log('| No. | Evento | Valor | Codigo HTTP | Latencia de respuesta (ms) | Id en la base | Disponible para el frontend (ms) |');
  console.log('|---|---|---|---|---|---|---|');
  for (const f of filas) console.log(`| ${f.i} | ${f.evento} | ${f.valor} | ${f.codigo} | ${f.ms} | ${f.id} | ${f.visible} |`);
  const ok = filas.filter((f) => f.codigo === 201);
  const lat = ok.map((f) => f.ms), vis = filas.map((f) => f.visible).filter((x) => x !== '-');
  const prom = (x) => x.length ? (x.reduce((s, v) => s + v, 0) / x.length).toFixed(1) : '-';
  console.log(`\nTransmisiones: 10   Exitosas (201): ${ok.length}   Fallidas: ${10 - ok.length}`);
  console.log(`Latencia de respuesta: promedio ${prom(lat)} ms, minimo ${lat.length ? Math.min(...lat) : '-'}, maximo ${lat.length ? Math.max(...lat) : '-'}`);
  if (vis.length) console.log(`Hasta estar disponible para el frontend: promedio ${prom(vis)} ms, minimo ${Math.min(...vis)}, maximo ${Math.max(...vis)} (${vis.length} de 10 medidas)`);
  else console.log('Disponibilidad para el frontend: no medida (faltan --email y --clave).');

  // ---- 3. Pruebas de rechazo ----
  console.log('\n| Prueba | Esperado | Obtenido |');
  console.log('|---|---|---|');
  const sinToken = await pedir('/mediciones', { metodo: 'POST', headers: { 'Content-Type': 'application/json' }, json: { zona: 'prueba', nodo_id: 'prueba-nodo', sensor_id: 'prueba-medicion', variable: 'estado_puerta', valor: 1 } });
  console.log(`| Medicion sin el encabezado X-Device-Token | 401, sin registrar | ${sinToken.status}: ${sinToken.datos && sinToken.datos.mensaje} |`);
  const mala = await pedir('/mediciones', { metodo: 'POST', headers: dev(), json: { ...(VIVIENDA ? { vivienda_id: VIVIENDA } : {}), zona: 'prueba', nodo_id: 'prueba-nodo', variable: 'estado_puerta', valor: 'abierto' } });
  console.log(`| Sin sensor_id y con valor no numerico | 400, enumera los errores | ${mala.status}: ${mala.datos && JSON.stringify(mala.datos.errores)} |`);
  const tokenMalo = await fetch(URL_BASE + '/mediciones', { method: 'POST', headers: { 'X-Device-Token': 'hv_invalido', 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`| Token incorrecto | 401 | ${tokenMalo.status} |`);
})().catch((e) => { console.error('Fallo:', e.message); process.exit(1); });
