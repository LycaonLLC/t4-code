// eslint-disable-next-line no-unused-expressions -- replaced by Flutter at build time
{{flutter_js}}
// eslint-disable-next-line no-unused-expressions -- replaced by Flutter at build time
{{flutter_build_config}}

// The public demo follows current main. Remove service workers left by older
// builds before starting so they cannot keep an obsolete UI in front of the
// freshly invalidated CloudFront files.
const startT4Demo = () => _flutter.loader.load();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      Promise.all(
        registrations
          .filter((registration) => new URL(registration.scope).pathname.startsWith('/demo/'))
          .map((registration) => registration.unregister()),
      ),
    )
    .then(startT4Demo, startT4Demo);
} else {
  startT4Demo();
}
