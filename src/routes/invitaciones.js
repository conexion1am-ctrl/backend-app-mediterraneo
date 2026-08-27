const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const router = express.Router();
require('dotenv').config();
const { generarToken } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Quita mayúsculas y acentos para poder comparar nombres sin importar cómo los haya escrito el
// usuario (mismo criterio que "textoNormalizado" en el frontend, ej. GrupoTrabajoScreen.tsx).
// Sin esto, alguien registrado como "José Pérez" que escriba "jose perez" en recuperar
// contraseña (sin tildes, muy común al escribir rápido en el celular) fallaría la validación.
const textoNormalizado = (t) => (t || '').toString().trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Lista histórica de áreas administrativas. Ya no se usa para decidir si se pide contraseña:
// ahora TODAS las áreas la requieren al aceptar una invitación (antes el personal de campo
// entraba solo con el celular, sin contraseña).
const AREAS_ADMINISTRATIVAS = ['GERENCIA', 'AREA ADMINISTRATIVA', 'AREA DE LOGISTICA'];

// 📝 AGREGAR personal desde Grupo de Trabajo. Ya NO genera ningún link: solo deja la fila
// "pendiente" en invitaciones (y su asignación en proyecto_equipo, si aplica) con el nombre y
// celular de la persona. Esa persona entra por su cuenta desde "Ingresar como invitado" poniendo
// su celular — la app descubre automáticamente a qué la asignaron (ver /verificar-celular y
// /aceptar-por-celular más abajo). El contacto para avisarle que la agregaron se hace por fuera
// de la app (llamada, WhatsApp manual, etc.), no con un link generado aquí.
router.post('/generar', async (req, res) => {
  try {
    const { empresa_id, area_id, nombre_invitado, celular_invitado } = req.body;

    if (!empresa_id || !area_id || !nombre_invitado || !celular_invitado) {
      return res.status(400).json({ error: 'empresa_id, area_id, nombre_invitado y celular_invitado son obligatorios' });
    }

    const result = await pool.query(
      'INSERT INTO invitaciones (empresa_id, area_id, nombre_invitado, celular_invitado) VALUES ($1, $2, $3, $4) RETURNING *',
      [empresa_id, area_id, nombre_invitado, celular_invitado]
    );

    res.status(201).json({
      mensaje: 'Persona agregada exitosamente. Pídele que entre a la app con su número de celular en "Ingresar como invitado".',
      invitacion: result.rows[0],
    });
  } catch (error) {
    console.error('Error agregando persona:', error);
    res.status(500).json({ error: 'Error al agregar persona' });
  }
});

// 🔍 VERIFICAR si un celular tiene una invitación pendiente (sin importar la empresa) - usado por
// la pantalla "Ingresar como trabajador", donde el usuario no elige empresa: la app la descubre
// a partir de su celular. Si ya tiene cuenta con contraseña, le decimos que use el login normal.
// NOTA: debe ir ANTES de "GET /:token" (más abajo), porque esa ruta genérica capturaría
// "/verificar-celular/..." como si fuera un token cualquiera si quedara declarada primero.
router.get('/verificar-celular/:celular', async (req, res) => {
  try {
    const { celular } = req.params;

    const usuarioExistente = await pool.query('SELECT id, contraseña_hash FROM usuarios WHERE celular = $1', [celular]);

    // IMPORTANTE: revisamos primero si hay una invitación pendiente nueva (a CUALQUIER empresa),
    // ANTES de decidir por "ya tiene contraseña, use login normal". Antes se revisaba al revés:
    // si el usuario ya tenía contraseña (por ejemplo porque ya trabaja en OTRA empresa), se
    // asumía directo que debía usar el login normal — pero el login normal (/auth/login) solo
    // busca en usuario_empresa_rol (vínculos ya ACEPTADOS), y una invitación nueva a una empresa
    // distinta vive solo en la tabla invitaciones/proyecto_equipo hasta que se acepta acá. Con el
    // orden viejo, alguien ya vinculado a la Empresa A que es invitado a la Empresa B nunca podía
    // completar esa segunda invitación: siempre caía al login normal, que no la conocía, y
    // terminaba con "Este usuario no pertenece a ninguna empresa activa".
    const invResult = await pool.query(
      `SELECT i.*, e.nombre AS empresa_nombre
       FROM invitaciones i
       JOIN empresas e ON e.id = i.empresa_id
       WHERE i.celular_invitado = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [celular]
    );

    if (invResult.rows.length > 0) {
      const invitacion = invResult.rows[0];
      return res.json({
        tiene_invitacion_pendiente: true,
        ya_tiene_cuenta: usuarioExistente.rows.length > 0,
        empresa_nombre: invitacion.empresa_nombre,
        nombre_invitado: invitacion.nombre_invitado,
      });
    }

    if (usuarioExistente.rows.length > 0 && usuarioExistente.rows[0].contraseña_hash) {
      // Ya tiene cuenta y contraseña, y no tiene ninguna invitación nueva pendiente: debe iniciar
      // sesión normal (ve las empresas a las que ya está vinculado de verdad).
      return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: true });
    }

    if (usuarioExistente.rows.length > 0) {
      // Usuario legacy: ya tiene cuenta (se vinculó antes de que la contraseña fuera obligatoria)
      // pero nunca creó contraseña, y no tiene ninguna invitación pendiente nueva. No es "nadie te
      // asignó" — ya pertenece a una empresa, solo le falta crear su contraseña por primera vez.
      return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: true, debe_crear_contraseña: true });
    }

    return res.json({ tiene_invitacion_pendiente: false, ya_tiene_cuenta: false });
  } catch (error) {
    console.error('Error verificando celular para invitado:', error);
    res.status(500).json({ error: 'Error al verificar el celular' });
  }
});

// ✅ ACEPTAR invitación pendiente identificando al usuario por su celular (en vez de por un token
// de link). Reutiliza la misma lógica que /aceptar/:token: crea o actualiza el usuario con
// contraseña, lo vincula a la empresa/área, y completa cualquier proyecto_equipo pendiente.
router.post('/aceptar-por-celular', async (req, res) => {
  const client = await pool.connect();
  try {
    const { celular, contraseña } = req.body;
    if (!celular) {
      return res.status(400).json({ error: 'celular es obligatorio' });
    }
    if (!contraseña || contraseña.length < 6) {
      return res.status(400).json({ error: 'Debes crear una contraseña de al menos 6 caracteres' });
    }

    const invResult = await client.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.celular_invitado = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [celular]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tienes ninguna invitación pendiente con este número' });
    }

    const invitacion = invResult.rows[0];

    await client.query('BEGIN');

    let usuarioResult = await client.query('SELECT * FROM usuarios WHERE celular = $1', [invitacion.celular_invitado]);
    let usuario;

    if (usuarioResult.rows.length > 0) {
      usuario = usuarioResult.rows[0];
      if (!usuario.contraseña_hash) {
        const hash = await bcrypt.hash(contraseña, 10);
        const actualizado = await client.query(
          'UPDATE usuarios SET contraseña_hash = $1 WHERE id = $2 RETURNING *',
          [hash, usuario.id]
        );
        usuario = actualizado.rows[0];
      } else {
        // Ya tenía cuenta y contraseña de antes (por ejemplo, ya trabaja en otra empresa) y ahora
        // está aceptando una invitación NUEVA a otra empresa distinta. La pantalla le pide
        // "crear" una contraseña otra vez, pero como el usuario ya existe, esa contraseña debe
        // coincidir con la que ya tiene — si no, validamos por seguridad: sin este chequeo,
        // alguien podría escribir cualquier cosa pensando que "crea" una contraseña nueva, y en
        // realidad entraría con la vieja sin darse cuenta de que no coincide.
        const coincide = await bcrypt.compare(contraseña, usuario.contraseña_hash);
        if (!coincide) {
          await client.query('ROLLBACK');
          return res.status(401).json({ error: 'Ya tienes una cuenta con este número. Escribe tu contraseña actual (la misma que usas para tus otras empresas).' });
        }
      }
    } else {
      const contraseñaHash = await bcrypt.hash(contraseña, 10);
      const nuevoUsuario = await client.query(
        'INSERT INTO usuarios (celular, nombre, contraseña_hash) VALUES ($1, $2, $3) RETURNING *',
        [invitacion.celular_invitado, invitacion.nombre_invitado, contraseñaHash]
      );
      usuario = nuevoUsuario.rows[0];
    }

    await client.query(
      'INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, area_id, estado) VALUES ($1, $2, $3, $4)',
      [usuario.id, invitacion.empresa_id, invitacion.area_id, 'activo']
    );

    await client.query(
      'UPDATE proyecto_equipo SET usuario_id = $1, invitacion_id = NULL WHERE invitacion_id = $2',
      [usuario.id, invitacion.id]
    );

    await client.query('UPDATE invitaciones SET usado = TRUE WHERE id = $1', [invitacion.id]);

    await client.query('COMMIT');

    delete usuario.contraseña_hash;

    const rolesResult = await client.query(
      `SELECT uer.empresa_id, e.nombre AS empresa_nombre, e.logo_url, e.color_hex, e.sitio_web,
              e.nit, e.cedula_representante, e.banco_nombre, e.banco_tipo_cuenta, e.banco_numero, e.banco_titular,
              a.id AS area_id, a.nombre AS area_nombre, a.tipo AS area_tipo
       FROM usuario_empresa_rol uer
       JOIN empresas e ON e.id = uer.empresa_id
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.estado = 'activo' AND e.estado = 'activo'`,
      [usuario.id]
    );

    // Token de sesión (2026-08-25, Paso 1 de la migración a autenticación real): esta ruta
    // literalmente loguea a la persona por primera vez (o de nuevo), así que emite token igual
    // que /api/auth/login — ver middleware/auth.js.
    const token = generarToken(usuario);

    res.json({
      mensaje: 'Invitación aceptada, usuario vinculado exitosamente',
      usuario,
      empresas: rolesResult.rows,
      token,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error aceptando invitación por celular:', error);
    res.status(500).json({ error: 'Error al aceptar la invitación' });
  } finally {
    client.release();
  }
});

// 🔑 RECUPERAR CONTRASEÑA: sin SMS ni servicios externos. Valida identidad pidiendo el celular +
// el nombre exacto con el que esa persona quedó registrada en la base de datos (el mismo que
// aparece en Grupo de Trabajo), y si coincide, le permite crear una contraseña nueva que
// reemplaza a la anterior. Menos seguro que un código por SMS, pero no depende de contratar un
// proveedor externo ni tiene costo por mensaje.
router.post('/recuperar-contraseña', async (req, res) => {
  try {
    const { celular, nombre, contraseña_nueva } = req.body;
    if (!celular || !nombre || !contraseña_nueva) {
      return res.status(400).json({ error: 'celular, nombre y contraseña_nueva son obligatorios' });
    }
    if (contraseña_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const usuarioResult = await pool.query('SELECT * FROM usuarios WHERE celular = $1', [celular]);
    if (usuarioResult.rows.length === 0) {
      return res.status(404).json({ error: 'No existe ningún usuario con este número de celular' });
    }
    const usuario = usuarioResult.rows[0];

    const nombreCoincide = textoNormalizado(usuario.nombre) === textoNormalizado(nombre);
    if (!nombreCoincide) {
      return res.status(401).json({ error: 'El nombre no coincide con el registrado para este celular. Verifica que esté escrito igual que en Grupo de Trabajo.' });
    }

    const hash = await bcrypt.hash(contraseña_nueva, 10);
    await pool.query('UPDATE usuarios SET contraseña_hash = $1 WHERE id = $2', [hash, usuario.id]);

    res.json({ mensaje: 'Contraseña actualizada exitosamente. Ya puedes ingresar con tu contraseña nueva.' });
  } catch (error) {
    console.error('Error recuperando contraseña:', error);
    res.status(500).json({ error: 'No se pudo actualizar la contraseña. Intenta de nuevo.' });
  }
});

// 👁️ LISTAR invitaciones pendientes de una empresa
router.get('/pendientes/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const result = await pool.query(
      `SELECT i.*, a.nombre AS area_nombre
       FROM invitaciones i
       JOIN areas_catalogo a ON a.id = i.area_id
       WHERE i.empresa_id = $1 AND i.usado = FALSE
       ORDER BY i.created_at DESC`,
      [empresa_id]
    );
    res.json({ total: result.rows.length, invitaciones: result.rows });
  } catch (error) {
    console.error('Error listando invitaciones pendientes:', error);
    res.status(500).json({ error: 'Error al listar invitaciones pendientes' });
  }
});

// ✏️ EDITAR una invitación pendiente (nombre, celular, área)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_invitado, celular_invitado, area_id } = req.body;

    if (!nombre_invitado || !celular_invitado || !area_id) {
      return res.status(400).json({ error: 'nombre_invitado, celular_invitado y area_id son obligatorios' });
    }

    const result = await pool.query(
      `UPDATE invitaciones
       SET nombre_invitado = $1, celular_invitado = $2, area_id = $3
       WHERE id = $4 AND usado = FALSE
       RETURNING *`,
      [nombre_invitado, celular_invitado, area_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación pendiente no encontrada (puede que ya haya sido aceptada)' });
    }

    res.json({ mensaje: 'Invitación actualizada exitosamente', invitacion: result.rows[0] });
  } catch (error) {
    console.error('Error editando invitación:', error);
    res.status(500).json({ error: 'Error al editar invitación' });
  }
});

// 🗑️ ELIMINAR una invitación pendiente por completo
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM invitaciones WHERE id = $1 AND usado = FALSE RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitación pendiente no encontrada (puede que ya haya sido aceptada)' });
    }

    res.json({ mensaje: 'Invitación eliminada exitosamente' });
  } catch (error) {
    console.error('Error eliminando invitación:', error);
    res.status(500).json({ error: 'Error al eliminar invitación' });
  }
});

module.exports = router;