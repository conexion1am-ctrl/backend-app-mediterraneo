// Este archivo contuvo endpoints temporales de un solo uso para mantenimiento manual de la base
// de datos (vaciado completo el 2026-08-24, siembra de areas_catalogo el mismo día tras el
// vaciado accidental de esa tabla). Ambos ya se usaron y quedaron deshabilitados. La siembra de
// areas_catalogo ahora es automática y permanente: ver migraciones.js (corre en cada arranque
// del servidor, solo si la tabla está vacía). Se deja este archivo vacío en el repo en vez de
// borrarlo, para no perder el historial de por qué existió.
module.exports = require('express').Router();
