const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR proyecto (con actividades/áreas seleccionadas)
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng, areas_ids } = req.body;

    if (!empresa_id || !nombre) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    await client.query('BEGIN');

    const proyectoResult = await client.query(
      'INSERT INTO proyectos (empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [empresa_id, nombre, direccion || null, area_m2 || null, ubicacion_lat || null, ubicacion_lng || null]
    );
    const proyecto = proyectoResult.rows[0];

    // Insertar las actividades (áreas) seleccionadas
    if (areas_ids && areas_ids.length > 0) {
      for (const areaId of areas_ids) {
        await client.query(
          'INSERT INTO proyecto_actividades (proyecto_id, area_id) VALUES ($1, $2)',
          [proyecto.id, areaId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Proyecto creado exitosamente', proyecto });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando proyecto:', error);
    res.status(500).json({ error: 'Error al crear proyecto' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR proyectos de una empresa
router.get('/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM proyectos WHERE empresa_id = $1 AND estado = 'activo' ORDER BY created_at DESC",
      [empresa_id]
    );
    res.json({ total: result.rows.length, proyectos: result.rows });
  } catch (error) {
    console.error('Error listando proyectos:', error);
    res.status(500).json({ error: 'Error al listar proyectos' });
  }
});

// 👁️ VER detalle de un proyecto (con sus actividades/áreas)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const proyecto = await pool.query('SELECT * FROM proyectos WHERE id = $1', [id]);

    if (proyecto.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const actividades = await pool.query(
      `SELECT a.id, a.nombre, a.categoria_padre 
       FROM proyecto_actividades pa 
       JOIN areas_catalogo a ON a.id = pa.area_id 
       WHERE pa.proyecto_id = $1`,
      [id]
    );

    res.json({ ...proyecto.rows[0], actividades: actividades.rows });
  } catch (error) {
    console.error('Error obteniendo proyecto:', error);
    res.status(500).json({ error: 'Error al obtener proyecto' });
  }
});

// 👥 ASIGNAR personal a un área dentro de un proyecto (pantalla Equipo)
router.post('/:id/equipo/asignar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, area_id } = req.body;

    if (!usuario_id || !area_id) {
      return res.status(400).json({ error: 'usuario_id y area_id son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO proyecto_equipo (proyecto_id, usuario_id, area_id) VALUES ($1, $2, $3) RETURNING *',
      [id, usuario_id, area_id]
    );

    res.status(201).json({ mensaje: 'Persona asignada al proyecto exitosamente', asignacion: result.rows[0] });
  } catch (error) {
    console.error('Error asignando persona:', error);
    res.status(500).json({ error: 'Error al asignar persona al proyecto' });
  }
});

// 👥 VER equipo asignado a un proyecto (agrupado por área)
router.get('/:id/equipo', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT pe.id AS asignacion_id, u.id AS usuario_id, u.nombre, u.celular, a.id AS area_id, a.nombre AS area_nombre
       FROM proyecto_equipo pe
       JOIN usuarios u ON u.id = pe.usuario_id
       JOIN areas_catalogo a ON a.id = pe.area_id
       WHERE pe.proyecto_id = $1
       ORDER BY a.nombre`,
      [id]
    );
    res.json({ equipo: result.rows });
  } catch (error) {
    console.error('Error obteniendo equipo:', error);
    res.status(500).json({ error: 'Error al obtener equipo del proyecto' });
  }
});

module.exports = router;