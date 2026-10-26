# Academia ASAF · Fe y Música

Plataforma de clases en video para Piano, Guitarra acústica, Guitarra eléctrica,
Bajo, Batería y Vocalización. Cada clase se desbloquea al terminar la anterior.

## Estructura

```
musica-app/
├── main.py            Backend FastAPI (cursos, lectura de listas de YouTube, API)
├── requirements.txt   Dependencias
├── prueba_carga.py    Simula muchos usuarios entrando a la vez
└── static/
    ├── index.html     Página (inicio + vista de curso)
    ├── app.js         Lógica del frontend y del reproductor de YouTube
    └── img/           Logo, emblema y favicon de la academia
```

## Cómo ejecutarlo (VS Code, terminal)

```bash
cd musica-app
python -m venv venv
# Windows:      venv\Scripts\activate
# Mac / Linux:  source venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

Abre **http://127.0.0.1:8000** en el navegador. Deja la terminal abierta
mientras usas la página.

> No abras `index.html` con doble clic: YouTube no reproduce videos en
> páginas abiertas como archivo.

## Cómo alimentar la página

Cada curso es una **lista de reproducción de YouTube**. En `main.py`, dentro de
`CURSOS`, cada curso tiene un `enlace`. Para cambiar las clases de un
instrumento, pega ahí el enlace de otra lista (tiene que contener `list=`).

- Para **añadir una clase**: agrégala a la lista en YouTube. La página la
  muestra sola (el servidor revisa las listas cada 6 horas, o al reiniciarlo).
- Para **cambiar el orden**: cámbialo en la lista de YouTube.
- Para **añadir un instrumento**: copia un bloque `Curso(...)` en `main.py`,
  cambia `id`, `nombre`, `descripcion`, `icono` y `enlace`.

La lista debe ser **pública** o **no listada** (no privada) y sus videos deben
permitir insertarse en otras páginas.

Cómo obtiene las clases: al arrancar, el servidor lee cada lista de YouTube y
guarda los títulos. Si YouTube no responde en ese momento, el navegador pide la
lista directamente al reproductor de YouTube, y los títulos aparecen a medida
que se ven las clases. En la terminal verás un mensaje por cada curso cargado.

## API

| Ruta                     | Devuelve                                       |
|--------------------------|------------------------------------------------|
| `GET /api/cursos`        | Lista de cursos con su número de clases        |
| `GET /api/cursos/{id}`   | Curso con sus clases en orden                  |
| `GET /api/salud`         | Estado del servidor y cursos ya cargados       |
| `GET /docs`              | Documentación interactiva de la API            |

## Preparado para muchos usuarios

- YouTube se consulta solo desde el servidor y cada 6 horas, no por cada visita.
- Las respuestas se sirven desde memoria, con caché en el navegador y gzip.
- Errores siempre en JSON claro (400, 404, 500), nunca trazas internas.
- El frontend reintenta si el servidor falla un momento y muestra avisos claros.
- El progreso de cada estudiante se guarda en su navegador.

Para producción, usa varios procesos:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

Prueba de carga (con el servidor encendido, en otra terminal):

```bash
python -m pip install httpx
python prueba_carga.py --usuarios 300 --peticiones 20
```

Sobre limitar peticiones por usuario (rate limiting): no se incluye a propósito.
En una iglesia o colegio muchos estudiantes comparten la misma IP y un límite
por IP les daría errores 429. Si la publicas en internet, ponlo en el proxy
(Nginx, Cloudflare).
