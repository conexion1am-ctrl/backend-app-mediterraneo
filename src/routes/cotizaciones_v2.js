const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { generarPdfBuffer } = require('../utils/generarPdf');
const { subirBufferAStorage, borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { esGerencia } = require('../utils/permisos');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Valores por defecto de los campos "estándar" de la carta (editables por el usuario al crear
// la cotización, pero precargados para no empezar desde cero cada vez).
const PARRAFO_CONTEXTO_DEFECTO = 'Por solicitud efectuada paso a cotizar los precios del Kit de acabados completos para su casa';
const TIEMPO_ENTREGA_DEFECTO = '12 - 14 Semanas';
const CONDICIONES_PAGO_DEFECTO = [
  { porcentaje: 25, descripcion: 'A la firma del contrato para el inicio de actividades' },
  { porcentaje: 25, descripcion: 'A las 3-4 semanas con avance' },
  { porcentaje: 25, descripcion: 'A la entrega de la obra blanca' },
  { porcentaje: 25, descripcion: 'A la entrega final de la obra, incluyendo carpintería' },
];

// 📝 CREAR cotización con sus ítems
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      empresa_id, cliente_id, proyecto_id, numero, items, descuento,
      propietario, ciudad, parrafo_contexto, condiciones_pago, tiempo_entrega, firmante,
    } = req.body;

    if (!empresa_id || !cliente_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'empresa_id, cliente_id e items son obligatorios' });
    }

    await client.query('BEGIN');

    const subtotal = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);
    const total = subtotal - (parseFloat(descuento) || 0);

    const cotizacionResult = await client.query(
      `INSERT INTO cotizaciones
        (empresa_id, cliente_id, proyecto_id, numero, total, descuento,
         propietario, ciudad, parrafo_contexto, condiciones_pago, tiempo_entrega, firmante)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        empresa_id, cliente_id, proyecto_id || null, numero || null, total, parseFloat(descuento) || 0,
        propietario || null, ciudad || null,
        parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
        JSON.stringify(condiciones_pago && condiciones_pago.length ? condiciones_pago : CONDICIONES_PAGO_DEFECTO),
        tiempo_entrega || TIEMPO_ENTREGA_DEFECTO,
        firmante || null,
      ]
    );
    const cotizacion = cotizacionResult.rows[0];

    for (const item of items) {
      await client.query(
        'INSERT INTO cotizacion_items (cotizacion_id, descripcion, cantidad, valor, seccion) VALUES ($1, $2, $3, $4, $5)',
        [cotizacion.id, item.descripcion, item.cantidad || null, item.valor, item.seccion || null]
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
    // LEFT JOIN (no JOIN): si el cliente fue eliminado, la cotización sigue apareciendo,
    // usando el nombre que quedó guardado en cliente_nombre_snapshot al momento de eliminarlo.
    // También traemos nombre_proyecto y mts2 del cliente, para mostrarlos en la ficha de la
    // pantalla de Cotizaciones (si el cliente ya fue eliminado, estos quedan en null).
    const result = await pool.query(
      `SELECT co.*, COALESCE(cl.nombre, co.cliente_nombre_snapshot) AS cliente_nombre,
              cl.nombre_proyecto, cl.mts2
       FROM cotizaciones co
       LEFT JOIN clientes cl ON cl.id = co.cliente_id
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

// ✅ ACEPTAR cotización → crea SOLO el contrato (ya NO crea el proyecto automáticamente).
// El proyecto se crea después, manualmente, con el botón "Crear Proyecto" en la pantalla de
// Contratos (ver POST /contratos/:id/crear-proyecto más abajo). Esto permite que el usuario
// pueda eliminar el proyecto sin perder el contrato, y volver a crearlo cuando lo necesite.
// El contrato guarda un "snapshot" (copia propia, blindada) del nombre/dirección/m2 del
// proyecto tal como estaban en el cliente al momento de aceptar, para poder crear el proyecto
// más adelante con esos mismos datos aunque el cliente original ya no exista.
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

    const clienteResult = await client.query('SELECT * FROM clientes WHERE id = $1', [cotizacion.cliente_id]);
    const cliente = clienteResult.rows[0];
    const nombreProyecto = (cliente && cliente.nombre_proyecto) ? cliente.nombre_proyecto : `Proyecto de ${cliente ? cliente.nombre : 'cliente'}`;

    await client.query(
      "UPDATE cotizaciones SET aceptada = TRUE, estado = 'aceptada', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    // El contrato nace SIN proyecto_id: el proyecto se crea después, a demanda, desde la
    // pantalla de Contratos. Guardamos aquí el snapshot con el que se creará ese proyecto.
    const contratoResult = await client.query(
      `INSERT INTO contratos
        (cotizacion_id, empresa_id, proyecto_id, fecha_entrega, valor_total,
         proyecto_nombre_snapshot, proyecto_direccion_snapshot, proyecto_mts2_snapshot)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7) RETURNING *`,
      [id, cotizacion.empresa_id, fecha_entrega || null, cotizacion.total,
       nombreProyecto, cliente?.direccion || null, cliente?.mts2 || null]
    );

    await client.query('COMMIT');

    res.json({ mensaje: 'Cotización aceptada y contrato generado exitosamente', contrato: contratoResult.rows[0] });

    // Generar y subir el PDF del contrato DESPUÉS de responder, para no hacer esperar al
    // usuario ni bloquear la aceptación si Puppeteer falla o tarda. Es "best effort": si
    // falla, el contrato queda igual creado, solo sin pdf_url (se puede reintentar luego).
    generarYGuardarPdfContrato(id, contratoResult.rows[0].id, null).catch((error) => {
      console.error('Error generando PDF automático del contrato:', error.message);
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando cotización:', error);
    res.status(500).json({ error: 'Error al aceptar cotización' });
  } finally {
    client.release();
  }
});

// 🏗️ CREAR PROYECTO a partir de un contrato ya aceptado que todavía no tiene proyecto (porque
// nunca se creó, o porque se eliminó desde la pantalla de Proyectos). Usa el snapshot guardado
// en el contrato (nombre/dirección/m2) y, si el cliente original todavía existe, también copia
// su nombre/celular/cédula como snapshot PROPIO del proyecto — así el proyecto queda blindado:
// aunque luego se borre el cliente o la cotización, el proyecto conserva esos datos.
router.post('/contratos/:id/crear-proyecto', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const contratoResult = await client.query('SELECT * FROM contratos WHERE id = $1', [id]);
    if (contratoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    const contrato = contratoResult.rows[0];

    if (contrato.proyecto_id) {
      return res.status(400).json({ error: 'Este contrato ya tiene un proyecto creado' });
    }

    await client.query('BEGIN');

    let cliente = null;
    if (contrato.cotizacion_id) {
      const cotizacionResult = await client.query('SELECT cliente_id FROM cotizaciones WHERE id = $1', [contrato.cotizacion_id]);
      const clienteId = cotizacionResult.rows[0]?.cliente_id;
      if (clienteId) {
        const clienteResult = await client.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
        cliente = clienteResult.rows[0] || null;
      }
    }

    const nuevoProyecto = await client.query(
      `INSERT INTO proyectos
        (empresa_id, nombre, direccion, area_m2, cliente_nombre_snapshot, cliente_celular_snapshot, cliente_cedula_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        contrato.empresa_id,
        contrato.proyecto_nombre_snapshot || 'Proyecto sin nombre',
        contrato.proyecto_direccion_snapshot || null,
        contrato.proyecto_mts2_snapshot || null,
        cliente?.nombre || null,
        cliente?.celular || null,
        cliente?.cedula || null,
      ]
    );
    const proyecto = nuevoProyecto.rows[0];

    await client.query('UPDATE contratos SET proyecto_id = $1 WHERE id = $2', [proyecto.id, id]);
    if (contrato.cotizacion_id) {
      await client.query('UPDATE cotizaciones SET proyecto_id = $1 WHERE id = $2', [proyecto.id, contrato.cotizacion_id]);
    }

    const estadisticasExistentes = await client.query('SELECT id FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto.id]);
    if (estadisticasExistentes.rows.length === 0) {
      await client.query(
        'INSERT INTO estadisticas_proyecto (proyecto_id, valor_contrato) VALUES ($1, $2)',
        [proyecto.id, contrato.valor_total]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ mensaje: 'Proyecto creado exitosamente', proyecto, contrato: { ...contrato, proyecto_id: proyecto.id } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando proyecto desde contrato:', error.message);
    res.status(500).json({ error: 'No se pudo crear el proyecto. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// ✏️ EDITAR cotización (solo si no ha sido aceptada)
router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      numero, items, descuento,
      propietario, ciudad, parrafo_contexto, condiciones_pago, tiempo_entrega, firmante,
    } = req.body;

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    if (cotizacionResult.rows[0].aceptada) {
      return res.status(400).json({ error: 'No se puede editar una cotización ya aceptada' });
    }

    await client.query('BEGIN');

    if (items && items.length > 0) {
      const subtotal = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);
      const total = subtotal - (parseFloat(descuento) || 0);
      await client.query(
        `UPDATE cotizaciones SET numero = $1, total = $2, descuento = $3,
          propietario = $4, ciudad = $5, parrafo_contexto = $6, condiciones_pago = $7, tiempo_entrega = $8, firmante = $9,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $10`,
        [
          numero || null, total, parseFloat(descuento) || 0,
          propietario || null, ciudad || null, parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
          JSON.stringify(condiciones_pago && condiciones_pago.length ? condiciones_pago : CONDICIONES_PAGO_DEFECTO),
          tiempo_entrega || TIEMPO_ENTREGA_DEFECTO, firmante || null,
          id,
        ]
      );

      await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
      for (const item of items) {
        await client.query('INSERT INTO cotizacion_items (cotizacion_id, descripcion, cantidad, valor, seccion) VALUES ($1, $2, $3, $4, $5)', [id, item.descripcion, item.cantidad || null, item.valor, item.seccion || null]);
      }
    } else {
      await client.query(
        `UPDATE cotizaciones SET numero = $1,
          propietario = $2, ciudad = $3, parrafo_contexto = $4, condiciones_pago = $5, tiempo_entrega = $6, firmante = $7,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [
          numero || null,
          propietario || null, ciudad || null, parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
          JSON.stringify(condiciones_pago && condiciones_pago.length ? condiciones_pago : CONDICIONES_PAGO_DEFECTO),
          tiempo_entrega || TIEMPO_ENTREGA_DEFECTO, firmante || null,
          id,
        ]
      );
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
        'INSERT INTO cotizacion_items (cotizacion_id, descripcion, cantidad, valor, adicional, seccion) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, item.descripcion, item.cantidad || null, item.valor, item.seccion || null]
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

// ✏️ EDITAR ítems de una cotización YA ACEPTADA (el cliente pide cambiar cantidades, valores o
// quitar/agregar ítems mientras la obra está en curso). Reemplaza la lista completa de ítems,
// recalcula el total y propaga el nuevo valor al contrato y a las estadísticas del proyecto.
router.put('/:id/items-aceptada', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items, descuento } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos un ítem' });
    }

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    const cotizacion = cotizacionResult.rows[0];

    if (!cotizacion.aceptada) {
      return res.status(400).json({ error: 'Esta cotización todavía no ha sido aceptada. Para editarla usa la opción Editar normal.' });
    }

    const itemsValidos = items.filter((i) => i.descripcion && i.descripcion.trim() && i.valor);
    if (itemsValidos.length === 0) {
      return res.status(400).json({ error: 'Los ítems deben tener descripción y valor' });
    }

    await client.query('BEGIN');

    // Reemplazamos todos los ítems por la lista editada (ya incluye los que se conservaron,
    // los que se modificaron y los nuevos que se hayan agregado en esta edición).
    await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    for (const item of itemsValidos) {
      await client.query(
        'INSERT INTO cotizacion_items (cotizacion_id, descripcion, cantidad, valor, adicional, seccion) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, item.descripcion, item.cantidad || null, item.valor, !!item.adicional, item.seccion || null]
      );
    }

    const subtotal = itemsValidos.reduce((sum, item) => sum + parseFloat(item.valor), 0);
    const descuentoAplicado = descuento !== undefined ? (parseFloat(descuento) || 0) : parseFloat(cotizacion.descuento) || 0;
    const nuevoTotal = subtotal - descuentoAplicado;

    await client.query(
      'UPDATE cotizaciones SET total = $1, descuento = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [nuevoTotal, descuentoAplicado, id]
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
      mensaje: 'Cotización actualizada exitosamente',
      total: nuevoTotal,
      contrato: contratoActualizado,
      proyecto_id: cotizacion.proyecto_id
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editando ítems de cotización aceptada:', error);
    res.status(500).json({ error: 'Error al editar la cotización' });
  } finally {
    client.release();
  }
});

// 🗑️ ELIMINAR contrato y la cotización que lo originó. El PROYECTO YA NO SE BORRA: nació
// blindado (con su propia copia de nombre/dirección/m2/cliente) precisamente para poder seguir
// existiendo aunque el contrato o la cotización que lo originaron se eliminen. Si el contrato
// tenía un proyecto vinculado, simplemente lo desvinculamos (proyecto_id = NULL en el proyecto
// no aplica porque esa columna vive en contratos/cotizaciones, no en proyectos — el proyecto no
// necesita saber nada del contrato para seguir funcionando). Solo GERENCIA puede eliminar
// contratos. Libera de Firebase Storage el PDF del contrato.
// IMPORTANTE: esta ruta debe declararse ANTES que DELETE /:id, si no Express interpretaría
// "contratos" como si fuera el :id de una cotización.
router.delete('/contratos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { solicitante_id } = req.body;

    const contratoResult = await client.query('SELECT * FROM contratos WHERE id = $1', [id]);
    if (contratoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    const contrato = contratoResult.rows[0];

    if (solicitante_id) {
      const esGerenciaDeEstaEmpresa = await esGerencia(solicitante_id, contrato.empresa_id);
      if (!esGerenciaDeEstaEmpresa) {
        return res.status(403).json({ error: 'Solo Gerencia puede eliminar contratos' });
      }
    }

    const urlsABorrar = [];
    if (contrato.pdf_url) urlsABorrar.push(contrato.pdf_url);

    await client.query('BEGIN');

    // La FK real es contratos.cotizacion_id → cotizaciones.id: el contrato (tabla hija) debe
    // borrarse antes que la cotización (tabla padre) que referencia.
    const cotizacionId = contrato.cotizacion_id;

    await client.query('DELETE FROM contratos WHERE id = $1', [id]);

    if (cotizacionId) {
      await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [cotizacionId]);
      await client.query('DELETE FROM cotizaciones WHERE id = $1', [cotizacionId]);
    }

    // El proyecto NO se toca: queda intacto (blindado) con toda su información, aunque haya
    // perdido el contrato/cotización que lo originaron. Se puede seguir viendo y usando
    // normalmente desde la pantalla de Proyectos.

    await client.query('COMMIT');

    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo de Storage al eliminar contrato:', error.message);
      });
    }

    res.json({ mensaje: 'Contrato y cotización eliminados exitosamente. El proyecto se conserva.' });
  } catch (error) {
    await client.query('ROLLBACK');
    // Loggeamos el detalle real de Postgres (código y tabla/constraint si viene), no solo el
    // mensaje genérico, para poder diagnosticar rápido desde los logs de Render si vuelve a fallar.
    console.error('Error eliminando contrato:', error.message, '| code:', error.code, '| detail:', error.detail, '| constraint:', error.constraint, '| table:', error.table);
    res.status(500).json({ error: 'Error al eliminar el contrato' });
  } finally {
    client.release();
  }
});

// 🗑️ ELIMINAR cotización. Solo Gerencia puede eliminarlas. Si ya fue aceptada (tiene un
// contrato generado), se elimina también el contrato. El PROYECTO NO se borra: queda blindado
// con su propia copia de datos, igual que al eliminar desde la pantalla de Contratos. Antes
// esto estaba bloqueado y pedía eliminar el contrato primero; ahora se hace todo junto, en una
// sola transacción, para no dejar nada huérfano.
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { solicitante_id } = req.body;

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    const cotizacion = cotizacionResult.rows[0];

    if (solicitante_id) {
      const esGerenciaDeEstaEmpresa = await esGerencia(solicitante_id, cotizacion.empresa_id);
      if (!esGerenciaDeEstaEmpresa) {
        return res.status(403).json({ error: 'Solo Gerencia puede eliminar cotizaciones' });
      }
    }

    const urlsABorrar = [];
    await client.query('BEGIN');

    // Si esta cotización ya fue aceptada, busca su contrato y lo elimina también (por su FK
    // hacia cotizaciones, el contrato debe irse antes que la cotización). El PROYECTO NO SE
    // TOCA: nació blindado con su propia copia de datos y sigue existiendo aunque se borre la
    // cotización/contrato que lo originaron.
    if (cotizacion.aceptada) {
      const contratoResult = await client.query('SELECT * FROM contratos WHERE cotizacion_id = $1', [id]);
      const contrato = contratoResult.rows[0];
      if (contrato) {
        if (contrato.pdf_url) urlsABorrar.push(contrato.pdf_url);
        await client.query('DELETE FROM contratos WHERE id = $1', [contrato.id]);
      }
    }

    await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    await client.query('DELETE FROM cotizaciones WHERE id = $1', [id]);

    await client.query('COMMIT');

    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo de Storage al eliminar cotización:', error.message);
      });
    }

    res.json({ mensaje: 'Cotización eliminada exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando cotización:', error.message, '| code:', error.code, '| detail:', error.detail, '| constraint:', error.constraint, '| table:', error.table);
    res.status(500).json({ error: 'Error al eliminar cotización' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR contratos de una empresa
router.get('/contratos/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT ct.*, p.nombre AS proyecto_nombre, p.estado AS proyecto_estado
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

// 👁️ Contrato de un proyecto específico (usado por la pestaña "Contrato" que ve AREA DE CLIENTES).
router.get('/contratos/por-proyecto/:proyecto_id', async (req, res) => {
  try {
    const { proyecto_id } = req.params;
    const result = await pool.query('SELECT * FROM contratos WHERE proyecto_id = $1 ORDER BY created_at DESC LIMIT 1', [proyecto_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Este proyecto todavía no tiene un contrato asociado' });
    }
    res.json({ contrato: result.rows[0] });
  } catch (error) {
    console.error('Error obteniendo contrato del proyecto:', error);
    res.status(500).json({ error: 'Error al obtener el contrato' });
  }
});

// 🔁 Regenerar el PDF de un contrato ya existente (por si falló la primera vez, o si se
// editaron datos de la empresa/cliente después de aceptar la cotización). No pide nada al
// usuario: usa siempre los datos ya guardados en la base de datos, igual que la generación
// automática al aceptar.
router.post('/contratos/:id/regenerar-pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const contrato = (await pool.query('SELECT * FROM contratos WHERE id = $1', [id])).rows[0];
    if (!contrato) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    if (!contrato.cotizacion_id) {
      return res.status(400).json({ error: 'Este contrato no tiene una cotización asociada' });
    }
    await generarYGuardarPdfContrato(contrato.cotizacion_id, contrato.id, contrato.proyecto_id);
    const actualizado = (await pool.query('SELECT * FROM contratos WHERE id = $1', [id])).rows[0];
    res.json({ mensaje: 'PDF regenerado exitosamente', contrato: actualizado });
  } catch (error) {
    // Loggeamos el mensaje completo (no solo el objeto error) para poder ver en los logs de
    // Render la causa real: por ejemplo "Firebase Admin no está configurado en el servidor"
    // (falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON) o un fallo de Puppeteer/Chromium.
    console.error('Error regenerando PDF del contrato:', error.message, error.stack);
    res.status(500).json({ error: 'No se pudo generar el PDF. Intenta de nuevo en unos minutos.' });
  }
});

// Genera el PDF del contrato recién creado (a partir de los datos ya guardados de la
// cotización aceptada) y lo sube a Firebase Storage, guardando la URL en contratos.pdf_url.
// Se llama de forma asíncrona después de responder al usuario (ver POST /:id/aceptar).
async function generarYGuardarPdfContrato(cotizacionId, contratoId, proyectoId) {
  const cotizacion = (await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [cotizacionId])).rows[0];
  const items = (await pool.query('SELECT * FROM cotizacion_items WHERE cotizacion_id = $1', [cotizacionId])).rows;
  const cliente = (await pool.query('SELECT * FROM clientes WHERE id = $1', [cotizacion.cliente_id])).rows[0];
  const empresa = (await pool.query('SELECT * FROM empresas WHERE id = $1', [cotizacion.empresa_id])).rows[0];
  const contrato = (await pool.query('SELECT * FROM contratos WHERE id = $1', [contratoId])).rows[0];

  const buffer = await generarPdfBuffer({
    tipoDocumento: 'contrato',
    empresa,
    cliente,
    numero: cotizacion.numero,
    fecha: contrato.created_at,
    items,
    total: cotizacion.total,
    fechaEntrega: contrato.fecha_entrega,
    ciudad: cotizacion.ciudad,
    propietario: cotizacion.propietario,
    parrafo: cotizacion.parrafo_contexto,
    descuento: cotizacion.descuento,
    condicionesPago: cotizacion.condiciones_pago,
    tiempoEntrega: cotizacion.tiempo_entrega,
    firmante: cotizacion.firmante,
  });

  const rutaDestino = `contratos/contrato_${contratoId}_${Date.now()}.pdf`;
  const url = await subirBufferAStorage(buffer, rutaDestino, 'application/pdf');

  await pool.query('UPDATE contratos SET pdf_url = $1 WHERE id = $2', [url, contratoId]);
}

module.exports = router;