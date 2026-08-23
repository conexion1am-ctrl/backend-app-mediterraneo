const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { generarExcelFinancieroBuffer } = require('../utils/generarExcelFinanciero');
const { subirBufferAStorage, borrarArchivoDeStorage } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Arma el mismo objeto de estadísticas que devuelve GET /:proyecto_id, pero como función
// reutilizable (la usa también el endpoint de Excel, para no duplicar las 4 consultas).
async function obtenerEstadisticasProyecto(proyecto_id) {
  const statsResult = await pool.query('SELECT * FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto_id]);
  if (statsResult.rows.length === 0) return null;
  const stats = statsResult.rows[0];

  const abonosResult = await pool.query(
    'SELECT * FROM abonos_proyecto WHERE proyecto_id = $1 ORDER BY fecha DESC',
    [proyecto_id]
  );

  const movimientosResult = await pool.query(
    `SELECT m.*, c.nombre AS categoria_nombre
     FROM movimientos_costos m
     LEFT JOIN categorias_costo c ON c.id = m.categoria_id
     WHERE m.proyecto_id = $1
     ORDER BY m.fecha DESC, m.created_at DESC`,
    [proyecto_id]
  );

  const resumenPorCategoriaResult = await pool.query(
    `SELECT c.id AS categoria_id, c.nombre AS categoria_nombre,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'materiales'), 0) AS total_materiales,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'mano_obra'), 0) AS total_mano_obra,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'imprevistos'), 0) AS total_imprevistos,
            COALESCE(SUM(m.valor), 0) AS total
     FROM movimientos_costos m
     JOIN categorias_costo c ON c.id = m.categoria_id
     WHERE m.proyecto_id = $1
     GROUP BY c.id, c.nombre
     ORDER BY total DESC`,
    [proyecto_id]
  );

  const totalAbonado = abonosResult.rows.reduce((sum, a) => sum + parseFloat(a.valor), 0);
  const costos = parseFloat(stats.costos_materiales) + parseFloat(stats.valor_mano_obra) + parseFloat(stats.valor_imprevistos);
  const utilidad = parseFloat(stats.valor_contrato) - costos;

  return {
    ...stats,
    abonos: abonosResult.rows,
    movimientos_costos: movimientosResult.rows,
    resumen_por_categoria: resumenPorCategoriaResult.rows,
    total_abonado: totalAbonado,
    saldo_pendiente: parseFloat(stats.valor_contrato) - totalAbonado,
    utilidad,
  };
}

// 👁️ VER estadísticas de un proyecto (incluye utilidad calculada, el historial de movimientos
// de costos agrupado por tipo: materiales, mano_obra, imprevistos, y un resumen por CATEGORÍA
// -carpintería, ferretería, estuco, etc- que suma materiales + mano de obra + imprevistos de
// cada rubro, para saber cuánto costó REALMENTE cada uno).
router.get('/:proyecto_id', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    const stats = await obtenerEstadisticasProyecto(proyecto_id);
    if (!stats) {
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto todavía' });
    }
    res.json(stats);
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// 📊 GENERAR Y DESCARGAR el estado financiero del proyecto en Excel (.xlsx): resumen, costos por
// categoría, historial de movimientos y de abonos. Se genera al momento (no se guarda en la base
// de datos ni en Storage, a diferencia del PDF de cotización/contrato) porque cambia cada vez que
// se registra un nuevo costo o abono — no tendría sentido cachear una versión vieja.
router.get('/:proyecto_id/excel', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    const stats = await obtenerEstadisticasProyecto(proyecto_id);
    if (!stats) {
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto todavía' });
    }

    const proyectoResult = await pool.query(
      `SELECT p.nombre AS proyecto_nombre, e.nombre AS empresa_nombre
       FROM proyectos p
       JOIN empresas e ON e.id = p.empresa_id
       WHERE p.id = $1`,
      [proyecto_id]
    );
    if (proyectoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    const { proyecto_nombre, empresa_nombre } = proyectoResult.rows[0];

    const buffer = await generarExcelFinancieroBuffer({
      proyectoNombre: proyecto_nombre,
      empresaNombre: empresa_nombre,
      stats,
    });

    const rutaDestino = `estados_financieros/proyecto_${proyecto_id}_${Date.now()}.xlsx`;
    const url = await subirBufferAStorage(
      buffer,
      rutaDestino,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    // Este Excel no se guarda de forma permanente (a diferencia de los PDF de cotización/
    // contrato): se genera al vuelo cada vez porque los datos cambian con cada costo o abono
    // nuevo. Para no acumular archivos huérfanos en Storage para siempre, lo borramos 10 minutos
    // después de servirlo — tiempo de sobra para que el celular termine de descargarlo desde la
    // URL antes de que se elimine.
    setTimeout(() => {
      borrarArchivoDeStorage(url).catch(() => {});
    }, 10 * 60 * 1000);

    res.json({ mensaje: 'Estado financiero generado exitosamente', url });
  } catch (error) {
    // Errores esperables: Firebase Admin sin configurar (no debería pasar en producción, pero
    // así el mensaje explica la causa real en vez de un genérico "Error interno").
    console.error('Error generando Excel de estado financiero:', error.message, error.stack);
    res.status(500).json({ error: 'No se pudo generar el estado financiero. Intenta de nuevo en unos minutos.' });
  }
});

// 👁️ LISTAR las categorías de costo de una empresa (ej. Carpintería, Ferretería, Estuco),
// ordenadas alfabéticamente para que sean fáciles de encontrar en la lista.
router.get('/categorias/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      'SELECT * FROM categorias_costo WHERE empresa_id = $1 ORDER BY nombre ASC',
      [empresa_id]
    );
    res.json({ categorias: result.rows });
  } catch (error) {
    console.error('Error listando categorías de costo:', error);
    res.status(500).json({ error: 'Error al listar categorías de costo' });
  }
});

// 📝 CREAR una categoría de costo nueva (ej. cuando el usuario escribe "Estuco" por primera
// vez). Si ya existe una con el mismo nombre en esa empresa, devolvemos la existente en vez de
// duplicarla (evita categorías repetidas por mayúsculas/espacios o toques accidentales dobles).
router.post('/categorias', async (req, res) => {
  try {
    const { empresa_id, nombre } = req.body;
    if (!empresa_id || !nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    const nombreLimpio = nombre.trim();
    const existente = await pool.query(
      'SELECT * FROM categorias_costo WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2)',
      [empresa_id, nombreLimpio]
    );
    if (existente.rows.length > 0) {
      return res.status(200).json({ mensaje: 'La categoría ya existía', categoria: existente.rows[0] });
    }

    const result = await pool.query(
      'INSERT INTO categorias_costo (empresa_id, nombre) VALUES ($1, $2) RETURNING *',
      [empresa_id, nombreLimpio]
    );
    res.status(201).json({ mensaje: 'Categoría creada exitosamente', categoria: result.rows[0] });
  } catch (error) {
    console.error('Error creando categoría de costo:', error);
    res.status(500).json({ error: 'Error al crear la categoría' });
  }
});

// 🗑️ ELIMINAR una categoría de costo. Los movimientos que la usaban NO se borran, solo quedan
// sin categoría (ver ON DELETE SET NULL en migraciones.js), para no perder el historial de
// gastos ya registrado.
router.delete('/categorias/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM categorias_costo WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    res.json({ mensaje: 'Categoría eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando categoría de costo:', error);
    res.status(500).json({ error: 'Error al eliminar la categoría' });
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
    const { tipo, detalle, valor, fecha, categoria_id } = req.body;

    const tiposValidos = ['materiales', 'mano_obra', 'imprevistos'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de costo inválido' });
    }
    if (!valor || parseFloat(valor) <= 0) {
      return res.status(400).json({ error: 'El valor debe ser mayor a 0' });
    }

    await client.query('BEGIN');

    const movimiento = await client.query(
      'INSERT INTO movimientos_costos (proyecto_id, tipo, detalle, valor, fecha, categoria_id) VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6) RETURNING *',
      [proyecto_id, tipo, detalle || null, valor, fecha || null, categoria_id || null]
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

// ✏️ EDITAR un movimiento de costo ya registrado (por si se equivocaron al escribir el valor de
// una factura, la fecha, el detalle o la categoría). Recalcula los totales de
// estadisticas_proyecto: primero resta el valor VIEJO de su columna, y suma el valor NUEVO a su
// columna correspondiente — así funciona correctamente incluso si además de cambiar el valor,
// también cambia el tipo (ej. lo habían puesto como "imprevistos" y en realidad era "materiales").
router.put('/movimiento/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { tipo, detalle, valor, fecha, categoria_id } = req.body;

    const tiposValidos = ['materiales', 'mano_obra', 'imprevistos'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de costo inválido' });
    }
    if (!valor || parseFloat(valor) <= 0) {
      return res.status(400).json({ error: 'El valor debe ser mayor a 0' });
    }

    const movimientoResult = await client.query('SELECT * FROM movimientos_costos WHERE id = $1', [id]);
    if (movimientoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    const movimientoViejo = movimientoResult.rows[0];
    const columnaVieja = movimientoViejo.tipo === 'materiales' ? 'costos_materiales' : movimientoViejo.tipo === 'mano_obra' ? 'valor_mano_obra' : 'valor_imprevistos';
    const columnaNueva = tipo === 'materiales' ? 'costos_materiales' : tipo === 'mano_obra' ? 'valor_mano_obra' : 'valor_imprevistos';

    await client.query('BEGIN');

    // Revierte el valor viejo de su columna original.
    await client.query(
      `UPDATE estadisticas_proyecto SET ${columnaVieja} = GREATEST(${columnaVieja} - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE proyecto_id = $2`,
      [movimientoViejo.valor, movimientoViejo.proyecto_id]
    );
    // Suma el valor nuevo a su columna correspondiente (puede ser la misma columna de antes).
    const estadisticas = await client.query(
      `UPDATE estadisticas_proyecto SET ${columnaNueva} = ${columnaNueva} + $1, updated_at = CURRENT_TIMESTAMP WHERE proyecto_id = $2 RETURNING *`,
      [valor, movimientoViejo.proyecto_id]
    );

    const movimiento = await client.query(
      'UPDATE movimientos_costos SET tipo = $1, detalle = $2, valor = $3, fecha = COALESCE($4, fecha), categoria_id = $5 WHERE id = $6 RETURNING *',
      [tipo, detalle || null, valor, fecha || null, categoria_id || null, id]
    );

    await client.query('COMMIT');

    res.json({ mensaje: 'Movimiento actualizado exitosamente', movimiento: movimiento.rows[0], estadisticas: estadisticas.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editando movimiento de costo:', error);
    res.status(500).json({ error: 'Error al editar el movimiento' });
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

// ✏️ EDITAR un abono ya registrado (por si el cliente dice que abonó un valor distinto al que
// se ingresó por error, o hay que corregir la fecha).
router.put('/abono/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, fecha } = req.body;

    if (!valor || !fecha) {
      return res.status(400).json({ error: 'valor y fecha son obligatorios' });
    }

    const result = await pool.query(
      'UPDATE abonos_proyecto SET valor = $1, fecha = $2 WHERE id = $3 RETURNING *',
      [valor, fecha, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Abono no encontrado' });
    }

    res.json({ mensaje: 'Abono actualizado exitosamente', abono: result.rows[0] });
  } catch (error) {
    console.error('Error editando abono:', error);
    res.status(500).json({ error: 'Error al editar el abono' });
  }
});

// 🗑️ ELIMINAR un abono (por si se registró por error, ej. un abono duplicado o un valor
// completamente equivocado que es más fácil borrar que corregir).
router.delete('/abono/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM abonos_proyecto WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Abono no encontrado' });
    }

    res.json({ mensaje: 'Abono eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando abono:', error);
    res.status(500).json({ error: 'Error al eliminar el abono' });
  }
});

module.exports = router;