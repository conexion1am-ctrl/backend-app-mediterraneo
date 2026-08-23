const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { areaDeUsuarioEnEmpresa } = require('../utils/permisos');
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 👁️ LISTAR catálogo completo de áreas
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM areas_catalogo ORDER BY id ASC');
    res.json({ areas: result.rows });
  } catch (error) {
    console.error('Error listando áreas:', error);
    res.status(500).json({ error: 'Error al listar áreas' });
  }
});

// 👁️ LISTAR personal de una empresa: vinculados (activos) + pendientes (invitación sin aceptar)
router.get('/personal/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;

    const vinculados = await pool.query(
      `SELECT uer.id AS rol_id, u.id AS usuario_id, u.nombre, u.celular, u.foto_url,
              u.arl_documento_url, u.arl_vencimiento,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo,
              'vinculado' AS estado
       FROM usuario_empresa_rol uer
       JOIN usuarios u ON u.id = uer.usuario_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.empresa_id = $1 AND uer.estado = 'activo'`,
      [empresa_id]
    );

    const pendientes = await pool.query(
      `SELECT i.id AS rol_id, NULL AS usuario_id, i.nombre_invitado AS nombre, i.celular_invitado AS celular, NULL AS foto_url,
              NULL AS arl_documento_url, NULL AS arl_vencimiento,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo,
              'pendiente' AS estado
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.empresa_id = $1 AND i.usado = FALSE`,
      [empresa_id]
    );

    // Orden alfabético por nombre de la persona (antes se agrupaba primero por área).
    const personal = [...vinculados.rows, ...pendientes.rows].sort((a, b) =>
      a.nombre.localeCompare(b.nombre)
    );

    res.json({ total: personal.length, personal });
  } catch (error) {
    console.error('Error listando personal:', error);
    res.status(500).json({ error: 'Error al listar personal' });
  }
});

// 🔍 VERIFICAR si un celular ya existe en la empresa (evitar duplicados)
router.get('/verificar-celular/:empresa_id/:celular', async (req, res) => {
  try {
    const { empresa_id, celular } = req.params;

    const activo = await pool.query(
      `SELECT u.nombre, a.nombre AS area_nombre
       FROM usuario_empresa_rol uer
       JOIN usuarios u ON u.id = uer.usuario_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.empresa_id = $1 AND u.celular = $2 AND uer.estado = 'activo'`,
      [empresa_id, celular]
    );

    if (activo.rows.length > 0) {
      return res.json({
        existe: true,
        estado: 'activo',
        nombre: activo.rows[0].nombre,
        areas: activo.rows.map(r => r.area_nombre),
      });
    }

    const pendiente = await pool.query(
      `SELECT nombre_invitado, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.empresa_id = $1 AND i.celular_invitado = $2 AND i.usado = FALSE`,
      [empresa_id, celular]
    );

    if (pendiente.rows.length > 0) {
      return res.json({
        existe: true,
        estado: 'pendiente',
        nombre: pendiente.rows[0].nombre_invitado,
        areas: pendiente.rows.map(r => r.area_nombre),
      });
    }

    res.json({ existe: false });
  } catch (error) {
    console.error('Error verificando celular:', error);
    res.status(500).json({ error: 'Error al verificar celular' });
  }
});

// ✏️ EDITAR nombre de una persona VINCULADA (afecta todas sus áreas, el nombre vive en usuarios)
// Solo alguien de GERENCIA puede editar a otra persona de GERENCIA (evita que Administrativa,
// por ejemplo, edite los datos del dueño de la empresa).
router.put('/personal/vinculado/:usuario_id/nombre', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { nombre, empresa_id, solicitante_id } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    if (empresa_id && solicitante_id) {
      const areaObjetivo = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
      const areaSolicitante = await areaDeUsuarioEnEmpresa(solicitante_id, empresa_id);
      if (areaObjetivo === 'GERENCIA' && areaSolicitante !== 'GERENCIA') {
        return res.status(403).json({ error: 'Solo Gerencia puede editar a otra persona de Gerencia' });
      }
    }

    const result = await pool.query('UPDATE usuarios SET nombre = $1 WHERE id = $2 RETURNING *', [nombre, usuario_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    res.json({ mensaje: 'Nombre actualizado exitosamente', usuario: result.rows[0] });
  } catch (error) {
    console.error('Error editando nombre:', error);
    res.status(500).json({ error: 'Error al editar nombre' });
  }
});

// ➕ AGREGAR una nueva área a una persona VINCULADA
router.post('/personal/vinculado/:usuario_id/areas', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { empresa_id, area_id, solicitante_id } = req.body;

    if (!empresa_id || !area_id) {
      return res.status(400).json({ error: 'empresa_id y area_id son obligatorios' });
    }

    if (solicitante_id) {
      const areaObjetivo = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
      const areaSolicitante = await areaDeUsuarioEnEmpresa(solicitante_id, empresa_id);
      if (areaObjetivo === 'GERENCIA' && areaSolicitante !== 'GERENCIA') {
        return res.status(403).json({ error: 'Solo Gerencia puede editar a otra persona de Gerencia' });
      }
    }

    const existe = await pool.query(
      `SELECT * FROM usuario_empresa_rol WHERE usuario_id = $1 AND empresa_id = $2 AND area_id = $3 AND estado = 'activo'`,
      [usuario_id, empresa_id, area_id]
    );
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Esta persona ya tiene esa área asignada' });
    }

    const result = await pool.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4) RETURNING *',
      [usuario_id, empresa_id, area_id, 'activo']
    );

    res.status(201).json({ mensaje: 'Área agregada exitosamente', rol: result.rows[0] });
  } catch (error) {
    console.error('Error agregando área:', error);
    res.status(500).json({ error: 'Error al agregar área' });
  }
});

// 🚫 QUITAR una persona VINCULADA de un área específica (rol_id), o desactivarla de la empresa por completo
router.delete('/personal/vinculado/:rol_id', async (req, res) => {
  try {
    const { rol_id } = req.params;
    const { todas } = req.query; // ?todas=true para desactivar TODAS sus áreas en la empresa
    const { solicitante_id } = req.body;

    const rolActual = await pool.query('SELECT * FROM usuario_empresa_rol WHERE id = $1', [rol_id]);
    if (rolActual.rows.length === 0) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }
    const { usuario_id, empresa_id } = rolActual.rows[0];

    if (solicitante_id) {
      const areaObjetivo = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
      const areaSolicitante = await areaDeUsuarioEnEmpresa(solicitante_id, empresa_id);
      if (areaObjetivo === 'GERENCIA' && areaSolicitante !== 'GERENCIA') {
        return res.status(403).json({ error: 'Solo Gerencia puede eliminar a otra persona de Gerencia' });
      }
    }

    if (todas === 'true') {
      await pool.query(
        `UPDATE usuario_empresa_rol SET estado = 'inactivo' WHERE usuario_id = $1 AND empresa_id = $2`,
        [usuario_id, empresa_id]
      );
      return res.json({ mensaje: 'Persona desactivada de la empresa exitosamente' });
    }

    const result = await pool.query(
      "UPDATE usuario_empresa_rol SET estado = 'inactivo' WHERE id = $1 RETURNING *",
      [rol_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }

    res.json({ mensaje: 'Área removida de esta persona exitosamente' });
  } catch (error) {
    console.error('Error desactivando persona/área:', error);
    res.status(500).json({ error: 'Error al desactivar' });
  }
});

// 🗑️💥 ELIMINAR a una persona de TODA la plataforma, aunque esté asignada a proyectos: borra su
// cuenta (tabla usuarios), todos sus vínculos con empresas (usuario_empresa_rol), todas sus
// asignaciones a proyectos (proyecto_equipo), y su documento ARL. Distinto del DELETE de arriba
// (que solo desactiva el vínculo con UNA empresa, sin tocar la cuenta ni las asignaciones) y
// también distinto de DELETE /api/proyectos/equipo/:asignacion_id (que solo quita a alguien de
// UN proyecto puntual, sin tocar su cuenta) — ese último sigue existiendo tal cual para "quitar
// de este proyecto" sin eliminar a la persona de la plataforma.
//
// Qué se CONSERVA a propósito (decisión explícita, no un descuido):
// - Mensajes de chat: no se borran. Antes de eliminar la cuenta, cada mensaje que esta persona
//   envió ya tiene guardado su nombre en remitente_nombre_snapshot (se llena al momento de
//   enviar, ver mensajes.js), así que el chat de la otra persona en la conversación se sigue
//   viendo completo con el nombre correcto, aunque la cuenta ya no exista.
// - Fotos de avance y planos 3D que esta persona subió: se conservan como evidencia de obra;
//   solo se desvincula el usuario_id (queda en NULL vía ON DELETE SET NULL, configurado en
//   migraciones.js).
router.delete('/personal/:usuario_id/total', async (req, res) => {
  const client = await pool.connect();
  try {
    const { usuario_id } = req.params;
    const { empresa_id, solicitante_id } = req.body;

    if (!empresa_id || !solicitante_id) {
      return res.status(400).json({ error: 'empresa_id y solicitante_id son obligatorios' });
    }

    if (Number(usuario_id) === Number(solicitante_id)) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo de la plataforma.' });
    }

    const usuarioResult = await client.query('SELECT id, nombre FROM usuarios WHERE id = $1', [usuario_id]);
    if (usuarioResult.rows.length === 0) {
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    const areaObjetivo = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
    const areaSolicitante = await areaDeUsuarioEnEmpresa(solicitante_id, empresa_id);
    if (areaObjetivo === 'GERENCIA' && areaSolicitante !== 'GERENCIA') {
      return res.status(403).json({ error: 'Solo Gerencia puede eliminar a otra persona de Gerencia' });
    }

    // No permitir dejar NINGUNA empresa sin Gerencia: como esta persona puede ser Gerencia de
    // VARIAS empresas a la vez (no solo la que solicita el borrado), y el DELETE más abajo la
    // elimina de TODAS, revisamos TODAS las empresas donde hoy es Gerencia activa — no solo
    // `empresa_id`. Si en alguna de ellas es la última Gerencia, bloqueamos el borrado completo.
    const empresasComoGerencia = await client.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre
       FROM usuario_empresa_rol uer
       JOIN areas_catalogo a ON a.id = uer.area_id
       JOIN empresas e ON e.id = uer.empresa_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo' AND a.nombre = 'GERENCIA'`,
      [usuario_id]
    );
    for (const fila of empresasComoGerencia.rows) {
      const otrosGerencia = await client.query(
        `SELECT COUNT(*) AS total FROM usuario_empresa_rol uer
         JOIN areas_catalogo a ON a.id = uer.area_id
         WHERE uer.empresa_id = $1 AND uer.estado = 'activo' AND a.nombre = 'GERENCIA' AND uer.usuario_id != $2`,
        [fila.empresa_id, usuario_id]
      );
      if (Number(otrosGerencia.rows[0].total) === 0) {
        return res.status(400).json({
          error: `No puedes eliminar a esta persona: es la única Gerencia de "${fila.empresa_nombre}" y esa empresa quedaría sin nadie a cargo.`,
        });
      }
    }

    await client.query('BEGIN');

    // Documento ARL: se borra la referencia (el archivo real de Storage se limpia después, fuera
    // de la transacción, igual que el resto de archivos de esta app).
    const urlsABorrar = [];
    const arl = await client.query('SELECT arl_documento_url FROM usuarios WHERE id = $1', [usuario_id]);
    if (arl.rows[0]?.arl_documento_url) urlsABorrar.push(arl.rows[0].arl_documento_url);

    // Cualquier proyecto donde esté asignada (en cualquier empresa, no solo esta) queda
    // desasignado. El chat que ya tuvo con otros queda intacto gracias al snapshot de nombre.
    await client.query('DELETE FROM proyecto_equipo WHERE usuario_id = $1', [usuario_id]);

    // Vínculos con TODAS las empresas (no solo la de quien solicita eliminar), ya que la cuenta
    // completa va a desaparecer.
    await client.query('DELETE FROM usuario_empresa_rol WHERE usuario_id = $1', [usuario_id]);

    // fotos_avance.usuario_id, planos_3d.usuario_id, mensajes.usuario_id,
    // mensajes.destinatario_usuario_id y archivos.usuario_id tienen todos ON DELETE SET NULL
    // (ver migraciones.js), así que se desvinculan solos al borrar la fila de usuarios — no hace
    // falta tocarlos aquí explícitamente. El nombre del remitente en cada mensaje ya quedó a
    // salvo en remitente_nombre_snapshot antes de este momento (se llena al enviar el mensaje).
    await client.query('DELETE FROM usuarios WHERE id = $1', [usuario_id]);

    await client.query('COMMIT');

    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo ARL de Storage al eliminar persona:', error.message);
      });
    }

    res.json({ mensaje: 'Persona eliminada de la plataforma exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando persona de la plataforma:', error);
    res.status(500).json({ error: 'No se pudo eliminar a esta persona. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// 📄 SUBIR/ACTUALIZAR documento ARL (riesgos profesionales) de una persona vinculada.
// El archivo ya fue subido a Firebase Storage desde el frontend; aquí se guarda la referencia
// (url) y la fecha de vencimiento, y se borra de Storage el documento anterior (si había uno)
// para no dejarlo huérfano ocupando espacio.
router.put('/personal/vinculado/:usuario_id/arl', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { arl_documento_url, arl_vencimiento } = req.body;

    if (!arl_documento_url) {
      return res.status(400).json({ error: 'arl_documento_url es obligatorio' });
    }

    const anterior = await pool.query('SELECT arl_documento_url FROM usuarios WHERE id = $1', [usuario_id]);

    const result = await pool.query(
      'UPDATE usuarios SET arl_documento_url = $1, arl_vencimiento = $2 WHERE id = $3 RETURNING *',
      [arl_documento_url, arl_vencimiento || null, usuario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    if (anterior.rows[0]?.arl_documento_url && anterior.rows[0].arl_documento_url !== arl_documento_url) {
      await borrarArchivoDeStorage(anterior.rows[0].arl_documento_url);
    }

    const usuario = result.rows[0];
    delete usuario.contraseña_hash;

    res.json({ mensaje: 'Documento ARL actualizado exitosamente', usuario });
  } catch (error) {
    console.error('Error actualizando documento ARL:', error);
    res.status(500).json({ error: 'Error al actualizar el documento ARL' });
  }
});

// 🗑️ ELIMINAR documento ARL de una persona (por si se subió por error o hay que reemplazarlo):
// borra la referencia y también el archivo real en Firebase Storage.
router.delete('/personal/vinculado/:usuario_id/arl', async (req, res) => {
  try {
    const { usuario_id } = req.params;

    const anterior = await pool.query('SELECT arl_documento_url FROM usuarios WHERE id = $1', [usuario_id]);

    const result = await pool.query(
      'UPDATE usuarios SET arl_documento_url = NULL, arl_vencimiento = NULL WHERE id = $1 RETURNING *',
      [usuario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Persona no encontrada' });
    }

    if (anterior.rows[0]?.arl_documento_url) {
      await borrarArchivoDeStorage(anterior.rows[0].arl_documento_url);
    }

    res.json({ mensaje: 'Documento ARL eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando documento ARL:', error);
    res.status(500).json({ error: 'Error al eliminar el documento ARL' });
  }
});

module.exports = router;