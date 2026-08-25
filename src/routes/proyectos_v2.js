const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { esGerencia } = require('../utils/permisos');
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { borrarDependenciasDeProyecto, borrarDependenciasDeArea, configurarProyectoNuevo } = require('../utils/cascadaProyecto');
const { vaciarChat } = require('./mensajes');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR proyecto (con actividades/áreas seleccionadas)
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng, areas_ids, creado_por_usuario_id } = req.body;

    if (!empresa_id || !nombre) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    await client.query('BEGIN');

    const proyectoResult = await client.query(
      'INSERT INTO proyectos (empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng, creado_por_usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [empresa_id, nombre, direccion || null, area_m2 || null, ubicacion_lat || null, ubicacion_lng || null, creado_por_usuario_id || null]
    );
    const proyecto = proyectoResult.rows[0];

    // Insertar las actividades (áreas) que el usuario seleccionó manualmente en el modal.
    // WHERE NOT EXISTS por seguridad: GERENCIA/AREA ADMINISTRATIVA/AREA DE LOGISTICA ya no se
    // ofrecen como checkbox en el modal (se crean siempre automáticamente, ver
    // configurarProyectoNuevo más abajo), pero este INSERT queda protegido igual contra
    // duplicados por si areas_ids trae una de esas 3, o la misma área repetida por error.
    if (areas_ids && areas_ids.length > 0) {
      for (const areaId of areas_ids) {
        await client.query(
          `INSERT INTO proyecto_actividades (proyecto_id, area_id)
           SELECT $1, $2 WHERE NOT EXISTS (
             SELECT 1 FROM proyecto_actividades WHERE proyecto_id = $1 AND area_id = $2
           )`,
          [proyecto.id, areaId]
        );
      }
    }

    // Además de lo seleccionado a mano, todo proyecto nace SIEMPRE con GERENCIA, AREA
    // ADMINISTRATIVA y AREA DE LOGISTICA como actividades (ver configurarProyectoNuevo) — no son
    // opcionales, existen en todos los proyectos por defecto — y con los gerentes de la empresa
    // más quien lo creó ya auto-asignados en su ficha correspondiente.
    await configurarProyectoNuevo(client, proyecto.id, empresa_id, creado_por_usuario_id || null);

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Proyecto creado exitosamente', proyecto });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando proyecto:', error);
    res.status(500).json({ error: 'Error al crear proyecto' });
  } finally {
    client.release();
  }
});

// 👁️ LISTAR proyectos de una empresa
router.get('/listar/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM proyectos WHERE empresa_id = $1 AND estado = 'activo' ORDER BY created_at DESC",
      [empresa_id]
    );
    res.json({ total: result.rows.length, proyectos: result.rows });
  } catch (error) {
    console.error('Error listando proyectos:', error);
    res.status(500).json({ error: 'Error al listar proyectos' });
  }
});

// 👁️ VER detalle de un proyecto (con sus actividades/áreas)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const proyecto = await pool.query('SELECT * FROM proyectos WHERE id = $1', [id]);

    if (proyecto.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const actividades = await pool.query(
      `SELECT a.id, a.nombre, a.categoria_padre 
       FROM proyecto_actividades pa 
       JOIN areas_catalogo a ON a.id = pa.area_id 
       WHERE pa.proyecto_id = $1`,
      [id]
    );

    res.json({ ...proyecto.rows[0], actividades: actividades.rows });
  } catch (error) {
    console.error('Error obteniendo proyecto:', error);
    res.status(500).json({ error: 'Error al obtener proyecto' });
  }
});

// 👥 ASIGNAR personal a un área dentro de un proyecto (pantalla Equipo)
// Acepta tanto personal ya vinculado (usuario_id) como personal invitado que aún no acepta
// su invitación (invitacion_id) — esto último para que la persona quede visible en el equipo
// del proyecto desde ya, sin tener que esperar a que acepte el link.
router.post('/:id/equipo/asignar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, invitacion_id, area_id } = req.body;

    if ((!usuario_id && !invitacion_id) || !area_id) {
      return res.status(400).json({ error: 'area_id y (usuario_id o invitacion_id) son obligatorios' });
    }

    // Antes de insertar, verificamos si esta MISMA persona ya está asignada a este proyecto (en
    // cualquier área, no solo en area_id) — esto es lo que causaba el bug de "fichas duplicadas":
    // tocar el botón Asignar varias veces (o para la misma persona en distintas pestañas de área)
    // creaba una fila nueva cada vez en proyecto_equipo, y el equipo del proyecto mostraba a la
    // misma persona repetida 2 o 3 veces. Si ya existe una asignación activa, no duplicamos: le
    // avisamos al frontend que ya estaba asignada en vez de crear una fila más.
    const yaAsignada = await pool.query(
      `SELECT id, area_id FROM proyecto_equipo
       WHERE proyecto_id = $1
         AND ((usuario_id IS NOT NULL AND usuario_id = $2::int)
           OR (invitacion_id IS NOT NULL AND invitacion_id = $3::int))`,
      [id, usuario_id || null, invitacion_id || null]
    );
    if (yaAsignada.rows.length > 0) {
      return res.status(200).json({
        mensaje: 'Esta persona ya estaba asignada a este proyecto',
        asignacion: yaAsignada.rows[0],
        yaExistia: true,
      });
    }

    const result = await pool.query(
      'INSERT INTO proyecto_equipo (proyecto_id, usuario_id, invitacion_id, area_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, usuario_id || null, invitacion_id || null, area_id]
    );

    res.status(201).json({ mensaje: 'Persona asignada al proyecto exitosamente', asignacion: result.rows[0] });
  } catch (error) {
    console.error('Error asignando persona:', error);
    res.status(500).json({ error: 'Error al asignar persona al proyecto' });
  }
});

// 👥 VER equipo asignado a un proyecto (agrupado por área)
// Trae tanto personal ya vinculado (usuario real) como personal pendiente (invitación sin
// aceptar todavía), para que gerencia pueda ver quién quedó asignado desde el primer momento.
//
// "solicitante_id" (query param opcional): el usuario_id de quien está pidiendo este listado.
// Se usa SOLO para calcular "le_ha_escrito" en las filas de GERENCIA: un trabajador de oficio
// (o Proveedor/Cliente) no debe poder iniciar una conversación con un gerente por su cuenta —
// esa fila solo debe volverse visible en el frontend después de que ESE gerente le haya escrito
// primero al solicitante. Área Administrativa y Área de Logística no tienen esta restricción
// (siguen siendo contactables libremente), así que el EXISTS solo se calcula cuando
// a.nombre = 'GERENCIA'; para cualquier otra área, "le_ha_escrito" simplemente viene en null
// y el frontend lo ignora.
router.get('/:id/equipo', async (req, res) => {
  try {
    const { id } = req.params;
    const { solicitante_id } = req.query;
    const result = await pool.query(
      `SELECT DISTINCT ON (COALESCE(pe.usuario_id::text, 'inv-' || pe.invitacion_id::text))
              pe.id AS asignacion_id,
              COALESCE(u.id, NULL) AS usuario_id,
              COALESCE(u.nombre, i.nombre_invitado) AS nombre,
              COALESCE(u.celular, i.celular_invitado) AS celular,
              a.id AS area_id, a.nombre AS area_nombre,
              pe.pausado,
              CASE WHEN pe.usuario_id IS NOT NULL THEN 'vinculado' ELSE 'pendiente' END AS estado,
              CASE
                WHEN a.nombre = 'GERENCIA' AND $2::int IS NOT NULL THEN EXISTS (
                  -- OJO: NO filtramos por área aquí a propósito (2026-08-25: la conversación entre
                  -- 2 personas es una sola, sin partirla por área — ver GET /:proyecto_id/:destino
                  -- en mensajes.js). Lo único que importa es: ¿ESTE gerente (pe.usuario_id) le
                  -- escribió alguna vez a ESTE solicitante, en ESTE proyecto? — sin importar el
                  -- area_id de cada mensaje individual (que ahora refleja el área propia de quien
                  -- lo envió, no la pantalla desde la que se escribió).
                  SELECT 1 FROM mensajes m
                  WHERE m.proyecto_id = pe.proyecto_id
                    AND m.usuario_id = pe.usuario_id
                    AND m.destinatario_usuario_id = $2::int
                )
                ELSE NULL
              END AS le_ha_escrito
       FROM proyecto_equipo pe
       LEFT JOIN usuarios u ON u.id = pe.usuario_id
       LEFT JOIN invitaciones i ON i.id = pe.invitacion_id
       JOIN areas_catalogo a ON a.id = pe.area_id
       WHERE pe.proyecto_id = $1
       -- DISTINCT ON exige que el primer campo del ORDER BY sea la misma expresión de arriba;
       -- dentro de cada persona duplicada nos quedamos con la fila de asignación más antigua
       -- (pe.id menor), y luego ordenamos el resultado final por nombre de área como antes.
       ORDER BY COALESCE(pe.usuario_id::text, 'inv-' || pe.invitacion_id::text), pe.id ASC`,
      [id, solicitante_id || null]
    );
    // El DISTINCT ON de Postgres no permite además un ORDER BY final por a.nombre en la misma
    // consulta (su primer criterio de orden debe ser la expresión del DISTINCT ON), así que
    // ordenamos por área aquí, ya con los duplicados fuera.
    const equipoOrdenado = result.rows.sort((a, b) => a.area_nombre.localeCompare(b.area_nombre));
    res.json({ equipo: equipoOrdenado });
  } catch (error) {
    console.error('Error obteniendo equipo:', error);
    res.status(500).json({ error: 'Error al obtener equipo del proyecto' });
  }
});

// ⏸️ PAUSAR / REANUDAR el acceso de una persona a este proyecto, sin desasignarla del todo.
// Alterna el valor actual (si estaba pausada, la reanuda; si estaba activa, la pausa) — así el
// mismo botón sirve para ambas acciones desde el frontend, sin tener que mandar el nuevo estado.
// Mientras está pausada, GET /asignaciones/:usuario_id no la incluye, así que la persona pierde
// acceso real a este proyecto (no puede verlo ni entrar), pero el historial de chat que ya
// tuvieron queda intacto para cuando se reanude.
router.put('/equipo/:asignacion_id/pausar', async (req, res) => {
  try {
    const { asignacion_id } = req.params;
    const result = await pool.query(
      'UPDATE proyecto_equipo SET pausado = NOT pausado WHERE id = $1 RETURNING *',
      [asignacion_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asignación no encontrada' });
    }
    const asignacion = result.rows[0];
    res.json({
      mensaje: asignacion.pausado ? 'Asignación pausada' : 'Asignación reanudada',
      asignacion,
    });
  } catch (error) {
    console.error('Error pausando/reanudando asignación:', error);
    res.status(500).json({ error: 'Error al pausar/reanudar la asignación' });
  }
});

// 🗑️ ELIMINAR a una persona de un proyecto por completo (quita la fila de proyecto_equipo, y
// además vacía el chat que tuvieron en esa área — confirmado con el usuario que ambas cosas
// deben borrarse juntas, para no dejar un chat "huérfano" con alguien que ya no tiene acceso).
// Solo aplica a personal ya vinculado (usuario_id no nulo); si la asignación era de alguien
// pendiente (invitación sin aceptar), no hay chat que vaciar.
router.delete('/equipo/:asignacion_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { asignacion_id } = req.params;
    const { usuario_solicitante_id } = req.body; // quién de gerencia hace la petición (dueño del chat con esta persona)

    const asignacionResult = await client.query('SELECT * FROM proyecto_equipo WHERE id = $1', [asignacion_id]);
    if (asignacionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Asignación no encontrada' });
    }
    const asignacion = asignacionResult.rows[0];

    await client.query('BEGIN');

    // El chat es 1 a 1 (usuario_id ↔ destinatario_usuario_id), así que se vacía específicamente
    // el hilo entre la persona eliminada y quien hizo la petición — solo si ambos ids existen
    // (la persona ya estaba vinculada, y sabemos quién es el otro lado de esa conversación).
    if (asignacion.usuario_id && usuario_solicitante_id) {
      await vaciarChat(client, asignacion.proyecto_id, asignacion.usuario_id, usuario_solicitante_id);
    }

    await client.query('DELETE FROM proyecto_equipo WHERE id = $1', [asignacion_id]);

    await client.query('COMMIT');
    res.json({ mensaje: 'Persona eliminada del proyecto exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando asignación:', error);
    res.status(500).json({ error: 'Error al eliminar la persona del proyecto' });
  } finally {
    client.release();
  }
});

// 👤 VER en qué proyectos y áreas está asignada una persona actualmente
// pe.pausado = false: si gerencia pausó la asignación de esta persona a un proyecto, deja de
// aparecer aquí — este es el bloqueo REAL de acceso (no solo visual), porque esta es la consulta
// que usa la app para decidir qué proyectos puede ver/entrar un trabajador.
router.get('/asignaciones/:usuario_id', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const result = await pool.query(
      `SELECT p.id AS proyecto_id, p.nombre AS proyecto_nombre, a.id AS area_id, a.nombre AS area_nombre
       FROM proyecto_equipo pe
       JOIN proyectos p ON p.id = pe.proyecto_id
       JOIN areas_catalogo a ON a.id = pe.area_id
       WHERE pe.usuario_id = $1 AND p.estado = 'activo' AND pe.pausado = false
       ORDER BY p.nombre`,
      [usuario_id]
    );
    res.json({ total: result.rows.length, asignaciones: result.rows });
  } catch (error) {
    console.error('Error obteniendo asignaciones:', error);
    res.status(500).json({ error: 'Error al obtener asignaciones de la persona' });
  }
});

// ✏️ EDITAR datos generales de un proyecto
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng } = req.body;

    const result = await pool.query(
      `UPDATE proyectos 
       SET nombre = COALESCE($1, nombre), 
           direccion = COALESCE($2, direccion), 
           area_m2 = COALESCE($3, area_m2),
           ubicacion_lat = COALESCE($4, ubicacion_lat),
           ubicacion_lng = COALESCE($5, ubicacion_lng),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    res.json({ mensaje: 'Proyecto actualizado exitosamente', proyecto: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando proyecto:', error);
    res.status(500).json({ error: 'Error al actualizar proyecto' });
  }
});

// ➕ AGREGAR una nueva actividad (área) a un proyecto ya existente
router.post('/:id/actividades/agregar', async (req, res) => {
  try {
    const { id } = req.params;
    const { area_id } = req.body;

    if (!area_id) {
      return res.status(400).json({ error: 'area_id es obligatorio' });
    }

    // Evitar duplicar la misma actividad
    const existe = await pool.query(
      'SELECT * FROM proyecto_actividades WHERE proyecto_id = $1 AND area_id = $2',
      [id, area_id]
    );
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Esta actividad ya está agregada a este proyecto' });
    }

    const result = await pool.query(
      'INSERT INTO proyecto_actividades (proyecto_id, area_id) VALUES ($1, $2) RETURNING *',
      [id, area_id]
    );

    res.status(201).json({ mensaje: 'Actividad agregada exitosamente', actividad: result.rows[0] });
  } catch (error) {
    console.error('Error agregando actividad:', error);
    res.status(500).json({ error: 'Error al agregar actividad' });
  }
});

// 🗑️ ELIMINAR una actividad/área de un proyecto, con TODO lo que tenga adentro: chats y sus
// archivos adjuntos, fotos de avance, diseños/planos 3D, y cualquier persona asignada a esa área
// en este proyecto (su cuenta y su vínculo con la empresa NO se tocan, solo esta asignación
// puntual). No afecta estadísticas/abonos del proyecto (son por proyecto completo, no por área).
router.delete('/:id/actividades/:area_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, area_id } = req.params;

    const existe = await client.query(
      'SELECT * FROM proyecto_actividades WHERE proyecto_id = $1 AND area_id = $2',
      [id, area_id]
    );
    if (existe.rows.length === 0) {
      return res.status(404).json({ error: 'Esta actividad no está agregada a este proyecto' });
    }

    await client.query('BEGIN');
    const urlsABorrar = await borrarDependenciasDeArea(client, id, area_id);
    await client.query('COMMIT');

    // Limpiamos Storage ya con la base de datos consistente (mismo criterio "best effort" que el
    // resto de la app): si algo falla aquí, no revertimos la base de datos.
    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo de Storage al eliminar actividad:', error.message);
      });
    }

    res.json({ mensaje: 'Actividad eliminada exitosamente, junto con todo su contenido' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando actividad:', error);
    res.status(500).json({ error: 'No se pudo eliminar la actividad. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

// ✅ MARCAR proyecto como finalizado (la obra ya se entregó). Deja de aparecer en la lista
// de proyectos activos, pero el proyecto y su contrato siguen existiendo y son consultables.
router.put('/:id/finalizar', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE proyectos SET estado = 'finalizado', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    res.json({ mensaje: 'Proyecto marcado como finalizado', proyecto: result.rows[0] });
  } catch (error) {
    console.error('Error finalizando proyecto:', error);
    res.status(500).json({ error: 'Error al finalizar el proyecto' });
  }
});

// ↩️ REACTIVAR proyecto finalizado (por si se marcó por error o hay que reabrir la obra)
router.put('/:id/reactivar', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE proyectos SET estado = 'activo', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    res.json({ mensaje: 'Proyecto reactivado', proyecto: result.rows[0] });
  } catch (error) {
    console.error('Error reactivando proyecto:', error);
    res.status(500).json({ error: 'Error al reactivar el proyecto' });
  }
});

// 🗑️ ELIMINAR proyecto de verdad (ya no es soft-delete), junto con todo lo que cuelga de él
// (fotos, planos 3D, chat y adjuntos, equipo asignado, estadísticas, abonos, actividades),
// limpiando también los archivos en Firebase Storage. El CONTRATO y la COTIZACIÓN que lo
// originaron NO se tocan: solo se desvinculan (proyecto_id = NULL), porque el contrato ya
// guarda su propio snapshot del proyecto y puede volver a crearlo con "Crear Proyecto" cuando
// se necesite. Solo Gerencia puede eliminar proyectos.
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { usuario_id } = req.body;

    const proyectoResult = await client.query('SELECT * FROM proyectos WHERE id = $1', [id]);
    if (proyectoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    const proyecto = proyectoResult.rows[0];

    if (usuario_id) {
      const esGerenciaDeEstaEmpresa = await esGerencia(usuario_id, proyecto.empresa_id);
      if (!esGerenciaDeEstaEmpresa) {
        return res.status(403).json({ error: 'Solo Gerencia puede eliminar proyectos' });
      }
    }

    await client.query('BEGIN');

    // Guardamos snapshot del proyecto en el contrato (si no lo tenía ya) ANTES de borrarlo,
    // para que "Crear Proyecto" pueda recrearlo con los mismos datos más adelante.
    await client.query(
      `UPDATE contratos SET
         proyecto_nombre_snapshot = COALESCE(proyecto_nombre_snapshot, $1),
         proyecto_direccion_snapshot = COALESCE(proyecto_direccion_snapshot, $2),
         proyecto_mts2_snapshot = COALESCE(proyecto_mts2_snapshot, $3)
       WHERE proyecto_id = $4`,
      [proyecto.nombre, proyecto.direccion, proyecto.area_m2, id]
    );

    // borrarDependenciasDeProyecto ya desvincula las cotizaciones (proyecto_id = NULL).
    // Los contratos también quedan desvinculados, conservándose intactos.
    const urlsABorrar = await borrarDependenciasDeProyecto(client, id);
    await client.query('UPDATE contratos SET proyecto_id = NULL WHERE proyecto_id = $1', [id]);

    await client.query('DELETE FROM proyectos WHERE id = $1', [id]);

    await client.query('COMMIT');

    for (const url of urlsABorrar) {
      await borrarArchivoDeStorage(url).catch((error) => {
        console.error('Error borrando archivo de Storage al eliminar proyecto:', error.message);
      });
    }

    res.json({ mensaje: 'Proyecto eliminado exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando proyecto:', error.message, '| code:', error.code, '| detail:', error.detail, '| constraint:', error.constraint, '| table:', error.table);
    res.status(500).json({ error: 'No se pudo eliminar el proyecto. Intenta de nuevo.' });
  } finally {
    client.release();
  }
});

module.exports = router;