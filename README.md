# SeriesMetro — plugin de Kino

Películas y series en **latino, castellano o subtituladas**, a través de [SeriesMetro](https://www3.seriesmetro.net), con el
catálogo de TMDB. Necesita Kino 0.9.55 o posterior.

Es la misma fuente que el plugin **Latino** trae entre las suyas (`src/sources/seriesmetro.js` allá); este plugin va solo, con su
propio extractor (Fastream).

## Instalar

En Kino: **Plugins ▸ Agregar un plugin ▸ Kino**, y pega la dirección de este repositorio.

## Qué trae

- **Inicio** con quince filas de TMDB (populares, en cines, próximos estrenos, mejor valoradas, series en emisión, películas por
  género y anime). Cada título lleva sus géneros, así el Inicio de Kino lo archiva en la fila de cada género.
- **Categorías** con los géneros de TMDB (películas y series), **búsqueda** y **episodios**.
- **Un reproductor por idioma.** La página de cada película o episodio ofrece latino, castellano y subtitulado, siempre en
  Fastream. El primero que abre se reproduce y los demás quedan en el menú **Servidor**, sin abrirlos de antemano.
- **Idioma preferido** (ajuste): latino (por defecto), castellano o subtitulado; los otros dos van después.
- **Descargas** sin conexión en el teléfono.
- Textos en español e inglés.

## Notas

- **Cobertura despareja:** las series suelen estar completas en los tres idiomas; las películas, bastante menos (muchas no
  están). Que haya o no un título depende del sitio, no del plugin.
- **Calidad:** Fastream ofrece 360p y 480p.
- El sitio no muestra año en la página de una serie, así que se juzga con el de su episodio. Para encontrar un título se usan
  sus nombres en TMDB (es-MX, es-ES, original e inglés) y su año, que se guardan 7 días. Otro título con el mismo nombre se
  descarta por el año.
- **Fastream** solo contesta a clientes que parecen un navegador: el plugin manda un `User-Agent` de navegador y el sitio como
  `Referer`. Kino muestra en rojo que el plugin "puede reproducir video desde cualquier servidor" (`streamHosts: "any"`), porque
  la lista y los segmentos llegan de un CDN que cambia.

## Desarrollo

```
npm run build                       # empaqueta src/ en plugin.js (esbuild)
node --test test/plugin.test.mjs    # sin red: un SeriesMetro simulado (películas, episodios con su lista por POST) y un Fastream simulado
node sdk/validate.mjs .             # el manifest, como lo revisa Kino
```

`plugin.js` está generado desde `src/`: edita `src/` y vuelve a empaquetar. `sdk/` y `contract.json` son el kit de pruebas abierto
de Kino (Apache-2.0). Usa este plugin con contenido que tengas derecho a ver.
