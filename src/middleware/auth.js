const jwt = require('jsonwebtoken');
require('dotenv').config();

// Migración a autenticación real (2026-08-25): antes de esto, NINGUNA ruta de la API verificaba
// quién hacía cada solicitud — todo confiaba ciegamente en los usuario_id/empresa_id/proyecto_id
// que mandaba el propio cliente en la URL o el body, sin comprobar que esa persona hubiera hecho
// login de verdad ni que tuviera permiso real sobre ese recurso. Esto se corrige en 5 pasos
// graduales (ver comentarios en auth.js, invitaciones.js y server.js) para no romper la app ya en
// uso mientras se migra. Este archivo es el PASO 1 y 3/4: la función que arma el token al hacer
// login, y el middleware que lo valida en cada request.

const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIAR_EN_PRODUCCION_jwt_secret_app_mediterraneo';
// 90 días: hoy la app no tiene ningún concepto de "sesión expira", el usuario queda logueado
// indefinidamente en su celular (ver AsyncStorage en el frontend). Un JWT de muy corta duración
// obligaría a rediseñar todo el manejo de sesión de una vez; 90 días da margen amplio y real
// seguridad (el token deja de servir si se roba y pasa ese tiempo) sin romper la expectativa
// actual de "no me pidas login seguido".
const DURACION_TOKEN = '90d';

// Genera el token que se entrega en login y en aceptar-por-celular. Solo lleva usuario_id (y el
// celular, útil para logs, no es secreto) — deliberadamente NO lleva empresa_id: un mismo usuario
// puede pertenecer a varias empresas y cambiar entre ellas sin volver a loguearse (ver
// SeleccionarEmpresaScreen.tsx), así que la pertenencia a cada empresa se valida aparte, por
// request, contra la tabla usuario_empresa_rol (ver middleware/autorizacion.js).
function generarToken(usuario) {
  return jwt.sign(
    { usuario_id: usuario.id, celular: usuario.celular },
    JWT_SECRET,
    { expiresIn: DURACION_TOKEN }
  );
}

// Middleware que exige un token válido. Lee "Authorization: Bearer <token>", lo verifica, y deja
// disponible req.usuario_id para el resto de la cadena. Si falta o es inválido, corta con 401 —
// nunca deja pasar una request sin usuario resuelto (a diferencia del modo "observación" del
// Paso 3, que es una variante separada, ver verificarTokenModoObservacion más abajo).
function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No autorizado: falta el token de sesión' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario_id = payload.usuario_id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'No autorizado: token inválido o expirado' });
  }
}

// Variante "modo observación" (Paso 3 del plan de migración): valida el token IGUAL que arriba,
// pero si falta o es inválido, NO bloquea la request — solo la deja pasar sin req.usuario_id y
// registra una advertencia en el log del servidor. Esto permite medir, mientras el frontend se
// actualiza en el mundo real, qué porcentaje de requests todavía llegan sin token (celulares con
// una versión vieja de la app que aún no lo manda) antes de pasar al modo estricto de verdad
// (verificarToken de arriba). Es temporal: una vez confirmado que casi todo el tráfico ya trae
// token, se reemplaza por verificarToken en server.js y este modo deja de usarse.
function verificarTokenModoObservacion(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    console.warn(`[auth:observación] Request sin token — ${req.method} ${req.originalUrl}`);
    return next();
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario_id = payload.usuario_id;
  } catch (error) {
    console.warn(`[auth:observación] Token inválido/expirado — ${req.method} ${req.originalUrl}: ${error.message}`);
  }
  next();
}

module.exports = { generarToken, verificarToken, verificarTokenModoObservacion, JWT_SECRET };
