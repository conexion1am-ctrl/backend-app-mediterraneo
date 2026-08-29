const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { generarPdfBuffer } = require('../utils/generarPdf');
const { subirBufferAStorage, borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { esGerencia } = require('../utils/permisos');
const { configurarProyectoNuevo } = require('../utils/cascadaProyecto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Valores por defecto de los campos "estándar" de la carta (editables por el usuario al crear
// la cotización, pero precargados para no empezar desde cero cada vez).
const PARRAFO_CONTEXTO_DEFECTO = 'Por solicitud efectuada paso a cotizar los precios del Kit de acabados completos para su casa';
// 2026-08-25: a pedido del usuario, el tiempo de entrega ya NO trae un rango de semanas fijo
// como sugerencia — nace en "00 - 00 Semanas" para que sea evidente que hay que llenarlo, en vez
// de arriesgarse a que alguien olvide cambiar un valor de ejemplo y lo deje mal en el documento.
const TIEMPO_ENTREGA_DEFECTO = '00 - 00 Semanas';
const SALUDO_DEFECTO = 'Cordial Saludo:';
const CONDICIONES_PAGO_DEFECTO = [
  { porcentaje: 25, descripcion: 'A la firma del contrato para el inicio de actividades' },
  { porcentaje: 25, descripcion: 'A las 3-4 semanas con avance' },
  { porcentaje: 25, descripcion: 'A la entrega de la obra blanca' },
  { porcentaje: 25, descripcion: 'A la entrega final de la obra, incluyendo carpintería' },
];
// Frase fija que antecede a los porcentajes de condiciones de pago, tal como aparece en el
// documento real de la empresa ("Cotizacion de Ejemplo Exacto.docx"). No es editable por
// cotización — es el mismo texto siempre, solo cambian los porcentajes/descripciones de abajo.
const PARRAFO_CONDICIONES_PAGO = 'El pago del costo total se plantea de la siguiente manera:';

// Numeración automática de cotizaciones (2026-08-26, a pedido del usuario): arranca en 1001 por
// empresa y sube de 1 en 1. Ya NO la escribe el usuario — evita que dos cotizaciones creadas casi
// al tiempo terminen con el mismo número a mano. Se calcula tomando el número más alto ya usado
// por esa empresa (ignorando cotizaciones viejas sin número o con formato no numérico) y sumando 1.
async function calcularSiguienteNumero(client, empresaId) {
  const resultado = await client.query(
    `SELECT numero FROM cotizaciones
     WHERE empresa_id = $1 AND numero ~ '^[0-9]+$'
     ORDER BY numero::INT DESC LIMIT 1`,
    [empresaId]
  );
  if (resultado.rows.length === 0) return '1001';
  const ultimo = parseInt(resultado.rows[0].numero, 10);
  return String(Math.max(ultimo + 1, 1001));
}

// Cláusulas legales estándar del contrato de obra (2026-08-25): antes vivían fijas en
// generarPdf.js sin que nadie pudiera tocarlas desde la app. Ahora son solo el PUNTO DE PARTIDA
// con el que nace cada contrato nuevo — cada contrato guarda su PROPIA copia editable en
// contratos.clausulas (JSONB), así que modificar una acá no afecta contratos ya creados, y
// modificar un contrato ya creado no afecta a los que se creen después.
const CLAUSULAS_DEFECTO = [
  { titulo: 'Primera - Objeto', texto: 'La CONTRATISTA se obliga a realizar y producir y el ORDENANTE a pagar los trabajos y objetos especificados en este contrato que consta de la tabla de ítems relacionada a continuación.' },
  { titulo: 'Segunda - Precio', texto: 'El ORDENANTE pagará a la CONTRATISTA acorde con el volumen de trabajos realmente realizados los valores relacionados en el presente contrato.' },
  // 2026-08-27 (a pedido del usuario): el texto se partió en dos oraciones separadas por un punto
  // — "...estipulándose el modo de pago de la siguiente manera." — porque justo ahí,
  // programáticamente, se inserta la tabla de condiciones de pago (Porcentaje | Ítem | Valor).
  // Ver clausulasLegalesHtml() en generarPdf.js, que busca esta cláusula por título y separa su
  // texto en "antes"/"después" de esa frase exacta para intercalar la tabla.
  { titulo: 'Tercera - Pago', texto: 'El ORDENANTE pagará a la CONTRATISTA los dineros que deba en razón a las entregas que efectivamente ésta realice, estipulándose el modo de pago de la siguiente manera. En caso de que se haga entrega de dinero o valores por encima del monto establecido, estos se abonarán al pago final. Los costos planteados en el presente documento corresponden al total de los trabajos a realizar. Se debe tomar en cuenta que, si se agregan elementos, aumentan cantidad de bienes a suministrar, estos se informarán y cobrarán aparte después de previa aprobación por escrito por parte del ORDENANTE.' },
  { titulo: 'Cuarta - Entrega', texto: 'La CONTRATISTA realizará la entrega de los trabajos según el plazo acordado, concretándose a la firma del presente documento y el respectivo abono inicial.' },
  { titulo: 'Quinta - Procedimiento para la entrega', texto: 'La CONTRATISTA hará el procedimiento para la entrega de los trabajos en el domicilio del ORDENANTE. El ORDENANTE dispondrá de 10 días hábiles, contados a partir de la entrega de los trabajos para formular los reclamos que procedan debido a las diferencias que exhiba respecto de los trabajos contratados.' },
  { titulo: 'Sexta - Materia Prima', texto: 'a) La materia prima será suministrada por la CONTRATISTA de lo que este haya acordado.\nb) Los desperdicios corresponderán a la CONTRATISTA de lo que este haya suministrado.' },
  { titulo: 'Séptima - Duración', texto: 'El contrato que consta en este escrito tiene una duración igual a la entrega del total de los trabajos. Para terminarlo, cualquiera de las partes podrá comunicar a la otra con una anticipación mínima de quince (15) días su intención de cesar su vínculo contractual, en tal caso, ORDENANTE y CONTRATISTA quedan obligados a cumplir con las obligaciones derivadas de los trabajos contratados con anterioridad al preaviso.' },
  { titulo: 'Octava - Obligaciones de la CONTRATISTA', texto: 'Constituyen las principales obligaciones de la CONTRATISTA las siguientes:\na. Realizar los trabajos objeto del presente contrato según las especificaciones acordadas.\nb. Realizar las entregas dentro del plazo acordado para tal efecto.\nc. Tomar las medidas de protección necesarias para proteger los elementos ya instalados en el inmueble.\nd. En caso de ocasionar daños estos se repararán y cambiarán para dejarlos en estado original.\ne. No se responderá por daños que existan previamente, establecidos por chequeo visual previo y documentado fotográficamente, la fachada externa de la puerta de ingreso no es susceptible a reclamaciones.\nf. En caso de requerirse arreglos fuera de este contrato por desperfectos preexistentes, deberán solicitarse al ORDENANTE y tendrán un valor adicional.\ng. Pagar cuando corresponda o hacer la verificación de los aportes a la Seguridad Social de cada uno de los empleados que ingresan a la obra; en ningún momento el ORDENANTE genera vínculo laboral ni se obliga a hacer reservas para dichos aportes.\nh. Entregar la obra con aseo, retirar todos los escombros y de la correcta disposición de estos.' },
  { titulo: 'Novena - Obligaciones especiales del ORDENANTE', texto: 'Constituyen las obligaciones principales del ORDENANTE las siguientes:\na. Pagar los precios dentro del plazo previsto.\nb. Recibir los trabajos que le entregue la CONTRATISTA, cuando tal hecho esté conforme con los términos definidos en esta convención y a los diseños previamente aprobados.\nc. Avisar oportunamente de requerimientos especiales para el ingreso al inmueble.\nd. Autorizar al personal que indique la CONTRATISTA en caso de ser requerido.\ne. Informar oportunamente de suspensión de agua o energía en el inmueble.\nf. Responder oportunamente las dudas que le presente la CONTRATISTA, así mismo tomar decisiones oportunas de la elección de materiales, diseños y colores.' },
  { titulo: 'Décima - Garantía', texto: 'Un año en mano de obra; en materiales, cada proveedor determina la garantía de su producto, la CONTRATISTA gestiona la garantía y su cubrimiento por parte del proveedor de los materiales que sean suministrados por la empresa.' },
  { titulo: 'Undécima - Cláusula de indemnidad', texto: 'La CONTRATISTA se obliga a mantener indemne al ORDENANTE de cualquier daño o perjuicio originado en reclamaciones de terceros que tengan como causa sus actuaciones hasta por el monto del daño o perjuicio causado. La CONTRATISTA mantendrá indemne al ORDENANTE por cualquier obligación de carácter laboral o relacionado que se origine en el incumplimiento de las obligaciones laborales o de la seguridad social que la CONTRATISTA asume frente al personal, subordinados, empleados o terceros que se vinculen a la ejecución de las obligaciones derivadas del presente Contrato.' },
  { titulo: 'Duodécima - Cláusula compromisoria', texto: 'Toda controversia o diferencia relativa a este contrato y a su ejecución o liquidación, se resolverá por un tribunal de Arbitramento designado por la cámara de comercio del domicilio de la CONTRATISTA mediante sorteo entre los árbitros inscritos en las listas que se lleva dicha cámara. El tribunal así constituido se sujetará a lo dispuesto por el Decreto 2279/89 y las demás disposiciones legales que lo modifiquen o adicionen, de acuerdo con las siguientes reglas:\na. El tribunal estará integrado por un árbitro.\nb. La organización interna del tribunal se sujetará a las reglas previstas para el efecto por el centro de arbitraje de la cámara de comercio correspondiente.\nc. El tribunal decidirá en derecho.\nd. El tribunal funcionará en el centro de arbitraje de la Cámara de Comercio de su domicilio.' },
];

// Párrafo introductorio "Entre X y Y..." — también editable por contrato, precargado con los
// marcadores {{...}} que generarPdf.js reemplaza por los datos reales (cliente, empresa, etc.)
// al momento de generar el PDF, para que el usuario pueda editar el texto alrededor sin tener
// que volver a escribir los datos que ya se llenan solos.
const PARRAFO_INTRODUCTORIO_DEFECTO = 'Entre {{ORDENANTE_NOMBRE}}{{ORDENANTE_CEDULA}}, quién para los efectos del presente contrato se denominará simplemente como el ORDENANTE y {{FIRMANTE}}{{FIRMANTE_CEDULA}}, quién actúa en representación de {{EMPRESA_NOMBRE}}{{EMPRESA_NIT}}, y en lo sucesivo se denominará como la CONTRATISTA, hemos decidido celebrar el contrato de obra civil y reformas que tendrán lugar{{PROYECTO_NOMBRE}}{{DIRECCION_INMUEBLE}}{{MTS2}}; que consta en el documento que ahora se suscribe y que se rige por las cláusulas que se enuncian y en lo previsto en ellas por las disposiciones legales aplicables a la materia de la que trata este acto jurídico.';

// 📝 CREAR cotización con sus ítems
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      empresa_id, cliente_id, proyecto_id, items, descuento,
      propietario, ciudad, saludo, parrafo_contexto, nombre_proyecto, condiciones_pago, tiempo_entrega, firmante,
    } = req.body;

    if (!empresa_id || !cliente_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'empresa_id, cliente_id e items son obligatorios' });
    }

    await client.query('BEGIN');

    // El número YA NO viene del frontend (ver calcularSiguienteNumero arriba): siempre se asigna
    // aquí de forma automática y secuencial por empresa, para que nunca se repita entre dos
    // cotizaciones creadas casi al mismo tiempo.
    const numero = await calcularSiguienteNumero(client, empresa_id);

    const subtotal = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);
    const total = subtotal - (parseFloat(descuento) || 0);

    const cotizacionResult = await client.query(
      `INSERT INTO cotizaciones
        (empresa_id, cliente_id, proyecto_id, numero, total, descuento,
         propietario, ciudad, saludo, parrafo_contexto, nombre_proyecto, condiciones_pago, tiempo_entrega, firmante)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        empresa_id, cliente_id, proyecto_id || null, numero, total, parseFloat(descuento) || 0,
        propietario || null, ciudad || null,
        saludo || SALUDO_DEFECTO,
        parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
        nombre_proyecto || null,
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
    // COALESCE(co.nombre_proyecto, cl.nombre_proyecto): la cotización puede tener su propio
    // nombre de proyecto editado; si no lo tiene, se cae al de la ficha del cliente.
    const result = await pool.query(
      `SELECT co.*, COALESCE(cl.nombre, co.cliente_nombre_snapshot) AS cliente_nombre,
              COALESCE(co.nombre_proyecto, cl.nombre_proyecto) AS nombre_proyecto, cl.mts2
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

// ===================== PLANTILLAS DE COTIZACIÓN =====================
// Un "molde" reutilizable con ítems/textos ya definidos, para no reescribir cotizaciones muy
// parecidas entre sí (2026-08-26, a pedido del usuario). No lleva cliente ni proyecto asociado.
// IMPORTANTE: estas rutas van declaradas ANTES de router.get('/:id', ...) más abajo — Express
// hace matching en orden de declaración, así que si '/plantillas/listar/:empresa_id' quedara
// después de '/:id', una petición a /plantillas/listar/5 caería en '/:id' (con id="plantillas")
// antes de llegar aquí. Este es el mismo patrón de bug de rutas que ya mordió esta app antes
// (ver mensajes.js) — cualquier ruta nueva con más de un segmento fijo debe ir antes de '/:id'.

// 📋 LISTAR plantillas de una empresa
router.get('/plantillas/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      'SELECT * FROM plantillas_cotizacion WHERE empresa_id = $1 ORDER BY nombre ASC',
      [empresa_id]
    );
    res.json({ plantillas: result.rows });
  } catch (error) {
    console.error('Error listando plantillas:', error);
    res.status(500).json({ error: 'Error al listar plantillas' });
  }
});

// 📝 CREAR plantilla nueva (desde cero o "guardar como plantilla" desde una cotización)
router.post('/plantillas/crear', async (req, res) => {
  try {
    const { empresa_id, nombre, saludo, parrafo_contexto, condiciones_pago, tiempo_entrega, items, descuento } = req.body;

    if (!empresa_id || !nombre || !items || items.length === 0) {
      return res.status(400).json({ error: 'empresa_id, nombre e items son obligatorios' });
    }

    const result = await pool.query(
      `INSERT INTO plantillas_cotizacion
        (empresa_id, nombre, saludo, parrafo_contexto, condiciones_pago, tiempo_entrega, items, descuento)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        empresa_id, nombre,
        saludo || SALUDO_DEFECTO,
        parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
        JSON.stringify(condiciones_pago && condiciones_pago.length ? condiciones_pago : CONDICIONES_PAGO_DEFECTO),
        tiempo_entrega || TIEMPO_ENTREGA_DEFECTO,
        JSON.stringify(items),
        parseFloat(descuento) || 0,
      ]
    );
    res.status(201).json({ mensaje: 'Plantilla guardada exitosamente', plantilla: result.rows[0] });
  } catch (error) {
    console.error('Error creando plantilla:', error);
    res.status(500).json({ error: 'Error al crear plantilla' });
  }
});

// ✏️ ACTUALIZAR plantilla existente (2026-08-28, a pedido del usuario): permite agregar/quitar
// ítems, cambiar valores y textos, y guardar los cambios sobre la MISMA plantilla, en vez de
// tener que borrarla y crear una nueva cada vez que cambian las condiciones de un cliente
// frecuente. Reemplaza todos los campos enviados (no hace merge parcial) — el frontend siempre
// manda el objeto completo de la plantilla, igual que al crearla.
// SEGURIDAD (2026-08-28, corregido a raíz de una pregunta del usuario sobre confidencialidad
// entre empresas): tanto este PUT como el DELETE de abajo identificaban la plantilla SOLO por su
// id numérico, sin confirmar que perteneciera a la empresa que hace la petición. GET
// /plantillas/listar/:empresa_id sí filtraba correctamente (nadie ve plantillas de otra empresa
// navegando la app), pero estos dos endpoints no — alguien que conociera o adivinara el id de una
// plantilla ajena habría podido editarla o borrarla (no verla completa, pero sí manipularla). Se
// exige empresa_id en el body y se agrega "AND empresa_id = $x" al UPDATE/DELETE para que una
// empresa nunca pueda tocar la plantilla de otra, sin importar qué id envíe.
router.put('/plantillas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { empresa_id, nombre, saludo, parrafo_contexto, condiciones_pago, tiempo_entrega, items, descuento } = req.body;

    if (!empresa_id || !nombre || !items || items.length === 0) {
      return res.status(400).json({ error: 'empresa_id, nombre e items son obligatorios' });
    }

    const result = await pool.query(
      `UPDATE plantillas_cotizacion
       SET nombre = $1, saludo = $2, parrafo_contexto = $3, condiciones_pago = $4,
           tiempo_entrega = $5, items = $6, descuento = $7
       WHERE id = $8 AND empresa_id = $9 RETURNING *`,
      [
        nombre,
        saludo || SALUDO_DEFECTO,
        parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
        JSON.stringify(condiciones_pago && condiciones_pago.length ? condiciones_pago : CONDICIONES_PAGO_DEFECTO),
        tiempo_entrega || TIEMPO_ENTREGA_DEFECTO,
        JSON.stringify(items),
        parseFloat(descuento) || 0,
        id,
        empresa_id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    res.json({ mensaje: 'Plantilla actualizada exitosamente', plantilla: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando plantilla:', error);
    res.status(500).json({ error: 'Error al actualizar plantilla' });
  }
});

// 🗑️ ELIMINAR plantilla (ver nota de seguridad arriba: ahora exige empresa_id también)
router.delete('/plantillas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { empresa_id } = req.query;
    if (!empresa_id) {
      return res.status(400).json({ error: 'empresa_id es obligatorio' });
    }
    const result = await pool.query('DELETE FROM plantillas_cotizacion WHERE id = $1 AND empresa_id = $2 RETURNING id', [id, empresa_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }
    res.json({ mensaje: 'Plantilla eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando plantilla:', error);
    res.status(500).json({ error: 'Error al eliminar plantilla' });
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
    //
    // El contrato nace con su PROPIA copia editable del texto legal (clausulas, párrafo
    // introductorio, condiciones de pago, tiempo de entrega, ciudad, firmante, número) —
    // precargada con el texto estándar (CLAUSULAS_DEFECTO) y con lo que ya se había llenado en
    // la cotización, pero a partir de aquí es independiente: editar el contrato ya NO modifica
    // la cotización de la que nació, ni viceversa.
    const contratoResult = await client.query(
      `INSERT INTO contratos
        (cotizacion_id, empresa_id, proyecto_id, fecha_entrega, valor_total,
         proyecto_nombre_snapshot, proyecto_direccion_snapshot, proyecto_mts2_snapshot,
         clausulas, parrafo_introductorio, condiciones_pago, tiempo_entrega, ciudad, firmante, numero)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        id, cotizacion.empresa_id, fecha_entrega || null, cotizacion.total,
        nombreProyecto, cliente?.direccion || null, cliente?.mts2 || null,
        JSON.stringify(CLAUSULAS_DEFECTO),
        PARRAFO_INTRODUCTORIO_DEFECTO,
        // Fallback a CONDICIONES_PAGO_DEFECTO (2026-08-26): si por alguna razón la cotización
        // quedó sin condiciones de pago (columna null/vacía), el contrato no debe nacer con el
        // campo en blanco en la pantalla "Revisar y editar documento" — siempre debe traer algo
        // editable, igual que ya se garantiza al crear/editar la cotización misma.
        //
        // FIX (2026-08-27, bug reportado: condiciones de pago vacías en el contrato aunque la
        // cotización sí las tenía): cotizacion.condiciones_pago puede llegar de pg como un array
        // ya parseado (columna JSONB) o como un string JSON sin parsear, dependiendo de cómo haya
        // quedado esa columna en la base real. Antes se pasaba tal cual al INSERT sin normalizar
        // (a diferencia del fallback, que sí llevaba JSON.stringify) — si llegaba como array de
        // objetos JS, pg podía no serializarlo de forma consistente al guardarlo en la columna
        // JSONB del contrato, dejándolo vacío o corrupto. Ahora se normaliza siempre a texto JSON
        // antes de insertar, igual en ambas ramas.
        (() => {
          let condPago = cotizacion.condiciones_pago;
          if (typeof condPago === 'string') {
            try { condPago = JSON.parse(condPago); } catch (e) { condPago = null; }
          }
          return JSON.stringify(Array.isArray(condPago) && condPago.length ? condPago : CONDICIONES_PAGO_DEFECTO);
        })(),
        cotizacion.tiempo_entrega || TIEMPO_ENTREGA_DEFECTO,
        cotizacion.ciudad || null,
        cotizacion.firmante || null,
        cotizacion.numero || null,
      ]
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
    // FIX (2026-08-27, bug reportado: "Cannot destructure property 'creado_por_usuario_id' of
    // 'req.body' as it is undefined"): el frontend llama este endpoint sin mandar body
    // (api.post sin segundo argumento), así que req.body llega undefined en vez de {}. El
    // "|| {}" evita el crash y deja creado_por_usuario_id como undefined, que ya estaba
    // contemplado más abajo (configurarProyectoNuevo lo trata igual que null).
    const { creado_por_usuario_id } = req.body || {};

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
        (empresa_id, nombre, direccion, area_m2, cliente_nombre_snapshot, cliente_celular_snapshot, cliente_cedula_snapshot, creado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        contrato.empresa_id,
        contrato.proyecto_nombre_snapshot || 'Proyecto sin nombre',
        contrato.proyecto_direccion_snapshot || null,
        contrato.proyecto_mts2_snapshot || null,
        cliente?.nombre || null,
        cliente?.celular || null,
        cliente?.cedula || null,
        creado_por_usuario_id || null,
      ]
    );
    const proyecto = nuevoProyecto.rows[0];

    // Igual que en la creación manual: toda actividad nace con GERENCIA/ADMINISTRATIVA/LOGISTICA
    // por defecto, con los gerentes de la empresa y quien creó el proyecto ya auto-asignados.
    await configurarProyectoNuevo(client, proyecto.id, contrato.empresa_id, creado_por_usuario_id || null);

    await client.query('UPDATE contratos SET proyecto_id = $1 WHERE id = $2', [proyecto.id, id]);
    if (contrato.cotizacion_id) {
      await client.query('UPDATE cotizaciones SET proyecto_id = $1 WHERE id = $2', [proyecto.id, contrato.cotizacion_id]);
    }
    // Enlaza también el registro del cliente (pantalla Clientes) con el proyecto recién creado.
    // Sin esto, clientes.proyecto_id se queda en NULL para siempre — y como el botón "Invitar a
    // su proyecto" de ClientesScreen depende de ese campo para saber a qué proyecto asignar al
    // cliente, quedaría inutilizable en la práctica (siempre diría "no tiene proyecto").
    if (cliente) {
      await client.query('UPDATE clientes SET proyecto_id = $1 WHERE id = $2', [proyecto.id, cliente.id]);
    }

    const estadisticasExistentes = await client.query('SELECT id FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyecto.id]);
    if (estadisticasExistentes.rows.length === 0) {
      await client.query(
        'INSERT INTO estadisticas_proyecto (proyecto_id, valor_contrato, empresa_id) VALUES ($1, $2, $3)',
        [proyecto.id, contrato.valor_total, contrato.empresa_id]
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
      items, descuento,
      propietario, ciudad, saludo, parrafo_contexto, nombre_proyecto, condiciones_pago, tiempo_entrega, firmante,
    } = req.body;

    const cotizacionResult = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotizacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    if (cotizacionResult.rows[0].aceptada) {
      return res.status(400).json({ error: 'No se puede editar una cotización ya aceptada' });
    }

    await client.query('BEGIN');

    // numero ya NO se recibe ni se actualiza aquí (ver calcularSiguienteNumero): una vez asignado
    // al crear la cotización, es permanente — editar la cotización nunca lo cambia.
    if (items && items.length > 0) {
      const subtotal = items.reduce((sum, item) => sum + parseFloat(item.valor), 0);
      const total = subtotal - (parseFloat(descuento) || 0);
      await client.query(
        `UPDATE cotizaciones SET total = $1, descuento = $2,
          propietario = $3, ciudad = $4, saludo = $5, parrafo_contexto = $6, nombre_proyecto = $7, condiciones_pago = $8, tiempo_entrega = $9, firmante = $10,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $11`,
        [
          total, parseFloat(descuento) || 0,
          propietario || null, ciudad || null, saludo || SALUDO_DEFECTO, parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
          nombre_proyecto || null,
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
        `UPDATE cotizaciones SET
          propietario = $1, ciudad = $2, saludo = $3, parrafo_contexto = $4, nombre_proyecto = $5, condiciones_pago = $6, tiempo_entrega = $7, firmante = $8,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $9`,
        [
          propietario || null, ciudad || null, saludo || SALUDO_DEFECTO, parrafo_contexto || PARRAFO_CONTEXTO_DEFECTO,
          nombre_proyecto || null,
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

// ✏️ EDITAR una cotización YA ACEPTADA: ítems, descuento, Y también los datos de la carta
// (propietario, ciudad, párrafo, condiciones de pago, tiempo de entrega, firmante). Antes esto
// solo dejaba tocar ítems/descuento; ahora reabre la cotización completa, igual que el editor de
// una cotización sin aceptar, para no tener que usar un flujo aparte de "agregar adicionales".
// Reemplaza la lista completa de ítems, recalcula el total, propaga el nuevo valor al contrato
// y a las estadísticas del proyecto, y regenera el PDF del contrato en segundo plano para que
// quede sincronizado con los datos nuevos.
router.put('/:id/items-aceptada', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      items, descuento,
      propietario, ciudad, nombre_proyecto, saludo, parrafo_contexto, condiciones_pago, tiempo_entrega, firmante,
    } = req.body;

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
      `UPDATE cotizaciones SET
         total = $1, descuento = $2,
         propietario = COALESCE($3, propietario),
         ciudad = COALESCE($4, ciudad),
         nombre_proyecto = COALESCE($5, nombre_proyecto),
         saludo = COALESCE($6, saludo),
         parrafo_contexto = COALESCE($7, parrafo_contexto),
         condiciones_pago = COALESCE($8, condiciones_pago),
         tiempo_entrega = COALESCE($9, tiempo_entrega),
         firmante = COALESCE($10, firmante),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $11`,
      [
        nuevoTotal, descuentoAplicado,
        propietario ?? null, ciudad ?? null, nombre_proyecto ?? null, saludo ?? null, parrafo_contexto ?? null,
        condiciones_pago ? JSON.stringify(condiciones_pago) : null,
        tiempo_entrega ?? null, firmante ?? null,
        id,
      ]
    );

    // Buscamos el contrato por cotizacion_id (no por proyecto_id: la cotización puede estar
    // aceptada sin tener todavía un proyecto creado, ver la reorganización de Clientes/
    // Cotizaciones/Contratos/Proyectos independientes).
    const contratoResult = await client.query(
      'UPDATE contratos SET valor_total = $1 WHERE cotizacion_id = $2 RETURNING *',
      [nuevoTotal, id]
    );
    const contratoActualizado = contratoResult.rows[0] || null;

    if (cotizacion.proyecto_id) {
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

    // Regeneramos el PDF del contrato en segundo plano (best effort) para que quede
    // sincronizado con los nuevos datos de la carta/ítems, sin hacer esperar al usuario.
    if (contratoActualizado) {
      generarYGuardarPdfContrato(id, contratoActualizado.id, cotizacion.proyecto_id).catch((error) => {
        console.error('Error regenerando PDF tras editar cotización aceptada:', error.message);
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editando cotización aceptada:', error);
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
    // FIX (2026-08-26): un contrato recién aceptado nace SIN proyecto_id (el proyecto se crea
    // después, a demanda, con el botón "Crear Proyecto" — ver POST /contratos/:id/crear-proyecto).
    // Antes esta ficha mostraba "Sin proyecto asociado" en TODOS los contratos nuevos porque
    // proyecto_nombre salía del LEFT JOIN con proyectos (NULL mientras no exista el proyecto
    // formal). Ahora usamos COALESCE con el snapshot que el contrato ya guarda desde que se creó
    // (ct.proyecto_nombre_snapshot), así la ficha muestra el nombre del proyecto/casa desde el
    // primer momento, exista o no el proyecto todavía. También sumamos el nombre del cliente
    // (vía cotizaciones → clientes) para mostrarlo junto al nombre del proyecto en la ficha.
    const result = await pool.query(
      `SELECT ct.*,
              COALESCE(p.nombre, ct.proyecto_nombre_snapshot) AS proyecto_nombre,
              p.estado AS proyecto_estado,
              cl.nombre AS cliente_nombre
       FROM contratos ct
       LEFT JOIN proyectos p ON p.id = ct.proyecto_id
       LEFT JOIN cotizaciones co ON co.id = ct.cotizacion_id
       LEFT JOIN clientes cl ON cl.id = co.cliente_id
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

// 👁️ VER detalle de un contrato (usado por la pantalla "Revisar y editar documento" antes de
// generar el PDF final).
router.get('/contratos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM contratos WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error obteniendo contrato:', error);
    res.status(500).json({ error: 'Error al obtener el contrato' });
  }
});

// ✏️ Guardar el texto editable del contrato (cláusulas, párrafo introductorio, condiciones de
// pago, tiempo de entrega, ciudad, firmante, número) — usado por la pantalla "Revisar y editar
// documento" cada vez que el usuario toca "Guardar" o justo antes de "Generar PDF". No toca
// ítems, valor_total ni fecha_entrega, que se editan desde otras pantallas.
router.put('/contratos/:id/texto', async (req, res) => {
  try {
    const { id } = req.params;
    const { clausulas, parrafo_introductorio, condiciones_pago, tiempo_entrega, ciudad, firmante, numero } = req.body;

    const result = await pool.query(
      `UPDATE contratos SET
        clausulas = COALESCE($1, clausulas),
        parrafo_introductorio = COALESCE($2, parrafo_introductorio),
        condiciones_pago = COALESCE($3, condiciones_pago),
        tiempo_entrega = COALESCE($4, tiempo_entrega),
        ciudad = COALESCE($5, ciudad),
        firmante = COALESCE($6, firmante),
        numero = COALESCE($7, numero)
       WHERE id = $8 RETURNING *`,
      [
        clausulas ? JSON.stringify(clausulas) : null,
        parrafo_introductorio || null,
        condiciones_pago ? JSON.stringify(condiciones_pago) : null,
        tiempo_entrega || null,
        ciudad || null,
        firmante || null,
        numero || null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }
    res.json({ mensaje: 'Texto del contrato actualizado', contrato: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando texto del contrato:', error);
    res.status(500).json({ error: 'Error al actualizar el texto del contrato' });
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

// 📄 Generar el PDF final del contrato desde la pantalla "Revisar y editar documento" — se llama
// cuando el usuario toca "Generar PDF" después de revisar/editar el texto. Guarda primero
// cualquier cambio de texto pendiente (mismo cuerpo que PUT /contratos/:id/texto) y luego genera
// el PDF de forma síncrona (a diferencia del automático al aceptar, aquí el usuario SÍ está
// esperando el resultado, así que no conviene responder antes de tenerlo listo).
router.post('/contratos/:id/generar-pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const { clausulas, parrafo_introductorio, condiciones_pago, tiempo_entrega, ciudad, firmante, numero } = req.body;

    const existente = (await pool.query('SELECT * FROM contratos WHERE id = $1', [id])).rows[0];
    if (!existente) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }

    await pool.query(
      `UPDATE contratos SET
        clausulas = COALESCE($1, clausulas),
        parrafo_introductorio = COALESCE($2, parrafo_introductorio),
        condiciones_pago = COALESCE($3, condiciones_pago),
        tiempo_entrega = COALESCE($4, tiempo_entrega),
        ciudad = COALESCE($5, ciudad),
        firmante = COALESCE($6, firmante),
        numero = COALESCE($7, numero)
       WHERE id = $8`,
      [
        clausulas ? JSON.stringify(clausulas) : null,
        parrafo_introductorio || null,
        condiciones_pago ? JSON.stringify(condiciones_pago) : null,
        tiempo_entrega || null,
        ciudad || null,
        firmante || null,
        numero || null,
        id,
      ]
    );

    await generarYGuardarPdfContrato(existente.cotizacion_id, id, existente.proyecto_id);
    const actualizado = (await pool.query('SELECT * FROM contratos WHERE id = $1', [id])).rows[0];
    res.json({ mensaje: 'PDF generado exitosamente', contrato: actualizado });
  } catch (error) {
    console.error('Error generando PDF del contrato:', error.message, error.stack);
    res.status(500).json({ error: 'No se pudo generar el PDF. Intenta de nuevo en unos minutos.' });
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

// Genera el PDF del contrato y lo sube a Firebase Storage, guardando la URL en
// contratos.pdf_url. Se llama de forma asíncrona después de responder al usuario (ver POST
// /:id/aceptar) y también bajo demanda desde POST /contratos/:id/generar-pdf (pantalla "Revisar
// y editar documento") y POST /contratos/:id/regenerar-pdf.
//
// 2026-08-25: el texto (cláusulas, párrafo introductorio, condiciones de pago, tiempo de
// entrega, ciudad, firmante, número) ya NO se toma de la cotización — se lee directamente de las
// columnas propias del contrato (editables por el usuario en la pantalla de revisión), para que
// editar el contrato no dependa de ni modifique la cotización de la que nació.
async function generarYGuardarPdfContrato(cotizacionId, contratoId, proyectoId) {
  const contrato = (await pool.query('SELECT * FROM contratos WHERE id = $1', [contratoId])).rows[0];
  const cotizacion = cotizacionId
    ? (await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [cotizacionId])).rows[0]
    : null;
  const items = cotizacionId
    ? (await pool.query('SELECT * FROM cotizacion_items WHERE cotizacion_id = $1', [cotizacionId])).rows
    : [];
  const clienteId = cotizacion?.cliente_id;
  const cliente = clienteId ? (await pool.query('SELECT * FROM clientes WHERE id = $1', [clienteId])).rows[0] : null;
  const empresa = (await pool.query('SELECT * FROM empresas WHERE id = $1', [contrato.empresa_id])).rows[0];

  const buffer = await generarPdfBuffer({
    tipoDocumento: 'contrato',
    empresa,
    cliente,
    numero: contrato.numero,
    fecha: contrato.created_at,
    items,
    total: contrato.valor_total,
    fechaEntrega: contrato.fecha_entrega,
    ciudad: contrato.ciudad,
    parrafoIntroductorio: contrato.parrafo_introductorio,
    clausulas: contrato.clausulas,
    condicionesPago: contrato.condiciones_pago,
    tiempoEntrega: contrato.tiempo_entrega,
    firmante: contrato.firmante,
  });

  const rutaDestino = `contratos/contrato_${contratoId}_${Date.now()}.pdf`;
  const url = await subirBufferAStorage(buffer, rutaDestino, 'application/pdf');

  await pool.query('UPDATE contratos SET pdf_url = $1 WHERE id = $2', [url, contratoId]);
}


module.exports = router;