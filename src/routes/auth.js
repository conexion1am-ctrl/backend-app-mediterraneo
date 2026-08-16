const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// El login ahora exige contraseña a TODOS los roles por seguridad (antes el personal no
// administrativo entraba solo con el celular, sin contraseña).

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

    res.json({
      existe: true,
      requiere_contraseña: true,
      // Si es la primera vez que este usuario usa contraseña (personas que se vincularon antes
      // de que se exigiera contraseña a todos los roles), le dejamos crear una en vez de pedirle
      // una que nunca configuró.
      debe_crear_contraseña: !usuario.contraseña_hash,
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

    // Traer todas sus empresas y roles (solo empresas activas, no eliminadas)
    const rolesResult = await pool.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, e.sitio_web,
              a.id AS area_id, a.nombre AS area_nombre
       FROM usuario_empresa_rol uer
       JOIN empresas e ON e.id = uer.empresa_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo' AND e.estado = 'activo'`,
      [usuario.id]
    );

    if (rolesResult.rows.length === 0) {
      return res.status(404).json({ error: 'Este usuario no pertenece a ninguna empresa activa' });
    }

    // Todos los roles requieren contraseña (antes solo Gerencia/Administrativa/Logística).
    if (!contraseña || contraseña.length < 6) {
      return res.status(400).json({ error: 'Este usuario requiere una contraseña de al menos 6 caracteres' });
    }

    let usuarioFinal = usuario;
    if (!usuario.contraseña_hash) {
      // Primera vez que este usuario usa contraseña (se vinculó antes de que fuera obligatoria
      // para todos los roles): la que envía ahora queda guardada como su nueva contraseña.
      const hash = await bcrypt.hash(contraseña, 10);
      const actualizado = await pool.query(
        'UPDATE usuarios SET contraseña_hash = $1 WHERE id = $2 RETURNING *',
        [hash, usuario.id]
      );
      usuarioFinal = actualizado.rows[0];
    } else {
      const coincide = await bcrypt.compare(contraseña, usuario.contraseña_hash);
      if (!coincide) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
      }
    }

    delete usuarioFinal.contraseña_hash;
    const usuarioRespuesta = usuarioFinal;

    res.json({
      mensaje: 'Ingreso exitoso',
      usuario: usuarioRespuesta,
      empresas: rolesResult.rows,
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ✏️ EDITAR PERFIL DE USUARIO: nombre y/o contraseña nueva (opcional)
router.put('/usuario/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, contraseña_actual, contraseña_nueva } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    const usuarioResult = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (usuarioResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const usuario = usuarioResult.rows[0];

    let nuevoHash = usuario.contraseña_hash;

    // Si el usuario quiere cambiar la contraseña
    if (contraseña_nueva) {
      if (contraseña_nueva.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
      }

      // Si ya tenía contraseña configurada, exigimos la actual para confirmar el cambio
      if (usuario.contraseña_hash) {
        if (!contraseña_actual) {
          return res.status(400).json({ error: 'Debes ingresar tu contraseña actual para cambiarla' });
        }
        const coincide = await bcrypt.compare(contraseña_actual, usuario.contraseña_hash);
        if (!coincide) {
          return res.status(401).json({ error: 'La contraseña actual no es correcta' });
        }
      }

      nuevoHash = await bcrypt.hash(contraseña_nueva, 10);
    }

    const actualizado = await pool.query(
      'UPDATE usuarios SET nombre = $1, contraseña_hash = $2 WHERE id = $3 RETURNING *',
      [nombre, nuevoHash, id]
    );

    const usuarioActualizado = actualizado.rows[0];
    delete usuarioActualizado.contraseña_hash;

    res.json({
      mensaje: 'Perfil de usuario actualizado exitosamente',
      usuario: usuarioActualizado,
    });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// 🔔 GUARDAR/ACTUALIZAR el token de notificaciones push de este usuario en este dispositivo.
// Se llama cada vez que la app abre sesión (login o restaurar sesión guardada), así siempre
// queda el token del último dispositivo donde el usuario entró.
router.put('/usuario/:id/push-token', async (req, res) => {
  try {
    const { id } = req.params;
    const { push_token } = req.body;

    if (!push_token) {
      return res.status(400).json({ error: 'push_token es obligatorio' });
    }

    await pool.query('UPDATE usuarios SET push_token = $1 WHERE id = $2', [push_token, id]);

    res.json({ mensaje: 'Token de notificaciones guardado exitosamente' });
  } catch (error) {
    console.error('Error guardando push token:', error);
    res.status(500).json({ error: 'Error al guardar el token de notificaciones' });
  }
});

module.exports = router;