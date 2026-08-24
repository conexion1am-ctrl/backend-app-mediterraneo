const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
require('dotenv').config();
const { bucket } = require('../utils/firebaseAdmin');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ⚠️ RUTA TEMPORAL DE UN SOLO USO ⚠️
// Vacía TODA la base de datos (todas las empresas, usuarios, proyectos, cotizaciones,
// contratos, mensajes, fotos, planos 3D, etc.) y borra también todos los archivos reales en
// Firebase Storage, dejando la app exactamente como si se acabara de instalar por primera vez.
// Pedida por Alejo para limpiar datos de prueba acumulados (incluida una empresa "fantasma"
// que no se podía eliminar desde la app) antes de empezar pruebas desde cero.
//
// Protegida con una clave simple (no es una clave de verdad, solo evita que alguien la dispare
// por accidente si algún día alguien más conoce la URL del backend). Está pensada para
// eliminarse del código apenas se use una vez — ver instrucciones que se le dieron al usuario.
router.post('/vaciar-todo', async (req, res) => {
  try {
    const { clave } = req.body;
    if (clave !== 'BORRAR-TODO-MEDITERRANEO-2026') {
      return res.status(403).json({ error: 'Clave incorrecta' });
    }

    // 1. Borrar archivos reales de Firebase Storage (fotos de avance, planos 3D, PDFs, adjuntos
    // de chat, ARL, logos). Si Firebase Admin no está configurado, se salta este paso sin
    // fallar el resto (mismo criterio que borrarArchivoDeStorage en el resto del backend).
    let archivosStorageBorrados = 0;
    if (bucket) {
      try {
        const [archivos] = await bucket.getFiles();
        for (const archivo of archivos) {
          await archivo.delete().catch(() => {});
          archivosStorageBorrados++;
        }
      } catch (error) {
        console.error('Error borrando archivos de Storage (continuando con la base de datos):', error.message);
      }
    }

    // 2. Vaciar todas las tablas. TRUNCATE ... CASCADE ignora el orden de llaves foráneas (a
    // diferencia de DELETE, que exigiría borrar en el orden exacto de dependencias) y
    // RESTART IDENTITY reinicia los contadores SERIAL (los ids vuelven a empezar en 1).
    const tablas = [
      'mensajes',
      'archivos',
      'fotos_avance',
      'planos_3d',
      'movimientos_costos',
      'categorias_costo',
      'abonos_proyecto',
      'estadisticas_proyecto',
      'proyecto_equipo',
      'proyecto_actividades',
      'proyectos',
      'contratos',
      'cotizacion_items',
      'cotizaciones',
      'clientes',
      'invitaciones',
      'usuario_empresa_rol',
      'usuarios',
      'empresas',
      'areas_catalogo',
    ];

    for (const tabla of tablas) {
      await pool.query(`TRUNCATE TABLE ${tabla} RESTART IDENTITY CASCADE`).catch((error) => {
        // Si una tabla no existe en este entorno, no detenemos el resto (por ejemplo si el
        // esquema real tiene menos o más tablas de las que aquí asumimos).
        console.error(`Aviso: no se pudo vaciar la tabla "${tabla}":`, error.message);
      });
    }

    res.json({
      mensaje: 'Base de datos vaciada por completo. La app queda como recién instalada.',
      archivosStorageBorrados,
    });
  } catch (error) {
    console.error('Error vaciando la base de datos:', error);
    res.status(500).json({ error: 'Error al vaciar la base de datos' });
  }
});

module.exports = router;
