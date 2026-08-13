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

// 👁️ LISTAR personal (usuario_empresa_rol) de una empresa, agrupado
router.get('/personal/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT uer.id AS rol_id, u.id AS usuario_id, u.nombre, u.celular, u.foto_url, a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo
       FROM usuario_empresa_rol uer
       JOIN usuarios u ON u.id = uer.usuario_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.empresa_id = $1 AND uer.estado = 'activo'
       ORDER BY a.nombre, u.nombre`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, personal: result.rows });
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