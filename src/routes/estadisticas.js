const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { generarExcelFinancieroBuffer, generarExcelBalanceGeneralBuffer } = require('../utils/generarExcelFinanciero');
const { subirBufferAStorage, borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { esGerencia } = require('../utils/permisos');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Busca la fila de estadisticas_proyecto a partir del identificador que mande el frontend, que
// puede ser CUALQUIERA de los dos según el caso (ver comentario largo en GET /proyectos-lista):
// - Si el proyecto sigue activo: ese identificador ES su proyecto_id real (funciona igual que
//   siempre, antes de que existieran las fichas huérfanas).
// - Si el proyecto ya fue eliminado: proyecto_id de la ficha quedó en NULL (ON DELETE SET NULL,
//   ver migraciones.js) y el identificador estable pasa a ser ep.id (la clave primaria propia de
//   estadisticas_proyecto, que nunca cambia). Se prueba primero por proyecto_id y, si no aparece
//   nada, se reintenta por id propio — así funciona para ambos casos sin que el frontend tenga
//   que saber de antemano cuál de los dos está mandando.
async function buscarFilaEstadisticas(client, identificador) {
  let result = await client.query('SELECT * FROM estadisticas_proyecto WHERE proyecto_id = $1', [identificador]);
  if (result.rows.length === 0) {
    result = await client.query('SELECT * FROM estadisticas_proyecto WHERE id = $1 AND proyecto_eliminado = true', [identificador]);
  }
  return result.rows[0] || null;
}

// Arma el mismo objeto de estadísticas que devuelve GET /:proyecto_id, pero como función
// reutilizable (la usa también el endpoint de Excel, para no duplicar las 4 consultas).
async function obtenerEstadisticasProyecto(identificador) {
  const stats = await buscarFilaEstadisticas(pool, identificador);
  if (!stats) return null;

  // A partir de acá usamos SIEMPRE stats.proyecto_id (puede ser NULL si es huérfana) y stats.id
  // (el identificador propio) — nunca el parámetro `identificador` de entrada, que solo sirvió
  // para encontrar la fila correcta más arriba.
  const proyecto_id = stats.proyecto_id;

  // Si la ficha es huérfana (proyecto ya eliminado), proyecto_id es NULL — abonos_proyecto y
  // movimientos_costos ya perdieron su vínculo (mismo ON DELETE SET NULL, ver migraciones.js) y
  // "WHERE proyecto_id = NULL" nunca compara verdadero en SQL, así que no tiene sentido ni siquiera
  // consultarlas: siempre devolverían vacío. En vez de eso, se usa el total ya congelado en
  // total_abonado_snapshot (capturado en cascadaProyecto.js justo antes de que el proyecto se
  // borrara, ver comentario ahí) y se muestra el historial de movimientos como vacío (no hay forma
  // de recuperar el detalle línea por línea una vez perdido el vínculo — ver bug documentado en
  // migraciones.js, columna total_abonado_snapshot).
  const abonosResult = proyecto_id != null
    ? await pool.query('SELECT * FROM abonos_proyecto WHERE proyecto_id = $1 ORDER BY fecha DESC', [proyecto_id])
    : { rows: [] };

  const movimientosResult = proyecto_id != null
    ? await pool.query(
        `SELECT m.*, c.nombre AS categoria_nombre
         FROM movimientos_costos m
         LEFT JOIN categorias_costo c ON c.id = m.categoria_id
         WHERE m.proyecto_id = $1
         ORDER BY m.fecha DESC, m.created_at DESC`,
        [proyecto_id]
      )
    : { rows: [] };

  const resumenPorCategoriaResult = proyecto_id != null
    ? await pool.query(
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
      )
    : { rows: [] };

  const totalAbonado = proyecto_id != null
    ? abonosResult.rows.reduce((sum, a) => sum + parseFloat(a.valor), 0)
    : parseFloat(stats.total_abonado_snapshot || 0);
  const costos = parseFloat(stats.costos_materiales) + parseFloat(stats.valor_mano_obra) + parseFloat(stats.valor_imprevistos);
  const utilidad = parseFloat(stats.valor_contrato) - costos;

  return {
    ...stats,
    // id_ficha: identificador estable a usar en el frontend para CUALQUIER acción posterior sobre
    // esta ficha (ej. el botón "Eliminar estadísticas" de Gerencia) — es proyecto_id si el
    // proyecto sigue activo, o el id propio de la ficha si ya es huérfana. Evita que el frontend
    // tenga que replicar esta misma lógica de "cuál de los dos usar".
    id_ficha: proyecto_id || stats.id,
    abonos: abonosResult.rows,
    movimientos_costos: movimientosResult.rows,
    resumen_por_categoria: resumenPorCategoriaResult.rows,
    total_abonado: totalAbonado,
    saldo_pendiente: parseFloat(stats.valor_contrato) - totalAbonado,
    utilidad,
  };
}

// 👁️ LISTAR proyectos para la pantalla de Estadísticas: los proyectos activos de la empresa
// (igual que GET /proyectos/listar/:empresa_id) MÁS las fichas "huérfanas" (proyecto_eliminado =
// true) — proyectos que ya fueron borrados pero cuya ficha financiera se conserva siempre (ver
// borrarDependenciasDeProyecto en cascadaProyecto.js). Se define ANTES de GET /:proyecto_id a
// propósito, para que Express no confunda "proyectos-lista" con un proyecto_id.
router.get('/proyectos-lista/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;

    const activosResult = await pool.query(
      "SELECT id, id AS proyecto_id, nombre, cliente_nombre_snapshot, false AS proyecto_eliminado FROM proyectos WHERE empresa_id = $1 AND estado = 'activo' ORDER BY created_at DESC",
      [empresa_id]
    );
    // OJO: proyecto_id aquí YA ES NULL para las fichas huérfanas (ver ON DELETE SET NULL en
    // migraciones.js — al borrarse el proyecto, esta columna se desvincula automáticamente para
    // que la fila sobreviva). Por eso NO se puede usar proyecto_id para identificar la ficha una
    // vez que el proyecto ya no existe: se usa el id propio de estadisticas_proyecto (ep.id, que
    // nunca cambia) como identificador estable, tanto para pedir el detalle (GET /:id ya acepta
    // proyecto_id real para los activos) como para poder borrarla después.
    const huerfanosResult = await pool.query(
      `SELECT ep.id AS id, NULL AS proyecto_id, proyecto_nombre_snapshot AS nombre, cliente_nombre_snapshot, true AS proyecto_eliminado
       FROM estadisticas_proyecto ep
       WHERE empresa_id = $1 AND proyecto_eliminado = true
       ORDER BY updated_at DESC`,
      [empresa_id]
    );

    res.json({ proyectos: [...activosResult.rows, ...huerfanosResult.rows] });
  } catch (error) {
    console.error('Error listando proyectos para Estadísticas:', error);
    res.status(500).json({ error: 'Error al listar proyectos' });
  }
});

// 📊 BALANCE FINANCIERO GENERAL de la empresa (2026-08-28, a pedido explícito del usuario): suma
// las estadísticas de TODOS los proyectos de la empresa — activos Y huérfanos (proyectos ya
// eliminados, cuya ficha se conserva siempre, ver el blindaje 2026-08-28 en cascadaProyecto.js) —
// en un solo balance: valor total contratado, total abonado, costos totales, utilidad total.
// También arma el desglose por proyecto y por categoría de costo (transversal a todos los
// proyectos), reutilizando exactamente los mismos números que ya muestra cada ficha individual —
// no se inventa ni recalcula nada nuevo, solo se suma. Reservado a GERENCIA, igual que el borrado
// de una ficha de Estadísticas: es información financiera de toda la compañía, no de un proyecto
// puntual. Se define ANTES de GET /:proyecto_id para que Express no confunda "balance-general" con
// un proyecto_id (mismo motivo que proyectos-lista, arriba).
async function calcularBalanceGeneral(empresa_id) {
  // Trae la fila de estadisticas_proyecto de CADA proyecto de la empresa (activos vía JOIN a
  // proyectos, huérfanos por su propio empresa_id) junto con el nombre correcto en cada caso.
  const fichasResult = await pool.query(
    `SELECT
       ep.id AS ficha_id,
       ep.proyecto_id,
       ep.proyecto_eliminado,
       ep.total_abonado_snapshot,
       COALESCE(p.nombre, ep.proyecto_nombre_snapshot, 'Proyecto eliminado') AS proyecto_nombre,
       COALESCE(p.cliente_nombre_snapshot, ep.cliente_nombre_snapshot) AS cliente_nombre,
       ep.valor_contrato,
       ep.costos_materiales,
       ep.valor_mano_obra,
       ep.valor_imprevistos
     FROM estadisticas_proyecto ep
     LEFT JOIN proyectos p ON p.id = ep.proyecto_id
     WHERE ep.empresa_id = $1
     ORDER BY COALESCE(p.created_at, ep.updated_at) DESC`,
    [empresa_id]
  );

  // Abonos y resumen por categoría se agregan aparte (uno por ficha sería una consulta por
  // proyecto — en cambio, se traen TODOS los abonos/movimientos de la empresa de una vez y se
  // agrupan en memoria, mucho más liviano para una empresa con muchos proyectos).
  //
  // BUG encontrado en auditoría (2026-08-28) y corregido acá: este query original filtraba
  // "WHERE proyecto_id = ANY($1::int[])" con los proyecto_id de las fichas ACTIVAS únicamente
  // (proyectoIds ya excluía los NULL de las huérfanas) — los abonos de proyectos YA ELIMINADOS
  // nunca se sumaban al balance, porque abonos_proyecto.proyecto_id también quedó en NULL para
  // ellos (mismo ON DELETE SET NULL que a estadisticas_proyecto), y no existe ninguna otra columna
  // en abonos_proyecto que permita re-vincularlos a su ficha huérfana. Para los proyectos activos
  // se sigue sumando en vivo (más preciso, refleja abonos recién registrados); para los huérfanos
  // se usa total_abonado_snapshot, el total que quedó congelado en el momento del blindaje (ver
  // cascadaProyecto.js) ANTES de que el proyecto se borrara y se perdiera el vínculo.
  const proyectoIds = fichasResult.rows.map((f) => f.proyecto_id).filter((id) => id != null);

  const abonosPorProyecto = {};
  if (proyectoIds.length > 0) {
    const abonosResult = await pool.query(
      'SELECT proyecto_id, COALESCE(SUM(valor), 0) AS total FROM abonos_proyecto WHERE proyecto_id = ANY($1::int[]) GROUP BY proyecto_id',
      [proyectoIds]
    );
    abonosResult.rows.forEach((a) => { abonosPorProyecto[a.proyecto_id] = parseFloat(a.total); });
  }

  // Mismo bug aplicaba acá: el JOIN a estadisticas_proyecto por proyecto_id excluye los
  // movimientos_costos de proyectos eliminados (proyecto_id también quedó en NULL). A diferencia
  // de los abonos, el desglose POR CATEGORÍA de un proyecto eliminado no se puede reconstruir de
  // forma agregada sin perder el sentido (no hay snapshot de "costos por categoría" congelado,
  // solo el total por tipo en estadisticas_proyecto) — se documenta como limitación conocida más
  // abajo, en total_costos, que sí sigue siendo exacto porque usa las columnas de estadisticas_proyecto.
  const categoriasResult = await pool.query(
    `SELECT c.id AS categoria_id, c.nombre AS categoria_nombre,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'materiales'), 0) AS total_materiales,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'mano_obra'), 0) AS total_mano_obra,
            COALESCE(SUM(m.valor) FILTER (WHERE m.tipo = 'imprevistos'), 0) AS total_imprevistos,
            COALESCE(SUM(m.valor), 0) AS total
     FROM movimientos_costos m
     JOIN categorias_costo c ON c.id = m.categoria_id
     JOIN estadisticas_proyecto ep ON ep.proyecto_id = m.proyecto_id
     WHERE ep.empresa_id = $1
     GROUP BY c.id, c.nombre
     ORDER BY total DESC`,
    [empresa_id]
  );

  let totalContratado = 0;
  let totalAbonado = 0;
  let totalCostos = 0;

  const porProyecto = fichasResult.rows.map((f) => {
    const valorContrato = parseFloat(f.valor_contrato || 0);
    const costos = parseFloat(f.costos_materiales || 0) + parseFloat(f.valor_mano_obra || 0) + parseFloat(f.valor_imprevistos || 0);
    // Activo: se suma en vivo desde abonos_proyecto (más preciso). Huérfano: se usa el snapshot
    // congelado en el momento del blindaje, ya que abonos_proyecto.proyecto_id es NULL y no hay
    // forma de recuperar el valor real por otra vía (ver comentario largo más arriba).
    const abonado = f.proyecto_id != null
      ? (abonosPorProyecto[f.proyecto_id] || 0)
      : parseFloat(f.total_abonado_snapshot || 0);
    const utilidad = valorContrato - costos;

    totalContratado += valorContrato;
    totalAbonado += abonado;
    totalCostos += costos;

    return {
      ficha_id: f.ficha_id,
      proyecto_id: f.proyecto_id,
      proyecto_nombre: f.proyecto_nombre,
      cliente_nombre: f.cliente_nombre,
      proyecto_eliminado: f.proyecto_eliminado,
      valor_contrato: valorContrato,
      total_abonado: abonado,
      saldo_pendiente: valorContrato - abonado,
      costos_materiales: parseFloat(f.costos_materiales || 0),
      valor_mano_obra: parseFloat(f.valor_mano_obra || 0),
      valor_imprevistos: parseFloat(f.valor_imprevistos || 0),
      costos_totales: costos,
      utilidad,
    };
  });

  return {
    total_proyectos: porProyecto.length,
    total_contratado: totalContratado,
    total_abonado: totalAbonado,
    total_saldo_pendiente: totalContratado - totalAbonado,
    total_costos: totalCostos,
    utilidad_total: totalContratado - totalCostos,
    por_proyecto: porProyecto,
    por_categoria: categoriasResult.rows.map((c) => ({
      categoria_id: c.categoria_id,
      categoria_nombre: c.categoria_nombre,
      total_materiales: parseFloat(c.total_materiales || 0),
      total_mano_obra: parseFloat(c.total_mano_obra || 0),
      total_imprevistos: parseFloat(c.total_imprevistos || 0),
      total: parseFloat(c.total || 0),
    })),
  };
}

router.get('/balance-general/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { usuario_id } = req.query;

    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id es obligatorio' });
    }
    const esGerente = await esGerencia(usuario_id, empresa_id);
    if (!esGerente) {
      return res.status(403).json({ error: 'Solo Gerencia puede ver el balance financiero general' });
    }

    const balance = await calcularBalanceGeneral(empresa_id);
    res.json(balance);
  } catch (error) {
    console.error('Error calculando balance general:', error);
    res.status(500).json({ error: 'No se pudo calcular el balance general' });
  }
});

// 📊 GENERAR Y DESCARGAR el balance financiero general en Excel — mismo patrón que
// GET /:proyecto_id/excel (genera al vuelo, sube a Storage, se autodestruye a los 10 minutos),
// pero con el balance de TODOS los proyectos en vez de uno solo. Reservado a Gerencia.
router.get('/balance-general/:empresa_id/excel', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { usuario_id } = req.query;

    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id es obligatorio' });
    }
    const esGerente = await esGerencia(usuario_id, empresa_id);
    if (!esGerente) {
      return res.status(403).json({ error: 'Solo Gerencia puede descargar el balance financiero general' });
    }

    const empresaResult = await pool.query('SELECT nombre FROM empresas WHERE id = $1', [empresa_id]);
    const empresaNombre = empresaResult.rows[0]?.nombre || '';

    const balance = await calcularBalanceGeneral(empresa_id);
    const buffer = await generarExcelBalanceGeneralBuffer({ empresaNombre, balance });

    const rutaDestino = `estados_financieros/balance_general_${empresa_id}_${Date.now()}.xlsx`;
    const url = await subirBufferAStorage(
      buffer,
      rutaDestino,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    setTimeout(() => {
      borrarArchivoDeStorage(url).catch(() => {});
    }, 10 * 60 * 1000);

    res.json({ mensaje: 'Balance general generado exitosamente', url });
  } catch (error) {
    console.error('Error generando Excel de balance general:', error.message, error.stack);
    res.status(500).json({ error: 'No se pudo generar el balance general. Intenta de nuevo en unos minutos.' });
  }
});

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

    // Si el proyecto ya fue eliminado (ver proyecto_eliminado, blindaje 2026-08-28), ya no existe
    // en la tabla proyectos — usamos el snapshot guardado en estadisticas_proyecto en vez de un
    // JOIN que fallaría. El nombre de la empresa sí se busca aparte porque empresa_id nunca se
    // borra (la empresa siempre existe mientras el usuario esté generando este reporte).
    let proyecto_nombre;
    let empresa_nombre;
    if (stats.proyecto_eliminado) {
      proyecto_nombre = stats.proyecto_nombre_snapshot || 'Proyecto eliminado';
      // El proyecto ya no existe, así que no podemos llegar a la empresa vía JOIN a proyectos —
      // el frontend manda empresa_id como query param en este caso (ver EstadisticasScreen.tsx),
      // ya que lo tiene disponible en la sesión de todas formas.
      const { empresa_id } = req.query;
      if (empresa_id) {
        const empresaResult = await pool.query('SELECT nombre FROM empresas WHERE id = $1', [empresa_id]);
        empresa_nombre = empresaResult.rows[0]?.nombre || '';
      } else {
        empresa_nombre = '';
      }
    } else {
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
      ({ proyecto_nombre, empresa_nombre } = proyectoResult.rows[0]);
    }

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

    // Solo lectura si el proyecto ya fue eliminado (2026-08-28, a pedido del usuario): la ficha
    // financiera sobrevive para consulta, pero nadie puede seguir registrando movimientos nuevos
    // en un proyecto que ya no existe.
    const fichaActual = await client.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
    }

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

    // Solo lectura si el proyecto ya fue eliminado (ver comentario en POST /:proyecto_id/movimiento).
    const fichaActual = await client.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [movimientoViejo.proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
    }

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

    // Solo lectura si el proyecto ya fue eliminado (ver comentario en POST /:proyecto_id/movimiento).
    const fichaActual = await client.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [movimiento.proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
    }

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

    // Solo lectura si el proyecto ya fue eliminado (ver comentario en POST /:proyecto_id/movimiento).
    const fichaActual = await pool.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
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

    const abonoActual = await pool.query('SELECT proyecto_id FROM abonos_proyecto WHERE id = $1', [id]);
    if (abonoActual.rows.length === 0) {
      return res.status(404).json({ error: 'Abono no encontrado' });
    }
    // Solo lectura si el proyecto ya fue eliminado (ver comentario en POST /:proyecto_id/movimiento).
    const fichaActual = await pool.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [abonoActual.rows[0].proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
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

    const abonoActual = await pool.query('SELECT proyecto_id FROM abonos_proyecto WHERE id = $1', [id]);
    if (abonoActual.rows.length === 0) {
      return res.status(404).json({ error: 'Abono no encontrado' });
    }
    // Solo lectura si el proyecto ya fue eliminado (ver comentario en POST /:proyecto_id/movimiento).
    const fichaActual = await pool.query('SELECT proyecto_eliminado FROM estadisticas_proyecto WHERE proyecto_id = $1', [abonoActual.rows[0].proyecto_id]);
    if (fichaActual.rows.length > 0 && fichaActual.rows[0].proyecto_eliminado) {
      return res.status(403).json({ error: 'Este proyecto fue eliminado — su ficha de Estadísticas es de solo lectura' });
    }

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

// 🗑️ ELIMINAR la ficha COMPLETA de Estadísticas de un proyecto (2026-08-28, a pedido explícito
// del usuario): borra estadisticas_proyecto, abonos_proyecto y movimientos_costos de ese
// proyecto_id para siempre. A diferencia de eliminar el proyecto (que NUNCA borra esta ficha —
// ver borrarDependenciasDeProyecto en cascadaProyecto.js), esta es la ÚNICA forma de que un
// registro financiero desaparezca de verdad, y está reservada exclusivamente a GERENCIA — ni
// siquiera Área Administrativa (que sí puede eliminar proyectos) tiene esta facultad.
router.delete('/:proyecto_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { proyecto_id: identificador } = req.params;
    const { usuario_id, empresa_id } = req.body;

    if (!usuario_id || !empresa_id) {
      return res.status(400).json({ error: 'usuario_id y empresa_id son obligatorios' });
    }
    const esGerente = await esGerencia(usuario_id, empresa_id);
    if (!esGerente) {
      return res.status(403).json({ error: 'Solo Gerencia puede eliminar una ficha de Estadísticas' });
    }

    // El identificador que manda el frontend puede ser el proyecto_id real (proyecto activo) o el
    // id propio de la ficha (proyecto ya eliminado, ver comentario largo en buscarFilaEstadisticas
    // más arriba) — se busca la fila real primero para saber con certeza su clave primaria (ficha.id)
    // y su proyecto_id verdadero (puede ser NULL), y se borra usando esos dos valores directamente
    // en vez de volver a adivinar cuál de los dos era el identificador de entrada.
    const ficha = await buscarFilaEstadisticas(client, identificador);
    if (!ficha) {
      return res.status(404).json({ error: 'No hay estadísticas para este proyecto' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM movimientos_costos WHERE proyecto_id = $1', [ficha.proyecto_id]);
    await client.query('DELETE FROM abonos_proyecto WHERE proyecto_id = $1', [ficha.proyecto_id]);
    // Por id propio, no por proyecto_id: si la ficha es huérfana, proyecto_id ya es NULL y
    // "WHERE proyecto_id = NULL" nunca compara verdadero en SQL (no borraría nada).
    await client.query('DELETE FROM estadisticas_proyecto WHERE id = $1', [ficha.id]);
    await client.query('COMMIT');

    res.json({ mensaje: 'Ficha de estadísticas eliminada exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando ficha de estadísticas:', error);
    res.status(500).json({ error: 'Error al eliminar la ficha de estadísticas' });
  } finally {
    client.release();
  }
});

module.exports = router;