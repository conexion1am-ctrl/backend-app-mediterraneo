const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const AREAS_ADMINISTRATIVAS = ['GERENCIA', 'AREA ADMINISTRATIVA', 'AREA DE LOGISTICA'];

// Verifica que el usuario tenga un rol administrativo en la empresa dueña del proyecto.
// Solo esos roles pueden subir o eliminar planos 3D (igual que el documento ARL).
async function esAdministrativoDelProyecto(usuario_id, proyecto_id) {
  const result = await pool.query(
    `SELECT a.nombre AS area_nombre
     FROM proyectos p
     JOIN usuario_empresa_rol uer ON uer.empresa_id = p.empresa_id AND uer.usuario_id = $1 AND uer.estado = 'activo'
     JOIN areas_catalogo a ON a.id = uer.area_id
     WHERE p.id = $2`,
    [usuario_id, proyecto_id]
  );
  return result.rows.some((r) => AREAS_ADMINISTRATIVAS.includes(r.area_nombre));
}

// 📝 SUBIR un plano 3D (.glb). El archivo ya fue subido a Firebase Storage desde el frontend;
// aquí solo se guarda la referencia. Solo roles administrativos pueden subir.
router.post('/subir', async (req, res) => {
  try {
    const { proyecto_id, area_id, usuario_id, nombre, url_glb } = req.body;

    if (!proyecto_id || !area_id || !usuario_id || !url_glb) {
      return res.status(400).json({ error: 'proyecto_id, area_id, usuario_id y url_glb son obligatorios' });
    }

    const esAdmin = await esAdministrativoDelProyecto(usuario_id, proyecto_id);
    if (!esAdmin) {
      return res.status(403).json({ error: 'Solo un rol administrativo puede subir planos 3D' });
    }

    const result = await pool.query(
      'INSERT INTO planos_3d (proyecto_id, area_id, usuario_id, nombre, url_glb) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [proyecto_id, area_id, usuario_id, nombre || 'Plano 3D', url_glb]
    );

    res.status(201).json({ mensaje: 'Plano 3D guardado exitosamente', plano: result.rows[0] });
  } catch (error) {
    console.error('Error guardando plano 3D:', error);
    res.status(500).json({ error: 'Error al guardar el plano 3D' });
  }
});

// 👁️ LISTAR planos 3D de un área dentro de un proyecto (más recientes primero)
router.get('/:proyecto_id/:area_id', async (req, res) => {
  try {
    const { proyecto_id, area_id } = req.params;
    const result = await pool.query(
      `SELECT pl.*, COALESCE(u.nombre, 'Usuario eliminado') AS usuario_nombre
       FROM planos_3d pl
       LEFT JOIN usuarios u ON u.id = pl.usuario_id
       WHERE pl.proyecto_id = $1 AND pl.area_id = $2
       ORDER BY pl.created_at DESC`,
      [proyecto_id, area_id]
    );
    res.json({ total: result.rows.length, planos: result.rows });
  } catch (error) {
    console.error('Error listando planos 3D:', error);
    res.status(500).json({ error: 'Error al listar los planos 3D' });
  }
});

// 🗑️ ELIMINAR un plano 3D: borra la fila y también el archivo .glb real en Firebase Storage.
// Solo roles administrativos.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id } = req.body;

    const planoResult = await pool.query('SELECT * FROM planos_3d WHERE id = $1', [id]);
    if (planoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plano no encontrado' });
    }
    const plano = planoResult.rows[0];

    const esAdmin = await esAdministrativoDelProyecto(usuario_id, plano.proyecto_id);
    if (!esAdmin) {
      return res.status(403).json({ error: 'Solo un rol administrativo puede eliminar planos 3D' });
    }

    await pool.query('DELETE FROM planos_3d WHERE id = $1', [id]);
    await borrarArchivoDeStorage(plano.url_glb);

    res.json({ mensaje: 'Plano 3D eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando plano 3D:', error);
    res.status(500).json({ error: 'Error al eliminar el plano 3D' });
  }
});

module.exports = router;
