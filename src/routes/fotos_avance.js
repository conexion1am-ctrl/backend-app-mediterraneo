const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 SUBIR una foto de avance (la imagen ya fue subida a Firebase Storage desde el frontend; aquí solo se guarda la referencia)
router.post('/subir', async (req, res) => {
  try {
    const { proyecto_id, area_id, usuario_id, foto_url, descripcion } = req.body;

    if (!proyecto_id || !area_id || !usuario_id || !foto_url) {
      return res.status(400).json({ error: 'proyecto_id, area_id, usuario_id y foto_url son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO fotos_avance (proyecto_id, area_id, usuario_id, foto_url, descripcion) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [proyecto_id, area_id, usuario_id, foto_url, descripcion || null]
    );

    res.status(201).json({ mensaje: 'Foto de avance guardada exitosamente', foto: result.rows[0] });
  } catch (error) {
    console.error('Error guardando foto de avance:', error);
    res.status(500).json({ error: 'Error al guardar la foto de avance' });
  }
});

// 👁️ LISTAR fotos de avance de un área dentro de un proyecto (más recientes primero)
router.get('/:proyecto_id/:area_id', async (req, res) => {
  try {
    const { proyecto_id, area_id } = req.params;
    const result = await pool.query(
      `SELECT f.*, COALESCE(u.nombre, 'Usuario eliminado') AS usuario_nombre
       FROM fotos_avance f
       LEFT JOIN usuarios u ON u.id = f.usuario_id
       WHERE f.proyecto_id = $1 AND f.area_id = $2
       ORDER BY f.created_at DESC`,
      [proyecto_id, area_id]
    );
    res.json({ total: result.rows.length, fotos: result.rows });
  } catch (error) {
    console.error('Error listando fotos de avance:', error);
    res.status(500).json({ error: 'Error al listar fotos de avance' });
  }
});

// 🗑️ ELIMINAR una foto de avance: borra la fila y también el archivo real en Firebase Storage,
// para no dejar el archivo huérfano ocupando espacio en la nube.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fotos_avance WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Foto no encontrada' });
    }

    await borrarArchivoDeStorage(result.rows[0].foto_url);

    res.json({ mensaje: 'Foto eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando foto de avance:', error);
    res.status(500).json({ error: 'Error al eliminar la foto' });
  }
});

module.exports = router;
