const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

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

    // Vinculados: ya aceptaron la invitación y están en usuario_empresa_rol
    const vinculados = await pool.query(
      `SELECT uer.id AS rol_id, u.id AS usuario_id, u.nombre, u.celular, u.foto_url,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo,
              'vinculado' AS estado
       FROM usuario_empresa_rol uer
       JOIN usuarios u ON u.id = uer.usuario_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.empresa_id = $1 AND uer.estado = 'activo'`,
      [empresa_id]
    );

    // Pendientes: invitación generada pero todavía no aceptada
    const pendientes = await pool.query(
      `SELECT i.id AS rol_id, NULL AS usuario_id, i.nombre_invitado AS nombre, i.celular_invitado AS celular, NULL AS foto_url,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo,
              'pendiente' AS estado
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.empresa_id = $1 AND i.usado = FALSE`,
      [empresa_id]
    );

    const personal = [...vinculados.rows, ...pendientes.rows].sort((a, b) => {
      if (a.area_nombre !== b.area_nombre) return a.area_nombre.localeCompare(b.area_nombre);
      return a.nombre.localeCompare(b.nombre);
    });

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

    // ¿Ya aceptó y es parte activa del equipo?
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

    // ¿Tiene invitación pendiente sin aceptar?
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

module.exports = router;