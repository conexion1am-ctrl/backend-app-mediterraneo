const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
    const link = `https://backend-app-mediterraneo.onrender.com/api/invitaciones/aceptar/${invitacion.token}`;

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

// ✅ ACEPTAR invitación (vincula al usuario con la empresa y área)
router.post('/aceptar/:token', async (req, res) => {
  const client = await pool.connect();
  try {
    const { token } = req.params;

    const invResult = await client.query('SELECT * FROM invitaciones WHERE token = $1', [token]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }

    const invitacion = invResult.rows[0];
    if (invitacion.usado) {
      return res.status(400).json({ error: 'Esta invitación ya fue utilizada' });
    }

    await client.query('BEGIN');

    // Crear o encontrar usuario por celular
    let usuarioResult = await client.query('SELECT * FROM usuarios WHERE celular = $1', [invitacion.celular_invitado]);
    let usuario;
    if (usuarioResult.rows.length > 0) {
      usuario = usuarioResult.rows[0];
    } else {
      const nuevoUsuario = await client.query(
        'INSERT INTO usuarios (celular, nombre) VALUES ($1, $2) RETURNING *',
        [invitacion.celular_invitado, invitacion.nombre_invitado]
      );
      usuario = nuevoUsuario.rows[0];
    }

    // Vincular a la empresa con el área correspondiente
    await client.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4)',
      [usuario.id, invitacion.empresa_id, invitacion.area_id, 'activo']
    );

    // Marcar invitación como usada
    await client.query('UPDATE invitaciones SET usado = TRUE WHERE token = $1', [token]);

    await client.query('COMMIT');

    res.json({
      mensaje: 'Invitación aceptada, usuario vinculado exitosamente',
      usuario
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

module.exports = router;