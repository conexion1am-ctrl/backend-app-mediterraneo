const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 👁️ VER estadísticas de un proyecto (incluye utilidad calculada y el historial de movimientos
// de costos, agrupado por tipo: materiales, mano_obra, imprevistos)
router.get('/:proyecto_id', async (req, res) => {
  try {
    const { proyecto_id } = req.params;

    const statsResult = await pool.query('SELECT * FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto_id]);
    if (statsResult.rows.length === 0) {
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto todavía' });
    }
    const stats = statsResult.rows[0];

    const abonosResult = await pool.query(
      'SELECT * FROM abonos_proyecto WHERE proyecto_id = $1 ORDER BY fecha DESC',
      [proyecto_id]
    );

    const movimientosResult = await pool.query(
      'SELECT * FROM movimientos_costos WHERE proyecto_id = $1 ORDER BY fecha DESC, created_at DESC',
      [proyecto_id]
    );

    const totalAbonado = abonosResult.rows.reduce((sum, a) => sum + parseFloat(a.valor), 0);

    const costos = parseFloat(stats.costos_materiales) + parseFloat(stats.valor_mano_obra) + parseFloat(stats.valor_imprevistos);
    const utilidad = parseFloat(stats.valor_contrato) - costos;

    res.json({
      ...stats,
      abonos: abonosResult.rows,
      movimientos_costos: movimientosResult.rows,
      total_abonado: totalAbonado,
      saldo_pendiente: parseFloat(stats.valor_contrato) - totalAbonado,
      utilidad
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// 📝 REGISTRAR un movimiento de costo (una compra de materiales, un pago de mano de obra, o un
// imprevisto), con detalle y valor. Se suma automáticamente al total de esa categoría en
// estadisticas_proyecto, y queda guardado en el historial para poder verlo después.
// tipo debe ser: 'materiales' | 'mano_obra' | 'imprevistos'
router.post('/:proyecto_id/movimiento', async (req, res) => {
  const client = await pool.connect();
  try {
    const { proyecto_id } = req.params;
    const { tipo, detalle, valor, fecha } = req.body;

    const tiposValidos = ['materiales', 'mano_obra', 'imprevistos'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de costo inválido' });
    }
    if (!valor || parseFloat(valor) <= 0) {
      return res.status(400).json({ error: 'El valor debe ser mayor a 0' });
    }

    await client.query('BEGIN');

    const movimiento = await client.query(
      'INSERT INTO movimientos_costos (proyecto_id, tipo, detalle, valor, fecha) VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE)) RETURNING *',
      [proyecto_id, tipo, detalle || null, valor, fecha || null]
    );

    const columna = tipo === 'materiales' ? 'costos_materiales' : tipo === 'mano_obra' ? 'valor_mano_obra' : 'valor_imprevistos';

    const estadisticas = await client.query(
      `UPDATE estadisticas_proyecto SET ${columna} = ${columna} + $1, updated_at = CURRENT_TIMESTAMP WHERE proyecto_id = $2 RETURNING *`,
      [valor, proyecto_id]
    );

    if (estadisticas.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto todavía' });
    }

    await client.query('COMMIT');

    res.status(201).json({ mensaje: 'Movimiento registrado exitosamente', movimiento: movimiento.rows[0], estadisticas: estadisticas.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error registrando movimiento de costo:', error);
    res.status(500).json({ error: 'Error al registrar el movimiento' });
  } finally {
    client.release();
  }
});

// 🗑️ ELIMINAR un movimiento de costo (por si se registró por error), restando su valor del
// total de esa categoría.
router.delete('/movimiento/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const movimientoResult = await client.query('SELECT * FROM movimientos_costos WHERE id = $1', [id]);
    if (movimientoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    const movimiento = movimientoResult.rows[0];
    const columna = movimiento.tipo === 'materiales' ? 'costos_materiales' : movimiento.tipo === 'mano_obra' ? 'valor_mano_obra' : 'valor_imprevistos';

    await client.query('BEGIN');
    await client.query(
      `UPDATE estadisticas_proyecto SET ${columna} = GREATEST(${columna} - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE proyecto_id = $2`,
      [movimiento.valor, movimiento.proyecto_id]
    );
    await client.query('DELETE FROM movimientos_costos WHERE id = $1', [id]);
    await client.query('COMMIT');

    res.json({ mensaje: 'Movimiento eliminado exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando movimiento de costo:', error);
    res.status(500).json({ error: 'Error al eliminar el movimiento' });
  } finally {
    client.release();
  }
});

// 📝 REGISTRAR abono con fecha
router.post('/:proyecto_id/abono', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    const { valor, fecha } = req.body;

    if (!valor || !fecha) {
      return res.status(400).json({ error: 'valor y fecha son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO abonos_proyecto (proyecto_id, valor, fecha) VALUES ($1, $2, $3) RETURNING *',
      [proyecto_id, valor, fecha]
    );

    res.status(201).json({ mensaje: 'Abono registrado exitosamente', abono: result.rows[0] });
  } catch (error) {
    console.error('Error registrando abono:', error);
    res.status(500).json({ error: 'Error al registrar abono' });
  }
});

module.exports = router;