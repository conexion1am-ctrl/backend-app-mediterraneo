const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR cotización con sus ítems
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa_id, cliente_id, proyecto_id, numero, items } = req.body;

    if (!empresa_id || !cliente_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'empresa_id, cliente_id e items son obligatorios' });
    }

    await client.query('BEGIN');

    const total = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);

    const cotizacionResult = await client.query(
      'INSERT INTO cotizaciones (empresa_id, cliente_id, proyecto_id, numero, total) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [empresa_id, cliente_id, proyecto_id || null, numero || null, total]
    );
    const cotizacion = cotizacionResult.rows[0];

    for (const item of items) {
      await client.query(
        'INSERT INTO cotizacion_items (cotizacion_id, descripcion, valor) VALUES ($1, $2, $3)',
        [cotizacion.id, item.descripcion, item.valor]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Cotización creada exitosamente', cotizacion });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando cotización:', error);
    res.status(500).json({ error: 'Error al crear cotización' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR cotizaciones de una empresa
router.get('/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT co.*, cl.nombre AS cliente_nombre 
       FROM cotizaciones co 
       JOIN clientes cl ON cl.id = co.cliente_id 
       WHERE co.empresa_id = $1 
       ORDER BY co.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, cotizaciones: result.rows });
  } catch (error) {
    console.error('Error listando cotizaciones:', error);
    res.status(500).json({ error: 'Error al listar cotizaciones' });
  }
});

// 👁️ VER detalle de una cotización con sus ítems
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cotizacion = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);

    if (cotizacion.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    const items = await pool.query('SELECT * FROM cotizacion_items WHERE cotizacion_id = $1', [id]);

    res.json({ ...cotizacion.rows[0], items: items.rows });
  } catch (error) {
    console.error('Error obteniendo cotización:', error);
    res.status(500).json({ error: 'Error al obtener cotización' });
  }
});

// ✅ ACEPTAR cotización → crea contrato automáticamente
router.post('/:id/aceptar', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { fecha_entrega } = req.body;

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    const cotizacion = cotizacionResult.rows[0];

    if (cotizacion.aceptada) {
      return res.status(400).json({ error: 'Esta cotización ya fue aceptada' });
    }

    await client.query('BEGIN');

    await client.query(
      "UPDATE cotizaciones SET aceptada = TRUE, estado = 'aceptada', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    const contratoResult = await client.query(
      'INSERT INTO contratos (cotizacion_id, empresa_id, proyecto_id, fecha_entrega, valor_total) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, cotizacion.empresa_id, cotizacion.proyecto_id, fecha_entrega || null, cotizacion.total]
    );

    // Crear también el registro de estadísticas del proyecto si tiene proyecto asociado
    if (cotizacion.proyecto_id) {
      await client.query(
        'INSERT INTO estadisticas_proyecto (proyecto_id, valor_contrato) VALUES ($1, $2)',
        [cotizacion.proyecto_id, cotizacion.total]
      );
    }

    await client.query('COMMIT');

    res.json({ mensaje: 'Cotización aceptada, contrato generado exitosamente', contrato: contratoResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando cotización:', error);
    res.status(500).json({ error: 'Error al aceptar cotización' });
  } finally {
    client.release();
  }
});
// 👁️ LISTAR contratos de una empresa
router.get('/contratos/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT ct.*, p.nombre AS proyecto_nombre 
       FROM contratos ct 
       LEFT JOIN proyectos p ON p.id = ct.proyecto_id 
       WHERE ct.empresa_id = $1 
       ORDER BY ct.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, contratos: result.rows });
  } catch (error) {
    console.error('Error listando contratos:', error);
    res.status(500).json({ error: 'Error al listar contratos' });
  }
});

module.exports = router;