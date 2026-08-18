const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { esGerencia } = require('../utils/permisos');
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');
const { borrarDependenciasDeProyecto } = require('../utils/cascadaProyecto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR proyecto (con actividades/áreas seleccionadas)
router.post('/crear', async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng, areas_ids } = req.body;

    if (!empresa_id || !nombre) {
      return res.status(400).json({ error: 'empresa_id y nombre son obligatorios' });
    }

    await client.query('BEGIN');

    const proyectoResult = await client.query(
      'INSERT INTO proyectos (empresa_id, nombre, direccion, area_m2, ubicacion_lat, ubicacion_lng) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [empresa_id, nombre, direccion || null, area_m2 || null, ubicacion_lat || null, ubicacion_lng || null]
    );
    const proyecto = proyectoResult.rows[0];

    // Insertar las actividades (áreas) seleccionadas
    if (areas_ids && areas_ids.length > 0) {
      for (const areaId of areas_ids) {
        await client.query(
          'INSERT INTO proyecto_actividades (proyecto_id, area_id) VALUES ($1, $2)',
          [proyecto.id, areaId]
        );
      }
    }

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
router.post('/:id/equipo/asignar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, area_id } = req.body;

    if (!usuario_id || !area_id) {
      return res.status(400).json({ error: 'usuario_id y area_id son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO proyecto_equipo (proyecto_id, usuario_id, area_id) VALUES ($1, $2, $3) RETURNING *',
      [id, usuario_id, area_id]
    );

    res.status(201).json({ mensaje: 'Persona asignada al proyecto exitosamente', asignacion: result.rows[0] });
  } catch (error) {
    console.error('Error asignando persona:', error);
    res.status(500).json({ error: 'Error al asignar persona al proyecto' });
  }
});

// 👥 VER equipo asignado a un proyecto (agrupado por área)
router.get('/:id/equipo', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT pe.id AS asignacion_id, u.id AS usuario_id, u.nombre, u.celular, a.id AS area_id, a.nombre AS area_nombre
       FROM proyecto_equipo pe
       JOIN usuarios u ON u.id = pe.usuario_id
       JOIN areas_catalogo a ON a.id = pe.area_id
       WHERE pe.proyecto_id = $1
       ORDER BY a.nombre`,
      [id]
    );
    res.json({ equipo: result.rows });
  } catch (error) {
    console.error('Error obteniendo equipo:', error);
    res.status(500).json({ error: 'Error al obtener equipo del proyecto' });
  }
});

// 👤 VER en qué proyectos y áreas está asignada una persona actualmente
router.get('/asignaciones/:usuario_id', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const result = await pool.query(
      `SELECT p.id AS proyecto_id, p.nombre AS proyecto_nombre, a.id AS area_id, a.nombre AS area_nombre
       FROM proyecto_equipo pe
       JOIN proyectos p ON p.id = pe.proyecto_id
       JOIN areas_catalogo a ON a.id = pe.area_id
       WHERE pe.usuario_id = $1 AND p.estado = 'activo'
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