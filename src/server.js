const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const setupDatabase = require('./setup');
const aplicarMigraciones = require('./migraciones');

const app = express();

setupDatabase();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Importar rutas
const proyectosRoutes = require('./routes/proyectos_v2');
const empresasRoutes = require('./routes/empresas');
const invitacionesRoutes = require('./routes/invitaciones');
const mensajesRoutes = require('./routes/mensajes');
const clientesRoutes = require('./routes/clientes');
const cotizacionesRoutes = require('./routes/cotizaciones_v2');
const estadisticasRoutes = require('./routes/estadisticas');
const areasRoutes = require('./routes/areas');
const authRoutes = require('./routes/auth');
const fotosAvanceRoutes = require('./routes/fotos_avance');
const planos3dRoutes = require('./routes/planos3d');
// Temporal (2026-08-24): endpoint de un solo uso para limpiar asignaciones duplicadas en
// proyecto_equipo, causadas por un bug ya corregido. Quitar este require Y la línea app.use de
// abajo juntos, en el mismo commit, cuando ya no se necesite — ver comentario en mantenimiento.js.
const mantenimientoRoutes = require('./routes/mantenimiento');
const { verificarTokenModoObservacion } = require('./middleware/auth');

// Paso 3 de la migración a autenticación real (2026-08-25): validamos el token en TODAS las
// rutas /api/*, pero en "modo observación" — si falta o es inválido, NO se bloquea la request,
// solo se registra en el log del servidor (ver middleware/auth.js). Esto es deliberadamente
// amplio (incluye login/registro, donde todavía no hay token) porque en observación nunca
// corta nada: solo sirve para medir, con tráfico real, qué porcentaje de requests ya llegan con
// token antes de pasar al Paso 4 (verificarToken estricto, que si bloqueará). Cuando ese
// porcentaje sea prácticamente el 100% (o solo falten rutas públicas esperadas como login),
// se reemplaza esta línea por la versión estricta.
app.use('/api', verificarTokenModoObservacion);

// Usar rutas
app.use('/api/proyectos', proyectosRoutes);
app.use('/api/empresas', empresasRoutes);
app.use('/api/invitaciones', invitacionesRoutes);
app.use('/api/mensajes', mensajesRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/cotizaciones', cotizacionesRoutes);
app.use('/api/estadisticas', estadisticasRoutes);
app.use('/api/areas', areasRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/fotos-avance', fotosAvanceRoutes);
app.use('/api/planos-3d', planos3dRoutes);
app.use('/api/mantenimiento', mantenimientoRoutes);


// Rutas básicas
app.get('/api/health', (req, res) => {
  res.json({ message: 'Servidor funcionando correctamente', timestamp: new Date() });
});

// Iniciar servidor. Esperamos a que las migraciones terminen ANTES de aceptar tráfico HTTP: antes
// "aplicarMigraciones()" se llamaba sin esperar su resultado, así que el servidor podía empezar a
// responder requests mientras las migraciones (varios ALTER TABLE secuenciales) seguían corriendo
// en segundo plano — en el primer arranque tras un cambio de esquema, una petición que llegara en
// esa ventana podía fallar contra columnas/constraints que todavía no existían.
const PORT = process.env.PORT || 5000;
aplicarMigraciones()
  .catch((error) => {
    // No tumbamos el servidor si esto falla: preferimos que la app siga funcionando con el
    // esquema anterior a que un problema de migración deje todo caído (mismo criterio usado
    // dentro de aplicarMigraciones para sus propios errores internos).
    console.error('❌ Error inesperado esperando migraciones:', error.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`✓ Servidor ejecutándose en puerto ${PORT}`);
    });
  });