# Manual del cazador · Comunidad de Madrid

App de estudio para el examen de cazador: 500 preguntas de teoría en 5 temas, reconocimiento de especies con fotos, repaso de falladas y simulacro de examen (20 de teoría + 10 de especies).

Es una web estática (HTML, CSS y JavaScript sin dependencias de compilación). El progreso se guarda con una cuenta (Google o Facebook; Apple preparado) usando Supabase.

## Estructura

- `index.html`, `css/style.css`, `js/app.js`: la aplicación.
- `js/config.js`: URL y clave pública de Supabase.
- `data/questions.js`, `data/species.js`, `data/explanations.js`: preguntas, especies y explicaciones.
- `img/`: fotos de las especies.
- `supabase/schema.sql`: tabla de progreso con seguridad por usuario.

## Puesta en marcha

1. **Supabase**: crea un proyecto gratis en supabase.com. En *SQL Editor* ejecuta `supabase/schema.sql`.
2. **Claves**: en *Project Settings > API* copia la *Project URL* y la clave *anon public* en `js/config.js`.
3. **GitHub Pages**: en el repositorio, *Settings > Pages > Source: GitHub Actions*. Tu web quedará en `https://TU-USUARIO.github.io/manual-cazador-madrid/`.
4. **Redirección**: en Supabase, *Authentication > URL Configuration*, pon esa dirección en *Site URL* y en *Redirect URLs*.
5. **Google**: en Google Cloud Console crea unas credenciales OAuth (tipo web). Como *URI de redireccionamiento* usa la que muestra Supabase en *Authentication > Providers > Google* (`https://TU-PROYECTO.supabase.co/auth/v1/callback`). Pega el Client ID y el Secret en Supabase.
6. **Facebook**: en developers.facebook.com crea una app con *Facebook Login*, usa la misma URI de callback de Supabase y pega App ID y Secret en *Providers > Facebook*.
7. **Apple** (opcional): requiere cuenta de desarrollador de Apple (99 $/año). Actívalo en Supabase y cambia `LOGIN_APPLE` a `true` en `js/config.js`.

## Importar tu progreso anterior

Con la sesión iniciada, pulsa *Importar progreso (.json)* al final de la pantalla de inicio y elige el archivo `mi-progreso.json`.
