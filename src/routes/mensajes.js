const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { borrarArchivoDeStorage } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Envía una notificación push a través del servicio gratuito de Expo. No requiere configurar
// Firebase aparte: Expo se encarga de entregarla en Android e iOS usando el "push token" que
// cada celular genera y guarda en la tabla usuarios (columna push_token).
async function enviarPush(pushToken, titulo, cuerpo, data) {
  if (!pushToken) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        sound: 'default',
        title: titulo,
        body: cuerpo,
        data: data || {},
      }),
    });
  } catch (error) {
    console.error('Error enviando notificación push:', error);
  }
}

// 📝 ENVIAR mensaje en el chat individual de una persona, dentro de un área y un proyecto
router.post('/enviar', async (req, res) => {
  try {
    const { proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido, archivo } = req.body;

    // El mensaje puede ir solo con archivo adjunto (sin texto), como en WhatsApp.
    if (!proyecto_id || !area_id || !usuario_id || !destinatario_usuario_id || (!contenido && !archivo)) {
      return res.status(400).json({ error: 'proyecto_id, area_id, usuario_id, destinatario_usuario_id y (contenido o archivo) son obligatorios' });
    }

    // Guardamos el nombre del remitente tal como es HOY como respaldo (remitente_nombre_snapshot):
    // si esa persona es eliminada de la plataforma más adelante, el chat sigue mostrando su
    // nombre en vez de romperse — ver el SELECT más abajo, que usa LEFT JOIN + COALESCE.
    const remitenteActual = await pool.query('SELECT nombre FROM usuarios WHERE id = $1', [usuario_id]);
    const nombreRemitenteActual = remitenteActual.rows[0]?.nombre || null;

    const result = await pool.query(
      'INSERT INTO mensajes (proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido, remitente_nombre_snapshot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [proyecto_id, area_id, usuario_id, destinatario_usuario_id, contenido || '', nombreRemitenteActual]
    );

    // Si el mensaje viene con un archivo (foto/documento), lo guardamos vinculado a este mensaje.
    if (archivo?.url_archivo) {
      await pool.query(
        'INSERT INTO archivos (mensaje_id, usuario_id, nombre_archivo, url_archivo, tipo_archivo) VALUES ($1, $2, $3, $4, $5)',
        [result.rows[0].id, usuario_id, archivo.nombre_archivo || null, archivo.url_archivo, archivo.tipo_archivo || null]
      );
    }

    // Avisamos al destinatario con una notificación push, si tiene un dispositivo registrado.
    const [remitente, destinatario, proyecto, areaCatalogo] = await Promise.all([
      pool.query('SELECT nombre FROM usuarios WHERE id = $1', [usuario_id]),
      pool.query('SELECT push_token FROM usuarios WHERE id = $1', [destinatario_usuario_id]),
      pool.query('SELECT id, nombre, empresa_id FROM proyectos WHERE id = $1', [proyecto_id]),
      pool.query('SELECT nombre FROM areas_catalogo WHERE id = $1', [area_id]),
    ]);
    const pushToken = destinatario.rows[0]?.push_token;
    if (pushToken) {
      const nombreRemitente = remitente.rows[0]?.nombre || 'Alguien';
      const proyectoRow = proyecto.rows[0] || {};
      enviarPush(
        pushToken,
        nombreRemitente,
        contenido || '📎 Envió un archivo',
        {
          tipo: 'mensaje',
          proyecto_id,
          proyecto_nombre: proyectoRow.nombre || '',
          empresa_id: proyectoRow.empresa_id || null,
          area_id,
          area_nombre: areaCatalogo.rows[0]?.nombre || '',
          remitente_usuario_id: usuario_id,
        }
      );
    }

    res.status(201).json({ mensaje: 'Mensaje enviado exitosamente', data: result.rows[0] });
  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// 👁️ VER la conversación individual con una persona específica, dentro de un área y proyecto
//
// "mi_usuario_id" (query param obligatorio): el usuario_id de quien está pidiendo el chat (el
// que está mirando la pantalla). ANTES este endpoint solo filtraba por destinatario_usuario_id
// = el OTRO participante, sin comparar nunca contra quién soy yo — eso traía "todos los mensajes
// dirigidos a esa persona", no "la conversación entre nosotros dos". El resultado real: cada
// quien solo veía los mensajes que ÉL MISMO había enviado (porque casi siempre coincidía con ser
// el remitente de los mensajes "dirigidos al otro" en su propia consulta), y nunca las
// respuestas — el chat parecía "no recibir nada" en ambos sentidos. El WHERE correcto ya existía
// en vaciarChat() más abajo en este mismo archivo; aquí faltaba aplicar el mismo patrón simétrico.
router.get('/:proyecto_id/:area_id/:destinatario_usuario_id', async (req, res) => {
  try {
    const { proyecto_id, area_id, destinatario_usuario_id } = req.params;
    const { mi_usuario_id } = req.query;

    if (!mi_usuario_id) {
      return res.status(400).json({ error: 'mi_usuario_id es obligatorio' });
    }

    // LEFT JOIN (no INNER JOIN) a propósito: si el remitente fue eliminado de la plataforma por
    // completo, u.id es NULL pero el mensaje se sigue mostrando — COALESCE usa el nombre actual
    // de la cuenta si todavía existe, o el snapshot guardado al momento de enviarlo si no.
    const result = await pool.query(
      `SELECT m.id, m.contenido, m.created_at, m.usuario_id,
              COALESCE(u.nombre, m.remitente_nombre_snapshot, 'Usuario eliminado') AS usuario_nombre
       FROM mensajes m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.proyecto_id = $1 AND m.area_id = $2
         AND ((m.usuario_id = $3::int AND m.destinatario_usuario_id = $4::int)
           OR (m.usuario_id = $4::int AND m.destinatario_usuario_id = $3::int))
       ORDER BY m.created_at ASC`,
      [proyecto_id, area_id, mi_usuario_id, destinatario_usuario_id]
    );

    // Traemos los archivos adjuntos de todos estos mensajes en una sola consulta y los
    // agrupamos por mensaje_id, para no hacer una consulta extra por cada mensaje.
    const idsMensajes = result.rows.map((m) => m.id);
    let archivosPorMensaje = {};
    if (idsMensajes.length > 0) {
      const archivosResult = await pool.query(
        'SELECT * FROM archivos WHERE mensaje_id = ANY($1::int[]) ORDER BY created_at ASC',
        [idsMensajes]
      );
      archivosPorMensaje = archivosResult.rows.reduce((acc, archivo) => {
        (acc[archivo.mensaje_id] = acc[archivo.mensaje_id] || []).push(archivo);
        return acc;
      }, {});
    }

    const mensajesConArchivos = result.rows.map((m) => ({
      ...m,
      archivos: archivosPorMensaje[m.id] || [],
    }));

    res.json({ total: mensajesConArchivos.length, mensajes: mensajesConArchivos });
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

// 🗑️ ELIMINAR un mensaje: borra la fila, sus archivos adjuntos reales en Firebase Storage (si
// tenía foto/documento/nota de voz) y las filas de la tabla archivos, para no dejar nada
// huérfano. Solo el usuario que lo envió puede eliminarlo (recibimos su usuario_id y lo
// comparamos contra el dueño real del mensaje, no confiamos en lo que mande el frontend).
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id } = req.body;

    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id es obligatorio' });
    }

    const mensajeResult = await pool.query('SELECT * FROM mensajes WHERE id = $1', [id]);
    if (mensajeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }

    const mensaje = mensajeResult.rows[0];
    if (mensaje.usuario_id !== Number(usuario_id)) {
      return res.status(403).json({ error: 'Solo quien envió el mensaje puede eliminarlo' });
    }

    const archivosResult = await pool.query('SELECT * FROM archivos WHERE mensaje_id = $1', [id]);

    // Se borran primero los archivos reales en Storage (fuera de la base de datos), y solo
    // después las filas — si algo falla borrando de Storage, mejor que sobre un registro en la
    // base de datos a que quede un archivo real huérfano sin ninguna referencia en ningún lado.
    for (const archivo of archivosResult.rows) {
      await borrarArchivoDeStorage(archivo.url_archivo);
    }

    await pool.query('DELETE FROM archivos WHERE mensaje_id = $1', [id]);
    await pool.query('DELETE FROM mensajes WHERE id = $1', [id]);

    res.json({ mensaje: 'Mensaje eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando mensaje:', error);
    res.status(500).json({ error: 'Error al eliminar el mensaje' });
  }
});

// Vacía COMPLETAMENTE el chat individual entre dos personas dentro de un proyecto+área: borra
// todos los mensajes en ambos sentidos (sin importar quién envió cada uno) y todos sus archivos
// adjuntos reales en Firebase Storage. Se exporta como función aparte (no solo como ruta HTTP)
// para poder reutilizarla desde proyectos_v2.js cuando se elimina a alguien del proyecto por
// completo — ahí también hay que vaciar el chat, y así no se duplica la lógica de borrado.
async function vaciarChat(client, proyecto_id, area_id, usuario_a, usuario_b) {
  const mensajesResult = await client.query(
    `SELECT id FROM mensajes
     WHERE proyecto_id = $1 AND area_id = $2
       AND ((usuario_id = $3 AND destinatario_usuario_id = $4) OR (usuario_id = $4 AND destinatario_usuario_id = $3))`,
    [proyecto_id, area_id, usuario_a, usuario_b]
  );
  const idsMensajes = mensajesResult.rows.map((m) => m.id);
  if (idsMensajes.length === 0) return;

  const archivosResult = await client.query('SELECT * FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
  for (const archivo of archivosResult.rows) {
    await borrarArchivoDeStorage(archivo.url_archivo).catch((error) => {
      console.error('Error borrando archivo de Storage al vaciar chat:', error.message);
    });
  }

  await client.query('DELETE FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
  await client.query('DELETE FROM mensajes WHERE id = ANY($1::int[])', [idsMensajes]);
}

// 🗑️ VACIAR chat completo con una persona, dentro de un proyecto y área (endpoint HTTP, usado
// desde el menú de long-press en el equipo del proyecto — "Eliminar chat"). Cualquiera de los
// dos participantes del chat puede vaciarlo, a diferencia de eliminar un solo mensaje (que solo
// puede hacerlo quien lo envió).
router.delete('/vaciar/:proyecto_id/:area_id/:usuario_a/:usuario_b', async (req, res) => {
  const client = await pool.connect();
  try {
    const { proyecto_id, area_id, usuario_a, usuario_b } = req.params;
    await client.query('BEGIN');
    await vaciarChat(client, proyecto_id, area_id, usuario_a, usuario_b);
    await client.query('COMMIT');
    res.json({ mensaje: 'Chat vaciado exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error vaciando chat:', error);
    res.status(500).json({ error: 'Error al vaciar el chat' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.vaciarChat = vaciarChat;