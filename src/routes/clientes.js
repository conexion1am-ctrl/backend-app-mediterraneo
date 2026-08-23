const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { areaDeUsuarioEnEmpresa, puedeEliminarClientes } = require('../utils/permisos');
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { borrarDependenciasDeProyecto } = require('../utils/cascadaProyecto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR cliente
router.post('/crear', async (req, res) => {
  try {
    const { empresa_id, proyecto_id, nombre, celular, contrato_url, nombre_proyecto, mts2, direccion, cedula } = req.body;

    if (!empresa_id || !nombre) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO clientes (empresa_id, proyecto_id, nombre, celular, contrato_url, nombre_proyecto, mts2, direccion, cedula) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [empresa_id, proyecto_id || null, nombre, celular || null, contrato_url || null, nombre_proyecto || null, mts2 || null, direccion || null, cedula || null]
    );

    res.status(201).json({ mensaje: 'Cliente creado exitosamente', cliente: result.rows[0] });
  } catch (error) {
    console.error('Error creando cliente:', error);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ✏️ EDITAR cliente
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, celular, nombre_proyecto, mts2, direccion, cedula } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    const result = await pool.query(
      'UPDATE clientes SET nombre = $1, celular = $2, nombre_proyecto = $3, mts2 = $4, direccion = $5, cedula = $6 WHERE id = $7 RETURNING *',
      [nombre, celular || null, nombre_proyecto || null, mts2 || null, direccion || null, cedula || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json({ mensaje: 'Cliente actualizado exitosamente', cliente: result.rows[0] });
  } catch (error) {
    console.error('Error editando cliente:', error);
    res.status(500).json({ error: 'Error al editar cliente' });
  }
});

// 🗑️ ELIMINAR cliente y TODO lo relacionado con su proyecto (fotos, planos 3D, mensajes y sus
// adjuntos, contrato, equipo asignado, estadísticas, y el proyecto mismo), incluyendo limpiar
// los archivos correspondientes de Firebase Storage. Las COTIZACIONES son la única excepción:
// se conservan (con el nombre del cliente guardado como snapshot, ya que cliente_id queda en
// NULL) para que sigan viéndose en la pantalla de Cotizaciones hasta que se borren manualmente.
// Área Comercial y Logística no tienen permiso para eliminar clientes (solo pueden verlos/
// agregarlos); esta validación evita que se salte ocultando el botón.
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { usuario_id } = req.body;

    const clienteResult = await client.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (clienteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const cliente = clienteResult.rows[0];

    if (usuario_id) {
      const areaNombre = await areaDeUsuarioEnEmpresa(usuario_id, cliente.empresa_id);
      if (!puedeEliminarClientes(areaNombre)) {
        return res.status(403).json({ error: 'Tu área no tiene permiso para eliminar clientes' });
      }
    }

    // Recopilamos las URLs de archivos que hay que borrar de Storage ANTES de borrar las filas,
    // para poder limpiarlas después (fuera de la transacción, ya que Storage no es transaccional).
    const urlsABorrar = [];
    if (cliente.contrato_url) urlsABorrar.push(cliente.contrato_url);

    await client.query('BEGIN');

    // Antes de borrar el cliente, dejamos sus cotizaciones "huérfanas pero con memoria": pierden
    // el vínculo (cliente_id = NULL) pero guardan el nombre que tenía el cliente, para que sigan
    // apareciendo en la pantalla de Cotizaciones exactamente igual que antes.
    await client.query(
      'UPDATE cotizaciones SET cliente_id = NULL, cliente_nombre_snapshot = $1 WHERE cliente_id = $2',
      [cliente.nombre, id]
    );

    const proyectoId = cliente.proyecto_id;
    if (proyectoId) {
      // Los contratos de este proyecto se recopilan y se borran ANTES de llamar a la función
      // compartida, y el proyecto se borra DESPUÉS — mismo orden seguro que usa el borrado de
      // contrato: primero lo que cuelga del proyecto, luego el proyecto, al final quien lo originó.
      const contratos = await client.query('SELECT pdf_url FROM contratos WHERE proyecto_id = $1', [proyectoId]);
      contratos.rows.forEach((c) => c.pdf_url && urlsABorrar.push(c.pdf_url));

      const urlsDelProyecto = await borrarDependenciasDeProyecto(client, proyectoId);
      urlsABorrar.push(...urlsDelProyecto);

      await client.query('DELETE FROM contratos WHERE proyecto_id = $1', [proyectoId]);
      await client.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
    }

    await client.query('DELETE FROM clientes WHERE id = $1', [id]);

    await client.query('COMMIT');

    // Limpiamos Storage ya con la base de datos consistente. Si algo falla aquí, no revertimos
    // la base de datos (mismo criterio "best effort" que el resto de la app): el registro ya
    // quedó eliminado, y en el peor caso un archivo queda huérfano en la nube.
    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo de Storage al eliminar cliente:', error.message);
      });
    }

    res.json({ mensaje: 'Cliente eliminado exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando cliente:', error.message, '| code:', error.code, '| detail:', error.detail, '| constraint:', error.constraint, '| table:', error.table);
    res.status(500).json({ error: 'No se pudo eliminar el cliente. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// 📩 INVITAR a un cliente a su proyecto: genera una invitación al "AREA DE CLIENTES" usando el
// nombre y celular que YA tiene guardados en su ficha (sin volver a escribirlos en Grupo de
// Trabajo, que antes duplicaba el registro del cliente con riesgo de que el celular quedara
// distinto entre los dos lugares). Deja además la asignación "provisional" en proyecto_equipo de
// una sola vez (mismo mecanismo que usa Asignar Personal en un proyecto), para que el cliente
// quede vinculado a SU proyecto desde el primer momento en que acepte el link.
router.post('/:id/invitar', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const clienteResult = await client.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (clienteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const cliente = clienteResult.rows[0];

    if (!cliente.celular) {
      return res.status(400).json({ error: 'Este cliente no tiene celular guardado. Agrégaselo editando su ficha antes de invitarlo.' });
    }

    // clientes.proyecto_id se llena automáticamente al crear el proyecto desde un contrato (ver
    // POST /contratos/:id/crear-proyecto en cotizaciones_v2.js). Para clientes que ya tenían un
    // proyecto creado ANTES de que ese enlace existiera, hacemos un respaldo buscando el
    // proyecto por el camino cliente → cotización → proyecto, sin depender de esa columna.
    let proyectoId = cliente.proyecto_id;
    if (!proyectoId) {
      const viaCotizacion = await client.query(
        `SELECT proyecto_id FROM cotizaciones WHERE cliente_id = $1 AND proyecto_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [id]
      );
      proyectoId = viaCotizacion.rows[0]?.proyecto_id || null;
    }
    if (!proyectoId) {
      return res.status(400).json({ error: 'Este cliente todavía no tiene un proyecto creado. Acepta su cotización o crea el proyecto primero.' });
    }

    const areaResult = await client.query("SELECT id FROM areas_catalogo WHERE nombre = 'AREA DE CLIENTES'");
    if (areaResult.rows.length === 0) {
      return res.status(500).json({ error: 'No se encontró el área de clientes en el catálogo. Contacta soporte.' });
    }
    const areaId = areaResult.rows[0].id;

    // Evita generar una segunda invitación si el cliente ya tiene una pendiente a este mismo
    // proyecto (por ejemplo si gerencia toca "Invitar" dos veces sin querer).
    const yaInvitado = await client.query(
      `SELECT i.id FROM proyecto_equipo pe
       JOIN invitaciones i ON i.id = pe.invitacion_id
       WHERE pe.proyecto_id = $1 AND pe.area_id = $2 AND i.celular_invitado = $3 AND i.usado = FALSE`,
      [proyectoId, areaId, cliente.celular]
    );
    if (yaInvitado.rows.length > 0) {
      return res.status(400).json({ error: 'Este cliente ya tiene una invitación pendiente a este proyecto.' });
    }

    await client.query('BEGIN');

    const invResult = await client.query(
      'INSERT INTO invitaciones (empresa_id, area_id, nombre_invitado, celular_invitado) VALUES ($1, $2, $3, $4) RETURNING *',
      [cliente.empresa_id, areaId, cliente.nombre, cliente.celular]
    );
    const invitacion = invResult.rows[0];

    await client.query(
      'INSERT INTO proyecto_equipo (proyecto_id, invitacion_id, area_id) VALUES ($1, $2, $3)',
      [proyectoId, invitacion.id, areaId]
    );

    await client.query('COMMIT');

    const link = `frontendappmedv2://invitacion/${invitacion.token}`;
    res.status(201).json({ mensaje: 'Invitación generada exitosamente', invitacion, link_whatsapp: link });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error invitando cliente:', error);
    res.status(500).json({ error: 'No se pudo invitar al cliente. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR clientes de una empresa
router.get('/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT c.*, p.nombre AS proyecto_nombre 
       FROM clientes c 
       LEFT JOIN proyectos p ON p.id = c.proyecto_id 
       WHERE c.empresa_id = $1 
       ORDER BY c.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, clientes: result.rows });
  } catch (error) {
    console.error('Error listando clientes:', error);
    res.status(500).json({ error: 'Error al listar clientes' });
  }
});

module.exports = router;