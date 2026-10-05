/*
 * Cuentas, sesiones, viviendas y autenticacion de dispositivos.
 *
 * Hay dos tipos de cliente y cada uno se autentica distinto:
 *
 *   Personas (aplicacion web). Inician sesion con correo y contrasena. El
 *   servidor entrega una cookie HttpOnly con un identificador aleatorio; en la
 *   base de datos solo se guarda su resumen SHA-256. Cada consulta comprueba
 *   ademas que la persona sea miembro de la vivienda que pide.
 *
 *   Dispositivos (concentrador y camara). Envian el encabezado X-Device-Token.
 *   Cada vivienda tiene su propio token, del que se guarda unicamente el resumen,
 *   y con el token el servidor sabe a que vivienda pertenece el dispositivo sin
 *   confiar en lo que diga el cuerpo de la peticion. El DEVICE_TOKEN global se
 *   sigue aceptando solo para viviendas que todavia no tienen token propio, de
 *   modo que el firmware ya instalado no deja de funcionar.
 *
 * Solo se usa el modulo crypto de Node (scrypt para las contrasenas), sin
 * dependencias nuevas.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'sid';
const DIAS_SESION = 30;
const REGISTRO_ABIERTO = String(process.env.REGISTRO_ABIERTO || '').toLowerCase() === 'true';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const MAX_VIVIENDAS_POR_USUARIO = 10;

// ===================== Utilidades =====================

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const aleatorio = (n) => crypto.randomBytes(n).toString('base64url');

function igualesSeguro(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const N = 16384;
  const llave = await scrypt(clave, sal, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${sal.toString('base64')}$${llave.toString('base64')}`;
}

async function verificarClave(clave, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 4 || partes[0] !== 'scrypt') return false;
  const N = Number(partes[1]);
  const sal = Buffer.from(partes[2], 'base64');
  const esperado = Buffer.from(partes[3], 'base64');
  const llave = await scrypt(clave, sal, esperado.length, { N, r: 8, p: 1 });
  return crypto.timingSafeEqual(llave, esperado);
}

// Para que "correo inexistente" tarde lo mismo que "contrasena incorrecta"
let hashFalso = null;
async function gastarTiempo(clave) {
  if (!hashFalso) hashFalso = await hashClave('sin-usuario');
  await verificarClave(clave, hashFalso);
}

function leerCookies(req) {
  const salida = {};
  for (const par of String(req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) salida[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return salida;
}

function ponerCookie(req, res, valor, maxAgeSeg) {
  const atributos = [`${COOKIE}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeg}`];
  if (req.secure) atributos.push('Secure');
  res.setHeader('Set-Cookie', atributos.join('; '));
}

function ipDe(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'desconocida';
}

function limpiarTexto(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().slice(0, max);
  return t === '' ? null : t;
}

// ===================== Limite de intentos =====================
// En memoria: basta para un servidor unico y se reinicia con el servicio.

const intentos = new Map();   // clave -> { n, hasta }
function bloqueado(clave) {
  const f = intentos.get(clave);
  if (!f) return 0;
  if (f.hasta && f.hasta > Date.now()) return Math.ceil((f.hasta - Date.now()) / 1000);
  if (f.hasta && f.hasta <= Date.now()) intentos.delete(clave);
  return 0;
}
function registrarFallo(clave, maximo, ventanaMs) {
  const f = intentos.get(clave) || { n: 0, desde: Date.now(), hasta: 0 };
  if (Date.now() - f.desde > ventanaMs) { f.n = 0; f.desde = Date.now(); }
  f.n++;
  if (f.n >= maximo) f.hasta = Date.now() + ventanaMs;
  intentos.set(clave, f);
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, f] of intentos) if ((f.hasta && f.hasta < ahora) || ahora - f.desde > 3600000) intentos.delete(k);
}, 600000).unref();

// ===================== Sesiones =====================

async function crearSesion(req, res, usuarioId) {
  const id = aleatorio(32);
  await pool.query(
    `INSERT INTO sesiones (id_hash, usuario_id, expira_en, agente)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval, $4)`,
    [sha256(id), usuarioId, String(DIAS_SESION), String(req.get('user-agent') || '').slice(0, 200)]
  );
  // Maximo 10 sesiones por usuario: se descartan las mas antiguas
  await pool.query(
    `DELETE FROM sesiones WHERE usuario_id = $1 AND id_hash NOT IN
       (SELECT id_hash FROM sesiones WHERE usuario_id = $1 ORDER BY creado_en DESC LIMIT 10)`,
    [usuarioId]
  );
  await pool.query('DELETE FROM sesiones WHERE expira_en < NOW()');
  ponerCookie(req, res, id, DIAS_SESION * 86400);
}

/*
 * Middleware global: si hay cookie valida deja la persona en req.usuario. No
 * rechaza nada por si mismo; para eso estan requiereSesion y los demas.
 */
async function cargarSesion(req, _res, next) {
  const id = leerCookies(req)[COOKIE];
  if (!id) return next();
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.nombre, s.id_hash, s.expira_en
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.id_hash = $1 AND s.expira_en > NOW()`,
      [sha256(id)]
    );
    if (r.rowCount) {
      const f = r.rows[0];
      req.usuario = { id: f.id, email: f.email, nombre: f.nombre };
      req.sesionHash = f.id_hash;
      // Sesion deslizante: se renueva cuando le queda menos de la mitad
      if (new Date(f.expira_en) - Date.now() < (DIAS_SESION * 86400000) / 2) {
        pool.query(`UPDATE sesiones SET expira_en = NOW() + ($2 || ' days')::interval WHERE id_hash = $1`,
                   [f.id_hash, String(DIAS_SESION)]).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Error al cargar la sesion:', e.message);
  }
  next();
}

/*
 * Defensa contra peticiones enviadas desde otro sitio web. La cookie es
 * SameSite=Lax, y ademas aqui se rechaza cualquier cambio cuyo Origin no sea
 * este mismo servidor.
 */
function verificarOrigen(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.header('X-Device-Token')) return next();
  const origen = req.get('origin');
  if (origen) {
    let host = '';
    try { host = new URL(origen).host; } catch (e) { /* origen invalido */ }
    if (host !== req.get('host')) {
      return res.status(403).json({ ok: false, mensaje: 'Origen no permitido.' });
    }
  }
  next();
}

function requiereSesion(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({ ok: false, codigo: 'sin_sesion', mensaje: 'Inicia sesion para continuar.' });
  }
  next();
}

// ===================== Viviendas y permisos =====================

async function rolEn(usuarioId, viviendaId) {
  const r = await pool.query('SELECT rol FROM miembros WHERE vivienda_id = $1 AND usuario_id = $2', [viviendaId, usuarioId]);
  return r.rowCount ? r.rows[0].rol : null;
}

/*
 * Comprueba que la persona con sesion pertenezca a la vivienda. Responde el
 * error y devuelve false si no; en ese caso el manejador debe terminar.
 * Para no revelar que viviendas existen, "no existe" y "no eres miembro"
 * dan la misma respuesta.
 */
async function exigirMiembro(req, res, viviendaId, rolMinimo = 'miembro') {
  if (!req.usuario) {
    res.status(401).json({ ok: false, codigo: 'sin_sesion', mensaje: 'Inicia sesion para continuar.' });
    return false;
  }
  if (!viviendaId) {
    res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
    return false;
  }
  const rol = await rolEn(req.usuario.id, String(viviendaId));
  if (!rol || (rolMinimo === 'propietario' && rol !== 'propietario')) {
    res.status(403).json({ ok: false, codigo: 'sin_acceso', mensaje: 'No tienes acceso a esta vivienda.' });
    return false;
  }
  req.rol = rol;
  return true;
}

function viviendaDeSolicitud(req) {
  return (req.query && req.query.vivienda_id) || (req.body && req.body.vivienda_id) || null;
}

/*
 * Identifica a un dispositivo por su token. Devuelve { viviendaId, global }
 * o null. Con el token global la vivienda se toma de la peticion, y solo se
 * acepta si esa vivienda no tiene token propio.
 */
async function autenticarDispositivo(req) {
  const token = req.header('X-Device-Token');
  if (!token) return null;
  const r = await pool.query('SELECT id FROM viviendas WHERE token_hash = $1', [sha256(token)]);
  if (r.rowCount) return { viviendaId: r.rows[0].id, global: false };

  if (DEVICE_TOKEN && igualesSeguro(token, DEVICE_TOKEN)) {
    const id = limpiarTexto(viviendaDeSolicitud(req), 60);
    if (!id) return null;
    const v = await pool.query('SELECT token_hash FROM viviendas WHERE id = $1', [id]);
    if (v.rowCount && v.rows[0].token_hash) return null;   // ya tiene token propio
    if (!v.rowCount) {
      // Vivienda nueva que aparece por el token global: se registra sin duenos
      await pool.query(`INSERT INTO viviendas (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, nombreDesdeId(id)]);
    }
    return { viviendaId: id, global: true };
  }
  return null;
}

function nombreDesdeId(id) {
  const t = String(id).replace(/[-_]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function rechazarDispositivo(res) {
  res.status(401).json({ ok: false, mensaje: 'Token de dispositivo invalido o ausente.' });
}

function nuevoTokenDispositivo() {
  return 'hv_' + aleatorio(24);
}

function idVivienda(nombre) {
  const base = String(nombre).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'casa';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  let s = '';
  const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += ALFABETO_CODIGO[b[i] % ALFABETO_CODIGO.length];
  return s;
}
const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatearCodigo = (c) => c.slice(0, 4) + '-' + c.slice(4);

/*
 * Quien hizo la accion, para la bitacora (RNF-11). Una persona con sesion queda
 * con su nombre; un dispositivo, con el identificador de su nodo.
 */
function quien(req, respaldo) {
  if (req.usuario) return req.usuario.nombre;
  return respaldo || 'dispositivo';
}

// ===================== Rutas =====================

function montarRutas(app, ganchos = {}) {
  const emailValido = (e) => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  async function hayUsuarios() {
    return (await pool.query('SELECT 1 FROM usuarios LIMIT 1')).rowCount > 0;
  }

  // Estado de registro, para que la pantalla de acceso sepa que mostrar
  app.get('/auth/estado', async (_req, res) => {
    try {
      const hay = await hayUsuarios();
      res.json({ ok: true, hay_usuarios: hay, registro_abierto: REGISTRO_ABIERTO || !hay });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo consultar.', detalle: e.message });
    }
  });

  app.post('/auth/registro', async (req, res) => {
    const { email, nombre, clave, codigo } = req.body || {};
    const errores = [];
    if (!emailValido(email)) errores.push('Escribe un correo valido.');
    if (!limpiarTexto(nombre, 60)) errores.push('Escribe tu nombre.');
    if (typeof clave !== 'string' || clave.length < 8) errores.push('La contrasena debe tener al menos 8 caracteres.');
    if (typeof clave === 'string' && clave.length > 200) errores.push('La contrasena es demasiado larga.');
    if (errores.length) return res.status(400).json({ ok: false, mensaje: errores.join(' '), errores });

    const llaveIp = 'reg|' + ipDe(req);
    const espera = bloqueado(llaveIp);
    if (espera) return res.status(429).json({ ok: false, mensaje: `Demasiados intentos. Espera ${espera} s.` });

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      // Evita que dos registros simultaneos sean "el primer usuario"
      await cliente.query('LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE');
      const hay = (await cliente.query('SELECT 1 FROM usuarios LIMIT 1')).rowCount > 0;

      let invitacion = null;
      const cod = normalizarCodigo(codigo);
      if (cod) {
        const i = await cliente.query(
          'SELECT codigo, vivienda_id FROM invitaciones WHERE codigo = $1 AND usado_en IS NULL AND expira_en > NOW() FOR UPDATE', [cod]);
        if (!i.rowCount) {
          await cliente.query('ROLLBACK');
          registrarFallo(llaveIp, 10, 3600000);
          return res.status(400).json({ ok: false, mensaje: 'El codigo de invitacion no es valido o ya caduco.' });
        }
        invitacion = i.rows[0];
      }
      if (hay && !REGISTRO_ABIERTO && !invitacion) {
        await cliente.query('ROLLBACK');
        return res.status(403).json({ ok: false, codigo: 'registro_cerrado',
          mensaje: 'El registro esta cerrado. Pide a un propietario un codigo de invitacion.' });
      }

      const existe = await cliente.query('SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
      if (existe.rowCount) {
        await cliente.query('ROLLBACK');
        registrarFallo(llaveIp, 10, 3600000);
        return res.status(409).json({ ok: false, mensaje: 'Ya existe una cuenta con ese correo.' });
      }

      const u = await cliente.query(
        'INSERT INTO usuarios (email, nombre, clave_hash) VALUES ($1, $2, $3) RETURNING id, email, nombre',
        [email.trim(), limpiarTexto(nombre, 60), await hashClave(clave)]);
      const usuario = u.rows[0];

      if (!hay) {
        // Primer usuario: hereda las viviendas que ya existian sin duenos, por
        // ejemplo la "casa-001" que usaba el prototipo antes de tener cuentas.
        await cliente.query(
          `INSERT INTO miembros (vivienda_id, usuario_id, rol)
           SELECT v.id, $1, 'propietario' FROM viviendas v
            WHERE NOT EXISTS (SELECT 1 FROM miembros m WHERE m.vivienda_id = v.id)`, [usuario.id]);
      }
      if (invitacion) {
        await cliente.query(
          `INSERT INTO miembros (vivienda_id, usuario_id, rol) VALUES ($1, $2, 'miembro') ON CONFLICT DO NOTHING`,
          [invitacion.vivienda_id, usuario.id]);
        await cliente.query('UPDATE invitaciones SET usado_por = $2, usado_en = NOW() WHERE codigo = $1',
                            [invitacion.codigo, usuario.id]);
      }
      await cliente.query('COMMIT');
      await crearSesion(req, res, usuario.id);
      res.status(201).json({ ok: true, usuario });
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => {});
      console.error('Error al registrar:', e.message);
      res.status(500).json({ ok: false, mensaje: 'No se pudo crear la cuenta.', detalle: e.message });
    } finally {
      cliente.release();
    }
  });

  app.post('/auth/entrar', async (req, res) => {
    const { email, clave } = req.body || {};
    if (!emailValido(email) || typeof clave !== 'string' || !clave || clave.length > 200) {
      return res.status(400).json({ ok: false, mensaje: 'Escribe tu correo y tu contrasena.' });
    }
    const llaveCuenta = 'in|' + String(email).toLowerCase() + '|' + ipDe(req);
    const llaveIp = 'in|' + ipDe(req);
    const espera = Math.max(bloqueado(llaveCuenta), bloqueado(llaveIp));
    if (espera) {
      return res.status(429).json({ ok: false, mensaje: `Demasiados intentos fallidos. Espera ${Math.ceil(espera / 60)} min.` });
    }
    try {
      const r = await pool.query('SELECT id, email, nombre, clave_hash FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
      let valido = false;
      if (r.rowCount) valido = await verificarClave(clave, r.rows[0].clave_hash);
      else await gastarTiempo(clave);
      if (!valido) {
        registrarFallo(llaveCuenta, 5, 900000);
        registrarFallo(llaveIp, 30, 900000);
        return res.status(401).json({ ok: false, mensaje: 'Correo o contrasena incorrectos.' });
      }
      intentos.delete(llaveCuenta);
      const u = r.rows[0];
      await pool.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1', [u.id]);
      await crearSesion(req, res, u.id);
      res.json({ ok: true, usuario: { id: u.id, email: u.email, nombre: u.nombre } });
    } catch (e) {
      console.error('Error al iniciar sesion:', e.message);
      res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar sesion.', detalle: e.message });
    }
  });

  app.post('/auth/salir', async (req, res) => {
    try {
      if (req.sesionHash) await pool.query('DELETE FROM sesiones WHERE id_hash = $1', [req.sesionHash]);
    } catch (e) { /* la cookie se borra de todos modos */ }
    ponerCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  async function listarViviendas(usuarioId) {
    const r = await pool.query(
      `SELECT v.id, v.nombre, m.rol, (v.token_hash IS NOT NULL) AS tiene_token,
              (SELECT COUNT(*)::int FROM miembros x WHERE x.vivienda_id = v.id) AS miembros
         FROM miembros m JOIN viviendas v ON v.id = m.vivienda_id
        WHERE m.usuario_id = $1
        ORDER BY v.creado_en`, [usuarioId]);
    return r.rows;
  }

  app.get('/auth/yo', requiereSesion, async (req, res) => {
    try {
      res.json({ ok: true, usuario: req.usuario, viviendas: await listarViviendas(req.usuario.id) });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo consultar la cuenta.', detalle: e.message });
    }
  });

  app.post('/auth/clave', requiereSesion, async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (typeof nueva !== 'string' || nueva.length < 8 || nueva.length > 200) {
      return res.status(400).json({ ok: false, mensaje: 'La contrasena nueva debe tener al menos 8 caracteres.' });
    }
    try {
      const r = await pool.query('SELECT clave_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
      if (typeof actual !== 'string' || !(await verificarClave(actual, r.rows[0].clave_hash))) {
        return res.status(401).json({ ok: false, mensaje: 'La contrasena actual no es correcta.' });
      }
      await pool.query('UPDATE usuarios SET clave_hash = $2 WHERE id = $1', [req.usuario.id, await hashClave(nueva)]);
      // Cierra las demas sesiones, por si la contrasena anterior estaba comprometida
      await pool.query('DELETE FROM sesiones WHERE usuario_id = $1 AND id_hash <> $2', [req.usuario.id, req.sesionHash]);
      res.json({ ok: true, mensaje: 'Contrasena actualizada.' });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo cambiar la contrasena.', detalle: e.message });
    }
  });

  // ---------- Viviendas ----------

  app.get('/viviendas', requiereSesion, async (req, res) => {
    try {
      res.json({ ok: true, viviendas: await listarViviendas(req.usuario.id) });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudieron consultar las viviendas.', detalle: e.message });
    }
  });

  app.post('/viviendas', requiereSesion, async (req, res) => {
    const nombre = limpiarTexto(req.body && req.body.nombre, 50);
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Escribe un nombre para la vivienda.' });
    try {
      const propias = await pool.query(`SELECT COUNT(*)::int AS n FROM miembros WHERE usuario_id = $1 AND rol = 'propietario'`, [req.usuario.id]);
      if (propias.rows[0].n >= MAX_VIVIENDAS_POR_USUARIO) {
        return res.status(400).json({ ok: false, mensaje: `Se permiten hasta ${MAX_VIVIENDAS_POR_USUARIO} viviendas por cuenta.` });
      }
      const token = nuevoTokenDispositivo();
      const id = idVivienda(nombre);
      await pool.query('INSERT INTO viviendas (id, nombre, token_hash, creado_por) VALUES ($1, $2, $3, $4)',
                       [id, nombre, sha256(token), req.usuario.id]);
      await pool.query(`INSERT INTO miembros (vivienda_id, usuario_id, rol) VALUES ($1, $2, 'propietario')`, [id, req.usuario.id]);
      // El token se muestra una sola vez; despues solo existe su resumen
      res.status(201).json({ ok: true, vivienda: { id, nombre, rol: 'propietario', tiene_token: true, miembros: 1 }, token });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo crear la vivienda.', detalle: e.message });
    }
  });

  app.patch('/viviendas/:id', requiereSesion, async (req, res) => {
    const nombre = limpiarTexto(req.body && req.body.nombre, 50);
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Escribe un nombre para la vivienda.' });
    try {
      if (!(await exigirMiembro(req, res, req.params.id, 'propietario'))) return;
      await pool.query('UPDATE viviendas SET nombre = $2 WHERE id = $1', [req.params.id, nombre]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo renombrar.', detalle: e.message });
    }
  });

  // Genera un token nuevo. El anterior deja de funcionar, asi que hay que
  // actualizar el firmware del concentrador y de la camara.
  app.post('/viviendas/:id/token', requiereSesion, async (req, res) => {
    try {
      if (!(await exigirMiembro(req, res, req.params.id, 'propietario'))) return;
      const token = nuevoTokenDispositivo();
      await pool.query('UPDATE viviendas SET token_hash = $2 WHERE id = $1', [req.params.id, sha256(token)]);
      if (ganchos.registrarAccion) await ganchos.registrarAccion(req.params.id, 'token_regenerado', '', '', quien(req));
      res.json({ ok: true, token });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo generar el token.', detalle: e.message });
    }
  });

  app.delete('/viviendas/:id', requiereSesion, async (req, res) => {
    try {
      if (!(await exigirMiembro(req, res, req.params.id, 'propietario'))) return;
      const v = await pool.query('SELECT nombre FROM viviendas WHERE id = $1', [req.params.id]);
      if (!v.rowCount) return res.status(404).json({ ok: false, mensaje: 'Vivienda no encontrada.' });
      if (String((req.body && req.body.confirmar) || '').trim() !== v.rows[0].nombre) {
        return res.status(400).json({ ok: false, mensaje: 'Para borrarla escribe el nombre exacto de la vivienda.' });
      }
      if (ganchos.borrarDatosVivienda) await ganchos.borrarDatosVivienda(req.params.id);
      await pool.query('DELETE FROM viviendas WHERE id = $1', [req.params.id]);
      res.json({ ok: true, mensaje: 'Vivienda eliminada con todos sus datos.' });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo eliminar la vivienda.', detalle: e.message });
    }
  });

  // ---------- Miembros e invitaciones ----------

  app.get('/viviendas/:id/miembros', requiereSesion, async (req, res) => {
    try {
      if (!(await exigirMiembro(req, res, req.params.id))) return;
      const r = await pool.query(
        `SELECT u.id AS usuario_id, u.nombre, u.email, m.rol, m.desde
           FROM miembros m JOIN usuarios u ON u.id = m.usuario_id
          WHERE m.vivienda_id = $1 ORDER BY m.rol DESC, m.desde`, [req.params.id]);
      res.json({ ok: true, miembros: r.rows, soy: req.usuario.id });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudieron consultar los miembros.', detalle: e.message });
    }
  });

  app.delete('/viviendas/:id/miembros/:uid', requiereSesion, async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) return res.status(400).json({ ok: false, mensaje: 'Identificador invalido.' });
    try {
      // Cualquiera puede salirse; solo un propietario puede sacar a otra persona
      const propio = uid === req.usuario.id;
      if (!(await exigirMiembro(req, res, req.params.id, propio ? 'miembro' : 'propietario'))) return;
      const objetivo = await rolEn(uid, req.params.id);
      if (!objetivo) return res.status(404).json({ ok: false, mensaje: 'Esa persona no es miembro.' });
      if (objetivo === 'propietario') {
        const n = await pool.query(`SELECT COUNT(*)::int AS n FROM miembros WHERE vivienda_id = $1 AND rol = 'propietario'`, [req.params.id]);
        if (n.rows[0].n <= 1) {
          return res.status(400).json({ ok: false, mensaje: 'Debe quedar al menos un propietario. Elimina la vivienda si ya no la quieres.' });
        }
      }
      await pool.query('DELETE FROM miembros WHERE vivienda_id = $1 AND usuario_id = $2', [req.params.id, uid]);
      if (ganchos.registrarAccion) await ganchos.registrarAccion(req.params.id, propio ? 'salio_de_vivienda' : 'miembro_eliminado', uid, '', quien(req));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo quitar al miembro.', detalle: e.message });
    }
  });

  app.post('/viviendas/:id/invitaciones', requiereSesion, async (req, res) => {
    const horas = Math.min(Math.max(Number(req.body && req.body.horas) || 72, 1), 168);
    try {
      if (!(await exigirMiembro(req, res, req.params.id, 'propietario'))) return;
      const activas = await pool.query(
        'SELECT COUNT(*)::int AS n FROM invitaciones WHERE vivienda_id = $1 AND usado_en IS NULL AND expira_en > NOW()', [req.params.id]);
      if (activas.rows[0].n >= 20) return res.status(400).json({ ok: false, mensaje: 'Ya hay demasiados codigos activos.' });
      const codigo = nuevoCodigo();
      await pool.query(
        `INSERT INTO invitaciones (codigo, vivienda_id, creado_por, expira_en)
         VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)`,
        [codigo, req.params.id, req.usuario.id, String(horas)]);
      res.status(201).json({ ok: true, codigo: formatearCodigo(codigo), horas });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo crear la invitacion.', detalle: e.message });
    }
  });

  app.post('/invitaciones/aceptar', requiereSesion, async (req, res) => {
    const cod = normalizarCodigo(req.body && req.body.codigo);
    const llave = 'inv|' + req.usuario.id;
    const espera = bloqueado(llave);
    if (espera) return res.status(429).json({ ok: false, mensaje: `Demasiados intentos. Espera ${espera} s.` });
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const i = await cliente.query(
        'SELECT vivienda_id FROM invitaciones WHERE codigo = $1 AND usado_en IS NULL AND expira_en > NOW() FOR UPDATE', [cod]);
      if (!i.rowCount) {
        await cliente.query('ROLLBACK');
        registrarFallo(llave, 5, 600000);
        return res.status(400).json({ ok: false, mensaje: 'El codigo no es valido o ya caduco.' });
      }
      const viviendaId = i.rows[0].vivienda_id;
      await cliente.query(`INSERT INTO miembros (vivienda_id, usuario_id, rol) VALUES ($1, $2, 'miembro') ON CONFLICT DO NOTHING`,
                          [viviendaId, req.usuario.id]);
      await cliente.query('UPDATE invitaciones SET usado_por = $2, usado_en = NOW() WHERE codigo = $1', [cod, req.usuario.id]);
      await cliente.query('COMMIT');
      res.json({ ok: true, vivienda_id: viviendaId });
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => {});
      res.status(500).json({ ok: false, mensaje: 'No se pudo aceptar la invitacion.', detalle: e.message });
    } finally {
      cliente.release();
    }
  });
}

module.exports = {
  montarRutas, cargarSesion, verificarOrigen, requiereSesion,
  exigirMiembro, rolEn, viviendaDeSolicitud,
  autenticarDispositivo, rechazarDispositivo, quien, limpiarTexto,
  sha256, REGISTRO_ABIERTO
};
