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
router.put('/personal/vinculado/:usuario_id/nombre', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { nombre } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
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
    const { empresa_id, area_id } = req.body;

    if (!empresa_id || !area_id) {
      return res.status(400).json({ error: 'empresa_id y area_id son obligatorios' });
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

    if (todas === 'true') {
      const rolActual = await pool.query('SELECT * FROM usuario_empresa_rol WHERE id = $1', [rol_id]);
      if (rolActual.rows.length === 0) {
        return res.status(404).json({ error: 'Registro no encontrado' });
      }
      const { usuario_id, empresa_id } = rolActual.rows[0];
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

module.exports = router;