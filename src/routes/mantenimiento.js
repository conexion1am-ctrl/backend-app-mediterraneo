// Este archivo contuvo endpoints temporales de un solo uso para mantenimiento manual de la base
// de datos (vaciado completo el 2026-08-24, siembra de areas_catalogo el mismo día tras el
// vaciado accidental de esa tabla). Ambos ya se usaron y quedaron deshabilitados. La siembra de
// areas_catalogo ahora es automática y permanente: ver migraciones.js.
//
// Uso #3 (2026-08-24): limpiar asignaciones duplicadas en proyecto_equipo, causadas por un bug
// ya corregido en proyectos_v2.js (POST /:id/equipo/asignar no validaba si la persona ya estaba
// asignada, así que tocar "Asignar" varias veces creaba una fila nueva cada vez — esto hacía que
// la misma persona apareciera 2 o 3 veces en el equipo del proyecto, y rompía el chat porque cada
// fila duplicada apuntaba a la misma persona real). Este endpoint consolida los duplicados que ya
// existían ANTES del fix, dejando solo la asignación más antigua de cada persona por proyecto y
// borrando las filas sobrantes (sin tocar mensajes ni archivos, que no dependen de proyecto_equipo).
const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CLAVE_LIMPIEZA = 'LIMPIAR-DUPLICADOS-EQUIPO-2026';

router.post('/limpiar-duplicados-equipo', async (req, res) => {
  try {
    const { clave } = req.body;
    if (clave !== CLAVE_LIMPIEZA) {
      return res.status(403).json({ error: 'Clave incorrecta' });
    }

    // Encuentra grupos de filas duplicadas: misma persona (usuario_id, o invitacion_id si aún no
    // tiene usuario_id), mismo proyecto. Nos quedamos con la fila de menor id (la más antigua =
    // la asignación original) y marcamos el resto para borrar.
    const duplicados = await pool.query(`
      SELECT proyecto_id,
             COALESCE(usuario_id::text, 'inv-' || invitacion_id::text) AS persona,
             array_agg(id ORDER BY id ASC) AS ids
      FROM proyecto_equipo
      WHERE usuario_id IS NOT NULL OR invitacion_id IS NOT NULL
      GROUP BY proyecto_id, COALESCE(usuario_id::text, 'inv-' || invitacion_id::text)
      HAVING COUNT(*) > 1
    `);

    let filasEliminadas = 0;
    const detalle = [];

    for (const grupo of duplicados.rows) {
      const [idConservar, ...idsBorrar] = grupo.ids;
      if (idsBorrar.length > 0) {
        await pool.query('DELETE FROM proyecto_equipo WHERE id = ANY($1::int[])', [idsBorrar]);
        filasEliminadas += idsBorrar.length;
        detalle.push({
          proyecto_id: grupo.proyecto_id,
          persona: grupo.persona,
          asignacion_conservada: idConservar,
          asignaciones_borradas: idsBorrar,
        });
      }
    }

    res.json({
      mensaje: `Limpieza completa: ${filasEliminadas} asignaciones duplicadas eliminadas`,
      gruposAfectados: detalle.length,
      filasEliminadas,
      detalle,
    });
  } catch (error) {
    console.error('Error limpiando duplicados de equipo:', error);
    res.status(500).json({ error: 'Error al limpiar duplicados' });
  }
});

module.exports = router;
