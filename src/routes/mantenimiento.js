// Este archivo contenía un endpoint temporal de un solo uso (POST /vaciar-todo) para vaciar por
// completo la base de datos en la nube y limpiar archivos de Storage, usado una única vez el
// 2026-08-24 para eliminar datos de prueba acumulados antes de empezar pruebas desde cero.
// Ya se usó y quedó deshabilitado (ya no está registrado en server.js). Se deja este archivo
// vacío en el repo en vez de borrarlo, para no perder el historial de por qué existió.
module.exports = require('express').Router();
