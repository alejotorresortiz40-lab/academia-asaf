"""Prueba de carga sencilla: simula muchos usuarios entrando a la vez.

Uso (con el servidor encendido):
    pip install httpx
    python prueba_carga.py --usuarios 200 --peticiones 20
"""

import argparse
import asyncio
import time
from collections import Counter

import httpx

RUTAS = ["/", "/app.js", "/img/logo.png", "/api/cursos", "/api/cursos/piano",
         "/api/cursos/bateria", "/api/cursos/bajo", "/api/cursos/vocalizacion"]


async def usuario(cliente, n, resultados, tiempos):
    for i in range(n):
        ruta = RUTAS[i % len(RUTAS)]
        inicio = time.perf_counter()
        try:
            r = await cliente.get(ruta)
            resultados[r.status_code] += 1
        except httpx.HTTPError as e:
            resultados[type(e).__name__] += 1
        tiempos.append(time.perf_counter() - inicio)


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:8000")
    p.add_argument("--usuarios", type=int, default=200)
    p.add_argument("--peticiones", type=int, default=20)
    a = p.parse_args()

    resultados, tiempos = Counter(), []
    limites = httpx.Limits(max_connections=a.usuarios)
    async with httpx.AsyncClient(base_url=a.url, limits=limites, timeout=30) as c:
        inicio = time.perf_counter()
        await asyncio.gather(*(usuario(c, a.peticiones, resultados, tiempos)
                               for _ in range(a.usuarios)))
        total = time.perf_counter() - inicio

    tiempos.sort()
    print(f"Peticiones: {len(tiempos)} en {total:.1f}s ({len(tiempos)/total:.0f}/s)")
    print(f"Respuestas: {dict(resultados)}")
    print(f"Tiempo medio: {sum(tiempos)/len(tiempos)*1000:.0f} ms, "
          f"p95: {tiempos[int(len(tiempos)*0.95)]*1000:.0f} ms")
    errores = sum(v for k, v in resultados.items() if k != 200)
    print("✅ Sin errores" if errores == 0 else f"❌ {errores} errores")


if __name__ == "__main__":
    asyncio.run(main())
