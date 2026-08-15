const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 ENVIAR mensaje en el chat individual de una persona, dentro de un área y un proyecto
router.post('/enviar', async (req, res) => {
  try {
    const { proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido } = req.body;

    if (!proyecto_id || !area_id || !usuario_id || !destinatario_usuario_id || !contenido) {
      return res.status(400).json({ error: 'proyecto_id, area_id, usuario_id, destinatario_usuario_id y contenido son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO mensajes (proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido]
    );

    res.status(201).json({ mensaje: 'Mensaje enviado exitosamente', data: result.rows[0] });
  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// 👁️ VER la conversación individual con una persona específica, dentro de un área y proyecto
router.get('/:proyecto_id/:area_id/:destinatario_usuario_id', async (req, res) => {
  try {
    const { proyecto_id, area_id, destinatario_usuario_id } = req.params;

    const result = await pool.query(
      `SELECT m.id, m.contenido, m.created_at, u.id AS usuario_id, u.nombre AS usuario_nombre
       FROM mensajes m
       JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.proyecto_id = $1 AND m.area_id = $2 AND m.destinatario_usuario_id = $3
       ORDER BY m.created_at ASC`,
      [proyecto_id, area_id, destinatario_usuario_id]
    );

    res.json({ total: result.rows.length, mensajes: result.rows });
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// 📎 ADJUNTAR archivo a un mensaje
router.post('/adjuntar', async (req, res) => {
  try {
    const { mensaje_id, usuario_id, nombre_archivo, url_archivo, tipo_archivo } = req.body;

    if (!mensaje_id || !usuario_id || !url_archivo) {
      return res.status(400).json({ error: 'mensaje_id, usuario_id y url_archivo son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO archivos (mensaje_id, usuario_id, nombre_archivo, url_archivo, tipo_archivo) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [mensaje_id, usuario_id, nombre_archivo || null, url_archivo, tipo_archivo || null]
    );

    res.status(201).json({ mensaje: 'Archivo adjuntado exitosamente', archivo: result.rows[0] });
  } catch (error) {
    console.error('Error adjuntando archivo:', error);
    res.status(500).json({ error: 'Error al adjuntar archivo' });
  }
});

module.exports = router;