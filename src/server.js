const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const setupDatabase = require('./setup');

const app = express();

setupDatabase();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Importar rutas
const proyectosRoutes = require('./routes/proyectos');

// Usar rutas
app.use('/api/proyectos', proyectosRoutes);
const cotizacionesRoutes = require('./routes/cotizaciones');
app.use('/api/cotizaciones', cotizacionesRoutes);

// Rutas básicas
app.get('/api/health', (req, res) => {
  res.json({ message: 'Servidor funcionando correctamente', timestamp: new Date() });
});

// Iniciar servidor
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✓ Servidor ejecutándose en puerto ${PORT}`);
  console.log(`✓ Base de datos: ${process.env.DB_NAME}`);
});