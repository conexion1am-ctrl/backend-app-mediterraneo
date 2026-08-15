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

// ✅ ACEPTAR cotización → crea el proyecto (si no existía) y el contrato automáticamente
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

    let proyectoId = cotizacion.proyecto_id;

    // Si esta cotización no tiene un proyecto real todavía, lo creamos ahora
    // usando el nombre de proyecto que el cliente indicó al ser registrado.
    if (!proyectoId) {
      const clienteResult = await client.query('SELECT * FROM clientes WHERE id = $1', [cotizacion.cliente_id]);
      const cliente = clienteResult.rows[0];
      const nombreProyecto = (cliente && cliente.nombre_proyecto) ? cliente.nombre_proyecto : `Proyecto de ${cliente ? cliente.nombre : 'cliente'}`;

      const nuevoProyecto = await client.query(
        'INSERT INTO proyectos (empresa_id, nombre) VALUES ($1, $2) RETURNING *',
        [cotizacion.empresa_id, nombreProyecto]
      );
      proyectoId = nuevoProyecto.rows[0].id;

      // Vinculamos la cotización a este proyecto recién creado
      await client.query('UPDATE cotizaciones SET proyecto_id = $1 WHERE id = $2', [proyectoId, id]);
    }

    await client.query(
      "UPDATE cotizaciones SET aceptada = TRUE, estado = 'aceptada', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    const contratoResult = await client.query(
      'INSERT INTO contratos (cotizacion_id, empresa_id, proyecto_id, fecha_entrega, valor_total) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, cotizacion.empresa_id, proyectoId, fecha_entrega || null, cotizacion.total]
    );

    await client.query(
      'INSERT INTO estadisticas_proyecto (proyecto_id, valor_contrato) VALUES ($1, $2)',
      [proyectoId, cotizacion.total]
    );

    await client.query('COMMIT');

    res.json({ mensaje: 'Cotización aceptada, proyecto y contrato generados exitosamente', contrato: contratoResult.rows[0], proyecto_id: proyectoId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando cotización:', error);
    res.status(500).json({ error: 'Error al aceptar cotización' });
  } finally {
    client.release();
  }
});

// ✏️ EDITAR cotización (solo si no ha sido aceptada)
router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { numero, items } = req.body;

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    if (cotizacionResult.rows[0].aceptada) {
      return res.status(400).json({ error: 'No se puede editar una cotización ya aceptada' });
    }

    await client.query('BEGIN');

    if (items && items.length > 0) {
      const total = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);
      await client.query('UPDATE cotizaciones SET numero = $1, total = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [numero || null, total, id]);

      await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
      for (const item of items) {
        await client.query('INSERT INTO cotizacion_items (cotizacion_id, descripcion, valor) VALUES ($1, $2, $3)', [id, item.descripcion, item.valor]);
      }
    } else {
      await client.query('UPDATE cotizaciones SET numero = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [numero || null, id]);
    }

    await client.query('COMMIT');
    res.json({ mensaje: 'Cotización actualizada exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editando cotización:', error);
    res.status(500).json({ error: 'Error al editar cotización' });
  } finally {
    client.release();
  }
});

// ➕ AGREGAR ítems adicionales a una cotización YA ACEPTADA (ej: el cliente pide adicionales en obra)
// Recalcula el total de la cotización y lo propaga al contrato y a estadisticas_proyecto.valor_contrato
router.post('/:id/adicionales', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos un ítem adicional' });
    }

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    const cotizacion = cotizacionResult.rows[0];

    if (!cotizacion.aceptada) {
      return res.status(400).json({ error: 'Esta cotización todavía no ha sido aceptada. Para editarla usa la opción Editar.' });
    }

    await client.query('BEGIN');

    const itemsValidos = items.filter((i) => i.descripcion && i.descripcion.trim() && i.valor);
    if (itemsValidos.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Los ítems deben tener descripción y valor' });
    }

    for (const item of itemsValidos) {
      await client.query(
        'INSERT INTO cotizacion_items (cotizacion_id, descripcion, valor, adicional) VALUES ($1, $2, $3, TRUE)',
        [id, item.descripcion, item.valor]
      );
    }

    const totalItemsResult = await client.query(
      'SELECT COALESCE(SUM(valor), 0) AS total FROM cotizacion_items WHERE cotizacion_id = $1',
      [id]
    );
    const nuevoTotal = parseFloat(totalItemsResult.rows[0].total);

    await client.query(
      'UPDATE cotizaciones SET total = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [nuevoTotal, id]
    );

    let contratoActualizado = null;
    if (cotizacion.proyecto_id) {
      const contratoResult = await client.query(
        'UPDATE contratos SET valor_total = $1 WHERE proyecto_id = $2 RETURNING *',
        [nuevoTotal, cotizacion.proyecto_id]
      );
      contratoActualizado = contratoResult.rows[0] || null;

      await client.query(
        'UPDATE estadisticas_proyecto SET valor_contrato = $1, updated_at = CURRENT_TIMESTAMP WHERE proyecto_id = $2',
        [nuevoTotal, cotizacion.proyecto_id]
      );
    }

    await client.query('COMMIT');

    res.json({
      mensaje: 'Ítems adicionales agregados exitosamente',
      total: nuevoTotal,
      contrato: contratoActualizado,
      proyecto_id: cotizacion.proyecto_id
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error agregando adicionales:', error);
    res.status(500).json({ error: 'Error al agregar ítems adicionales' });
  } finally {
    client.release();
  }
});

// 🗑️ ELIMINAR cotización (solo si no ha sido aceptada)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const cotizacionResult = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    if (cotizacionResult.rows[0].aceptada) {
      return res.status(400).json({ error: 'No se puede eliminar una cotización ya aceptada (ya generó un contrato)' });
    }

    await pool.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    await pool.query('DELETE FROM cotizaciones WHERE id = $1', [id]);

    res.json({ mensaje: 'Cotización eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando cotización:', error);
    res.status(500).json({ error: 'Error al eliminar cotización' });
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