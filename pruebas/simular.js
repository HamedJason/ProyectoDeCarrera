#!/usr/bin/env node
/*
 * Simulador de dispositivos para probar el servidor SIN hardware.
 * Se comporta como el concentrador, un nodo C3 y la camara, con los mismos
 * mensajes que el firmware real. Requiere Node 18 o superior (sin dependencias).
 *
 * Uso:
 *   node simular.js --url https://sentinelhome.ddns.net --token hv_xxx <modo>
 *   (con el servidor en HTTP plano, usa --url http://sentinelhome.ddns.net:8080)
 *
 * Modos:
 *   registro   el hub reporta un nodo C3 nuevo con 2 contactos y un PIR.
 *              Deben aparecer en la app con la etiqueta "Nuevo".
 *   alarma     manda un evento de puerta abierta y el aviso de alarma (con el
 *              retraso_ms del hub). Con la casa ARMADA debe llegar el push, y si
 *              la camara simulada esta corriendo, se toman 3 fotos.
 *   latidos    solo latidos cada 30 s (para ver hub y nodo "en linea"); detenlo
 *              con Ctrl+C y espera ~2 min para probar el aviso de "sin senal".
 *   camara     simula la camara: pregunta tareas y responde fotos y vista en vivo.
 *   estado     imprime el estado de la casa tal como lo ve el hub.
 */

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modo = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))[0];
const URL_BASE = (opt('url', 'http://localhost:8080')).replace(/\/+$/, '');
const TOKEN = opt('token', '');
const NODO = opt('nodo', 'c3-sim001');

if (!modo || !TOKEN) {
  console.log('Uso: node simular.js --url <URL> --token <hv_...> <registro|alarma|latidos|camara|estado>');
  process.exit(1);
}

// JPEG minimo valido (332 bytes) para fotos y cuadros de prueba
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APv8/9k=', 'base64');

async function api(ruta, { metodo = 'GET', json, cuerpo, tipo, timeout = 15000 } = {}) {
  const t0 = Date.now();
  const r = await fetch(URL_BASE + ruta, {
    method: metodo,
    headers: { 'X-Device-Token': TOKEN, ...(json ? { 'Content-Type': 'application/json' } : tipo ? { 'Content-Type': tipo } : {}) },
    body: json ? JSON.stringify(json) : cuerpo,
    signal: AbortSignal.timeout(timeout)
  });
  let datos = null;
  try { datos = await r.json(); } catch (_) {}
  return { status: r.status, datos, ms: Date.now() - t0 };
}

const sensoresSim = [
  { sensor_id: NODO + '-gpio4', variable: 'estado_puerta', zona: '' },
  { sensor_id: NODO + '-gpio3', variable: 'estado_puerta', zona: '' },
  { sensor_id: NODO + '-pir',   variable: 'movimiento',    zona: '' }
];

async function latido() {
  const r = await api('/nodos/latido', { metodo: 'POST', json: { nodos: [{ nodo_id: NODO, hace_s: 1, rssi: -55, sensores: sensoresSim }] } });
  console.log(`[latido] ${r.status} ${JSON.stringify(r.datos)}  (${r.ms} ms)`);
  return r;
}

async function estado() {
  const r = await api('/estado');
  console.log(`[estado] ${r.status} ${JSON.stringify(r.datos)}  (${r.ms} ms)`);
  return r;
}

async function alarma() {
  const est = await estado();
  if (!est.datos || !est.datos.armado) console.log('  Aviso: la casa esta DESARMADA, no se esperan notificaciones. Armala desde la app.');
  const t0 = Date.now();
  let r = await api('/mediciones', { metodo: 'POST', json: { zona: '', nodo_id: NODO, sensor_id: sensoresSim[0].sensor_id, variable: 'estado_puerta', valor: 1, unidad: 'estado', numero_registro: Date.now() % 100000 } });
  console.log(`[medicion] ${r.status} (${r.ms} ms)`);
  r = await api('/alarma', { metodo: 'POST', json: { nodo_id: NODO, activa: true, motivo: 'estado_puerta', zona: '', sensor_id: sensoresSim[0].sensor_id, silenciosa: false, retraso_ms: Date.now() - t0 } });
  console.log(`[alarma] ${r.status} ${JSON.stringify(r.datos)}  (${r.ms} ms)`);
  console.log('Apaga la alarma desde la app (o desarma) cuando termines.');
}

async function camara() {
  console.log('[camara] simulada, esperando tareas. Ctrl+C para salir.');
  let fallos = 0;
  for (;;) {
    let r;
    try { r = await api('/camara/tarea?camara_id=camara-sim&espera=20', { timeout: 30000 }); }
    catch (e) { console.log('[camara] error de red:', e.message); await new Promise((s) => setTimeout(s, Math.min(30000, 2000 * ++fallos))); continue; }
    if (r.status !== 200) { console.log('[camara] consulta', r.status, JSON.stringify(r.datos)); await new Promise((s) => setTimeout(s, Math.min(30000, 2000 * ++fallos))); continue; }
    fallos = 0;
    const t = r.datos && r.datos.tarea;
    if (!t) continue;
    if (t.tipo === 'foto') {
      for (let i = 0; i < t.restantes; i++) {
        const f = await api(`/camara/foto?tarea=${t.id}&camara_id=camara-sim`, { metodo: 'POST', cuerpo: JPEG, tipo: 'image/jpeg' });
        console.log(`[foto] ${i + 1}/${t.restantes} codigo=${f.status} (${f.ms} ms)`);
        if (f.status !== 201) break;
        await new Promise((s) => setTimeout(s, t.intervalo_ms || 700));
      }
    } else if (t.tipo === 'vivo') {
      console.log('[vivo] sesion', t.id);
      let n = 0;
      for (;;) {
        const f = await api(`/camara/cuadro?tarea=${t.id}`, { metodo: 'POST', cuerpo: JPEG, tipo: 'image/jpeg' });
        n++;
        if (f.status !== 200 || !f.datos || !f.datos.continuar) break;
        await new Promise((s) => setTimeout(s, 170));
      }
      console.log('[vivo] fin, cuadros:', n);
    }
  }
}

(async () => {
  if (modo === 'registro') {
    const r = await latido();
    if (r.status !== 200) { console.log('Fallo: revisa la URL y el token.'); process.exit(1); }
    console.log('Revisa la app: deben aparecer 3 sensores "Nuevo".');
  }
  else if (modo === 'alarma') await alarma();
  else if (modo === 'estado') await estado();
  else if (modo === 'latidos') { for (;;) { await latido(); await new Promise((s) => setTimeout(s, 30000)); } }
  else if (modo === 'camara') await camara();
  else { console.log('Modo desconocido:', modo); process.exit(1); }
})().catch((e) => { console.error('Fallo:', e.message); process.exit(1); });
