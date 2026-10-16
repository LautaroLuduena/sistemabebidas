# 🥤 ETL Bebidas — Sistema de gestión

Sistema de gestión para una distribuidora de bebidas **mayorista y minorista**: caja, ventas, compras, cuentas corrientes de clientes y proveedores, inventario con stock, catálogo con fotos y códigos de barras, y listas de precios descargables.

Funciona en tu computadora (Windows, Mac o Linux) y se usa desde el navegador. También se puede abrir desde el celular o la tablet si están en la misma red WiFi.

## Funciones

| Módulo | Qué hace |
|---|---|
| **Inicio** | Saldos de ambas cajas, cuánto te deben los clientes y cuánto les debés a los proveedores, ventas del día y del mes, ganancia bruta, stock valorizado, más vendidos y alertas de stock bajo. |
| **Vender** | Punto de venta: escaneás el código de barras (o buscás por nombre) y se agrega. Elegís cliente → se aplica su lista de precios. Botón “+ bulto”. Descuento. Pago en efectivo, transferencia, cuenta corriente o combinado (calcula el vuelto). Comprobante imprimible. |
| **Ventas** | Historial con filtros por fecha y cliente, detalle, reimpresión y **anulación** (devuelve stock y revierte caja y cuenta corriente). |
| **Presupuestos** | Desde **Vender**, cargás los productos y tocás **📄 Presupuesto**: se guarda con número, cliente (o un nombre libre), validez y observaciones, sin descontar stock ni mover la caja. Se imprime o se guarda como PDF (con o sin fotos), se puede editar, duplicar, anular y **pasar a venta** con un clic. Las condiciones del pie y la validez por defecto se configuran en *Configuración*. |
| **Remitos X** | Documento no válido como factura (para quienes no son responsables inscriptos). Se emite desde una venta (al confirmarla o desde *Ventas*): numeración correlativa con punto de venta (ej. `0001-00000001`), dirección de entrega, observaciones, valorizado o solo cantidades, bultos, copias original/duplicado y espacio de "Recibí conforme". No vuelve a descontar stock. Punto de venta, próximo número, copias, leyenda y datos fiscales (CUIT, condición IVA, IIBB, inicio de actividades) en *Configuración*. |
| **Reportes mes a mes** | Comparativo por mes (elegís desde/hasta, últimos 12 meses, este año o el anterior): ventas, cantidad, ticket promedio, costo de lo vendido, ganancia bruta, margen, gastos, **ganancia neta** y compras, con variación contra el mes anterior y gráficos. Tocando un mes ves el detalle: productos vendidos con su ganancia, por categoría, clientes, compras por proveedor, productos comprados y gastos. Exporta a Excel. |
| **Historial** | Todas las operaciones en una sola lista (ventas, compras, cobros, pagos, gastos, ingresos, traspasos, presupuestos, remitos y ajustes), con filtros por mes o fechas, tipo, cliente, proveedor, anuladas y texto libre. Totales del filtro y exportación a Excel. |
| **Comprar / Compras** | Ingreso de mercadería por proveedor con N° de factura: suma stock, actualiza el costo y registra el pago (efectivo / transferencia / a cuenta). |
| **Caja** | Dos cajas: **Efectivo** y **Transferencia**. Ver saldos y movimientos, cargar ingresos y gastos, y traspasar entre cajas (ej: depositar efectivo). Sin cierres. |
| **Clientes / Proveedores** | Ficha, saldo de **cuenta corriente** con historial (debe / haber / saldo), registrar cobros y pagos, ajustes, saldo inicial y límite de crédito. |
| **Cuentas corrientes** | Resumen de todos los saldos pendientes de clientes y proveedores. |
| **Catálogo y stock** | Productos con **foto**, **código de barras**, código interno, categoría, marca, presentación, unidades por bulto, costo, stock y stock mínimo. Vista en tarjetas o tabla, ajustes de stock (roturas, conteos) e historial de movimientos. |
| **Listas de precios** | Todas las listas que quieras (Minorista, Mayorista, Bares…). Cada una con un % de recargo sobre el costo o precios fijos por producto. **Actualización masiva** por %. Descarga en **Excel**, **PDF** (lista o catálogo con fotos), por lista o directamente **según el cliente**. |
| **Importar / Exportar** | Carga masiva de productos desde **Excel (.xlsx) o CSV**, carga masiva de **fotos** (nombradas con el código de barras) y exportación del inventario completo. |

## Instalación

1. Instalá **Node.js 22 o superior** desde <https://nodejs.org> (versión LTS).
2. Descargá este proyecto y, dentro de la carpeta, ejecutá:

```bash
npm install
npm start
```

3. Abrí el navegador en **http://localhost:3000**

En Windows también podés hacer doble clic en `iniciar.bat`.

Para usarlo desde otro dispositivo de la misma red, entrá a `http://IP-DE-LA-PC:3000` (ej: `http://192.168.0.10:3000`).

La primera vez que entrás te pide crear el **usuario administrador**. Después podés agregar más usuarios en **Configuración → Usuarios**.

> **¿Se pierden los datos si cierro la terminal?** No. Todo queda guardado en la carpeta `data/`. Al cerrar la terminal el sistema se detiene, pero al volver a iniciarlo está todo como lo dejaste. Para no tener que iniciarlo cada vez, publicalo online (ver abajo).

## Publicarlo online (sin tener que iniciarlo cada vez)

El sistema queda funcionando 24 h en un servidor y entrás desde cualquier PC o celular con usuario y contraseña. Lo importante es que el servidor tenga un **disco persistente** (volumen), porque ahí se guardan la base de datos y las fotos: en servicios sin disco persistente los datos se borran en cada reinicio.

### Opción recomendada: Railway (≈ USD 5/mes)

1. Creá una cuenta en <https://railway.com> e iniciá sesión con GitHub.
2. **New Project → Deploy from GitHub repo** → elegí `sistemabebidas` (y la rama que quieras publicar).
3. Railway detecta el `Dockerfile` y lo construye solo.
4. En el servicio: **Settings → Volumes → Add volume**, con *mount path* `/data`. (Sin este paso, los datos se pierden en cada actualización).
5. **Settings → Networking → Generate Domain** para obtener la dirección pública (ej: `sistemabebidas.up.railway.app`).
6. Entrá a esa dirección y creá tu usuario administrador **enseguida** (el primero que entra lo crea).

Cada vez que se suban cambios a la rama, Railway actualiza el sistema solo y los datos se mantienen en el volumen.

### Otras opciones

- **Render** (plan pago “Starter” + *Persistent Disk* montado en `/data`).
- **Fly.io** (con un *volume* montado en `/data`).
- **Un VPS** (DigitalOcean, Hetzner, Contabo, etc.): `docker build -t bebidas . && docker run -d --restart=always -p 80:3000 -v bebidas-data:/data bebidas`.

Cualquier opción que use el `Dockerfile` funciona, siempre que `/data` sea un disco persistente.

**Respaldo online:** descargá periódicamente el inventario en Excel desde *Importar / Exportar*, y si el proveedor lo permite, activá los backups del volumen.

## Carga masiva de productos

Desde **Importar / Exportar** descargá la plantilla. Columnas reconocidas (solo `nombre` es obligatoria):

| Columna | Ejemplo |
|---|---|
| `codigo` | BEB001 |
| `codigo_barras` | 7790895000997 |
| `nombre` | Coca-Cola Original 2.25L |
| `categoria` | Gaseosas (se crea sola si no existe) |
| `marca` | Coca-Cola |
| `presentacion` | Botella 2.25L |
| `unidades_bulto` | 8 |
| `costo` | 1800 o 1.800,50 |
| `stock` | 48 |
| `stock_minimo` | 16 |
| `descripcion` | |
| `precio_<lista>` | `precio_minorista`, `precio_mayorista`… (opcional: si queda vacío se usa el recargo de la lista) |

- Si el código de barras (o el código) ya existe, el producto se **actualiza**; si no, se **crea**.
- Podés elegir si la columna `stock` **reemplaza** o **se suma** al stock actual.
- Se aceptan CSV separados por `;` o `,` y números con formato argentino (`1.234,56`).
- Tip: exportá el inventario, editalo en Excel y volvé a importarlo para actualizar precios o stock de muchos productos a la vez.

**Fotos en masa:** seleccioná muchas imágenes juntas; cada archivo debe llamarse como el código de barras o el código interno (`7790895000997.jpg`).

## Lector de código de barras

Cualquier lector USB/Bluetooth que funcione como teclado sirve: en **Vender**, **Comprar** o **Catálogo** hacé foco en el buscador y escaneá. En la ficha del producto también podés escanear para cargar el código, o generar un código interno con el botón ⚙️ para productos sin código.

## Datos y respaldo

Todo se guarda en la carpeta `data/`:

- `data/sistema.db` → base de datos (SQLite)
- `data/uploads/` → fotos de los productos

También podés descargar un respaldo completo desde **Configuración → Respaldo**, y restaurarlo ahí mismo en otra instalación (por ejemplo, para pasar los datos de tu PC al servidor online: comprimí la carpeta `data` en un .zip y subilo en *Restaurar respaldo*). Los usuarios de la instalación donde restaurás se mantienen.

**Hacé copias de esa carpeta periódicamente** (pendrive, Google Drive, etc.). Para restaurar, reemplazá la carpeta `data/` con la copia.

Variables opcionales: `PORT` (puerto, por defecto 3000) y `DATA_DIR` (carpeta de datos).

**Si olvidaste la contraseña:** definí las variables de entorno `RESET_ADMIN_USER` (tu usuario) y `RESET_ADMIN_PASSWORD` (la nueva contraseña) y reiniciá el sistema; en Railway se cargan en *Variables*. Al iniciar, ese usuario queda con la nueva contraseña (o se crea si no existe). Después **borrá la variable `RESET_ADMIN_PASSWORD`**.

Otra forma, en una instalación local y con el sistema detenido: con el sistema detenido, borrá las tablas de usuarios con `node -e "const D=require('better-sqlite3');const d=new D('data/sistema.db');d.exec('DELETE FROM sessions; DELETE FROM users')"` y al volver a entrar te pedirá crear el administrador de nuevo (no se pierde ningún otro dato).

## Cómo se calculan los saldos

- **Caja:** cada venta/cobro suma en la caja elegida; cada compra/pago/gasto resta. El saldo es la suma de los movimientos.
- **Cuenta corriente:** saldo positivo = deuda pendiente (el cliente nos debe / le debemos al proveedor). La parte no pagada de una venta o compra va a la cuenta corriente; los cobros y pagos la reducen.
- **Precio de un producto en una lista:** precio fijo si se cargó; si no, `costo × (1 + recargo de la lista)`.

## Desarrollo

```bash
npm run dev   # reinicia el servidor al guardar cambios
npm test      # tests de la API
```

Estructura:

```
server/           API (Node.js + Express + SQLite)
  db.js           esquema de la base de datos
  services.js     lógica de precios, caja, cuentas corrientes y stock
  auth.js         usuarios, login y sesiones
  routes/         catálogo, clientes/proveedores, ventas/compras, caja, reportes, importación/exportación
public/           interfaz web (HTML + CSS + JavaScript, sin compilación)
test/             tests
```
