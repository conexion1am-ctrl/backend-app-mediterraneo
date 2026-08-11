const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR un nuevo proyecto
router.post('/crear', async (req, res) => {
  try {
    const { nombre, direccion, area_m2, descripcion } = req.body;
    
    const result = await pool.query(
      'INSERT INTO proyectos (nombre, direccion, area_m2, descripcion, estado) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [nombre, direccion, area_m2, descripcion, 'activo']
    );
    
    res.status(201).json({ 
      mensaje: 'Proyecto creado exitosamente',
      proyecto: result.rows[0] 
    });
  } catch (error) {
    console.error('Error creando proyecto:', error);
    res.status(500).json({ error: 'Error al crear proyecto' });
  }
});

// 👁️ VER todos los proyectos
router.get('/listar', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proyectos WHERE estado = $1 ORDER BY created_at DESC', ['activo']);
    res.json({ 
      total: result.rows.length,
      proyectos: result.rows 
    });
  } catch (error) {
    console.error('Error listando proyectos:', error);
    res.status(500).json({ error: 'Error al listar proyectos' });
  }
});

// 👁️ VER un proyecto específico
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM proyectos WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error obteniendo proyecto:', error);
    res.status(500).json({ error: 'Error al obtener proyecto' });
  }
});

// ✏️ ACTUALIZAR un proyecto
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, direccion, area_m2, estado, descripcion } = req.body;
    
    const result = await pool.query(
      'UPDATE proyectos SET nombre = $1, direccion = $2, area_m2 = $3, estado = $4, descripcion = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [nombre, direccion, area_m2, estado, descripcion, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    
    res.json({ 
      mensaje: 'Proyecto actualizado exitosamente',
      proyecto: result.rows[0] 
    });
  } catch (error) {
    console.error('Error actualizando proyecto:', error);
    res.status(500).json({ error: 'Error al actualizar proyecto' });
  }
});

// 🗑️ ELIMINAR un proyecto
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('UPDATE proyectos SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', ['eliminado', id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    
    res.json({ 
      mensaje: 'Proyecto eliminado exitosamente',
      proyecto: result.rows[0] 
    });
  } catch (error) {
    console.error('Error eliminando proyecto:', error);
    res.status(500).json({ error: 'Error al eliminar proyecto' });
  }
});

module.exports = router;