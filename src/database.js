const { Pool } = require('pg');
require('dotenv').config();

// Conexión a PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

// Crear tablas
const createTables = async () => {
  try {
    // Tabla de Usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        contraseña VARCHAR(255) NOT NULL,
        rol VARCHAR(50) NOT NULL,
        telefono VARCHAR(20),
        activo BOOLEAN DEFAULT true,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla de Proyectos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proyectos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        direccion VARCHAR(255),
        cliente_id INTEGER REFERENCES usuarios(id),
        area_m2 DECIMAL(10, 2),
        estado VARCHAR(50) DEFAULT 'activo',
        fecha_inicio DATE,
        fecha_estimada_fin DATE,
        descripcion TEXT,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla de Cotizaciones
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizaciones (
        id SERIAL PRIMARY KEY,
        proyecto_id INTEGER REFERENCES proyectos(id),
        titulo VARCHAR(255),
        descripcion TEXT,
        total DECIMAL(15, 2),
        estado VARCHAR(50) DEFAULT 'borrador',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_envio TIMESTAMP
      );
    `);

    // Tabla de Items de Cotización
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizacion_items (
        id SERIAL PRIMARY KEY,
        cotizacion_id INTEGER REFERENCES cotizaciones(id),
        descripcion VARCHAR(255),
        cantidad DECIMAL(10, 2),
        unidad VARCHAR(50),
        valor_unitario DECIMAL(10, 2),
        valor_total DECIMAL(15, 2)
      );
    `);

    // Tabla de Áreas de Trabajo
    await pool.query(`
      CREATE TABLE IF NOT EXISTS areas_trabajo (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        descripcion TEXT
      );
    `);

    // Tabla de Asignaciones (Qué técnico trabaja en qué proyecto)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asignaciones (
        id SERIAL PRIMARY KEY,
        proyecto_id INTEGER REFERENCES proyectos(id),
        usuario_id INTEGER REFERENCES usuarios(id),
        area_id INTEGER REFERENCES areas_trabajo(id),
        fecha_asignacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        estado VARCHAR(50) DEFAULT 'activo'
      );
    `);

    // Tabla de Mensajes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensajes (
        id SERIAL PRIMARY KEY,
        proyecto_id INTEGER REFERENCES proyectos(id),
        usuario_id INTEGER REFERENCES usuarios(id),
        area_id INTEGER REFERENCES areas_trabajo(id),
        contenido TEXT,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla de Archivos Compartidos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS archivos (
        id SERIAL PRIMARY KEY,
        proyecto_id INTEGER REFERENCES proyectos(id),
        mensaje_id INTEGER REFERENCES mensajes(id),
        nombre_archivo VARCHAR(255),
        url_archivo VARCHAR(255),
        tipo_archivo VARCHAR(50),
        fecha_subida TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✓ Todas las tablas creadas correctamente');
    pool.end();
  } catch (error) {
    console.error('✗ Error creando tablas:', error);
    pool.end();
  }
};

// Ejecutar
createTables();