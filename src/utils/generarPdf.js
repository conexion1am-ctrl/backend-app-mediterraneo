// Genera el PDF de cotización/contrato en el servidor (Node), para que quede guardado
// automáticamente en Firebase Storage sin depender de que alguien abra la app.
//
// La cotización usa un formato de "carta" simple. El contrato usa un formato de contrato de
// obra legal completo (cláusulas fijas + tabla de ítems + condiciones de pago + firmas),
// igual al modelo real que usa la empresa.

const formatearMoneda = (valor) => {
  const numero = parseFloat(valor) || 0;
  return numero.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
};

// La columna "cantidad" es DECIMAL en la base de datos, así que pg siempre la devuelve como
// string con dos decimales (ej. "1.00", "2.50") aunque el usuario haya escrito un número entero.
// La app NO maneja decimales salvo que el usuario mismo los escriba a propósito (2026-08-26, a
// pedido del usuario) — así que si la cantidad es un entero, se muestra sin ".00"; si de verdad
// tiene decimales (ej. 2.5 metros), se respetan tal cual.
const formatearCantidad = (valor) => {
  if (valor == null || valor === '') return '';
  const numero = parseFloat(valor);
  if (Number.isNaN(numero)) return valor;
  return String(numero); // parseFloat+String ya quita los ceros de relleno: "1.00" -> "1", "2.50" -> "2.5"
};

// Convierte un número entero (pesos colombianos) a su forma en letras, en español, para el
// bloque "Segunda - Precio" del contrato: "$87.500.000 (Ochenta y siete millones quinientos mil
// pesos colombianos)". Cubre el rango que puede necesitar un contrato de obra (hasta miles de
// millones); no pretende ser un conversor genérico de propósito general.
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const DIEZ_A_DIECINUEVE = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
// 20-29 en español van pegados ("veintiuno", "veintidós"...), a diferencia de 30 en adelante
// ("treinta y uno", "cuarenta y dos"...) que van separados con "y".
const VEINTIALGO = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function trescientosALetras(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let texto = '';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) texto += CENTENAS[c];
  if (resto > 0) {
    if (texto) texto += ' ';
    if (resto < 10) {
      texto += UNIDADES[resto];
    } else if (resto < 20) {
      texto += DIEZ_A_DIECINUEVE[resto - 10];
    } else if (resto < 30) {
      texto += VEINTIALGO[resto - 20];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      texto += DECENAS[d];
      if (u > 0) texto += ` y ${UNIDADES[u]}`;
    }
  }
  return texto;
}

// La forma apocopada "un/veintiún" (sin la "o" final) se usa cuando "uno" antecede directamente
// a un sustantivo masculino como "millones" o "mil" (ej. "veintiún millones", "treinta y un
// millones" — nunca "veintiuno millones" ni "treinta y uno millones"). Cubre tanto "uno" pegado
// (veintiuno → veintiún) como "y uno" separado (treinta y uno → treinta y un).
function conApocope(n) {
  const texto = trescientosALetras(n);
  if (n % 10 !== 1 || n === 1) return texto;
  return texto.endsWith('y uno') ? texto.replace(/y uno$/, 'y un') : texto.replace(/uno$/, 'ún');
}

// trescientosALetras/conApocope solo saben convertir bloques de 0-999. Los "millones" pueden
// superar 999 en montos de mil millones de pesos o más (poco común en un contrato de obra, pero
// posible), lo que antes rompía la función y llegaba a imprimir "Undefined" en el PDF del
// contrato. Esta función descompone CUALQUIER cantidad de millones en sus propios "miles de
// millones" + "millones" antes de convertirlos, igual que ya se hace con miles/centenas.
function bloqueDeMillonesALetras(millones) {
  if (millones < 1000) return conApocope(millones);
  const milesDeMillones = Math.floor(millones / 1000);
  const restoMillones = millones % 1000;
  const partes = [];
  partes.push(milesDeMillones === 1 ? 'mil' : `${conApocope(milesDeMillones)} mil`);
  if (restoMillones > 0) partes.push(conApocope(restoMillones));
  return partes.join(' ');
}

function numeroALetras(valor) {
  let n = Math.round(Math.abs(parseFloat(valor) || 0));
  if (n === 0) return 'cero pesos colombianos';

  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const centenas = n % 1000;

  const partes = [];
  if (millones > 0) {
    partes.push(millones === 1 ? 'un millón' : `${bloqueDeMillonesALetras(millones)} millones`);
  }
  if (miles > 0) {
    partes.push(miles === 1 ? 'mil' : `${conApocope(miles)} mil`);
  }
  if (centenas > 0) {
    partes.push(trescientosALetras(centenas));
  }

  let texto = partes.join(' ').trim();
  texto = texto.charAt(0).toUpperCase() + texto.slice(1);
  // "de pesos" solo aplica cuando el número es un múltiplo exacto de un millón (ej. "dos
  // millones de pesos"); si hay miles o centenas de por medio no lleva "de" (ej. "un millón
  // quinientos mil pesos", como en el ejemplo real del usuario: "ochenta y siete millones
  // quinientos mil pesos colombianos").
  const conector = millones > 0 && miles === 0 && centenas === 0 ? ' de' : '';
  return `${texto}${conector} pesos colombianos`;
}

const formatearFechaDdMmAa = (fecha) => {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = String(d.getUTCFullYear()).slice(-2);
  return `${dia}-${mes}-${anio}`;
};

const formatearFechaLarga = (fecha) => {
  if (!fecha) return '';
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const d = new Date(fecha);
  return `${d.getUTCDate()} de ${meses[d.getUTCMonth()]} del año ${d.getUTCFullYear()}`;
};

// Agrupa los ítems por su campo "seccion". Los que no tienen sección van en un grupo sin
// título, al final. Devuelve una lista de { nombre, items, subtotal }.
function agruparPorSeccion(items) {
  const grupos = [];
  const indicePorNombre = {};
  (items || []).forEach((item) => {
    const nombre = (item.seccion || '').trim();
    const clave = nombre || '__sin_seccion__';
    if (indicePorNombre[clave] === undefined) {
      indicePorNombre[clave] = grupos.length;
      grupos.push({ nombre, items: [] });
    }
    grupos[indicePorNombre[clave]].items.push(item);
  });
  return grupos.map((g) => ({
    ...g,
    subtotal: g.items.reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0),
  }));
}

// condicionesPago: array de { porcentaje, descripcion }. Se muestra como lista con viñetas,
// sin recuadros ni tabla, tal como se definió: "25% — descripción".
function listaCondicionesPago(condicionesPago) {
  if (!Array.isArray(condicionesPago) || condicionesPago.length === 0) return '';
  const filas = condicionesPago
    .filter((c) => c.porcentaje || c.descripcion)
    .map((c) => `<li>${c.porcentaje ? `${c.porcentaje}% — ` : ''}${c.descripcion || ''}</li>`)
    .join('');
  return filas ? `<ul>${filas}</ul>` : '';
}

function parsearCondicionesPago(condicionesPago) {
  if (Array.isArray(condicionesPago)) return condicionesPago;
  if (typeof condicionesPago === 'string') {
    try {
      const parsed = JSON.parse(condicionesPago);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------- COTIZACIÓN (carta simple) ----------

function construirHtmlCotizacion({
  empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, propietario, saludo, parrafo, descuento, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalBruto = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const valorDescuento = parseFloat(descuento) || 0;
  const condiciones = parsearCondicionesPago(condicionesPago);

  const filaItem = (item, index) => `
    <tr style="background:${index % 2 === 0 ? '#fff' : '#f7f7f7'};">
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad != null && item.cantidad !== '' ? formatearCantidad(item.cantidad) : '-'}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee;">${item.descripcion || ''}${item.adicional ? ' <span style="color:#888; font-size:11px;">(adicional)</span>' : ''}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(item.valor)}</td>
    </tr>`;

  const tablasSecciones = grupos
    .map((grupo) => `
      ${grupo.nombre ? `<p class="tituloSeccion">${grupo.nombre.toUpperCase()}</p>` : ''}
      <table>
        <thead>
          <tr>
            <th class="cantidad">Cant.</th>
            <th>Descripción</th>
            <th class="valor">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.items.map(filaItem).join('')}
          <tr class="subtotalFila">
            <td></td>
            <td>SUBTOTAL</td>
            <td style="text-align:right;">${formatearMoneda(grupo.subtotal)}</td>
          </tr>
        </tbody>
      </table>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Helvetica, Arial, sans-serif; color: #222; padding: 28px; font-size: 13px; line-height: 1.5; }
        .encabezado { display:flex; align-items:center; gap:14px; border-bottom: 3px solid ${colorEmpresa}; padding-bottom: 16px; margin-bottom: 20px; }
        .logo { width: 64px; height: 64px; border-radius: 32px; object-fit: cover; }
        .empresaNombre { font-size: 20px; font-weight: bold; color: ${colorEmpresa}; margin: 0; }
        .empresaWeb { font-size: 12px; color: #888; margin: 2px 0 0 0; }
        .tituloDoc { font-size: 16px; font-weight: bold; text-align:center; margin: 0 0 18px 0; color:${colorEmpresa}; letter-spacing: 1px; }
        .fechaCiudad { text-align: right; margin-bottom: 10px; }
        p { margin: 6px 0; }
        .tituloSeccion { font-weight: bold; margin: 18px 0 4px 0; color: ${colorEmpresa}; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { text-align:left; background:${colorEmpresa}; color:#fff; padding:8px 10px; font-size:12px; }
        th.cantidad { text-align:center; width: 50px; }
        th.valor { text-align:right; width: 110px; }
        .subtotalFila td { padding:8px 10px; font-weight:bold; border-top: 1px solid ${colorEmpresa}; background:#f2f2f2; }
        .resumen { margin-top: 18px; width: 100%; border-collapse: collapse; }
        .resumen td { padding: 6px 10px; font-size: 13px; }
        .resumen .totalGeneral td { font-weight: bold; font-size: 15px; border-top: 2px solid ${colorEmpresa}; padding-top: 10px; }
        .resumen .descuentoFila td { color: #c0392b; }
        .resumen td.etiqueta { text-align: left; }
        .resumen td.monto { text-align: right; }
        .condiciones { margin-top: 24px; }
        .condiciones ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
        .condiciones li { margin: 3px 0; }
        .firma { margin-top: 30px; }
        .pie { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="encabezado">
        ${empresa?.logo_url ? `<img class="logo" src="${empresa.logo_url}" />` : ''}
        <div>
          <p class="empresaNombre">${empresa?.nombre || ''}</p>
          ${empresa?.sitio_web ? `<p class="empresaWeb">${empresa.sitio_web}</p>` : ''}
        </div>
      </div>

      <p class="tituloDoc">COTIZACIÓN${numero ? ` N° ${numero}` : ''}</p>

      <p class="fechaCiudad">${ciudad ? `${ciudad}, ` : ''}${formatearFechaDdMmAa(fecha || new Date())}</p>

      <p>Señor(a)<br/>${propietario || cliente?.nombre || ''}${cliente?.nombre_proyecto ? `<br/>${cliente.nombre_proyecto}` : ''}</p>

      <p>${saludo || 'Cordial Saludo:'}</p>

      ${parrafo ? `<p>${parrafo}</p>` : ''}

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr>
            <td class="etiqueta">Subtotal</td>
            <td class="monto">${formatearMoneda(subtotalBruto)}</td>
          </tr>
          ${valorDescuento > 0 ? `
          <tr class="descuentoFila">
            <td class="etiqueta">Descuento</td>
            <td class="monto">- ${formatearMoneda(valorDescuento)}</td>
          </tr>` : ''}
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(total)}</td>
          </tr>
        </tbody>
      </table>

      ${(condiciones && condiciones.length) || tiempoEntrega ? `
      <div class="condiciones">
        ${condiciones && condiciones.length ? `<p><strong>Condiciones de pago:</strong></p>${listaCondicionesPago(condiciones)}` : ''}
        ${tiempoEntrega ? `<p><strong>Tiempo de entrega:</strong> ${tiempoEntrega}</p>` : ''}
      </div>` : ''}

      ${fechaEntrega ? `<p><strong>Fecha de entrega estimada:</strong> ${formatearFechaDdMmAa(fechaEntrega)}</p>` : ''}

      <p>Agradecemos por contar con nuestra empresa y estaremos atentos a resolver cualquier inquietud sobre esta cotización.</p>

      <div class="firma">
        <p>Atentamente,</p>
        <p><strong>${firmante || ''}</strong><br/>${empresa?.nombre || ''}</p>
      </div>

      <p class="pie">Generado desde ${empresa?.nombre || 'C&D Manager'}</p>
    </body>
  </html>`;
}

// ---------- CONTRATO DE OBRA (formato legal completo) ----------

// Texto legal fijo y genérico (mismas cláusulas para todas las empresas), con marcadores
// {{ORDENANTE}} / {{CONTRATISTA}} que se reemplazan según el caso.
// 2026-08-25: las cláusulas ya NO son texto fijo — cada contrato guarda su propio array editable
// (ver contratos.clausulas, precargado con CLAUSULAS_DEFECTO en cotizaciones_v2.js). Esta función
// solo arma el HTML a partir de lo que venga guardado; si por algún motivo un contrato viejo no
// tiene clausulas (creado antes de este cambio), simplemente no se imprime esa sección en vez de
// fallar. La cláusula "Segunda - Precio" recibe además, en su propio párrafo aparte, el valor
// total en números y en letras entre paréntesis — a pedido explícito del usuario.
function parsearClausulas(clausulas) {
  if (Array.isArray(clausulas)) return clausulas;
  if (typeof clausulas === 'string') {
    try {
      const parsed = JSON.parse(clausulas);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// FIX (2026-08-27, a pedido del usuario): la tabla de ítems debe imprimirse justo después de la
// cláusula "Primera - Objeto" (que termina en "...que consta de la tabla de ítems relacionada a
// continuación"), no antes de todas las cláusulas ni después de todas. Por eso esta función ahora
// recibe la lista de cláusulas YA DIVIDIDA en dos tramos desde construirHtmlContrato (antes/después
// de la tabla) — permite reusar el mismo bloque de estilo/formato de párrafo para ambos tramos sin
// duplicar código. `incluirCierre` controla si se imprime el párrafo final "En señal de
// conformidad..." (debe ir una sola vez, al final del segundo tramo).
// 2026-08-27 (a pedido del usuario): tabla de condiciones de pago (Porcentaje | Ítem | Valor) que
// va INTERCALADA dentro del texto de la cláusula "Tercera - Pago", no como bloque aparte. El
// "Ítem" es la descripción que el usuario ya escribe en Condiciones de pago (ej. "A la firma del
// contrato"); el "Valor" se calcula automáticamente como porcentaje% del valor total del contrato
// — nunca se pide ni se guarda por separado, para que nunca quede desincronizado del total real.
// FIX (2026-08-28, a pedido del usuario): esta tabla usaba background gris claro (#f2f2f2) en sus
// <th>, pero heredaba color:#fff del estilo global `th { background:${colorEmpresa}; color:#fff; }`
// (ver más abajo, en el CSS del documento) — texto blanco sobre fondo gris claro, invisible. La
// tabla de ítems (Cantidad/Descripción/Valor) se ve bien porque SÍ usa el color de la empresa como
// fondo de cabecera; esta tabla ahora hace exactamente lo mismo, recibiendo colorEmpresa como
// parámetro en vez de un gris fijo que no combinaba con el resto del documento.
function tablaCondicionesPagoHtml(condiciones, total, colorEmpresa) {
  const lista = Array.isArray(condiciones) ? condiciones.filter((c) => c.porcentaje || c.descripcion) : [];
  if (!lista.length) return '';
  const totalNumero = parseFloat(total) || 0;
  const filas = lista
    .map((c) => {
      const porcentaje = parseFloat(c.porcentaje) || 0;
      const valorFila = totalNumero * (porcentaje / 100);
      return `
        <tr>
          <td style="padding:6px 10px; border-bottom:1px solid #eee; text-align:center;">${porcentaje}%</td>
          <td style="padding:6px 10px; border-bottom:1px solid #eee;">${c.descripcion || ''}</td>
          <td style="padding:6px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(valorFila)}</td>
        </tr>`;
    })
    .join('');
  return `
    <table style="width:100%; border-collapse:collapse; margin:10px 0;">
      <thead>
        <tr>
          <th style="text-align:center; background:${colorEmpresa}; color:#fff; padding:6px 10px; font-size:12px;">Porcentaje</th>
          <th style="text-align:left; background:${colorEmpresa}; color:#fff; padding:6px 10px; font-size:12px;">Ítem</th>
          <th style="text-align:right; background:${colorEmpresa}; color:#fff; padding:6px 10px; font-size:12px;">Valor</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

// Frase exacta (ver CLAUSULAS_DEFECTO en cotizaciones_v2.js) que marca dónde debe cortarse el
// texto de la cláusula "Tercera - Pago" para intercalar la tabla justo después.
const FRASE_CORTE_TERCERA_PAGO = 'estipulándose el modo de pago de la siguiente manera.';

function clausulasLegalesHtml({ clausulas, total, ciudad, fechaLarga, incluirCierre = true, condicionesPago, colorEmpresa }) {
  const lista = parsearClausulas(clausulas);
  const esSegundaPrecio = (titulo) => /segunda/i.test(titulo || '') && /precio/i.test(titulo || '');
  const esTerceraPago = (titulo) => /tercera/i.test(titulo || '') && /pago/i.test(titulo || '');

  const bloques = lista
    .map((c) => {
      const textoConSaltos = (c.texto || '').replace(/\n/g, '<br/>');
      const valorEnLetras = esSegundaPrecio(c.titulo) && total != null
        ? `<br/>${formatearMoneda(total)} (${numeroALetras(total)})`
        : '';

      if (esTerceraPago(c.titulo) && condicionesPago) {
        const indiceCorte = (c.texto || '').indexOf(FRASE_CORTE_TERCERA_PAGO);
        if (indiceCorte !== -1) {
          const finCorte = indiceCorte + FRASE_CORTE_TERCERA_PAGO.length;
          const antes = (c.texto || '').slice(0, finCorte).replace(/\n/g, '<br/>');
          const despues = (c.texto || '').slice(finCorte).trim().replace(/\n/g, '<br/>');
          const tabla = tablaCondicionesPagoHtml(condicionesPago, total, colorEmpresa || '#1E90FF');
          return `<p><strong>${c.titulo || ''}.</strong> ${antes}</p>${tabla}${despues ? `<p>${despues}</p>` : ''}`;
        }
      }

      return `<p><strong>${c.titulo || ''}.</strong> ${textoConSaltos}${valorEnLetras}</p>`;
    })
    .join('\n');

  const cierre = incluirCierre
    ? `<p>En señal de conformidad las partes contratantes suscriben el presente documento${ciudad ? ` en la Ciudad de ${ciudad}` : ''} siendo el día ${fechaLarga}. Se extienden dos copias del mismo tenor y valor.</p>`
    : '';

  return `
    ${bloques}

    ${cierre}
  `;
}

// Reemplaza los marcadores {{...}} del párrafo introductorio editable (ver
// PARRAFO_INTRODUCTORIO_DEFECTO en cotizaciones_v2.js) por los datos reales del cliente/empresa,
// igual que antes se armaba ese párrafo a mano, pero ahora el TEXTO ALREDEDOR de esos datos es
// editable por el usuario en la pantalla de revisión sin tener que volver a escribir los datos.
function armarParrafoIntroductorio({ plantilla, cliente, empresa, firmante, direccionInmueble, mts2Texto, nombreProyecto }) {
  if (!plantilla) return '';
  return plantilla
    .replace('{{ORDENANTE_NOMBRE}}', cliente?.nombre || 'el ORDENANTE')
    .replace('{{ORDENANTE_CEDULA}}', cliente?.cedula ? `, quién se identifica con la cédula de ciudadanía ${cliente.cedula}` : '')
    .replace('{{FIRMANTE}}', firmante || 'el representante de la CONTRATISTA')
    .replace('{{FIRMANTE_CEDULA}}', empresa?.cedula_representante ? `, quién se identifica con la cédula de ciudadanía ${empresa.cedula_representante}` : '')
    .replace('{{EMPRESA_NOMBRE}}', empresa?.nombre || 'la empresa')
    .replace('{{EMPRESA_NIT}}', empresa?.nit ? ` con NIT: ${empresa.nit}` : '')
    .replace('{{PROYECTO_NOMBRE}}', nombreProyecto ? ` en ${nombreProyecto}` : '')
    .replace('{{DIRECCION_INMUEBLE}}', direccionInmueble ? ` ubicado en ${direccionInmueble}` : '')
    .replace('{{MTS2}}', mts2Texto || '');
}

function construirHtmlContrato({
  empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, parrafoIntroductorio, clausulas, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalGeneral = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const condiciones = parsearCondicionesPago(condicionesPago);
  const fechaContrato = fecha || new Date();
  const direccionInmueble = cliente?.direccion ? `${cliente.direccion}` : '';
  // FIX (2026-08-27): clientes.mts2 es DECIMAL(10,2) — pg lo devuelve como string con decimales
  // (ej. "180.00"). Sin normalizar, el párrafo introductorio del contrato (documento legal)
  // mostraba "(180.00 m²)" en vez de "(180 m²)".
  const mts2Texto = cliente?.mts2 ? ` (${parseFloat(cliente.mts2)} m²)` : '';
  const totalContrato = total != null ? total : subtotalGeneral;

  // FIX (2026-08-27, a pedido del usuario): la cláusula "Primera - Objeto" dice textualmente
  // "...que consta de la tabla de ítems relacionada a continuación", así que esa tabla debe
  // aparecer justo después de ella, no antes de todas las cláusulas ni al final. Se divide el
  // array de cláusulas en "primera" (siempre la posición 0, ya que CLAUSULAS_DEFECTO y cualquier
  // edición del usuario mantienen el orden) y "resto" (Segunda en adelante).
  const listaClausulasCompleta = parsearClausulas(clausulas);
  const clausulaPrimera = listaClausulasCompleta.slice(0, 1);
  const clausulasRestantes = listaClausulasCompleta.slice(1);

  const filaItem = (item, index) => `
    <tr style="background:${index % 2 === 0 ? '#fff' : '#f7f7f7'};">
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad != null && item.cantidad !== '' ? formatearCantidad(item.cantidad) : '-'}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee;">${item.descripcion || ''}${item.adicional ? ' <span style="color:#888; font-size:11px;">(adicional)</span>' : ''}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(item.valor)}</td>
    </tr>`;

  const tablasSecciones = grupos
    .map((grupo) => `
      ${grupo.nombre ? `<p class="tituloSeccion">${grupo.nombre.toUpperCase()}</p>` : ''}
      <table>
        <thead>
          <tr>
            <th class="cantidad">Cant.</th>
            <th>Descripción</th>
            <th class="valor">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.items.map(filaItem).join('')}
          <tr class="subtotalFila">
            <td></td>
            <td>SUBTOTAL</td>
            <td style="text-align:right;">${formatearMoneda(grupo.subtotal)}</td>
          </tr>
        </tbody>
      </table>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Helvetica, Arial, sans-serif; color: #222; padding: 28px; font-size: 12.5px; line-height: 1.55; }
        .encabezado { display:flex; align-items:center; gap:14px; border-bottom: 3px solid ${colorEmpresa}; padding-bottom: 16px; margin-bottom: 20px; }
        .logo { width: 64px; height: 64px; border-radius: 32px; object-fit: cover; }
        .empresaNombre { font-size: 20px; font-weight: bold; color: ${colorEmpresa}; margin: 0; }
        .empresaWeb { font-size: 12px; color: #888; margin: 2px 0 0 0; }
        .tituloDoc { font-size: 17px; font-weight: bold; text-align:center; margin: 0 0 18px 0; color:${colorEmpresa}; letter-spacing: 1px; }
        .fechaCiudad { margin-bottom: 14px; }
        p { margin: 8px 0; text-align: justify; }
        .tituloSeccion { font-weight: bold; margin: 18px 0 4px 0; color: ${colorEmpresa}; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { text-align:left; background:${colorEmpresa}; color:#fff; padding:8px 10px; font-size:12px; }
        th.cantidad { text-align:center; width: 50px; }
        th.valor { text-align:right; width: 110px; }
        .subtotalFila td { padding:8px 10px; font-weight:bold; border-top: 1px solid ${colorEmpresa}; background:#f2f2f2; }
        .resumen { margin-top: 18px; width: 100%; border-collapse: collapse; }
        .resumen td { padding: 6px 10px; font-size: 13px; }
        .resumen .totalGeneral td { font-weight: bold; font-size: 15px; border-top: 2px solid ${colorEmpresa}; padding-top: 10px; }
        .resumen td.etiqueta { text-align: left; }
        .resumen td.monto { text-align: right; }
        .condiciones { margin-top: 20px; }
        .condiciones ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
        .condiciones li { margin: 3px 0; }
        .clausulas { margin-top: 26px; page-break-inside: auto; }
        .firmas { margin-top: 40px; display:flex; justify-content: space-between; gap: 40px; }
        .firmaBloque { flex: 1; }
        .firmaLinea { border-top: 1px solid #333; margin-top: 46px; padding-top: 6px; }
        .firmaNombre { font-weight: bold; font-size: 13px; }
        .firmaCedula { font-size: 12px; color: #555; }
        .pie { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="encabezado">
        ${empresa?.logo_url ? `<img class="logo" src="${empresa.logo_url}" />` : ''}
        <div>
          <p class="empresaNombre">${empresa?.nombre || ''}</p>
          ${empresa?.sitio_web ? `<p class="empresaWeb">${empresa.sitio_web}</p>` : ''}
        </div>
      </div>

      <p class="tituloDoc">CONTRATO DE OBRA${numero ? ` N° ${numero}` : ''}</p>

      <div class="fechaCiudad">
        ${ciudad ? `<p>Ciudad: ${ciudad}</p>` : ''}
        <p>Fecha: ${formatearFechaDdMmAa(fechaContrato)}</p>
      </div>

      <p>${armarParrafoIntroductorio({
        plantilla: parrafoIntroductorio,
        cliente, empresa, firmante, direccionInmueble, mts2Texto,
        nombreProyecto: cliente?.nombre_proyecto,
      })}</p>

      <div class="clausulaPrimera">
        ${clausulasLegalesHtml({ clausulas: clausulaPrimera, total: totalContrato, ciudad, fechaLarga: formatearFechaLarga(fechaContrato), incluirCierre: false, colorEmpresa })}
      </div>

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(totalContrato)}</td>
          </tr>
        </tbody>
      </table>

      ${tiempoEntrega ? `
      <div class="condiciones">
        <p><strong>Tiempo de entrega:</strong> ${tiempoEntrega}</p>
      </div>` : ''}

      ${fechaEntrega ? `<p><strong>Fecha de entrega estimada:</strong> ${formatearFechaDdMmAa(fechaEntrega)}</p>` : ''}

      ${empresa?.banco_numero ? `
      <p>Los dineros deben ser consignados a la Cuenta ${empresa.banco_tipo_cuenta || ''} de ${empresa.banco_nombre || ''} <strong>${empresa.banco_numero}</strong> a nombre de <strong>${empresa.banco_titular || empresa.nombre || ''}</strong>.</p>` : ''}

      <div class="clausulas">
        ${clausulasLegalesHtml({ clausulas: clausulasRestantes, total: totalContrato, ciudad, fechaLarga: formatearFechaLarga(fechaContrato), incluirCierre: true, condicionesPago: condiciones, colorEmpresa })}
      </div>

      <div class="firmas">
        <div class="firmaBloque">
          <p style="margin-bottom:0;"><strong>LA CONTRATISTA:</strong></p>
          <div class="firmaLinea">
            <p class="firmaNombre">${firmante || ''}</p>
            ${empresa?.cedula_representante ? `<p class="firmaCedula">CC. ${empresa.cedula_representante}</p>` : ''}
          </div>
        </div>
        <div class="firmaBloque">
          <p style="margin-bottom:0;"><strong>EL ORDENANTE:</strong></p>
          <div class="firmaLinea">
            <p class="firmaNombre">${cliente?.nombre || ''}</p>
            ${cliente?.cedula ? `<p class="firmaCedula">CC. ${cliente.cedula}</p>` : ''}
          </div>
        </div>
      </div>

      <p class="pie">Generado desde ${empresa?.nombre || 'C&D Manager'}</p>
    </body>
  </html>`;
}

function construirHtml(datos) {
  return datos.tipoDocumento === 'contrato' ? construirHtmlContrato(datos) : construirHtmlCotizacion(datos);
}

// Convierte el HTML a un PDF (Buffer) usando Puppeteer con Chromium empaquetado para entornos
// tipo Render (sin depender de que Chrome esté instalado en el sistema).
async function generarPdfBuffer(datos) {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  const html = construirHtml(datos);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({ format: 'letter', printBackground: true });
    return buffer;
  } finally {
    await browser.close();
  }
}

module.exports = { construirHtml, generarPdfBuffer };
