const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 📝 CREAR PERFIL: Nueva empresa + usuario Gerencia
router.post('/crear-perfil', async (req, res) => {
  const client = await pool.connect();
  try {
    const { nombre_empresa, logo_url, sitio_web, color_hex, nombre_usuario, celular } = req.body;

    if (!nombre_empresa || !nombre_usuario || !celular) {
      return res.status(400).json({ error: 'Nombre de empresa, nombre de usuario y celular son obligatorios' });
    }

    await client.query('BEGIN');

    // 1. Crear la empresa
    const empresaResult = await client.query(
      'INSERT INTO empresas (nombre, logo_url, sitio_web, color_hex) VALUES ($1, $2, $3, $4) RETURNING *',
      [nombre_empresa, logo_url || null, sitio_web || null, color_hex || null]
    );
    const empresa = empresaResult.rows[0];

    // 2. Crear o encontrar el usuario (por celular)
    let usuarioResult = await client.query('SELECT * FROM usuarios WHERE celular = $1', [celular]);
    let usuario;
    if (usuarioResult.rows.length > 0) {
      usuario = usuarioResult.rows[0];
    } else {
      const nuevoUsuario = await client.query(
        'INSERT INTO usuarios (celular, nombre) VALUES ($1, $2) RETURNING *',
        [celular, nombre_usuario]
      );
      usuario = nuevoUsuario.rows[0];
    }

    // 3. Buscar el area_id de GERENCIA
    const areaResult = await client.query("SELECT id FROM areas_catalogo WHERE nombre = 'GERENCIA'");
    const areaGerenciaId = areaResult.rows[0].id;

    // 4. Vincular usuario a empresa como Gerencia
    const vinculo = await client.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4) RETURNING *',
      [usuario.id, empresa.id, areaGerenciaId, 'activo']
    );

    await client.query('COMMIT');

    res.status(201).json({
      mensaje: 'Perfil de empresa creado exitosamente',
      empresa,
      usuario,
      rol: vinculo.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando perfil de empresa:', error);
    res.status(500).json({ error: 'Error al crear perfil de empresa' });
  } finally {
    client.release();
  }
});

module.exports = router;