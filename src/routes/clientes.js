const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR cliente
router.post('/crear', async (req, res) => {
  try {
    const { empresa_id, proyecto_id, nombre, celular, contrato_url, nombre_proyecto } = req.body;

    if (!empresa_id || !nombre) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO clientes (empresa_id, proyecto_id, nombre, celular, contrato_url, nombre_proyecto) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [empresa_id, proyecto_id || null, nombre, celular || null, contrato_url || null, nombre_proyecto || null]
    );

    res.status(201).json({ mensaje: 'Cliente creado exitosamente', cliente: result.rows[0] });
  } catch (error) {
    console.error('Error creando cliente:', error);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ✏️ EDITAR cliente
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, celular, nombre_proyecto } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    const result = await pool.query(
      'UPDATE clientes SET nombre = $1, celular = $2, nombre_proyecto = $3 WHERE id = $4 RETURNING *',
      [nombre, celular || null, nombre_proyecto || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente actualizado exitosamente', cliente: result.rows[0] });
  } catch (error) {
    console.error('Error editando cliente:', error);
    res.status(500).json({ error: 'Error al editar cliente' });
  }
});

// 🗑️ ELIMINAR cliente
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM clientes WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando cliente:', error);
    // Si tiene cotizaciones asociadas, la base de datos puede rechazar el borrado
    res.status(500).json({ error: 'No se pudo eliminar. Puede que este cliente ya tenga cotizaciones asociadas.' });
  }
});

// 👁️ LISTAR clientes de una empresa
router.get('/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT c.*, p.nombre AS proyecto_nombre 
       FROM clientes c 
       LEFT JOIN proyectos p ON p.id = c.proyecto_id 
       WHERE c.empresa_id = $1 
       ORDER BY c.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, clientes: result.rows });
  } catch (error) {
    console.error('Error listando clientes:', error);
    res.status(500).json({ error: 'Error al listar clientes' });
  }
});

module.exports = router;