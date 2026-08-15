const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 👁️ VER estadísticas de un proyecto (incluye utilidad calculada)
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

    const totalAbonado = abonosResult.rows.reduce((sum, a) => sum + parseFloat(a.valor), 0);

    const costos = parseFloat(stats.costos_materiales) + parseFloat(stats.valor_mano_obra) + parseFloat(stats.valor_imprevistos);
    const utilidad = parseFloat(stats.valor_contrato) - costos;

    res.json({
      ...stats,
      abonos: abonosResult.rows,
      total_abonado: totalAbonado,
      saldo_pendiente: parseFloat(stats.valor_contrato) - totalAbonado,
      utilidad
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ✏️ ACTUALIZAR costos (materiales, mano de obra, imprevistos)
router.put('/:proyecto_id', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    const { costos_materiales, valor_mano_obra, valor_imprevistos } = req.body;

    const result = await pool.query(
      `UPDATE estadisticas_proyecto 
       SET costos_materiales = COALESCE($1, costos_materiales),
           valor_mano_obra = COALESCE($2, valor_mano_obra),
           valor_imprevistos = COALESCE($3, valor_imprevistos),
           updated_at = CURRENT_TIMESTAMP
       WHERE proyecto_id = $4 RETURNING *`,
      [costos_materiales, valor_mano_obra, valor_imprevistos, proyecto_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto todavía' });
    }

    res.json({ mensaje: 'Estadísticas actualizadas exitosamente', estadisticas: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando estadísticas:', error);
    res.status(500).json({ error: 'Error al actualizar estadísticas' });
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