const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

// 📝 CREAR una cotización
router.post('/crear', async (req, res) => {
  try {
    const { proyecto_id, titulo, descripcion, total } = req.body;
    
    const result = await pool.query(
      'INSERT INTO cotizaciones (proyecto_id, titulo, descripcion, total) VALUES ($1, $2, $3, $4) RETURNING *',
      [proyecto_id, titulo, descripcion, total]
    );
    
    res.status(201).json({ 
      mensaje: 'Cotización creada exitosamente',
      cotizacion: result.rows[0] 
    });
  } catch (error) {
    console.error('Error creando cotización:', error);
    res.status(500).json({ error: 'Error al crear cotización' });
  }
});

// 👁️ VER cotizaciones de un proyecto
router.get('/proyecto/:proyecto_id', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM cotizaciones WHERE proyecto_id = $1 ORDER BY fecha_creacion DESC',
      [proyecto_id]
    );
    
    res.json({ 
      total: result.rows.length,
      cotizaciones: result.rows 
    });
  } catch (error) {
    console.error('Error listando cotizaciones:', error);
    res.status(500).json({ error: 'Error al listar cotizaciones' });
  }
});

// 👁️ VER una cotización específica
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const cotizacion = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    
    if (cotizacion.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    // Obtener items de la cotización
    const items = await pool.query('SELECT * FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    
    res.json({
      cotizacion: cotizacion.rows[0],
      items: items.rows
    });
  } catch (error) {
    console.error('Error obteniendo cotización:', error);
    res.status(500).json({ error: 'Error al obtener cotización' });
  }
});

// ✏️ ACTUALIZAR una cotización
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, descripcion, total, estado } = req.body;
    
    const result = await pool.query(
      'UPDATE cotizaciones SET titulo = $1, descripcion = $2, total = $3, estado = $4 WHERE id = $5 RETURNING *',
      [titulo, descripcion, total, estado, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    res.json({ 
      mensaje: 'Cotización actualizada exitosamente',
      cotizacion: result.rows[0] 
    });
  } catch (error) {
    console.error('Error actualizando cotización:', error);
    res.status(500).json({ error: 'Error al actualizar cotización' });
  }
});

// 🗑️ ELIMINAR una cotización
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Eliminar items primero
    await pool.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    
    // Luego eliminar cotización
    const result = await pool.query('DELETE FROM cotizaciones WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    res.json({ 
      mensaje: 'Cotización eliminada exitosamente',
      cotizacion: result.rows[0] 
    });
  } catch (error) {
    console.error('Error eliminando cotización:', error);
    res.status(500).json({ error: 'Error al eliminar cotización' });
  }
});

// ➕ AGREGAR un item a la cotización
router.post('/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const { descripcion, cantidad, unidad, valor_unitario } = req.body;
    
    const valor_total = cantidad * valor_unitario;
    
    const result = await pool.query(
      'INSERT INTO cotizacion_items (cotizacion_id, descripcion, cantidad, unidad, valor_unitario, valor_total) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, descripcion, cantidad, unidad, valor_unitario, valor_total]
    );
    
    res.status(201).json({ 
      mensaje: 'Item agregado exitosamente',
      item: result.rows[0] 
    });
  } catch (error) {
    console.error('Error agregando item:', error);
    res.status(500).json({ error: 'Error al agregar item' });
  }
});

// 📊 OBTENER resumen de cotización (total items, suma)
router.get('/:id/resumen', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT COUNT(*) as total_items, SUM(valor_total) as subtotal FROM cotizacion_items WHERE cotizacion_id = $1',
      [id]
    );
    
    const cotizacion = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    
    if (cotizacion.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    res.json({
      cotizacion: cotizacion.rows[0],
      resumen: {
        total_items: result.rows[0].total_items,
        subtotal: parseFloat(result.rows[0].subtotal) || 0,
        iva: (parseFloat(result.rows[0].subtotal) || 0) * 0.19,
        total: (parseFloat(result.rows[0].subtotal) || 0) * 1.19
      }
    });
  } catch (error) {
    console.error('Error obteniendo resumen:', error);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

module.exports = router;