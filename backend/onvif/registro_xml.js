/*
 * Registro de los mensajes XML de ONVIF, para entender como se comporta el
 * firmware de la camara. Siempre oculta las credenciales antes de escribir.
 *
 * Se activa con ONVIF_LOG_XML=<ruta del archivo>. El archivo se rota al llegar
 * a un tamano maximo (queda un solo respaldo .1), asi que no crece sin limite.
 */

const fs = require('fs');
const path = require('path');

/** Quita del XML todo lo que permitiria autenticarse como el usuario. */
function ocultarCredenciales(xml, secretos = []) {
  let t = String(xml);
  t = t.replace(/(<(?:\w+:)?Username[^>]*>)[^<]*(<\/(?:\w+:)?Username>)/gi, '$1***$2');
  t = t.replace(/(<(?:\w+:)?Password[^>]*>)[^<]*(<\/(?:\w+:)?Password>)/gi, '$1***$2');
  t = t.replace(/(<(?:\w+:)?Nonce[^>]*>)[^<]*(<\/(?:\w+:)?Nonce>)/gi, '$1***$2');
  for (const s of secretos) {
    if (s && String(s).length >= 3) t = t.split(String(s)).join('***');
  }
  return t;
}

function crearRegistroXml(ruta, { maxBytes = 2 * 1024 * 1024, secretos = [] } = {}) {
  if (!ruta) return null;
  try { fs.mkdirSync(path.dirname(ruta), { recursive: true }); } catch (e) { /* se intenta escribir igual */ }
  return function registrar(direccion, url, xml) {
    try {
      const limpio = ocultarCredenciales(xml, secretos);
      let tam = 0;
      try { tam = fs.statSync(ruta).size; } catch (e) { /* aun no existe */ }
      if (tam > maxBytes) fs.renameSync(ruta, `${ruta}.1`);
      fs.appendFileSync(ruta, `\n=== ${new Date().toISOString()} ${direccion} ${url}\n${limpio}\n`);
    } catch (e) {
      // El registro es una ayuda de diagnostico: nunca debe romper el servicio
    }
  };
}

module.exports = { ocultarCredenciales, crearRegistroXml };
