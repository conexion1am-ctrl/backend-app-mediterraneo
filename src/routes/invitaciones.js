const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Lista histórica de áreas administrativas. Ya no se usa para decidir si se pide contraseña:
// ahora TODAS las áreas la requieren al aceptar una invitación (antes el personal de campo
// entraba solo con el celular, sin contraseña).
const AREAS_ADMINISTRATIVAS = ['GERENCIA', 'AREA ADMINISTRATIVA', 'AREA DE LOGISTICA'];

// 📝 GENERAR invitación (agregar personal desde Grupo de Trabajo)
router.post('/generar', async (req, res) => {
  try {
    const { empresa_id, area_id, nombre_invitado, celular_invitado } = req.body;

    if (!empresa_id || !area_id || !nombre_invitado || !celular_invitado) {
      return res.status(400).json({ error: 'empresa_id, area_id, nombre_invitado y celular_invitado son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO invitaciones (empresa_id, area_id, nombre_invitado, celular_invitado) VALUES ($1, $2, $3, $4) RETURNING *',
      [empresa_id, area_id, nombre_invitado, celular_invitado]
    );

    const invitacion = result.rows[0];
    const link = `frontendappmedv2://invitacion/${invitacion.token}`;

    res.status(201).json({
      mensaje: 'Invitación generada exitosamente',
      invitacion,
      link_whatsapp: link
    });
  } catch (error) {
    console.error('Error generando invitación:', error);
    res.status(500).json({ error: 'Error al generar invitación' });
  }
});

// 🔍 VERIFICAR si un celular tiene una invitación pendiente (sin importar la empresa) - usado por
// la pantalla "Ingresar como trabajador", donde el usuario no elige empresa: la app la descubre
// a partir de su celular. Si ya tiene cuenta con contraseña, le decimos que use el login normal.
// NOTA: debe ir ANTES de "GET /:token" (más abajo), porque esa ruta genérica capturaría
// "/verificar-celular/..." como si fuera un token cualquiera si quedara declarada primero.
router.get('/verificar-celular/:celular', async (req, res) => {
  try {
    const { celular } = req.params;

    const usuarioExistente = await pool.query('SELECT id, contraseña_hash FROM usuarios WHERE celular = $1', [celular]);
    if (usuarioExistente.rows.length > 0 && usuarioExistente.rows[0].contraseña_hash) {
      // Ya tiene cuenta y contraseña: no es un invitado "nuevo", debe iniciar sesión normal.
      return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: true });
    }

    const invResult = await pool.query(
      `SELECT i.*, e.nombre AS empresa_nombre
       FROM invitaciones i
       JOIN empresas e ON e.id = i.empresa_id
       WHERE i.celular_invitado = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [celular]
    );

    if (invResult.rows.length === 0) {
      // Usuario legacy: ya tiene cuenta (se vinculó antes de que la contraseña fuera obligatoria)
      // pero nunca creó contraseña, y no tiene ninguna invitación pendiente nueva. No es "nadie te
      // asignó" — ya pertenece a una empresa, solo le falta crear su contraseña por primera vez.
      if (usuarioExistente.rows.length > 0) {
        return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: true, debe_crear_contraseña: true });
      }
      return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: false });
    }

    const invitacion = invResult.rows[0];
    res.json({
      tiene_invitacion_pendiente: true,
      ya_tiene_cuenta: usuarioExistente.rows.length > 0,
      empresa_nombre: invitacion.empresa_nombre,
      nombre_invitado: invitacion.nombre_invitado,
    });
  } catch (error) {
    console.error('Error verificando celular para invitado:', error);
    res.status(500).json({ error: 'Error al verificar el celular' });
  }
});

// ✅ ACEPTAR invitación pendiente identificando al usuario por su celular (en vez de por un token
// de link). Reutiliza la misma lógica que /aceptar/:token: crea o actualiza el usuario con
// contraseña, lo vincula a la empresa/área, y completa cualquier proyecto_equipo pendiente.
router.post('/aceptar-por-celular', async (req, res) => {
  const client = await pool.connect();
  try {
    const { celular, contraseña } = req.body;
    if (!celular) {
      return res.status(400).json({ error: 'celular es obligatorio' });
    }
    if (!contraseña || contraseña.length < 6) {
      return res.status(400).json({ error: 'Debes crear una contraseña de al menos 6 caracteres' });
    }

    const invResult = await client.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.celular_invitado = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [celular]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tienes ninguna invitación pendiente con este número' });
    }

    const invitacion = invResult.rows[0];

    await client.query('BEGIN');

    let usuarioResult = await client.query('SELECT * FROM usuarios WHERE celular = $1', [invitacion.celular_invitado]);
    let usuario;

    if (usuarioResult.rows.length > 0) {
      usuario = usuarioResult.rows[0];
      if (!usuario.contraseña_hash) {
        const hash = await bcrypt.hash(contraseña, 10);
        const actualizado = await client.query(
          'UPDATE usuarios SET contraseña_hash = $1 WHERE id = $2 RETURNING *',
          [hash, usuario.id]
        );
        usuario = actualizado.rows[0];
      }
    } else {
      const contraseñaHash = await bcrypt.hash(contraseña, 10);
      const nuevoUsuario = await client.query(
        'INSERT INTO usuarios (celular, nombre, contraseña_hash) VALUES ($1, $2, $3) RETURNING *',
        [invitacion.celular_invitado, invitacion.nombre_invitado, contraseñaHash]
      );
      usuario = nuevoUsuario.rows[0];
    }

    await client.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4)',
      [usuario.id, invitacion.empresa_id, invitacion.area_id, 'activo']
    );

    await client.query(
      'UPDATE proyecto_equipo SET usuario_id = $1, invitacion_id = NULL WHERE invitacion_id = $2',
      [usuario.id, invitacion.id]
    );

    await client.query('UPDATE invitaciones SET usado = TRUE WHERE id = $1', [invitacion.id]);

    await client.query('COMMIT');

    delete usuario.contraseña_hash;

    const rolesResult = await client.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, e.sitio_web,
              e.nit, e.cedula_representante, e.banco_nombre, e.banco_tipo_cuenta, e.banco_numero, e.banco_titular,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo
       FROM usuario_empresa_rol uer
       JOIN empresas e ON e.id = uer.empresa_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo' AND e.estado = 'activo'`,
      [usuario.id]
    );

    res.json({
      mensaje: 'Invitación aceptada, usuario vinculado exitosamente',
      usuario,
      empresas: rolesResult.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando invitación por celular:', error);
    res.status(500).json({ error: 'Error al aceptar la invitación' });
  } finally {
    client.release();
  }
});

// 👁️ VER detalle de una invitación (sin consumirla) - útil para la app antes de aceptar
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      `SELECT i.*, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, a.nombre AS area_nombre, a.tipo AS area_tipo
       FROM invitaciones i
       JOIN empresas e ON e.id = i.empresa_id
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error obteniendo invitación:', error);
    res.status(500).json({ error: 'Error al obtener invitación' });
  }
});

// 👁️ VER el link de una invitación existente por su id (para reenviarla desde Grupo de Trabajo
// cuando una persona sigue "pendiente" y quizás no se le reenvió el link a tiempo)
router.get('/id/:id/link', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }

    const invitacion = result.rows[0];
    if (invitacion.usado) {
      return res.status(400).json({ error: 'Esta invitación ya fue aceptada' });
    }

    const link = `frontendappmedv2://invitacion/${invitacion.token}`;
    res.json({ invitacion, link_whatsapp: link });
  } catch (error) {
    console.error('Error obteniendo link de invitación:', error);
    res.status(500).json({ error: 'Error al obtener el link de invitación' });
  }
});

// ✅ ACEPTAR invitación (vincula al usuario con la empresa y área)
router.post('/aceptar/:token', async (req, res) => {
  const client = await pool.connect();
  try {
    const { token } = req.params;
    const { contraseña } = req.body;

    const invResult = await client.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.token = $1`,
      [token]
    );
    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }

    const invitacion = invResult.rows[0];
    if (invitacion.usado) {
      return res.status(400).json({ error: 'Esta invitación ya fue utilizada' });
    }

    // Todas las áreas requieren contraseña al aceptar la invitación (antes solo las administrativas).
    if (!contraseña || contraseña.length < 6) {
      return res.status(400).json({ error: 'Debes crear una contraseña de al menos 6 caracteres' });
    }

    await client.query('BEGIN');

    let usuarioResult = await client.query('SELECT * FROM usuarios WHERE celular = $1', [invitacion.celular_invitado]);
    let usuario;

    if (usuarioResult.rows.length > 0) {
      usuario = usuarioResult.rows[0];
      if (!usuario.contraseña_hash) {
        const hash = await bcrypt.hash(contraseña, 10);
        const actualizado = await client.query(
          'UPDATE usuarios SET contraseña_hash = $1 WHERE id = $2 RETURNING *',
          [hash, usuario.id]
        );
        usuario = actualizado.rows[0];
      }
    } else {
      const contraseñaHash = await bcrypt.hash(contraseña, 10);
      const nuevoUsuario = await client.query(
        'INSERT INTO usuarios (celular, nombre, contraseña_hash) VALUES ($1, $2, $3) RETURNING *',
        [invitacion.celular_invitado, invitacion.nombre_invitado, contraseñaHash]
      );
      usuario = nuevoUsuario.rows[0];
    }

    await client.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4)',
      [usuario.id, invitacion.empresa_id, invitacion.area_id, 'activo']
    );

    // Si esta persona ya había sido asignada a algún proyecto mientras estaba "pendiente"
    // (proyecto_equipo.invitacion_id), ahora que tiene usuario real esas filas se completan con
    // su usuario_id, para que dejen de figurar como pendientes en el equipo del proyecto.
    await client.query(
      'UPDATE proyecto_equipo SET usuario_id = $1, invitacion_id = NULL WHERE invitacion_id = $2',
      [usuario.id, invitacion.id]
    );

    await client.query('UPDATE invitaciones SET usado = TRUE WHERE token = $1', [token]);

    await client.query('COMMIT');

    delete usuario.contraseña_hash;

    // Traemos TODAS las empresas/áreas activas de este usuario (puede que ya perteneciera a
    // otras antes de esta invitación), con el mismo formato que devuelve /auth/login — así el
    // frontend puede guardar la sesión y entrar directo a la app, sin tener que loguearse de
    // nuevo con celular/contraseña justo después de haber creado la contraseña.
    const rolesResult = await client.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, e.sitio_web,
              e.nit, e.cedula_representante, e.banco_nombre, e.banco_tipo_cuenta, e.banco_numero, e.banco_titular,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo
       FROM usuario_empresa_rol uer
       JOIN empresas e ON e.id = uer.empresa_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo' AND e.estado = 'activo'`,
      [usuario.id]
    );

    res.json({
      mensaje: 'Invitación aceptada, usuario vinculado exitosamente',
      usuario,
      empresas: rolesResult.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando invitación:', error);
    res.status(500).json({ error: 'Error al aceptar invitación' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR invitaciones pendientes de una empresa
router.get('/pendientes/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.empresa_id = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, invitaciones: result.rows });
  } catch (error) {
    console.error('Error listando invitaciones pendientes:', error);
    res.status(500).json({ error: 'Error al listar invitaciones pendientes' });
  }
});

// ✏️ EDITAR una invitación pendiente (nombre, celular, área)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_invitado, celular_invitado, area_id } = req.body;

    if (!nombre_invitado || !celular_invitado || !area_id) {
      return res.status(400).json({ error: 'nombre_invitado, celular_invitado y area_id son obligatorios' });
    }

    const result = await pool.query(
      `UPDATE invitaciones
       SET nombre_invitado = $1, celular_invitado = $2, area_id = $3
       WHERE id = $4 AND usado = FALSE
       RETURNING *`,
      [nombre_invitado, celular_invitado, area_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación pendiente no encontrada (puede que ya haya sido aceptada)' });
    }

    res.json({ mensaje: 'Invitación actualizada exitosamente', invitacion: result.rows[0] });
  } catch (error) {
    console.error('Error editando invitación:', error);
    res.status(500).json({ error: 'Error al editar invitación' });
  }
});

// 🗑️ ELIMINAR una invitación pendiente por completo
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM invitaciones WHERE id = $1 AND usado = FALSE RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación pendiente no encontrada (puede que ya haya sido aceptada)' });
    }

    res.json({ mensaje: 'Invitación eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando invitación:', error);
    res.status(500).json({ error: 'Error al eliminar invitación' });
  }
});

module.exports = router;