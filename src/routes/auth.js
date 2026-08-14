const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const AREAS_ADMINISTRATIVAS = ['GERENCIA', 'AREA ADMINISTRATIVA', 'AREA DE LOGISTICA'];

// 🔍 PASO 1: verificar celular y saber si necesita contraseña
router.post('/verificar', async (req, res) => {
  try {
    const { celular } = req.body;
    if (!celular) {
      return res.status(400).json({ error: 'celular es obligatorio' });
    }

    const usuarioResult = await pool.query('SELECT * FROM usuarios WHERE celular = $1', [celular]);
    if (usuarioResult.rows.length === 0) {
      return res.status(404).json({ error: 'No existe ningún usuario con este número de celular' });
    }
    const usuario = usuarioResult.rows[0];

    const rolesResult = await pool.query(
      `SELECT a.nombre AS area_nombre FROM usuario_empresa_rol uer
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo'`,
      [usuario.id]
    );

    const esAdministrativo = rolesResult.rows.some((r) => AREAS_ADMINISTRATIVAS.includes(r.area_nombre));

    res.json({
      existe: true,
      requiere_contraseña: esAdministrativo,
      nombre: usuario.nombre,
    });
  } catch (error) {
    console.error('Error verificando celular:', error);
    res.status(500).json({ error: 'Error al verificar celular' });
  }
});

// 🔑 PASO 2: login (con o sin contraseña según corresponda)
router.post('/login', async (req, res) => {
  try {
    const { celular, contraseña } = req.body;
    if (!celular) {
      return res.status(400).json({ error: 'celular es obligatorio' });
    }

    const usuarioResult = await pool.query('SELECT * FROM usuarios WHERE celular = $1', [celular]);
    if (usuarioResult.rows.length === 0) {
      return res.status(404).json({ error: 'No existe ningún usuario con este número de celular' });
    }
    const usuario = usuarioResult.rows[0];

    // Traer todas sus empresas y roles
    const rolesResult = await pool.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, e.sitio_web,
              a.id AS area_id, a.nombre AS area_nombre
       FROM usuario_empresa_rol uer
       JOIN empresas e ON e.id = uer.empresa_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo'`,
      [usuario.id]
    );

    if (rolesResult.rows.length === 0) {
      return res.status(404).json({ error: 'Este usuario no pertenece a ninguna empresa activa' });
    }

    const esAdministrativo = rolesResult.rows.some((r) => AREAS_ADMINISTRATIVAS.includes(r.area_nombre));

    if (esAdministrativo) {
      if (!contraseña) {
        return res.status(400).json({ error: 'Este usuario requiere contraseña' });
      }
      if (!usuario.contraseña_hash) {
        return res.status(400).json({ error: 'Este usuario no tiene contraseña configurada' });
      }
      const coincide = await bcrypt.compare(contraseña, usuario.contraseña_hash);
      if (!coincide) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
      }
    }

    delete usuario.contraseña_hash;

    res.json({
      mensaje: 'Ingreso exitoso',
      usuario,
      empresas: rolesResult.rows,
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

module.exports = router;